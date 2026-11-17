// "Déplacer vers la fenêtre": the windows the menu of a tab offers, what it refuses (private ↔ normal, the same window, a window gone), the tabs that go
// together (a split view), and where they land in the window that takes them (decided with the drag's own rule, decideTransfer).

import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, reduce, sidebarOrder, type Action, type Ctx } from './sidebar'
import { decideTransfer, type TransferOrder } from './tab-transfer'
import { blankSelection, project } from './window-selection'
import type { WindowEntry } from './window-names'
import { NEW_WINDOW, splitToRestore, tabsToSend, windowChoices, windowMoveRefusal, windowMoveTarget } from './window-move'

let counter = 0
const ctx: Ctx = { now: 1_000_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Communication (a, b, c; p1 and p2 pinned, p2 in the folder Docs with p3) and Work, another profile (w1, w2; wp pinned). */
function setup() {
  counter = 0
  let s = createInitialState(ctx)
  const comm = s.activeSpaceId
  s = run(s, { type: 'space/create', name: 'Work', emoji: '💼', hue: 200, profileName: 'Travail' })
  const work = s.spaces.find((sp) => sp.name === 'Work')!.id
  s = run(s, { type: 'folder/create', name: 'Docs', spaceId: comm })
  const docs = s.folders.find((f) => f.name === 'Docs')!.id
  for (const [name, spaceId] of [['a', comm], ['b', comm], ['c', comm], ['p1', comm], ['p2', comm], ['p3', comm], ['w1', work], ['w2', work], ['wp', work]] as const) s = run(s, { type: 'tab/open', url: `https://${name}.fr/`, spaceId, background: true })
  const id = (n: string) => s.tabs.find((t) => t.url === `https://${n}.fr/`)!.id
  s = run(
    s,
    { type: 'tab/move', id: id('p1'), toIndex: 0, pinned: true },
    { type: 'tab/move', id: id('p2'), toIndex: 1, pinned: true, folderId: docs },
    { type: 'tab/move', id: id('p3'), toIndex: 2, pinned: true, folderId: docs },
    { type: 'tab/move', id: id('wp'), toIndex: 0, pinned: true }
  )
  const view = (state: SidebarState, spaceId: string) => project(state, blankSelection(state, spaceId))
  return { s, comm, work, docs, id, view }
}

const entry = (id: string, kind: WindowEntry['kind'], position: number, more: Partial<WindowEntry> = {}): WindowEntry => ({ id, kind, position, focused: false, ...more })

/** The order a move puts the tabs in once it is done, for the space `spaceId`, by name. */
function landing(s: SidebarState, view: SidebarState, ids: string[]): { order: TransferOrder; after: SidebarState } {
  const decision = decideTransfer({ shared: s, view, from: { key: 'main', private: false }, to: { key: 'window-1', private: false }, ids, target: windowMoveTarget(view, ids.map((i) => s.tabs.find((t) => t.id === i)!)) })
  expect(decision.ok, JSON.stringify(decision)).toBe(true)
  const order = decision as TransferOrder
  const moved = order.respace.reduce((state, tabId) => run(state, { type: 'tab/move-to-space', id: tabId, spaceId: order.spaceId }), s)
  const { placement } = order
  return { order, after: run(moved, { type: 'tabs/move', ids: order.ids, toIndex: placement.toIndex, pinned: placement.pinned, folderId: placement.folderId }) }
}
const names = (state: SidebarState, spaceId: string) => sidebarOrder(state, spaceId).map((tab) => tab.url.split('/')[2]!.replace('.fr', ''))

describe('the windows the menu offers', () => {
  const entries = [entry('main', 'main', 1), entry('window-1', 'window', 2, { name: 'Travail' }), entry('private-1', 'private', 3), entry('guest-1', 'private', 4, { guest: true }), entry('window-2', 'window', 5)]

  it('lists the other normal windows in the order they were opened, never a private or a guest one, never the window itself', () => {
    expect(windowChoices(entries, 'main', true).map((choice) => choice.id)).toEqual(['window-1', 'window-2'])
    expect(windowChoices(entries, 'window-2', true).map((choice) => choice.id)).toEqual(['main', 'window-1'])
  })

  it('offers nothing from a private or a guest window, nor from a window it does not know', () => {
    expect(windowChoices(entries, 'private-1', true)).toEqual([])
    expect(windowChoices(entries, 'guest-1', true)).toEqual([])
    expect(windowChoices(entries, 'gone', true)).toEqual([])
  })

  it('names them as the Window menu does: their name while windows can be named, else "Fenêtre N"; and what they show under it', () => {
    expect(windowChoices(entries, 'main', true).map((choice) => choice.label)).toEqual(['Travail', 'Fenêtre 5'])
    expect(windowChoices(entries, 'main', false).map((choice) => choice.label)).toEqual(['Fenêtre 2', 'Fenêtre 5'])
    const titles: Record<string, string> = { 'window-1': 'Courrier', 'window-2': '  ' }
    expect(windowChoices(entries, 'main', true, (id) => titles[id])).toEqual([{ id: 'window-1', label: 'Travail', title: 'Courrier' }, { id: 'window-2', label: 'Fenêtre 5' }])
    // A title that only says the name again is not repeated.
    expect(windowChoices(entries, 'main', true, () => 'Travail')[0]).toEqual({ id: 'window-1', label: 'Travail' })
  })
})

describe('what is refused', () => {
  const { s, id } = setup()
  const main = { key: 'main', private: false }

  it('refuses a move between a private window and a normal one, either way, and from a private window to a new one', () => {
    expect(windowMoveRefusal(s, id('a'), { key: 'private-1', private: true }, main)).toBe('private-window')
    expect(windowMoveRefusal(s, id('a'), main, { key: 'private-1', private: true })).toBe('private-window')
    expect(windowMoveRefusal(s, id('a'), { key: 'guest-1', private: true }, NEW_WINDOW)).toBe('private-window')
  })

  it('refuses the window the tab is in, a window that is gone, and a tab that has no row', () => {
    expect(windowMoveRefusal(s, id('a'), main, main)).toBe('same-window')
    expect(windowMoveRefusal(s, id('a'), main, null)).toBe('no-window')
    expect(windowMoveRefusal(s, 'nope', main, NEW_WINDOW)).toBe('no-tab')
    // The page of a favourite is a tab no row shows: its tile stands for it.
    const favorite = run(s, { type: 'favorite/add', url: 'https://fav.fr/', title: 'Fav' })
    const opened = run(favorite, { type: 'favorite/open', id: favorite.favorites[0]!.id })
    const page = opened.tabs.find((t) => t.favoriteId !== undefined)!
    expect(windowMoveRefusal(opened, page.id, main, NEW_WINDOW)).toBe('no-tab')
  })

  it('lets a normal tab, a pinned one and a private tab of a normal window go to another normal window or to a new one', () => {
    const withPrivate = run(s, { type: 'tab/open', url: 'https://secret.fr/', background: true, private: true })
    const secret = withPrivate.tabs.find((t) => t.url === 'https://secret.fr/')!
    expect(secret.private).toBe(true)
    for (const tab of [id('a'), id('p2'), secret.id]) {
      expect(windowMoveRefusal(withPrivate, tab, main, { key: 'window-1', private: false }), tab).toBeNull()
      expect(windowMoveRefusal(withPrivate, tab, main, NEW_WINDOW), tab).toBeNull()
    }
  })
})

describe('the split view put back after the move', () => {
  it('is the same one in the space its panes landed in together; nothing when they stayed, split up, or there was none', () => {
    const { s, work, id } = setup()
    const before = run(s, { type: 'split/create', tabId: id('a'), withTabId: id('b') })
    const split = before.splits[0]!
    // Moved pane by pane, the split view is gone once its first pane is in another space.
    const after = run(before, { type: 'tab/move-to-space', id: id('a'), spaceId: work }, { type: 'tab/move-to-space', id: id('b'), spaceId: work })
    expect(after.splits).toEqual([])
    expect(splitToRestore(before, after, id('b'))).toEqual({ ...split, spaceId: work })
    expect(run(after, { type: 'split/restore', split: splitToRestore(before, after, id('b'))! }).splits).toEqual([{ ...split, spaceId: work }])
    expect(splitToRestore(before, before, id('a'))).toBeNull()
    expect(splitToRestore(before, run(before, { type: 'tab/move-to-space', id: id('a'), spaceId: work }), id('a'))).toBeNull()
    expect(splitToRestore(s, after, id('c'))).toBeNull()
  })
})

describe('the tabs that go', () => {
  it('are the tab alone, or every pane of its split view, in the order of the sidebar', () => {
    const { s, id } = setup()
    expect(tabsToSend(s, id('b'))).toEqual([id('b')])
    const split = run(s, { type: 'split/create', tabId: id('c'), withTabId: id('a') })
    expect(tabsToSend(split, id('c'))).toEqual([id('a'), id('c')])
    expect(tabsToSend(split, id('a'))).toEqual([id('a'), id('c')])
    expect(tabsToSend(s, 'nope')).toEqual([])
  })
})

describe('where they land', () => {
  it('a Today tab goes to the top of Today of the space the window shows', () => {
    const { s, comm, work, id, view } = setup()
    const { after } = landing(s, view(s, work), [id('b')])
    expect(names(after, work)).toEqual(['wp', 'b', 'w1', 'w2'])
    expect(names(after, comm)).toEqual(['p1', 'p2', 'p3', 'a', 'c'])
    // A window on the same space: the tab goes to the top there.
    expect(names(landing(s, view(s, comm), [id('c')]).after, comm)).toEqual(['p1', 'p2', 'p3', 'c', 'a', 'b'])
  })

  it('a Today tab goes to an empty Today, and a split view goes whole, together', () => {
    const { s, work, id, view } = setup()
    const empty = run(s, { type: 'tab/close', id: id('w1') }, { type: 'tab/close', id: id('w2') })
    expect(names(landing(empty, view(empty, work), [id('a')]).after, work)).toEqual(['wp', 'a'])
    const split = run(s, { type: 'split/create', tabId: id('a'), withTabId: id('c') })
    const { order, after } = landing(split, view(split, work), tabsToSend(split, id('a')))
    expect(order.ids).toEqual([id('a'), id('c')])
    expect(names(after, work)).toEqual(['wp', 'a', 'c', 'w1', 'w2'])
  })

  it('a pinned tab stays pinned, at its place and in its folder when the window shows its space', () => {
    const { s, comm, docs, id, view } = setup()
    for (const name of ['p1', 'p2', 'p3']) {
      const { after } = landing(s, view(s, comm), [id(name)])
      expect(names(after, comm), name).toEqual(names(s, comm))
      const tab = after.tabs.find((t) => t.id === id(name))!
      expect(tab.pinned, name).toBe(true)
      expect(tab.folderId, name).toBe(name === 'p1' ? undefined : docs)
    }
  })

  it('a pinned tab goes after the loose pinned tabs of another space, still pinned', () => {
    const { s, work, id, view } = setup()
    const { order, after } = landing(s, view(s, work), [id('p2')])
    expect(order.placement.pinned).toBe(true)
    expect(names(after, work)).toEqual(['wp', 'p2', 'w1', 'w2'])
    expect(after.tabs.find((t) => t.id === id('p2'))!.folderId).toBeUndefined()
  })

  it('is decided on the view of the window that takes them: the tab another space shows there is not counted', () => {
    const { s, work, id, view } = setup()
    expect(windowMoveTarget(view(s, work), [s.tabs.find((t) => t.id === id('a'))!])).toEqual({ kind: 'tab', id: id('w1'), edge: 'before' })
  })
})
