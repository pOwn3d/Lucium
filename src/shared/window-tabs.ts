// Windows with tabs of their own (setting `independentWindows`). By default every normal window shows the same tabs (window-selection.ts:
// each has its own current space and selected tab). With this on, a tab opened in a window after the first belongs to that window: the
// others do not list it, and closing the window hands its tabs to the first one. The pinned tabs stay shared, as the spaces and everything
// else are. Pure rules: a window's view of the shared state, and how what it changed is put back. Nothing here runs while the setting is off.

import type { SidebarState, SplitView, TabItem } from './model'
import { keepPanes } from './split-grid'

/** The first window's key. A tab with no key belongs to it: what existed before the setting, and what the first window opens. */
export const MAIN_WINDOW_KEY = 'main'

const WINDOW_KEY = /^window-\d{1,6}$/
/** The key of a window opened after the first one (`window-1`…), as the window manager names it. */
export const isWindowKey = (value: unknown): value is string => typeof value === 'string' && WINDOW_KEY.test(value)

/** The window a tab belongs to. */
export const ownerOfTab = (tab: Pick<TabItem, 'windowKey'>): string => tab.windowKey ?? MAIN_WINDOW_KEY

/** Whether a window lists a tab: the pinned tabs are everybody's, the others belong to one window. */
export const showsTab = (tab: Pick<TabItem, 'pinned' | 'windowKey'>, key: string): boolean => tab.pinned || ownerOfTab(tab) === key

/** Whether the shared state asks for windows with tabs of their own. */
export const windowsAreIndependent = (state: Pick<SidebarState, 'settings'>): boolean => state.settings.independentWindows === true

/**
 * The state as the window `key` lists it: its own tabs and the pinned ones, and the split views whose panes are all among them. Same object
 * when nothing is hidden from it.
 */
export function onlyTabsOf(shared: SidebarState, key: string): SidebarState {
  if (shared.tabs.every((tab) => showsTab(tab, key))) return shared
  const tabs = shared.tabs.filter((tab) => showsTab(tab, key))
  const ids = new Set(tabs.map((tab) => tab.id))
  return { ...shared, tabs, splits: shared.splits.filter((split) => split.tabIds.every((id) => ids.has(id))) }
}

/** Actions that replace every tab of the state: what the other windows listed goes with them. */
export const REPLACING_ACTIONS: ReadonlySet<string> = new Set(['state/restore', 'backup/restore'])

/**
 * Actions about every tab of the state, not only the window's: they are reduced on every tab, not on the window's view.
 *  - `space/aside` takes a whole space away and keeps what it held (in a session): on the view, the tabs the other windows have in that space
 *    would be closed without being kept;
 *  - `sync/apply` adds and removes the pinned tabs the other device synchronised, in every window;
 *  - `container/delete` closes every tab of the container: on the view, the other windows' tabs would stay, naming a container that is gone,
 *    and load their page in the session of the profile, with its cookies;
 *  - `import/merge` adds only what the state does not hold yet: on the view, a tab of another window would be taken for a new one, and the
 *    copy of the file would replace it.
 */
export const EVERY_TAB_ACTIONS: ReadonlySet<string> = new Set(['space/aside', 'container/delete', 'import/merge', 'sync/apply'])

/** The window's view with every tab and split view of the shared state: what an `EVERY_TAB_ACTIONS` action is reduced on. The selection stays the window's. */
export const withEveryTab = (view: SidebarState, shared: SidebarState): SidebarState => (view.tabs === shared.tabs && view.splits === shared.splits ? view : { ...view, tabs: shared.tabs, splits: shared.splits })

/** The tab made the property of the window `key` (the first window's tabs carry no key). */
function ownedBy(tab: TabItem, key: string): TabItem {
  if (key === MAIN_WINDOW_KEY) {
    const { windowKey: _gone, ...rest } = tab
    return rest
  }
  return tab.windowKey === key ? tab : { ...tab, windowKey: key }
}

/** The shared tabs with the window's own put in the slots it had, the hidden ones where they were, and the new ones last. */
function interleave(sharedTabs: readonly TabItem[], hidden: ReadonlySet<string>, mine: readonly TabItem[], key: string): TabItem[] {
  const queue = [...mine]
  const out: TabItem[] = []
  for (const tab of sharedTabs) {
    if (hidden.has(tab.id)) out.push(tab)
    else if (showsTab(tab, key) && queue.length > 0) out.push(queue.shift()!)
  }
  return [...out, ...queue]
}

/**
 * The shared state once the window `key`, which saw `base` (its view of `shared`), has reached `next`. The tabs and split views the window did not
 * see are put back as they were, where they were; the tabs it opened, and the pinned ones it unpinned, are its own. The rest of `next` is the shared
 * state's new value. A tab the window cannot see is dropped when its space is gone, when the window brought a tab of the same id, and when
 * `replacing` is set (a restore replaced every tab).
 */
