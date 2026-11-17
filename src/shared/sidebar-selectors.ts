// What the sidebar state says without changing it: the order of the rows, the tab or space one step away, the split view of a tab, the tab
// Back returns to. Pure; re-exported by `@shared/sidebar`.

import { type SplitView, type SidebarState, type TabItem, isListedTab } from './model'
import { SPLIT_MAX_PANES } from './split'
import { foldedAway } from './tab-tree'
import { folderRows } from './folders'

/** The tabs a session is saved from, in the sidebar's order: the whole current space, or only `tabIds` (a multiple selection, which sits in one space). */
export function sessionSourceTabs(state: SidebarState, tabIds?: readonly string[]): TabItem[] {
  return sessionSourceTabsAll(state, tabIds).filter((t) => t.private !== true)
}

function sessionSourceTabsAll(state: SidebarState, tabIds?: readonly string[]): TabItem[] {
  if (tabIds === undefined) return sidebarOrder(state, state.activeSpaceId)
  // The renderer is not trusted: ids that are not a list name nothing.
  if (!Array.isArray(tabIds)) return []
  const wanted = new Set(tabIds.filter((id): id is string => typeof id === 'string'))
  const first = state.tabs.find((t) => wanted.has(t.id))
  return first ? sidebarOrder(state, first.spaceId).filter((t) => wanted.has(t.id)) : []
}

/**
 * Tabs of a space in the order the sidebar lists them: loose pinned tabs, then each folder's (the ones above the Today header, then the ones at the start of
 * Today), then Today, then the folders put under it (`atBottom`).
 */
export function sidebarOrder(state: Pick<SidebarState, 'tabs' | 'folders'>, spaceId: string): TabItem[] {
  // The rows of the list: the page of a favourite is not one, so neither a shortcut that counts rows nor a ⇧-click that ranges over them reaches it.
  const tabs = state.tabs.filter((t) => t.spaceId === spaceId && isListedTab(t))
  const top = folderRows(state.folders, spaceId, 'top')
  const start = folderRows(state.folders, spaceId, 'today-start')
  const bottom = folderRows(state.folders, spaceId, 'bottom')
  const pinned = tabs.filter((t) => t.pinned)
  const inRows = (rows: typeof top) => rows.flatMap((r) => pinned.filter((t) => t.folderId === r.folder.id))
  const inFolders = new Set([...top, ...start, ...bottom].map((r) => r.folder.id))
  return [
    ...pinned.filter((t) => !t.folderId || !inFolders.has(t.folderId)),
    ...inRows(top),
    ...inRows(start),
    ...tabs.filter((t) => !t.pinned),
    ...inRows(bottom)
  ]
}

/** `sidebarOrder` without the tabs hidden in a collapsed folder (or a folded branch): the rows the user can actually click (⇧-click selects a range of them). */
export function visibleTabOrder(state: SidebarState, spaceId: string): TabItem[] {
  const hidden = new Set(folderRows(state.folders, spaceId).filter((r) => r.hidden || r.folder.collapsed).map((r) => r.folder.id))
  // A folded branch of the tab tree hides its tabs too.
  const folded = state.settings.tabTree ? foldedAway(state.tabs) : null
  return sidebarOrder(state, spaceId).filter((t) => (!t.folderId || !hidden.has(t.folderId)) && !folded?.has(t.id))
}

/** The tab one step down (1) or up (-1) the sidebar from the selected one, wrapping around; null when there is nothing to move to. */
export function stepTab(state: SidebarState, direction: 1 | -1): string | null {
  const order = sidebarOrder(state, state.activeSpaceId)
  if (order.length === 0) return null
  const at = order.findIndex((t) => t.id === state.activeTabBySpace[state.activeSpaceId])
  // With nothing selected, "next" is the first tab and "previous" the last one.
  const target = at === -1 ? (direction === 1 ? 0 : order.length - 1) : (at + direction + order.length) % order.length
  return order[target]!.id
}

