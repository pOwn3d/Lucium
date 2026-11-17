// The origin of a tab opened from a link: Back on its first page closes it and returns there.
// These are the rules of the reducer and of the loading of a file; the browser's use of them is checked by the engine test (smoke-navigation.ts).

import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { backClosesTab, createInitialState, normalize, originOf, parseSavedState, pruneOrigins, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(now = 1_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}
const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Tab A on screen, then B opened from A (in the foreground unless `background`). */
function withOpened(background = false) {
  const ctx = makeCtx()
  const start = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' })
  const a = start.tabs[0]!
  const state = run(ctx, start, { type: 'tab/open', url: 'https://b.example/', openerId: a.id, background })
  return { ctx, a, b: state.tabs[1]!, state }
}

describe('the origin of an opened tab', () => {
  it('is kept when the tab is opened from another tab, in the foreground or the background', () => {
    for (const background of [false, true]) {
      const { a, b } = withOpened(background)
      expect(b.openerId, `background ${background}`).toBe(a.id)
    }
  })

  it('is not kept for an opener that is not a tab, and a tab opened with no opener has none', () => {
    const ctx = makeCtx()
    const state = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, { type: 'tab/open', url: 'https://b.example/', openerId: 'nothing' })
    expect(state.tabs.every((t) => t.openerId === undefined)).toBe(true)
  })

  it('is forgotten by tab/forget-origin, and nothing happens for a tab that has none', () => {
    const { ctx, a, b, state } = withOpened()
    const forgotten = reduce(state, { type: 'tab/forget-origin', id: b.id }, ctx)
    expect(forgotten.tabs.find((t) => t.id === b.id)).not.toHaveProperty('openerId')
    expect(originOf(forgotten, b.id)).toBeUndefined()
    expect(reduce(forgotten, { type: 'tab/forget-origin', id: b.id }, ctx)).toBe(forgotten)
    expect(reduce(state, { type: 'tab/forget-origin', id: a.id }, ctx)).toBe(state)
  })

  it('goes with the tab it names: closing or archiving the origin leaves the other tab an ordinary one', () => {
    const { ctx, a, b, state } = withOpened()
    for (const gone of [{ type: 'tab/close', id: a.id }, { type: 'tab/archive', id: a.id }] as Action[]) {
      const kept = run(ctx, state, gone).tabs.find((t) => t.id === b.id)
      expect(kept, gone.type).toBeDefined()
      expect(kept, gone.type).not.toHaveProperty('openerId')
    }
  })

  it('goes too when the origin is cleared from Today with the tab it opened: nothing is left to point at it', () => {
    const { ctx, b, state } = withOpened()
    // B is on screen and stays; A, its origin, goes to the archive: B is left with nothing to point at, rather than with no tab at all.
    const after = run(ctx, state, { type: 'today/clear' })
    expect(after.tabs.map((t) => t.id)).toEqual([b.id])
    expect(after.tabs[0]).not.toHaveProperty('openerId')
  })

  it('does not survive a pin: a pinned tab is a place of its own', () => {
    const { ctx, b, state } = withOpened()
    const pinned = reduce(state, { type: 'tab/pin', id: b.id }, ctx)
    expect(pinned.tabs.find((t) => t.id === b.id)).not.toHaveProperty('openerId')
  })

  it('is not copied by a duplicate', () => {
    const { ctx, b, state } = withOpened()
    const copy = reduce(state, { type: 'tab/duplicate', id: b.id }, ctx).tabs.at(-1)!
    expect(copy.id).not.toBe(b.id)
    expect(copy).not.toHaveProperty('openerId')
  })
})

describe('when Back closes a tab', () => {
  it('only with the setting on, an origin that exists, and a page with nothing behind it', () => {
    const { a, b, state } = withOpened()
    expect(backClosesTab(state, b.id, undefined)).toBe(true)
    expect(backClosesTab(state, b.id, false)).toBe(true)
    // Something behind the page: Back goes back, whatever the tab remembers.
    expect(backClosesTab(state, b.id, true)).toBe(false)
    // No origin: an ordinary tab.
    expect(backClosesTab(state, a.id, false)).toBe(false)
    expect(backClosesTab(state, 'nothing', false)).toBe(false)
    // The setting off.
    const off = { ...state, settings: { ...state.settings, backClosesOpenedTab: false } }
    expect(backClosesTab(off, b.id, false)).toBe(false)
  })
})

