// Windows with tabs of their own: which tabs a window lists, how what it changed is put back among the others', and what lasts.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { activeTab, createInitialState, normalize, parseSavedState, persistableState, reduce, type Action, type Ctx } from './sidebar'
import { project, selectionOf } from './window-selection'
import { MAIN_WINDOW_KEY, giveTabs, handOverTabs, isWindowKey, onlyTabsOf, ownerOfTab, putBackOwnTabs, showsTab, splitsOfOneWindow, tabsOfEverySpace, windowsAreIndependent, withoutWindowKeys } from './window-tabs'

let counter = 0
const ctx: Ctx = { now: 1_000_000, newId: () => `id${++counter}` }

const tab = (id: string, over: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 'sp', url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 1, ...over })

/** A state holding exactly these tabs, in one space "sp". */
function stateOf(tabs: TabItem[], independent = true): SidebarState {
  counter = 0
  const base = createInitialState(ctx)
  const space = { ...base.spaces[0]!, id: 'sp' }
  return { ...base, spaces: [space], activeSpaceId: 'sp', activeTabBySpace: { sp: null }, tabs, settings: { ...base.settings, independentWindows: independent } }
}

/** What window `key` does: it sees its view, applies the action to it, and the result is put back. */
function act(shared: SidebarState, key: string, action: Action): SidebarState {
  const base = project(shared, selectionOf(shared), key)
  const next = reduce(base, action, ctx)
  return next === base ? shared : putBackOwnTabs(shared, base, next, key, action.type === 'state/restore' || action.type === 'backup/restore')
}

const ids = (tabs: readonly TabItem[]): string[] => tabs.map((t) => t.id)

describe('keys', () => {
  it('knows the keys the window manager gives', () => {
    for (const ok of ['window-1', 'window-42', 'window-999999']) expect(isWindowKey(ok), ok).toBe(true)
    for (const bad of ['main', 'window-', 'window-1000000', 'Window-1', 'window-1 ', '../window-1', '', 1, null, undefined]) expect(isWindowKey(bad), String(bad)).toBe(false)
  })

  it('gives a tab with no key to the first window, and the pinned tabs to every window', () => {
    expect(ownerOfTab(tab('a'))).toBe(MAIN_WINDOW_KEY)
    expect(ownerOfTab(tab('a', { windowKey: 'window-2' }))).toBe('window-2')
    expect(showsTab(tab('a'), 'main')).toBe(true)
    expect(showsTab(tab('a'), 'window-1')).toBe(false)
    expect(showsTab(tab('a', { windowKey: 'window-1' }), 'window-1')).toBe(true)
    expect(showsTab(tab('a', { windowKey: 'window-1' }), 'main')).toBe(false)
    expect(showsTab(tab('a', { windowKey: 'window-1', pinned: true }), 'window-2')).toBe(true)
  })
})

describe('what a window lists', () => {
  const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('p', { pinned: true }), tab('w2', { windowKey: 'window-2' }), tab('m2')])

  it('is its own tabs and the pinned ones', () => {
    expect(ids(onlyTabsOf(shared, 'main').tabs)).toEqual(['m1', 'p', 'm2'])
    expect(ids(onlyTabsOf(shared, 'window-1').tabs)).toEqual(['w1', 'p'])
    expect(ids(onlyTabsOf(shared, 'window-2').tabs)).toEqual(['p', 'w2'])
    expect(ids(onlyTabsOf(shared, 'window-9').tabs)).toEqual(['p'])
  })

  it('is the shared state itself when nothing is hidden', () => {
    const alone = stateOf([tab('m1'), tab('p', { pinned: true })])
    expect(onlyTabsOf(alone, 'main')).toBe(alone)
    expect(onlyTabsOf(alone, 'window-1').tabs).toHaveLength(1)
  })

  it('drops the split views that have a pane in another window', () => {
    const withSplits = { ...shared, splits: [{ id: 's1', spaceId: 'sp', tabIds: ['m1', 'm2'], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }, { id: 's2', spaceId: 'sp', tabIds: ['m1', 'w1'], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }] }
    expect(onlyTabsOf(withSplits, 'main').splits.map((s) => s.id)).toEqual(['s1'])
    expect(onlyTabsOf(withSplits, 'window-1').splits).toEqual([])
  })

  it('is looked at only while the setting is on (project)', () => {
    const off = { ...shared, settings: { ...shared.settings, independentWindows: false } }
    expect(windowsAreIndependent(off)).toBe(false)
    expect(project(off, selectionOf(off), 'window-1')).toBe(off)
    expect(ids(project(shared, selectionOf(shared), 'window-1').tabs)).toEqual(['w1', 'p'])
  })
})

