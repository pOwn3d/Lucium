// Where the tabs of a split view stand in the sidebar. The sidebar draws a split view as one row, at the place of one of its tabs (its anchor). The rules
// here say which tab that is when a split view is made of tabs of two lists, where the other tab goes then, and how a split view whose tabs already sit in
// two lists (a state saved before these rules) is drawn. Pure: used by the reducer (`split/create`), the sidebar (Sidebar.tsx) and ⌘1 … ⌘9 (sidebar-items.ts).

import { isListedTab, type Folder, type SidebarState, type SplitView, type TabItem } from './model'

/** The list of the sidebar a tab is a row of: the Today tabs, the loose pinned tabs, or one folder. */
export type SplitList = 'today' | 'pinned' | `folder:${string}`

/** The list a tab is a row of. A pinned tab whose folder is gone (or is another space's) is drawn with the loose pinned tabs. */
export function listOfTab(folders: readonly Pick<Folder, 'id' | 'spaceId'>[], tab: Pick<TabItem, 'pinned' | 'folderId' | 'spaceId'>): SplitList {
  if (!tab.pinned) return 'today'
  const folderId = tab.folderId
  return folderId !== undefined && folders.some((f) => f.id === folderId && f.spaceId === tab.spaceId) ? `folder:${folderId}` : 'pinned'
}

/** Which list the anchor is taken from first: a folder, then the loose pinned tabs, then Today. */
const weightOf = (list: SplitList): number => (list === 'today' ? 0 : list === 'pinned' ? 1 : 2)

/**
 * The tab whose place the split view of `tabId` and `withTabId` takes in the sidebar, or null when no tab has to move: both are in the same list, a tab is
 * missing or is the page of a favourite (its tile stands for it: it is no row, and a favourite stays one). A tab already in a split view is the anchor (the
 * split view keeps its place and the new pane joins it); otherwise the tab in a folder, else the pinned one, else `withTabId`. So the tab that moves is never
 * unpinned: it would lose its anchor address.
 */
export function splitAnchor(state: Pick<SidebarState, 'tabs' | 'folders' | 'splits'>, tabId: string, withTabId: string): TabItem | null {
  const tab = state.tabs.find((t) => t.id === tabId)
  const withTab = state.tabs.find((t) => t.id === withTabId)
  if (!tab || !withTab || tab.id === withTab.id || tab.spaceId !== withTab.spaceId || !isListedTab(tab) || !isListedTab(withTab)) return null
  const tabList = listOfTab(state.folders, tab)
  const withList = listOfTab(state.folders, withTab)
  if (tabList === withList) return null
  const inSplit = (id: string) => state.splits.some((sp) => sp.tabIds.includes(id))
  if (inSplit(tab.id) !== inSplit(withTab.id)) return inSplit(tab.id) ? tab : withTab
  return weightOf(tabList) > weightOf(withList) ? tab : withTab
}

/** Where the tab that joins a split view goes: the arguments of `tab/move` (the tab, its place in the pinned or Today tabs of its space, its folder). */
export interface SplitJoin {
  id: string
  toIndex: number
  pinned: boolean
  folderId?: string
}

/**
 * Where the other tab goes when the split view of `tabId` and `withTabId` is made: into the list of the anchor (`splitAnchor`), right after it, so that the
 * row of the split view is drawn at the anchor's place. Null when nothing moves: the same list, a favourite, a pinned tab that the anchor would unpin (a pane
 * added to a split view of Today tabs), or a private tab that the anchor would pin (a private tab is never saved).
 */
export function splitJoin(state: Pick<SidebarState, 'tabs' | 'folders' | 'splits'>, tabId: string, withTabId: string): SplitJoin | null {
  const anchor = splitAnchor(state, tabId, withTabId)
  if (!anchor) return null
  const joiner = state.tabs.find((t) => t.id === (anchor.id === tabId ? withTabId : tabId))!
  if ((joiner.pinned && !anchor.pinned) || (anchor.pinned && joiner.private === true)) return null
  // The places are counted as `tab/move` counts them: among the listed tabs of the anchor's group (pinned or Today) of the space, without the tab that moves.
  const group = state.tabs.filter((t) => t.spaceId === anchor.spaceId && t.pinned === anchor.pinned && isListedTab(t) && t.id !== joiner.id)
  const list = listOfTab(state.folders, anchor)
  return { id: joiner.id, toIndex: group.indexOf(anchor) + 1, pinned: anchor.pinned, ...(list.startsWith('folder:') ? { folderId: anchor.folderId! } : {}) }
}

/** A list of rows as the sidebar draws it: the loose pinned tabs, the tabs of one folder, the Today tabs (or one group of them). */
export interface DrawnList<T> {
  tabs: readonly T[]
  /** The list is a folder's. */
  folder: boolean
}

/** How the sidebar draws the tabs of split views. */
export interface SplitRows<T> {
  /** By anchor (the tab whose place the row takes): the split view and the tabs the row shows, in its order. */
  rows: Map<string, { id: string; tabs: T[] }>
  /** The other tabs of the split views: the row of their split view stands for them, they have none of their own. */
  covered: Set<string>
}

/**
 * The rows of the split views, given the lists the sidebar draws, top to bottom. A split view is one row wherever its tabs are: at the place of its first tab
 * in a folder, else of its first tab, and its other tabs have no row of their own. A split view whose tabs share one list is drawn as it always was, at the
 * place of the first of them. Only the tabs in `lists` are counted (the page of a favourite and a tab under a folded branch are not drawn).
 */
export function splitRows<T extends { id: string }>(lists: readonly DrawnList<T>[], splits: readonly Pick<SplitView, 'id' | 'tabIds'>[]): SplitRows<T> {
  const drawn = new Map<string, { tab: T; folder: boolean; at: number }>()
  let at = 0
  for (const list of lists) for (const tab of list.tabs) if (!drawn.has(tab.id)) drawn.set(tab.id, { tab, folder: list.folder, at: at++ })
  const rows = new Map<string, { id: string; tabs: T[] }>()
  const covered = new Set<string>()
  for (const split of splits) {
    const members = split.tabIds.flatMap((id) => drawn.get(id) ?? [])
    const byPlace = [...members].sort((x, y) => x.at - y.at)
    const anchor = byPlace.find((m) => m.folder) ?? byPlace[0]
    if (!anchor) continue
    rows.set(anchor.tab.id, { id: split.id, tabs: members.map((m) => m.tab) })
    for (const m of members) if (m !== anchor) covered.add(m.tab.id)
  }
  return { rows, covered }
}
