// The keyboard and the menu reorder a tab one place up or down its group, as the drag does. The drag dispatches `tab/move` with the place it
// drops on; this turns "one place up" or "one place down" into the same action, so that the menu and the drag share one reducer path.

import { isListedTab, type SidebarState, type TabItem } from './model'

/** The fields of the `tab/move` action that put the tab one place away from where it is. */
export interface TabStep {
  toIndex: number
  pinned: boolean
  folderId?: string
  parentId?: string
}

/** The tabs that hang, in the tree, under the given one (at any depth). */
function descendantsOf(tabs: readonly TabItem[], id: string): Set<string> {
  const found = new Set<string>()
  let frontier = [id]
  while (frontier.length > 0) {
    const next = tabs.filter((t) => t.parentId !== undefined && frontier.includes(t.parentId) && !found.has(t.id)).map((t) => t.id)
    for (const child of next) found.add(child)
    frontier = next
  }
  return found
}

/**
 * The `tab/move` that puts the tab one place up (-1) or down (1) in its group: its space, its pinned or its Today tabs, the ones the sidebar lists.
 * With the tree on, the tabs of its branch go with it, so they are not places of the group. Null when it is already at that end, or is not a listed tab.
 */
export function tabStep(state: Pick<SidebarState, 'tabs' | 'settings'>, id: string, direction: -1 | 1): TabStep | null {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || !isListedTab(tab)) return null
  const pinned = tab.pinned === true
  const branch = state.settings.tabTree === true ? descendantsOf(state.tabs, tab.id) : new Set<string>()
  // The group as the sidebar draws it, the branch of the tab left out: `at` is how many places come before the tab in it.
  const group = state.tabs.filter((t) => t.spaceId === tab.spaceId && (t.pinned === true) === pinned && isListedTab(t) && (t.id === tab.id || !branch.has(t.id)))
  const at = group.indexOf(tab)
  // The reducer puts the tab in front of the place at `toIndex` among the other places of the group (the group without the tab).
  // A child does not go above the tab it hangs under: the place just above it is its parent then, and there is no step.
  if (direction === -1) return at === 0 || (tab.parentId !== undefined && group[at - 1]?.id === tab.parentId) ? null : withParent({ toIndex: at - 1, pinned }, tab)
  return at === group.length - 1 ? null : withParent({ toIndex: at + 1, pinned }, tab)
}

/** A pinned tab keeps its folder and a tab of the tree its parent: the move keeps both. */
function withParent(step: Pick<TabStep, 'toIndex' | 'pinned'>, tab: TabItem): TabStep {
  return {
    ...step,
    ...(tab.pinned === true && tab.folderId !== undefined ? { folderId: tab.folderId } : {}),
    ...(tab.parentId !== undefined ? { parentId: tab.parentId } : {})
  }
}