describe('what a window changes', () => {
  it('opens a tab of its own (the first window’s carry no key), and leaves the others where they are', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('m2')])
    const inSecond = act(shared, 'window-1', { type: 'tab/open', url: 'https://new.example/' })
    expect(inSecond.tabs.map((t) => [t.url, t.windowKey])).toEqual([['https://m1.example/', undefined], ['https://w1.example/', 'window-1'], ['https://m2.example/', undefined], ['https://new.example/', 'window-1']])
    const inMain = act(inSecond, 'main', { type: 'tab/open', url: 'https://main.example/' })
    expect(inMain.tabs.at(-1)).toMatchObject({ url: 'https://main.example/' })
    expect(inMain.tabs.at(-1)).not.toHaveProperty('windowKey')
    expect(inMain.tabs.map((t) => t.url).slice(0, 4)).toEqual(['https://m1.example/', 'https://w1.example/', 'https://m2.example/', 'https://new.example/'])
  })

  it('closes, renames and updates its own tabs without touching the others’', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('m2'), tab('w2', { windowKey: 'window-1' })])
    const closed = act(shared, 'window-1', { type: 'tab/close', id: 'w1' })
    // The tabs of the other window stay where they were (m1 first, m2 third); the window's own fill the slots that are left.
    expect(ids(closed.tabs)).toEqual(['m1', 'w2', 'm2'])
    const renamed = act(closed, 'main', { type: 'tab/rename', id: 'm1', title: 'Mon nom' })
    expect(renamed.tabs.find((t) => t.id === 'w2')).toBe(shared.tabs.find((t) => t.id === 'w2'))
    expect(renamed.tabs.find((t) => t.id === 'm1')!.customTitle).toBe('Mon nom')
  })

  it('cannot reach a tab of another window: the action finds nothing', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    for (const action of [{ type: 'tab/close', id: 'w1' }, { type: 'tab/archive', id: 'w1' }, { type: 'tab/rename', id: 'w1', title: 'x' }, { type: 'tab/pin', id: 'w1' }, { type: 'tab/select', id: 'w1' }] satisfies Action[]) {
      expect(act(shared, 'main', action).tabs, action.type).toEqual(shared.tabs)
    }
  })

  it('keeps the places of the other windows’ tabs when its own are moved or closed', () => {
    const shared = stateOf([tab('w1', { windowKey: 'window-1' }), tab('m1'), tab('w2', { windowKey: 'window-1' }), tab('m2'), tab('w3', { windowKey: 'window-1' })])
    const moved = act(shared, 'window-1', { type: 'tab/move', id: 'w3', toIndex: 0, pinned: false })
    expect(ids(moved.tabs)).toEqual(['w3', 'm1', 'w1', 'm2', 'w2'])
    const closedFirst = act(shared, 'window-1', { type: 'tab/close', id: 'w1' })
    expect(ids(closedFirst.tabs)).toEqual(['w2', 'm1', 'w3', 'm2'])
  })

  it('pinning a tab shares it, and a tab unpinned in a window is that window’s', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    const pinned = act(shared, 'window-1', { type: 'tab/pin', id: 'w1' })
    expect(ids(onlyTabsOf(pinned, 'main').tabs).sort()).toEqual(['m1', 'w1'])
    const back = act(pinned, 'main', { type: 'tab/unpin', id: 'w1' })
    expect(back.tabs.find((t) => t.id === 'w1')).not.toHaveProperty('windowKey')
    expect(ids(onlyTabsOf(back, 'window-1').tabs)).toEqual([])
    const fromPinned = act(act(shared, 'main', { type: 'tab/pin', id: 'm1' }), 'window-1', { type: 'tab/unpin', id: 'm1' })
    expect(fromPinned.tabs.find((t) => t.id === 'm1')!.windowKey).toBe('window-1')
  })

  it('a split view of its own tabs is kept with the others’, and the other window’s stays whole', () => {
    const shared = stateOf([tab('m1'), tab('m2'), tab('w1', { windowKey: 'window-1' }), tab('w2', { windowKey: 'window-1' })])
    const mainSplit = act(shared, 'main', { type: 'split/create', tabId: 'm1', withTabId: 'm2' })
    const bothSplit = act(mainSplit, 'window-1', { type: 'split/create', tabId: 'w1', withTabId: 'w2' })
    expect(bothSplit.splits.map((s) => s.tabIds).sort()).toEqual([['m1', 'm2'], ['w1', 'w2']])
    const removed = act(bothSplit, 'main', { type: 'split/remove', tabId: 'm1' })
    expect(removed.splits.map((s) => s.tabIds)).toEqual([['w1', 'w2']])
  })

  it('drops the tabs of another window whose space it deleted, so that none is left in a space that is gone', () => {
    const base = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('x', { spaceId: 'other' }), tab('wx', { spaceId: 'other', windowKey: 'window-1' })])
    const shared = { ...base, spaces: [...base.spaces, { ...base.spaces[0]!, id: 'other', name: 'Autre' }], activeTabBySpace: { sp: null, other: null } }
    const deleted = act(shared, 'main', { type: 'space/delete', id: 'other' })
    expect(ids(deleted.tabs)).toEqual(['m1', 'w1'])
    expect(deleted.tabs.every((t) => deleted.spaces.some((s) => s.id === t.spaceId))).toBe(true)
  })

  it('a restore replaces every tab, the other windows’ too', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    const restored = act(shared, 'main', { type: 'state/restore', state: stateOf([tab('r1')], false) })
    expect(ids(restored.tabs)).toEqual(['r1'])
  })

  it('does not copy a tab of the same id that the window brought and another window holds', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    const base = project(shared, selectionOf(shared), 'main')
    const merged = putBackOwnTabs(shared, base, { ...base, tabs: [...base.tabs, tab('w1')] }, 'main', false)
    expect(merged.tabs.filter((t) => t.id === 'w1')).toHaveLength(1)
  })

  it('hands back the shared tabs and split views as they were when nothing about tabs changed', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    const next = act(shared, 'main', { type: 'settings/update', patch: { blockAds: true } })
    expect(next.tabs).toBe(shared.tabs)
    expect(next.splits).toBe(shared.splits)
    expect(next.settings.blockAds).toBe(true)
  })

  it('selecting a tab in a window leaves the other windows’ tabs and their order alone', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('m2')])
    const selected = act(shared, 'main', { type: 'tab/select', id: 'm2' })
    expect(selected.tabs.map((t) => t.id)).toEqual(['m1', 'w1', 'm2'])
    expect(activeTab(selected)?.id).toBe('m2')
  })
})

