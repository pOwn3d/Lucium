// File › Rouvrir la dernière fenêtre fermée: the windows closed during this session, kept in memory only (never written: not in the state file, not in the
// session file) and bounded. A closed window comes back where it was, with the tab it showed in each space, its name and the sidebar it had chosen; the tabs
// themselves are in the shared state, so a tab that is gone since, or that another window shows now, is simply not selected (`release`, window-selection.ts).
//
// What is never kept: a private or guest window (its tabs and its data went with it), a window of a locked space or closed while the application is locked
// (reopening it would be a way round the lock), and the windows closed on the way out of the application.

import type { Rect } from './window-layout'
import type { Selection } from './window-selection'
import type { WindowSidebar } from './window-sidebar'

/** How many closed windows are kept: the oldest goes first. */
export const CLOSED_WINDOWS_MAX = 10

export interface ClosedWindow {
  bounds: Rect
  selection: Selection
  /** The name the user gave the window (Fenêtre › Nommer la fenêtre…). */
  name?: string
  sidebar?: WindowSidebar
}

/** What the lock says at the moment a window closes, or one reopens. */
export interface LockFacts {
  appLocked: boolean
  /** The spaces that are locked now (their phrase not given). */
  lockedSpaces: readonly string[]
}

/** Whether a window that just closed may be remembered: a normal window, shown while neither it nor the application was locked, and not closed by the quit. */
export function mayRemember(window: { kind: 'main' | 'window' | 'private'; guest?: boolean; quitting: boolean; selection: Selection }, lock: LockFacts): boolean {
  if (window.kind !== 'window' || window.guest === true || window.quitting) return false
  return !lock.appLocked && !lock.lockedSpaces.includes(window.selection.spaceId)
}

/** The list with `entry` added as the latest, at most `max` kept (the oldest dropped). The list given is not changed. */
export function remember(list: readonly ClosedWindow[], entry: ClosedWindow, max: number = CLOSED_WINDOWS_MAX): ClosedWindow[] {
  return [...list, entry].slice(-max)
}

/**
 * The latest closed window that may reopen now, and the list without it. An entry whose space is locked now is not reopened (and not kept: the lock is what
 * decides, and it is not for this list to remember what the person could not see); none at all while the application is locked (the list is left as it is).
 */
export function takeLast(list: readonly ClosedWindow[], lock: LockFacts): { entry: ClosedWindow | null; rest: ClosedWindow[] } {
  if (lock.appLocked) return { entry: null, rest: [...list] }
  const usable = list.filter((window) => !lock.lockedSpaces.includes(window.selection.spaceId))
  const entry = usable.at(-1) ?? null
  return { entry, rest: entry === null ? [] : usable.slice(0, -1) }
}

/** Whether « Rouvrir la dernière fenêtre fermée » has something to reopen (greyed out otherwise). */
export const canReopen = (list: readonly ClosedWindow[], lock: LockFacts): boolean => !lock.appLocked && list.some((window) => !lock.lockedSpaces.includes(window.selection.spaceId))