/** The space after (1) or before (-1) the current one, wrapping around; null with a single space. */
export function stepSpace(state: SidebarState, direction: 1 | -1): string | null {
  if (state.spaces.length < 2) return null
  const at = state.spaces.findIndex((sp) => sp.id === state.activeSpaceId)
  return state.spaces[(at + direction + state.spaces.length) % state.spaces.length]!.id
}

export function splitFor(state: SidebarState, tabId: string): SplitView | undefined {
  return state.splits.find((sp) => sp.tabIds.includes(tabId))
}

/** Whether the tab on screen is in a split view that already has the most panes there can be: it takes no more. */
export function splitIsFull(state: SidebarState): boolean {
  const tab = activeTab(state)
  return tab !== undefined && (splitFor(state, tab.id)?.tabIds.length ?? 0) >= SPLIT_MAX_PANES
}

/** The tab Back would return to from `tabId` (it has an origin that still exists), or undefined. */
export function originOf(state: SidebarState, tabId: string): TabItem | undefined {
  const opener = state.tabs.find((t) => t.id === tabId)?.openerId
  return opener === undefined ? undefined : state.tabs.find((t) => t.id === opener)
}

/**
 * Whether Back would close this tab and return to its origin: the setting is on, the tab still has an origin and its page has nothing behind
 * it. A tab that was navigated has forgotten its origin, but the page's own history is asked as well, so a tab never closes while it could
 * still go back. `pageCanGoBack` is what the page says (undefined: it has not said yet, which is a page with nothing behind it).
 */
export function backClosesTab(state: SidebarState, tabId: string, pageCanGoBack: boolean | undefined): boolean {
  return state.settings.backClosesOpenedTab && originOf(state, tabId) !== undefined && pageCanGoBack !== true
}

/**
 * `backClosesTab` for many tabs of one state: the tabs are put in a map once, rather than searched again for each tab and for its origin. The window
 * asks it for every tab at each snapshot it sends; searching each time took milliseconds with a few thousand tabs, as soon as one tab had an origin.
 */
export function backClosesLookup(state: SidebarState): (tabId: string, pageCanGoBack: boolean | undefined) => boolean {
  if (!state.settings.backClosesOpenedTab) return () => false
  // The first tab of each id, as `find` gives it.
  const byId = new Map<string, TabItem>()
  for (const tab of state.tabs) if (!byId.has(tab.id)) byId.set(tab.id, tab)
  return (tabId, pageCanGoBack) => {
    const opener = byId.get(tabId)?.openerId
    return opener !== undefined && byId.has(opener) && pageCanGoBack !== true
  }
}

/**
 * The tab an action just opened: the one of `after` that `before` did not have. Undefined when the state refused the opening (an address a tab
 * cannot hold, a private tab while the setting is off, a container that is gone…): the last tab of the state is then a tab that was already there,
 * and whoever asked must do nothing with it.
 */
export function tabOpenedSince(before: SidebarState, after: SidebarState): TabItem | undefined {
  if (after.tabs === before.tabs) return undefined
  const known = new Set(before.tabs.map((t) => t.id))
  return after.tabs.find((t) => !known.has(t.id))
}

export function activeTab(state: SidebarState): TabItem | undefined {
  const id = state.activeTabBySpace[state.activeSpaceId]
  return id ? state.tabs.find((t) => t.id === id) : undefined
}

/** Tab to focus after `closed` disappears: next Today tab, else previous, else most recent other tab. */
export function pickNeighbor(state: SidebarState, closed: TabItem): string | null {
  const today = state.tabs.filter((t) => t.spaceId === closed.spaceId && !t.pinned && isListedTab(t))
  const idx = today.findIndex((t) => t.id === closed.id)
  const adjacent = idx === -1 ? undefined : (today[idx + 1] ?? today[idx - 1])
  if (adjacent) return adjacent.id
  const others = state.tabs
    .filter((t) => t.spaceId === closed.spaceId && t.id !== closed.id)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return others[0]?.id ?? null
}
