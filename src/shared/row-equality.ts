// When a row of the sidebar or the toolbar is drawn again. Every snapshot reaches the interface as a fresh copy (it crosses a process), so
// no object of it is ever the same as the one before: React.memo's default comparison would never hold. These compare what a row draws,
// by value, so that a title that changes in the background redraws its own row and not the other five hundred.

import type { RuntimeState, Space, TabItem } from './model'
import type { TreeRow } from './tab-tree'

/** Same value, for the plain data of a snapshot (primitives, arrays, records without cycles). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameData(item, b[i]))
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]))
}

/** What a tab row reads: the tab, whether it is the one on screen, in a split view, a stop of the Tab key, its place in the tree, its own runtime entry and its mark of « Actualiser tous les onglets ». */
export interface TabRowInputs {
  tab: TabItem
  active: boolean
  inSplit: boolean
  tabbable?: boolean
  tree?: TreeRow | undefined
  runtime: RuntimeState
}

export function sameTabRow(a: TabRowInputs, b: TabRowInputs): boolean {
  return a.active === b.active && a.inSplit === b.inSplit && a.tabbable === b.tabbable && sameData(a.tab, b.tab) && sameData(a.tree, b.tree) && sameData(a.runtime.tabs[a.tab.id], b.runtime.tabs[b.tab.id]) && a.runtime.reloadMarks?.[a.tab.id] === b.runtime.reloadMarks?.[b.tab.id]
}

/** What the row of a split view reads: its tabs, the anchor it stands for, the tab on screen, whether each tab is awake, and the work view it was opened from. */
export interface SplitRowInputs {
  tabs: TabItem[]
  anchor: string
  activeId: string | null | undefined
  runtime: RuntimeState
  /** The icon and the name of the work view the split view stands for (its mark at the start of the row); absent for any other split view. */
  view?: { emoji: string; name: string } | undefined
}

export function sameSplitRow(a: SplitRowInputs, b: SplitRowInputs): boolean {
  return a.anchor === b.anchor && a.activeId === b.activeId && a.view?.emoji === b.view?.emoji && a.view?.name === b.view?.name && sameData(a.tabs, b.tabs) && a.tabs.every((tab) => a.runtime.tabs[tab.id]?.awake === b.runtime.tabs[tab.id]?.awake)
}

/** What a toolbar strip reads. The callbacks of a pane are not compared: they act on the pane's own tab, which the strip's key already names. */
export interface ToolbarInputs {
  space: Pick<Space, 'profileId'>
  current: TabItem | undefined
  runtime: RuntimeState
  sidebarVisible: boolean
  fullUrl: boolean
  draggable: boolean
  canSplit: boolean
  zoomMark?: string | null
  pane?: { style: unknown; focused: boolean } | undefined
  sidebarRight?: boolean
  leading?: number
  /** Setting `tabStateBadges`: the bar draws its line of loading only with it. */
  badges?: boolean
  /** The button « Annoter » (the page annotation is shared by a page of this window): the bar must render when it changes. */
  annotate?: boolean
  /** The button « Toutes les notes » and the keys of its tooltip: the bar must render when the switch or the shortcut changes. */
  notesList?: readonly string[]
  /** The keys the tooltips show (the shortcuts as they are set now): the bar must render when a shortcut changes. */
  keys?: Readonly<Record<string, readonly string[]>> | undefined
  /** The button « Contraste de la page » and the mode its icon shows: the bar must render when the button comes or goes, or the page's mode changes. */
  readable?: string
  /** The button « Traduction de la page » and its state: the bar must render when it comes or goes, or the translation moves on (also a change of the target). */
  translate?: { state: string; from: string; to: string } | undefined
  /** The button ☰ (the menu of the application, on a window with no menu bar) and the room left at the bar's end for the buttons of the system: the bar must render when either changes. */
  menu?: boolean
  underControls?: boolean
}

export function sameToolbar(a: ToolbarInputs, b: ToolbarInputs): boolean {
  return (
    a.space.profileId === b.space.profileId &&
    a.sidebarVisible === b.sidebarVisible &&
    a.fullUrl === b.fullUrl &&
    a.draggable === b.draggable &&
    a.canSplit === b.canSplit &&
    a.zoomMark === b.zoomMark &&
    a.sidebarRight === b.sidebarRight &&
    a.leading === b.leading &&
    (a.menu === true) === (b.menu === true) &&
    (a.underControls === true) === (b.underControls === true) &&
    a.badges === b.badges &&
    (a.annotate === true) === (b.annotate === true) &&
    a.notesList?.join(' ') === b.notesList?.join(' ') &&
    sameData(a.keys, b.keys) &&
    a.readable === b.readable &&
    sameData(a.translate, b.translate) &&
    a.runtime.canGoBack === b.runtime.canGoBack &&
    a.runtime.canGoForward === b.runtime.canGoForward &&
    a.runtime.backCloses === b.runtime.backCloses &&
    sameData(a.current, b.current) &&
    sameData(a.current ? a.runtime.tabs[a.current.id] : undefined, b.current ? b.runtime.tabs[b.current.id] : undefined) &&
    a.pane?.focused === b.pane?.focused &&
    (a.pane === undefined) === (b.pane === undefined) &&
    sameData(a.pane?.style, b.pane?.style)
  )
}

/** What the sidebar hands its rows besides functions (see `useStableUi`). */
export interface RowsContextData {
  selected: ReadonlySet<string>
  dragging: ReadonlySet<string>
  mark: unknown
  developerHosts: readonly string[]
  containers: readonly unknown[]
  /** The tabs that wear the mark of a profile's proxy they do not go through, with why (shared/proxy-mark.ts): a mark that comes or goes must redraw its row. */
  proxyMarks?: ReadonlyMap<string, string> | undefined
  /** Setting `tabStateBadges`: a row draws its state marks only with it (a switch that changes must redraw the rows). */
  badges?: boolean | undefined
  tree?: boolean | undefined
  compact?: { fullUrl: boolean } | undefined
}

/** The content of the rows' context: two contexts with the same key are the same one, whatever objects they are made of. */
export function rowsContextKey(data: RowsContextData): string {
  return JSON.stringify([[...data.selected], [...data.dragging], data.mark ?? null, data.developerHosts, data.containers, data.proxyMarks ? [...data.proxyMarks] : [], data.badges === true, data.tree === true, data.compact ? data.compact.fullUrl : null])
}
