// The sidebar of one window (« Barre de cette fenêtre »): each window may put its sidebar on the other side than the setting says, or dock it to a
// column of site icons (« coller la barre »). The setting `sidebarRight` (Réglages › Apparence) stays the side of the new windows and of every window
// that made no choice of its own, which then follows it when it changes; a new window is never docked.
//
// Pure rules. The shell keeps the choice of each window (main/shell/browser-commands.ts) and windows.json remembers it with the window, the first one
// included (window-session.ts); closing a window forgets it. The interface draws the column (renderer/DockedSidebar.tsx, its content: docked-sidebar.ts).

import type { Settings } from './model'

export type SidebarSide = 'left' | 'right'

/** What one window chose for itself. Empty: as the new windows (the setting's side, the full sidebar). */
export interface WindowSidebar {
  /** The side of this window; absent, the setting `sidebarRight`. */
  side?: SidebarSide
  /** Docked: a column of site icons takes the place of the full sidebar while the sidebar is shown. Absent: the full sidebar. */
  docked?: true
}

/** A change asked by a menu, a button, a key or the command bar. */
export type WindowSidebarChange =
  /** Docks the sidebar (and shows it when it is hidden), or gives the full one back. */
  | { op: 'dock'; docked: boolean }
  /** ⌃⌘S: what is on screen changes, docked or not. */
  | { op: 'toggle-dock' }
  /** The side of this window; null: as the new windows again (« Comme les nouvelles fenêtres »). */
  | { op: 'side'; side: SidebarSide | null }
  /** « Barre à droite dans cette fenêtre »: the other side than the one on screen. */
  | { op: 'toggle-side' }

/** Where the sidebar of a window is, and in which shape. */
export interface SidebarPlacement {
  /** At the right of the window (the window is mirrored). */
  right: boolean
  /** The column of icons is on screen: docked, and the sidebar shown. */
  docked: boolean
  /** The side this window chose, null when it follows the setting. */
  own: SidebarSide | null
}

/** Nothing chosen: what a new window, and a window opened before this existed, has. */
export const NO_WINDOW_SIDEBAR: WindowSidebar = Object.freeze({})

const SIDES: readonly SidebarSide[] = ['left', 'right']
const isSide = (value: unknown): value is SidebarSide => typeof value === 'string' && (SIDES as readonly string[]).includes(value)

/**
 * The placement of a window's sidebar: its own side, else the setting; the column only while the sidebar is shown (hidden, nothing is drawn of either
 * shape, and the floating sidebar the edge opens is the full one). `own` may be anything a file or a test hands over: only the known values count.
 */
export function sidebarPlacement(settings: Pick<Settings, 'sidebarRight' | 'sidebarVisible'>, own: WindowSidebar | null | undefined): SidebarPlacement {
  const side = isSide(own?.side) ? own.side : null
  return { right: side === null ? settings.sidebarRight : side === 'right', docked: own?.docked === true && settings.sidebarVisible, own: side }
}

/**
 * Whether the touch of the window's edge opens the floating copy of the sidebar: only while no sidebar is on screen, in either shape. The column of a docked
 * sidebar is a shown sidebar, not a hidden one: the pointer over it (or at the edge of its window) opens nothing, and the full sidebar comes back only by
 * « Déplier », ⌃⌘S, the menus or a double-click on the column's edge. A hidden sidebar (⌘S) keeps its edge, docked before it was hidden or not.
 */
export function edgeOpensFloatingSidebar(settings: Pick<Settings, 'sidebarRight' | 'sidebarVisible'>, own: WindowSidebar | null | undefined): boolean {
  return !settings.sidebarVisible && !sidebarPlacement(settings, own).docked
}

/** The choice once `change` is applied, and whether the sidebar must be shown for it (docking a hidden sidebar shows its column). The same object when nothing changes. */
export function changeWindowSidebar(own: WindowSidebar, change: WindowSidebarChange, settings: Pick<Settings, 'sidebarRight' | 'sidebarVisible'>): { own: WindowSidebar; show: boolean } {
  const placement = sidebarPlacement(settings, own)
  switch (change.op) {
    case 'dock':
      return { own: withDocked(own, change.docked), show: change.docked && !settings.sidebarVisible }
    case 'toggle-dock':
      // What the user sees decides: a hidden sidebar that was docked comes back docked rather than leaving the column it never saw.
      return placement.docked ? { own: withDocked(own, false), show: false } : { own: withDocked(own, true), show: !settings.sidebarVisible }
    case 'side':
      return { own: withSide(own, change.side), show: false }
    case 'toggle-side':
      return { own: withSide(own, placement.right ? 'left' : 'right'), show: false }
  }
}

function withDocked(own: WindowSidebar, docked: boolean): WindowSidebar {
  if ((own.docked === true) === docked) return own
  const { docked: _was, ...rest } = own
  return docked ? { ...rest, docked: true } : rest
}

function withSide(own: WindowSidebar, side: SidebarSide | null): WindowSidebar {
  if ((own.side ?? null) === side) return own
  const { side: _was, ...rest } = own
  return side === null ? rest : { ...rest, side }
}

/** What a file (windows.json) or a caller hands over, kept to the known values: undefined when nothing is left (the window chose nothing). */
export function cleanWindowSidebar(raw: unknown): WindowSidebar | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const clean: WindowSidebar = { ...(isSide(r['side']) ? { side: r['side'] } : {}), ...(r['docked'] === true ? { docked: true as const } : {}) }
  return clean.side === undefined && clean.docked === undefined ? undefined : clean
}

/** A change sent by the interface (it is not trusted): one of the four, with its value of the right kind, or null. */
export function parseWindowSidebarChange(raw: unknown): WindowSidebarChange | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  switch (r['op']) {
    case 'dock':
      return typeof r['docked'] === 'boolean' ? { op: 'dock', docked: r['docked'] } : null
    case 'toggle-dock':
      return { op: 'toggle-dock' }
    case 'side':
      return r['side'] === null || isSide(r['side']) ? { op: 'side', side: r['side'] } : null
    case 'toggle-side':
      return { op: 'toggle-side' }
    default:
      return null
  }
}
