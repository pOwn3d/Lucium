// The sidebar items ⌘1 … ⌘9 go to ("Aller à l’élément n de la barre latérale").
//
// The rule: item n is the nth row the sidebar shows for the current space, from the top. The sidebar draws the loose pinned tabs, then each folder (a folder
// before the ones inside it) with its own pinned tabs, then Today (the folders put at its start come before its tabs, those put under them after). What it
// does not draw has no number: a tab inside a collapsed folder, the page of a favourite
// (the tile stands for it) and a tab under a folded branch of the tab tree. The tabs of one split view are a single row, at the place of its anchor (its first
// tab in a folder, else its first tab: split-place.ts), even when they sit in two lists.
// There is no "last item" for ⌘9: with fewer than n rows, ⌘n does nothing.

import type { SidebarState, TabItem } from './model'
import { sidebarOrder, visibleTabOrder } from './sidebar'
import { listOfTab, splitRows, type DrawnList, type SplitList } from './split-place'
import { foldedAway } from './tab-tree'

/** The lists the sidebar draws for a space, top to bottom: with the tabs of a collapsed folder (drawn, then hidden), without those of a folded branch. */
function drawnLists(state: SidebarState, spaceId: string): DrawnList<TabItem>[] {
  const folded = state.settings.tabTree ? foldedAway(state.tabs) : null
  const lists: Array<{ key: SplitList; tabs: TabItem[]; folder: boolean }> = []
  // `sidebarOrder` gives each list as one run of tabs.
  for (const tab of sidebarOrder(state, spaceId)) {
    if (folded?.has(tab.id)) continue
    const key = listOfTab(state.folders, tab)
    const last = lists.at(-1)
    if (last?.key === key) last.tabs.push(tab)
    else lists.push({ key, tabs: [tab], folder: key !== 'today' && key !== 'pinned' })
  }
  return lists
}

/** The tab each row of the sidebar stands for, top to bottom: the anchor of a split view stands for the whole row. */
export function sidebarRows(state: SidebarState, spaceId: string): TabItem[] {
  const { covered } = splitRows(drawnLists(state, spaceId), state.splits)
  return visibleTabOrder(state, spaceId).filter((tab) => !covered.has(tab.id))
}

/** The tab ⌘n (n from 1 to 9) selects in the current space, or undefined when the sidebar shows fewer than n rows. */
export function tabOfItem(state: SidebarState, n: number): TabItem | undefined {
  if (!Number.isInteger(n) || n < 1) return undefined
  return sidebarRows(state, state.activeSpaceId)[n - 1]
}