describe('what outlives a window', () => {
  it('hands the tabs of a window to the first one, and nothing else', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('w2', { windowKey: 'window-2' })])
    const handed = handOverTabs(shared, 'window-1')
    expect(handed.tabs.map((t) => [t.id, t.windowKey])).toEqual([['m1', undefined], ['w1', undefined], ['w2', 'window-2']])
    expect(handOverTabs(handed, 'window-1')).toBe(handed)
    expect(handOverTabs(shared, MAIN_WINDOW_KEY)).toBe(shared)
  })

  it('is not saved: the file, the exports and the copies hold no key', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    expect(withoutWindowKeys(shared).tabs.some((t) => 'windowKey' in t)).toBe(false)
    expect(JSON.stringify(persistableState(shared))).not.toContain('windowKey')
    expect(withoutWindowKeys(stateOf([tab('m1')]))).toBeDefined()
    const clean = stateOf([tab('m1')])
    expect(withoutWindowKeys(clean)).toBe(clean)
  })

  it('is not read from a file either', () => {
    const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' })])
    const loaded = parseSavedState(JSON.stringify(shared))
    expect(loaded.tabs.every((t) => t.windowKey === undefined)).toBe(true)
    // A state in memory is repaired without losing the key of a window that is open...
    expect(normalize(shared).tabs[1]!.windowKey).toBe('window-1')
    // ...but a key that no window could have given is dropped.
    const hostile = JSON.parse(JSON.stringify(shared)) as { tabs: Array<{ windowKey?: unknown }> }
    for (const bad of ['main', '../x', 3, {}, '__proto__']) {
      hostile.tabs[1]!.windowKey = bad
      expect(normalize(hostile as unknown as SidebarState).tabs[1]!.windowKey, String(bad)).toBeUndefined()
    }
  })
})

