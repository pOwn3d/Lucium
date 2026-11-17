// Several windows can show the same tabs: the tabs, spaces and settings are shared, but each window has its own current
// space and its own selected tab (two windows on the same space, or on different ones). Pure rules for that split.

import type { Settings, SidebarState } from './model'
import { activeTab, splitFor } from './sidebar'
import { MAIN_WINDOW_KEY, onlyTabsOf, windowsAreIndependent } from './window-tabs'

/** What one window chooses for itself. */
export interface Selection {
  spaceId: string
  /** The selected tab of each space; a missing space means none. */
  tabs: Record<string, string | null>
  /** The layout settings of this window (sidebar, toolbar). */
  layout: Partial<Pick<Settings, LayoutKey>>
}

/** Settings that describe one window's layout: hiding the sidebar in a window must not hide it in the others. */
export const LAYOUT_SETTINGS = ['sidebarVisible', 'sidebarWidth', 'sidePanelWidth', 'showToolbar', 'fullUrlInToolbar'] as const
export type LayoutKey = (typeof LAYOUT_SETTINGS)[number]

export function layoutOf(settings: Settings): Selection['layout'] {
  return Object.fromEntries(LAYOUT_SETTINGS.map((key) => [key, settings[key]])) as Selection['layout']
}

export function selectionOf(state: SidebarState): Selection {
  return { spaceId: state.activeSpaceId, tabs: state.activeTabBySpace, layout: layoutOf(state.settings) }
}

/** A window that shows `spaceId` with no tab selected and the sidebar visible. */
export function blankSelection(state: SidebarState, spaceId: string): Selection {
  return { spaceId: state.spaces.some((s) => s.id === spaceId) ? spaceId : state.activeSpaceId, tabs: {}, layout: { ...layoutOf(state.settings), sidebarVisible: true } }
}

export const sameLayout = (a: Selection['layout'], b: Selection['layout']) => LAYOUT_SETTINGS.every((key) => a[key] === b[key])

/**
 * The state as one window sees it: everything shared, with the window's own space, selected tabs and layout. A selection
 * that points at something another window removed, or moved to another space, shows nothing selected. Same object as `shared` when the window sees it unchanged.
 * With the setting `independentWindows` on, the window `key` lists only the pinned tabs and its own (window-tabs.ts); off, `key` is not looked at.
 */
export function project(shared: SidebarState, selection: Selection, key: string = MAIN_WINDOW_KEY): SidebarState {
  return windowsAreIndependent(shared) ? projectSelection(onlyTabsOf(shared, key), selection) : projectSelection(shared, selection)
}

function projectSelection(shared: SidebarState, selection: Selection): SidebarState {
  const spaceId = shared.spaces.some((s) => s.id === selection.spaceId) ? selection.spaceId : shared.activeSpaceId
  const spaceOfTab = new Map(shared.tabs.map((t) => [t.id, t.spaceId]))
  const tabs: Record<string, string | null> = {}
  let sameTabs = true
  for (const space of shared.spaces) {
    const id = selection.tabs[space.id] ?? null
    // A space shows one of its own tabs: a tab another window moved to a space of its own is no longer this one's selection.
    tabs[space.id] = id !== null && spaceOfTab.get(id) === space.id ? id : null
    if (tabs[space.id] !== (shared.activeTabBySpace[space.id] ?? null)) sameTabs = false
  }
  const layout = { ...layoutOf(shared.settings), ...selection.layout }
  if (spaceId === shared.activeSpaceId && sameTabs && sameLayout(layout, layoutOf(shared.settings))) return shared
  return { ...shared, activeSpaceId: spaceId, activeTabBySpace: tabs, settings: { ...shared.settings, ...layout } }
}

/** The tab on screen in a window, or every pane of its split view. */
export function visibleTabIds(state: SidebarState): string[] {
  const active = activeTab(state)
  if (!active) return []
  return splitFor(state, active.id)?.tabIds ?? [active.id]
}

/** A tab lives in one window at a time: the selection of a window that shows one of `taken` is cleared. Same object when nothing changes. */
export function release(selection: Selection, state: SidebarState, taken: ReadonlySet<string>, key: string = MAIN_WINDOW_KEY): Selection {
  const shown = new Set(visibleTabIds(project(state, selection, key)))
  if (![...shown].some((id) => taken.has(id))) return selection
  const tabs = { ...selection.tabs }
  for (const [spaceId, id] of Object.entries(tabs)) if (id && shown.has(id)) tabs[spaceId] = null
  return { ...selection, tabs }
}