export function putBackOwnTabs(shared: SidebarState, base: SidebarState, next: SidebarState, key: string, replacing: boolean): SidebarState {
  // Nothing about tabs, spaces or split views changed: the shared ones stand (the usual case: a selection, a setting).
  if (!replacing && next.tabs === base.tabs && next.splits === base.splits && next.spaces === base.spaces) return { ...next, tabs: shared.tabs, splits: shared.splits }

  const before = new Map(base.tabs.map((tab) => [tab.id, tab]))
  const mine = next.tabs.map((tab) => {
    const was = before.get(tab.id)
    // A tab the window made, or took out of the pinned list, is its own.
    return was === undefined ? ownedBy(tab, key) : was.pinned && !tab.pinned ? ownedBy(tab, key) : tab
  })
  // Nothing stamped: the reducer's own array stands.
  const own = mine.some((tab, i) => tab !== next.tabs[i]) ? mine : next.tabs
  const mineIds = new Set(own.map((tab) => tab.id))
  const spaceIds = new Set(next.spaces.map((space) => space.id))
  const hidden = replacing ? [] : shared.tabs.filter((tab) => !showsTab(tab, key) && spaceIds.has(tab.spaceId) && !mineIds.has(tab.id))
  const hiddenIds = new Set(hidden.map((tab) => tab.id))
  const tabs = hidden.length === 0 ? own : interleave(shared.tabs, hiddenIds, own, key)

  // The split views the window could not see, as long as all their panes are still there.
  const seen = new Set(base.splits.map((split) => split.id))
  const present = new Set(tabs.map((tab) => tab.id))
  // A pinned tab is listed by every window: one of them may have put it in a split view of its own meanwhile. A tab is in one split view at most, so
  // the one the window has just made stands, and the hidden one that shares a pane with it is not put back.
  const paned = new Set(next.splits.flatMap((split) => split.tabIds))
  const held = replacing ? [] : shared.splits.filter((split) => !seen.has(split.id) && split.tabIds.every((id) => present.has(id)) && !split.tabIds.some((id) => paned.has(id)))
  return splitsOfOneWindow({ ...next, tabs, splits: held.length === 0 ? next.splits : [...next.splits, ...held] })
}

/**
 * The state with every split view in one window. A window draws a split view only when it lists all its panes: one whose panes belong to two windows (a
 * pane dragged to another window, a pinned pane unpinned in a window that did not see the split view) is drawn by none, and its tabs stay tied to it out
 * of sight. It keeps the panes of the window that holds most of them (on a tie, the window of the first of them), with its pinned panes; with fewer than
 * two left, it is undone. Same object when every split view is in one window.
 */
export function splitsOfOneWindow(state: SidebarState): SidebarState {
  if (state.splits.length === 0) return state
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]))
  let changed = false
  const splits: SplitView[] = []
  for (const split of state.splits) {
    // The windows of the panes that are not pinned, in the order of the panes, with how many each holds.
    const owners = new Map<string, number>()
    for (const id of split.tabIds) {
      const tab = byId.get(id)
      if (tab && !tab.pinned) owners.set(ownerOfTab(tab), (owners.get(ownerOfTab(tab)) ?? 0) + 1)
    }
    if (owners.size <= 1) {
      splits.push(split)
      continue
    }
    changed = true
    let keeper = ''
    let most = 0
    for (const [owner, count] of owners) {
      if (count > most) {
        keeper = owner
        most = count
      }
    }
    const kept = split.tabIds.filter((id) => {
      const tab = byId.get(id)
      return tab !== undefined && (tab.pinned || ownerOfTab(tab) === keeper)
    })
    if (kept.length >= 2) splits.push(keepPanes(split, kept))
  }
  return changed ? { ...state, splits } : state
}

/**
 * The shared state with the tabs `ids` made the property of the window `key`: a tab dragged from a window to another one goes with the drag, or the
 * window it lands in could not list it. Same object when they already are its own.
 */
export function giveTabs(shared: SidebarState, ids: Iterable<string>, key: string): SidebarState {
  const wanted = new Set(ids)
  const tabs = shared.tabs.map((tab) => (wanted.has(tab.id) && ownerOfTab(tab) !== key ? ownedBy(tab, key) : tab))
  // A pane that goes leaves its split view: the split view stays with the window that keeps most of its panes.
  return tabs.some((tab, i) => tab !== shared.tabs[i]) ? splitsOfOneWindow({ ...shared, tabs }) : shared
}

/** The shared state with the tabs of the window `key` handed to the first window (the window closed). Same object when it owned none. */
export function handOverTabs(shared: SidebarState, key: string): SidebarState {
  if (key === MAIN_WINDOW_KEY || !shared.tabs.some((tab) => tab.windowKey === key)) return shared
  return { ...shared, tabs: shared.tabs.map((tab) => (tab.windowKey === key ? ownedBy(tab, MAIN_WINDOW_KEY) : tab)) }
}

/**
 * The number of tabs each space of the window's view holds in every window, when the view lists only some of the shared tabs (windows of their own):
 * what « Gérer les espaces » counts, since deleting a space or putting it aside takes the tabs every window has in it. Null when the view lists them all.
 */
export function tabsOfEverySpace(shared: Pick<SidebarState, 'tabs'>, view: Pick<SidebarState, 'tabs' | 'spaces'>): Record<string, number> | null {
  if (view.tabs === shared.tabs || view.tabs.length === shared.tabs.length) return null
  const counts = new Map(view.spaces.map((space) => [space.id, 0]))
  for (const tab of shared.tabs) {
    const count = counts.get(tab.spaceId)
    if (count !== undefined) counts.set(tab.spaceId, count + 1)
  }
  return Object.fromEntries(counts)
}

/** The state without the keys of the windows (they last as long as the windows do): what is saved, exported or copied. Same object when there is none. */
export function withoutWindowKeys(state: SidebarState): SidebarState {
  if (!state.tabs.some((tab) => tab.windowKey !== undefined)) return state
  return { ...state, tabs: state.tabs.map(({ windowKey: _gone, ...tab }) => tab) }
}