// « Gérer les espaces »: deleting a space or putting it aside takes the tabs every window has in it.
describe('the tabs of each space in every window', () => {
  it('counts, for each space the window lists, the tabs of every window', () => {
    const shared = { ...stateOf([tab('a'), tab('b', { windowKey: 'window-1' }), tab('p', { pinned: true }), tab('c', { windowKey: 'window-2' }), tab('o', { spaceId: 'other' })]) }
    const view = onlyTabsOf(shared, 'window-1')
    expect(ids(view.tabs)).toEqual(['b', 'p'])
    // The tab of a space the view does not hold is not counted.
    expect(tabsOfEverySpace(shared, view)).toEqual({ sp: 4 })
  })

  it('counts a space with no tab at all as none', () => {
    const shared = stateOf([tab('a', { windowKey: 'window-1' })])
    const view = { ...onlyTabsOf(shared, MAIN_WINDOW_KEY), spaces: [...shared.spaces, { ...shared.spaces[0]!, id: 'empty' }] }
    expect(tabsOfEverySpace(shared, view)).toEqual({ sp: 1, empty: 0 })
  })

  it('is nothing when the window lists every tab', () => {
    const shared = stateOf([tab('a'), tab('p', { pinned: true })])
    expect(tabsOfEverySpace(shared, onlyTabsOf(shared, MAIN_WINDOW_KEY))).toBeNull()
    expect(tabsOfEverySpace(shared, { ...shared, tabs: [...shared.tabs] })).toBeNull()
  })
})

describe('giving tabs to a window', () => {
  const shared = stateOf([tab('m1'), tab('w1', { windowKey: 'window-1' }), tab('w2', { windowKey: 'window-2' }), tab('p', { pinned: true })])

  it('makes the tabs the window\'s own, so that it lists them and the window they came from does not', () => {
    const given = giveTabs(shared, ['m1', 'w2'], 'window-1')
    expect(given.tabs.map((t) => [t.id, t.windowKey])).toEqual([['m1', 'window-1'], ['w1', 'window-1'], ['w2', 'window-1'], ['p', undefined]])
    expect(ids(onlyTabsOf(given, 'window-1').tabs)).toEqual(['m1', 'w1', 'w2', 'p'])
    expect(ids(onlyTabsOf(given, 'main').tabs)).toEqual(['p'])
  })

  it('gives to the first window by taking the key away, and leaves the other tabs as they are', () => {
    const given = giveTabs(shared, ['w1'], MAIN_WINDOW_KEY)
    expect(Object.hasOwn(given.tabs[1]!, 'windowKey')).toBe(false)
    expect(given.tabs[0]).toBe(shared.tabs[0])
    expect(given.tabs[2]).toBe(shared.tabs[2])
  })

  it('is the same object when the tabs are the window\'s already, or do not exist', () => {
    expect(giveTabs(shared, ['w1'], 'window-1')).toBe(shared)
    expect(giveTabs(shared, ['m1'], MAIN_WINDOW_KEY)).toBe(shared)
    expect(giveTabs(shared, ['nope'], 'window-1')).toBe(shared)
  })
})

