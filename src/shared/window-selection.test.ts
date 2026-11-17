import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Action } from './sidebar'
import { LAYOUT_SETTINGS, blankSelection, project, release, selectionOf, visibleTabIds } from './window-selection'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

// Two spaces, three tabs: a and b in the first space (b selected), c in the second.
const shared = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 }, { type: 'tab/open', url: 'https://c.fr/' })
const [first, second] = shared.spaces
const [a, b, c] = shared.tabs

describe('project', () => {
  it('is the very same object when the window sees what the shared state says (a single window changes nothing)', () => {
    expect(project(shared, selectionOf(shared))).toBe(shared)
  })

  it('gives a window its own space and selected tabs, over the same tabs', () => {
    const view = project(shared, { spaceId: first!.id, tabs: { [first!.id]: a!.id, [second!.id]: null }, layout: {} })
    expect(shared.activeSpaceId).toBe(second!.id)
    expect(view.activeSpaceId).toBe(first!.id)
    expect(view.activeTabBySpace[first!.id]).toBe(a!.id)
    expect(view.tabs).toBe(shared.tabs)
  })

  it('shows nothing selected when the selected tab was closed or the space deleted by another window', () => {
    const closed = run(shared, { type: 'tab/close', id: a!.id })
    expect(project(closed, { spaceId: first!.id, tabs: { [first!.id]: a!.id }, layout: {} }).activeTabBySpace[first!.id]).toBeNull()
    const deleted = run(shared, { type: 'space/delete', id: first!.id })
    expect(project(deleted, { spaceId: first!.id, tabs: {}, layout: {} }).activeSpaceId).toBe(deleted.activeSpaceId)
  })

  it('shows nothing selected in a space whose selected tab another window moved to another space', () => {
    // The tab a is still there, but in the second space now: the first space must not show a page that belongs to the other one.
    const moved = run(shared, { type: 'tab/move-to-space', id: a!.id, spaceId: second!.id })
    const view = project(moved, { spaceId: first!.id, tabs: { [first!.id]: a!.id, [second!.id]: null }, layout: {} })
    expect(view.activeTabBySpace[first!.id]).toBeNull()
    expect(view.tabs.find((t) => t.id === a!.id)?.spaceId).toBe(second!.id)
    // A selection that is in its own space is left alone.
    expect(project(moved, { spaceId: second!.id, tabs: { [second!.id]: a!.id }, layout: {} }).activeTabBySpace[second!.id]).toBe(a!.id)
  })

  it('keeps the layout of a window to itself', () => {
    const view = project(shared, { ...selectionOf(shared), layout: { sidebarVisible: false, sidebarWidth: 321 } })
    expect(view.settings.sidebarVisible).toBe(false)
    expect(view.settings.sidebarWidth).toBe(321)
    expect(shared.settings.sidebarVisible).toBe(true)
    expect(view.settings.blockAds).toBe(shared.settings.blockAds)
  })

  it('knows which settings are layout', () => {
    expect([...LAYOUT_SETTINGS].sort()).toEqual(['fullUrlInToolbar', 'showToolbar', 'sidePanelWidth', 'sidebarVisible', 'sidebarWidth'])
  })
})

describe('blankSelection', () => {
  it('shows a space with nothing selected', () => {
    const view = project(shared, blankSelection(shared, first!.id))
    expect(view.activeSpaceId).toBe(first!.id)
    expect(view.activeTabBySpace[first!.id]).toBeNull()
    expect(blankSelection(shared, 'gone').spaceId).toBe(shared.activeSpaceId)
  })

  it('shows the sidebar even when the other window hid it', () => {
    const hidden = run(shared, { type: 'settings/update', patch: { sidebarVisible: false } })
    expect(hidden.settings.sidebarVisible).toBe(false)
    expect(project(hidden, blankSelection(hidden, first!.id)).settings.sidebarVisible).toBe(true)
  })
})

describe('release', () => {
  const selection = { spaceId: first!.id, tabs: { [first!.id]: b!.id, [second!.id]: c!.id }, layout: {} }

  it('clears the tab another window takes, and only then', () => {
    const released = release(selection, shared, new Set([b!.id]))
    expect(released.tabs[first!.id]).toBeNull()
    expect(released.tabs[second!.id]).toBe(c!.id)
    expect(release(selection, shared, new Set([a!.id]))).toBe(selection)
  })

  it('treats the panes of a split view as taken together', () => {
    const split = run(shared, { type: 'split/create', tabId: b!.id, withTabId: a!.id })
    const view = { spaceId: first!.id, tabs: { [first!.id]: b!.id }, layout: {} }
    expect(visibleTabIds(project(split, view)).sort()).toEqual([a!.id, b!.id].sort())
    expect(release(view, split, new Set([a!.id])).tabs[first!.id]).toBeNull()
  })
})