describe('tab/back-to-origin', () => {
  it('archives the tab and shows the tab it came from', () => {
    const { ctx, a, b, state } = withOpened()
    expect(state.activeTabBySpace[state.activeSpaceId]).toBe(b.id)
    const after = reduce(state, { type: 'tab/back-to-origin', id: b.id }, ctx)
    expect(after.tabs.map((t) => t.id)).toEqual([a.id])
    expect(after.activeTabBySpace[after.activeSpaceId]).toBe(a.id)
    expect(after.archive[0]).toMatchObject({ url: 'https://b.example/', source: 'manual' })
  })

  it('returns to the origin even when the tab was opened in the background and the origin is not the neighbour', () => {
    const ctx = makeCtx()
    let state = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, { type: 'tab/open', url: 'https://c.example/' })
    const [a, c] = state.tabs
    state = run(ctx, state, { type: 'tab/select', id: a!.id }, { type: 'tab/open', url: 'https://b.example/', openerId: a!.id, background: true })
    const b = state.tabs.at(-1)!
    state = run(ctx, state, { type: 'tab/select', id: b.id }, { type: 'tab/back-to-origin', id: b.id })
    expect(state.tabs.map((t) => t.id)).toEqual([a!.id, c!.id])
    expect(state.activeTabBySpace[state.activeSpaceId]).toBe(a!.id)
  })

  it('does nothing for a tab that has no origin: a tab never closes by Back on its own', () => {
    const { ctx, a, state } = withOpened()
    expect(reduce(state, { type: 'tab/back-to-origin', id: a.id }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tab/back-to-origin', id: 'nothing' }, ctx)).toBe(state)
  })

  it('does nothing once the tab has forgotten its origin', () => {
    const { ctx, b, state } = withOpened()
    const navigated = reduce(state, { type: 'tab/forget-origin', id: b.id }, ctx)
    expect(reduce(navigated, { type: 'tab/back-to-origin', id: b.id }, ctx)).toBe(navigated)
  })
})

describe('an origin in a saved file', () => {
  const file = (tabs: unknown[]) => JSON.stringify({ ...createInitialState(makeCtx()), tabs, spaces: [{ id: 's', name: 'S', emoji: '🏠' }] })
  const tab = (id: string, extra: Record<string, unknown> = {}) => ({ id, spaceId: 's', url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 1, ...extra })

  it('is kept when it names another tab of the file', () => {
    const state = parseSavedState(file([tab('a'), tab('b', { openerId: 'a' })]))
    expect(state.tabs.find((t) => t.id === 'b')?.openerId).toBe('a')
  })

  it('is dropped when it names nothing, the tab itself, a pinned tab or a non-text value', () => {
    for (const openerId of ['ghost', 'b', 42, null, {}, '', '__proto__', 'x'.repeat(5000)]) {
      const state = parseSavedState(file([tab('a'), tab('b', { openerId })]))
      expect(state.tabs.find((t) => t.id === 'b'), String(openerId)).not.toHaveProperty('openerId')
    }
    const pinned = parseSavedState(file([tab('a'), tab('b', { openerId: 'a', pinned: true })]))
    expect(pinned.tabs.find((t) => t.id === 'b')).not.toHaveProperty('openerId')
  })

  it('is repaired by normalize and pruneOrigins when the state itself is inconsistent', () => {
    const { state, b } = withOpened()
    const dangling = { ...state, tabs: state.tabs.filter((t) => t.id !== state.tabs[0]!.id) }
    expect(pruneOrigins(dangling).tabs[0]).not.toHaveProperty('openerId')
    expect(normalize(dangling).tabs.find((t) => t.id === b.id)).not.toHaveProperty('openerId')
    // A tab that names itself has no origin (a file can say it).
    const selfish = { ...state, tabs: state.tabs.map((t) => (t.id === b.id ? { ...t, openerId: b.id } : t)) }
    expect(pruneOrigins(selfish).tabs.find((t) => t.id === b.id)).not.toHaveProperty('openerId')
    // Same object when there is nothing to repair.
    expect(pruneOrigins(state)).toBe(state)
  })
})