describe('a pinned tab and the split views of two windows', () => {
  it('is in one split view at most: the one a window has just made stands, the hidden one that shares the pinned tab is not put back', () => {
    // The first window pairs the pinned tab with one of its own; the second window lists the pinned tab but not that split view.
    const tabs = [tab('p', { pinned: true, anchorUrl: 'https://p.example/' }), tab('m1'), tab('w1', { windowKey: 'window-1' })]
    const shared: SidebarState = { ...stateOf(tabs), splits: [{ id: 'first', spaceId: 'sp', tabIds: ['m1', 'p'], orientation: 'horizontal', ratios: [0.5, 0.5] }] }
    expect(onlyTabsOf(shared, 'window-1').splits).toEqual([])
    const both = act(shared, 'window-1', { type: 'split/create', tabId: 'w1', withTabId: 'p' })
    const withPinned = both.splits.filter((split) => split.tabIds.includes('p'))
    expect(withPinned).toHaveLength(1)
    expect(withPinned[0]!.tabIds).toContain('w1')
    // No tab was lost for it.
    expect(ids(both.tabs).sort()).toEqual(['m1', 'p', 'w1'])
  })

  it('still puts back a hidden split view that shares no pane with the window’s own', () => {
    const shared = act(stateOf([tab('m1'), tab('m2'), tab('w1', { windowKey: 'window-1' }), tab('w2', { windowKey: 'window-1' })]), 'main', { type: 'split/create', tabId: 'm1', withTabId: 'm2' })
    const both = act(shared, 'window-1', { type: 'split/create', tabId: 'w1', withTabId: 'w2' })
    expect(both.splits).toHaveLength(2)
  })
})

// A window draws a split view only when it lists every pane: one with panes in two windows would be drawn by none, its tabs tied to it out of sight.
describe('a split view and the panes of two windows', () => {
  const split = (id: string, tabIds: string[]) => ({ id, spaceId: 'sp', tabIds, orientation: 'horizontal' as const, ratios: tabIds.map(() => 1 / tabIds.length) })

  it('is undone when one of its two panes is dragged to another window: each window lists its pane alone', () => {
    const shared: SidebarState = { ...stateOf([tab('m1'), tab('m2')]), splits: [split('s', ['m1', 'm2'])] }
    const given = giveTabs(shared, ['m1'], 'window-1')
    expect(given.splits).toEqual([])
    expect(ids(onlyTabsOf(given, 'window-1').tabs)).toEqual(['m1'])
    expect(ids(onlyTabsOf(given, MAIN_WINDOW_KEY).tabs)).toEqual(['m2'])
  })

  it('stays with the window that keeps most of its panes, without the pane that left', () => {
    const shared: SidebarState = { ...stateOf([tab('m1'), tab('m2'), tab('m3')]), splits: [split('s', ['m1', 'm2', 'm3'])] }
    const given = giveTabs(shared, ['m1'], 'window-1')
    expect(given.splits.map((s) => s.tabIds)).toEqual([['m2', 'm3']])
    expect(onlyTabsOf(given, MAIN_WINDOW_KEY).splits.map((s) => s.tabIds)).toEqual([['m2', 'm3']])
  })

  it('is undone when a window unpins its pinned pane, which that window did not see in a split view', () => {
    const shared: SidebarState = { ...stateOf([tab('p', { pinned: true, anchorUrl: 'https://p.example/' }), tab('m1')]), splits: [split('s', ['p', 'm1'])] }
    expect(onlyTabsOf(shared, 'window-1').splits).toEqual([])
    const unpinned = act(shared, 'window-1', { type: 'tab/unpin', id: 'p' })
    expect(unpinned.tabs.find((t) => t.id === 'p')!.windowKey).toBe('window-1')
    expect(unpinned.splits).toEqual([])
  })

  it('keeps a pinned pane with the panes of one window: that split view is drawn by its window', () => {
    const shared: SidebarState = { ...stateOf([tab('p', { pinned: true }), tab('w1', { windowKey: 'window-1' }), tab('m1')]), splits: [split('s', ['p', 'w1'])] }
    expect(splitsOfOneWindow(shared)).toBe(shared)
    expect(onlyTabsOf(shared, 'window-1').splits.map((s) => s.tabIds)).toEqual([['p', 'w1']])
  })

  it('goes, on a tie, to the window of its first pane that is not pinned', () => {
    const shared: SidebarState = { ...stateOf([tab('p', { pinned: true }), tab('w1', { windowKey: 'window-1' }), tab('m1'), tab('w2', { windowKey: 'window-1' }), tab('m2')]), splits: [split('s', ['p', 'w1', 'm1', 'w2', 'm2'])] }
    expect(splitsOfOneWindow(shared).splits.map((s) => s.tabIds)).toEqual([['p', 'w1', 'w2']])
  })
})
