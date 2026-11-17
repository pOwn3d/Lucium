// Opening again at launch the windows of the previous session (Settings › Onglets et fenêtres). The tabs themselves are always kept (the state file); this is
// where the windows were and what each one showed. Private windows are never part of it.

import type { SidebarState } from './model'
import type { Rect } from './window-layout'
import { blankSelection, type Selection } from './window-selection'
import { cleanWindowName } from './window-names'
import { cleanWindowSidebar, type WindowSidebar } from './window-sidebar'

export const SESSION_WINDOWS_MAX = 8
/** The smallest window the application allows (see the window options in index.ts). */
export const WINDOW_MIN = { width: 720, height: 480 } as const
/** A window is restored only if at least this much of it is on a screen: enough to grab and drag back. */
const VISIBLE_MIN = 120

export interface SavedWindow {
  bounds: Rect
  spaceId: string
  /** The selected tab of each space. */
  tabs: Record<string, string | null>
  sidebarVisible: boolean
  /** The name the user gave the window (Fenêtre › Nommer la fenêtre…); absent when it has none, and in a file written before names existed. */
  name?: string
  /** The sidebar of this window (« Barre de cette fenêtre »: its side, docked or not, window-sidebar.ts); absent when it chose nothing. */
  sidebar?: WindowSidebar
}

export interface SavedSession {
  /** Where the first window was. */
  main: Rect | null
  /** The name of the first window. */
  mainName?: string
  /** The sidebar of the first window, when it chose one of its own. */
  mainSidebar?: WindowSidebar
  /** The other windows, in the order they were opened. */
  windows: SavedWindow[]
}

export const EMPTY_SESSION: SavedSession = { main: null, windows: [] }

const isRect = (value: unknown): value is Rect => {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof r[key] === 'number' && Number.isFinite(r[key]))
}

const overlap = (a: Rect, b: Rect): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
})

/**
 * Where a saved window opens on the screens there are now: as saved when enough of it is visible on one of them, otherwise
 * centred on the first screen (a screen that is no longer plugged in must not hide a window). The size never exceeds the screen's.
 */
export function fitToDisplays(bounds: Rect, displays: readonly Rect[]): Rect | null {
  const first = displays[0]
  if (!first) return null
  const width = Math.min(Math.max(Math.round(bounds.width), WINDOW_MIN.width), Math.max(first.width, WINDOW_MIN.width))
  const height = Math.min(Math.max(Math.round(bounds.height), WINDOW_MIN.height), Math.max(first.height, WINDOW_MIN.height))
  const placed = { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height }
  const visible = displays.some((display) => {
    const seen = overlap(placed, display)
    return seen.width >= VISIBLE_MIN && seen.height >= VISIBLE_MIN
  })
  if (visible) return placed
  return { x: first.x + Math.round((first.width - width) / 2), y: first.y + Math.round((first.height - height) / 2), width, height }
}

/**
 * What to write at quit: the first window and the others, as they are. The sidebar each one chose for itself goes with it (none for a window that
 * chose nothing: it opens again as the new windows, following the setting); a window closed before is no longer in the list, nor is its choice.
 */
export function sessionOf(main: Rect, others: ReadonlyArray<{ bounds: Rect; selection: Selection; name?: string; sidebar?: WindowSidebar }>, mainName?: string, mainSidebar?: WindowSidebar): SavedSession {
  const kept = cleanWindowSidebar(mainSidebar)
  return {
    main,
    ...(mainName !== undefined ? { mainName } : {}),
    ...(kept ? { mainSidebar: kept } : {}),
    windows: others.slice(0, SESSION_WINDOWS_MAX).map(({ bounds, selection, name, sidebar }) => {
      const own = cleanWindowSidebar(sidebar)
      return {
        bounds,
        spaceId: selection.spaceId,
        tabs: selection.tabs,
        sidebarVisible: selection.layout.sidebarVisible !== false,
        ...(name !== undefined ? { name } : {}),
        ...(own ? { sidebar: own } : {})
      }
    })
  }
}

/** How many windows a session lists: the first one and the others. */
export const sessionWindowCount = (session: SavedSession): number => (session.main ? 1 : 0) + session.windows.length

/** How long a list with fewer windows than the saved one waits, from the last window that went away, before it replaces the saved one. */
export const SHRINK_GRACE_MS = 10_000

/**
 * Whether a list of `count` windows may replace the saved list of `written` windows. A list with fewer windows is what closing the windows one by one
 * leaves, and that is also how the application is quit (the last window closing ends it, and so does ⌘Q right after a closing): it is only saved once
 * `SHRINK_GRACE_MS` went by since the last window went away (`sinceClosingMs`, null when none did), so that an end of the application in that time keeps the
 * list from before, the windows the user had. Nothing waits when the list is as long or longer, or when nothing is known of the saved one.
 */
export function mayReplaceSession(count: number, written: number | null, sinceClosingMs: number | null): boolean {
  if (written === null || count >= written) return true
  return sinceClosingMs !== null && sinceClosingMs >= SHRINK_GRACE_MS
}

/** The saved session as the screens and the state allow it today. A file that is not a session gives an empty one. */
export function usableSession(raw: unknown, displays: readonly Rect[], state: SidebarState): SavedSession {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SESSION
  const saved = raw as Record<string, unknown>
  const main = isRect(saved['main']) ? fitToDisplays(saved['main'], displays) : null
  const windows: SavedWindow[] = []
  for (const entry of Array.isArray(saved['windows']) ? saved['windows'] : []) {
    if (windows.length >= SESSION_WINDOWS_MAX) break
    if (typeof entry !== 'object' || entry === null || !isRect((entry as Record<string, unknown>)['bounds'])) continue
    const e = entry as Record<string, unknown>
    const bounds = fitToDisplays(e['bounds'] as Rect, displays)
    if (!bounds) continue
    const tabs: Record<string, string | null> = {}
    if (typeof e['tabs'] === 'object' && e['tabs'] !== null) {
      for (const [space, id] of Object.entries(e['tabs'] as Record<string, unknown>)) if (typeof id === 'string' || id === null) tabs[space] = id
    }
    const name = cleanWindowName(e['name'])
    // A sidebar of unknown values (a file from before, or one edited by hand) is a window that chose nothing: it opens as the new windows.
    const sidebar = cleanWindowSidebar(e['sidebar'])
    windows.push({ bounds, spaceId: typeof e['spaceId'] === 'string' ? e['spaceId'] : state.activeSpaceId, tabs, sidebarVisible: e['sidebarVisible'] !== false, ...(name !== undefined ? { name } : {}), ...(sidebar ? { sidebar } : {}) })
  }
  // A file that cannot be read this way (a name that is not text, a file from before names) has no name, and nothing else is lost.
  const mainName = cleanWindowName(saved['mainName'])
  const mainSidebar = cleanWindowSidebar(saved['mainSidebar'])
  return { main, ...(mainName !== undefined ? { mainName } : {}), ...(mainSidebar ? { mainSidebar } : {}), windows }
}

/** The selection a restored window starts with: its space and tabs when they still exist, otherwise a blank window on the current space. */
export function selectionOfSaved(saved: SavedWindow, state: SidebarState): Selection {
  const blank = blankSelection(state, saved.spaceId)
  const known = new Set(state.tabs.map((t) => t.id))
  const tabs: Record<string, string | null> = {}
  for (const [space, id] of Object.entries(saved.tabs)) if (state.spaces.some((s) => s.id === space)) tabs[space] = id !== null && known.has(id) ? id : null
  return { ...blank, tabs, layout: { ...blank.layout, sidebarVisible: saved.sidebarVisible } }
}
