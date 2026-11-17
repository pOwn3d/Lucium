import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { DRAG_TABS_MAX, DRAG_TTL_MS, DROP_GRACE_MS, TabDragLedger, tabsToDrag } from './tab-drag'

/** A ledger on a clock the test moves. */
function ledger() {
  let now = 1_000
  const l = new TabDragLedger(() => now)
  return { l, wait: (ms: number) => void (now += ms) }
}

const tabs = [{ id: 'a' }, { id: 'b', private: true as const }]

describe('a drag going on', () => {
  it('is what the other windows are told, with a token that tells it from the next drag', () => {
    const { l } = ledger()
    expect(l.live()).toBeNull()
    const first = l.begin('main', tabs)
    expect(l.live()).toMatchObject({ token: first.token, sourceKey: 'main', tabs })
    l.end('main')
    expect(l.begin('main', tabs).token).toBeGreaterThan(first.token)
  })

  it('is replaced by a new drag, whose window may be another one', () => {
    const { l } = ledger()
    l.begin('main', tabs)
    l.begin('window-2', [{ id: 'z' }])
    expect(l.live()).toMatchObject({ sourceKey: 'window-2', tabs: [{ id: 'z' }] })
  })

  it('holds no more tabs than a selection can', () => {
    const { l } = ledger()
    const many = Array.from({ length: DRAG_TABS_MAX + 50 }, (_, i) => ({ id: `t${i}` }))
    expect(l.begin('main', many).tabs).toHaveLength(DRAG_TABS_MAX)
  })

  it('is forgotten when nobody ends it for too long: no window shows its marks for ever', () => {
    const { l, wait } = ledger()
    l.begin('main', tabs)
    wait(DRAG_TTL_MS)
    expect(l.live()).not.toBeNull()
    wait(1)
    expect(l.live()).toBeNull()
    expect(l.claim()).toBeNull()
  })
})

describe('the end of a drag', () => {
  it('only ends the drag of the window that says so', () => {
    const { l } = ledger()
    l.begin('main', tabs)
    expect(l.end('window-2')).toBe(false)
    expect(l.live()).not.toBeNull()
    expect(l.end('main')).toBe(true)
    expect(l.live()).toBeNull()
    expect(l.end('main')).toBe(false)
  })

  it('leaves the drop a moment to arrive: the two windows\' messages come in either order', () => {
    const { l, wait } = ledger()
    l.begin('main', tabs)
    l.end('main')
    wait(DROP_GRACE_MS)
    expect(l.claim()).toMatchObject({ sourceKey: 'main', tabs })
  })

  it('takes no drop after that', () => {
    const { l, wait } = ledger()
    l.begin('main', tabs)
    l.end('main')
    wait(DROP_GRACE_MS + 1)
    expect(l.claim()).toBeNull()
  })
})

describe('a drop', () => {
  it('takes the drag once: a second drop finds nothing, and so does the end that comes after it', () => {
    const { l } = ledger()
    l.begin('main', tabs)
    expect(l.claim()).not.toBeNull()
    expect(l.claim()).toBeNull()
    expect(l.end('main')).toBe(false)
    expect(l.live()).toBeNull()
  })

  it('finds nothing without a drag', () => {
    expect(ledger().l.claim()).toBeNull()
  })
})

describe('a window that goes', () => {
  it('takes its drag with it, and only its own', () => {
    const { l } = ledger()
    l.begin('window-2', tabs)
    expect(l.forget('main')).toBe(false)
    expect(l.live()).not.toBeNull()
    expect(l.forget('window-2')).toBe(true)
    expect(l.live()).toBeNull()
    expect(l.claim()).toBeNull()
  })
})

describe('the tabs a window starts to drag', () => {
  let counter = 0
  const ctx: Ctx = { now: 1_000_000, newId: () => `id${++counter}` }
  const run = (state: SidebarState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a, ctx), state)
  function listed() {
    let state = createInitialState(ctx)
    const first = state.activeSpaceId
    state = run(state, { type: 'space/create', name: 'Autre', emoji: '✨', hue: 10 })
    const other = state.activeSpaceId
    for (const [name, spaceId] of [['a', first], ['b', first], ['c', first], ['z', other]] as const) state = run(state, { type: 'tab/open', url: `https://${name}.fr/`, spaceId, background: true })
    state = run(state, { type: 'tab/open', url: 'https://secret.fr/', spaceId: first, private: true, background: true })
    const id = (n: string) => state.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
    return { state, first, id }
  }

  it('are those the window lists, in the order of its sidebar, with the private ones marked', () => {
    const { state, id } = listed()
    expect(tabsToDrag(state, [id('c'), id('a'), id('secret')])).toEqual([{ id: id('a') }, { id: id('c') }, { id: id('secret'), private: true }])
  })

  it('leaves out what the window does not have, and the tabs of another space than the first one\'s', () => {
    const { state, id } = listed()
    expect(tabsToDrag(state, ['nope', id('b'), id('z')])).toEqual([{ id: id('b') }])
    expect(tabsToDrag(state, ['nope'])).toEqual([])
  })

  it('leaves out the page of a favourite: its tile is dragged, never a row', () => {
    const { state, first, id } = listed()
    const added = run(state, { type: 'favorite/add', url: 'https://fav.fr/', title: 'Fav', spaceId: first })
    const opened = run(added, { type: 'favorite/open', id: added.favorites[0]!.id, spaceId: first })
    const favoritePage = opened.tabs.find((t) => t.favoriteId !== undefined)!
    expect(tabsToDrag(opened, [id('a'), favoritePage.id])).toEqual([{ id: id('a') }])
  })

  it('takes nothing that is not a list of ids, or is longer than a selection can be', () => {
    const { state, id } = listed()
    for (const bad of [undefined, null, 'a', 5, {}, [id('a'), 3], [id('a'), null], Array.from({ length: DRAG_TABS_MAX + 1 }, () => id('a'))]) expect(tabsToDrag(state, bad), JSON.stringify(bad)?.slice(0, 40)).toEqual([])
  })
})
