// "Déplacer vers la fenêtre" in the menu of a tab: the tab goes to another window of the application, the way a drag onto that window's sidebar takes it
// (shell/tab-transfer.ts does the move, shared/tab-transfer.ts decides it). Pure rules: which windows the menu offers and how it names them, when nothing
// may move, which tabs go together, and where they land in the window that takes them, since a menu has no place under the pointer.

import { draggedTabs, type DropTarget } from './dnd'
import { isListedTab, type SidebarState, type SplitView, type TabItem } from './model'
import { splitFor } from './sidebar'
import { windowEntryLabel, type WindowEntry } from './window-names'

/** What the menu gives "Nouvelle fenêtre" for a window: there is none yet, one is opened for the tab. */
export const NEW_WINDOW = 'new'

/** A window the menu offers, named as the Window menu names it. */
export interface WindowChoice {
  id: string
  label: string
  /** What it shows (the title of its window), under the label, when that says more than the label. */
  title?: string
}

/**
 * The windows a tab of the window `selfId` can go to: the other normal windows, in the order they were opened. None from a private or guest window, and
 * none of those is offered: their tabs live in a state and a session of their own. A name is used only while windows can be named (`namesEnabled`),
 * as the Window menu does; else "Fenêtre 2". `titleOf` gives the title of a window, shown under its label.
 */
export function windowChoices(entries: readonly WindowEntry[], selfId: string, namesEnabled: boolean, titleOf: (id: string) => string | undefined = () => undefined): WindowChoice[] {
  const self = entries.find((entry) => entry.id === selfId)
  if (!self || self.kind === 'private') return []
  return entries
    .filter((entry) => entry.id !== selfId && entry.kind !== 'private')
    .map((entry) => {
      const label = windowEntryLabel({ kind: entry.kind, position: entry.position, ...(namesEnabled && entry.name !== undefined ? { name: entry.name } : {}) })
      const title = titleOf(entry.id)?.trim()
      return { id: entry.id, label, ...(title && title !== label ? { title } : {}) }
    })
}

/** A window of a move, as the rule needs it: its key (`main`, `window-2`…), and whether it is private (or a guest's). */
export interface MoveSide {
  key: string
  private: boolean
}

/** Why nothing moves: from or to a private window, to the window the tab is in, to a window that is gone, or a tab that has no row. */
export type WindowMoveRefusal = 'private-window' | 'same-window' | 'no-window' | 'no-tab'

/** Whether the tab `tabId` of the window `from` may go to `to` (`NEW_WINDOW`: one opened for it; null: a window that is gone). Null when it may. */
export function windowMoveRefusal(state: SidebarState, tabId: string, from: MoveSide, to: MoveSide | typeof NEW_WINDOW | null): WindowMoveRefusal | null {
  // A private window (and a guest one) is its own world: nothing leaves it for a normal window, nothing comes in from one.
  if (from.private || (to !== null && to !== NEW_WINDOW && to.private)) return 'private-window'
  if (to === null) return 'no-window'
  if (to !== NEW_WINDOW && to.key === from.key) return 'same-window'
  const tab = state.tabs.find((t) => t.id === tabId)
  return tab && isListedTab(tab) ? null : 'no-tab'
}

/** The tabs that go: the tab, or every pane of its split view (a drag of the row takes them all), in the order of the sidebar. Empty for a tab with no row. */
export function tabsToSend(state: SidebarState, tabId: string): string[] {
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab || !isListedTab(tab)) return []
  const split = splitFor(state, tabId)
  return draggedTabs(state, split ? split.tabIds : [tabId]).map((t) => t.id)
}

/**
 * Where the tabs land in the window that takes them, as a drop there would put them (`view` is that window's view of the state; they go to the space it
 * shows). A pinned tab stays pinned: at its own place when that window shows its space, else after the loose pinned tabs of the space it shows. A Today
 * tab goes to the top of Today, where a new tab opens.
 */
export function windowMoveTarget(view: SidebarState, tabs: readonly TabItem[]): DropTarget {
  const first = tabs[0]
  const spaceId = view.activeSpaceId
  const moving = new Set(tabs.map((t) => t.id))
  const rows = view.tabs.filter((t) => t.spaceId === spaceId && isListedTab(t) && !moving.has(t.id))
  if (first?.pinned === true) {
    if (first.spaceId !== spaceId) return { kind: 'folder', id: null }
    // The pinned tab after it in the same folder (or among the loose ones) keeps it where it is; the last one goes back to the end of its folder.
    const folderId = first.folderId !== undefined && view.folders.some((f) => f.id === first.folderId && f.spaceId === spaceId) ? first.folderId : undefined
    const group = view.tabs.filter((t) => t.spaceId === spaceId && t.pinned && isListedTab(t) && (folderId === undefined ? !inFolder(view, t) : t.folderId === folderId))
    const next = group.slice(group.findIndex((t) => t.id === first.id) + 1).find((t) => !moving.has(t.id))
    return next ? { kind: 'tab', id: next.id, edge: 'before' } : { kind: 'folder', id: folderId ?? null }
  }
  const top = rows.find((t) => !t.pinned)
  return top ? { kind: 'tab', id: top.id, edge: 'before' } : { kind: 'today' }
}

/**
 * The split view of `tabId` to put back once its panes have moved (`before` and `after` the move): a split view lives in one space, so one whose panes went
 * to another space was taken apart on the way, pane by pane. The same panes, order, sizes and orientation, in their new space; null when there is nothing
 * to put back (no split view, the same space, or panes that did not all land together).
 */
export function splitToRestore(before: SidebarState, after: SidebarState, tabId: string): SplitView | null {
  const split = splitFor(before, tabId)
  if (!split) return null
  const spaces = new Set(split.tabIds.map((id) => after.tabs.find((t) => t.id === id)?.spaceId))
  const [spaceId] = [...spaces]
  if (spaces.size !== 1 || spaceId === undefined || spaceId === split.spaceId) return null
  return { ...split, spaceId }
}

/** Whether a pinned tab is in a folder of its space (a folder that is gone leaves it among the loose ones). */
const inFolder = (state: SidebarState, tab: TabItem): boolean => tab.folderId !== undefined && state.folders.some((f) => f.id === tab.folderId && f.spaceId === tab.spaceId)
