// View › Always on Top: one window kept above the windows of the other applications, as the mini window and the picture in picture are.

import type { BrowserWindow } from 'electron'

/**
 * 'floating' is the level of a palette (NSFloatingWindowLevel): over every normal window, under the menu bar, the Dock and the dialogs of the system, which
 * 'screen-saver' or 'pop-up-menu' would cover. It is the level of the mini window (little.ts) and of the other floating windows of Lucium, so they keep their
 * order among themselves.
 */
export const ALWAYS_ON_TOP_LEVEL = 'floating'

/** What is read and changed on a window; a window of Electron has them, a test gives its own. */
export type OnTopWindow = Pick<BrowserWindow, 'isAlwaysOnTop' | 'setAlwaysOnTop' | 'isDestroyed'>

/** Whether the window is kept in front (false for a window that is gone). */
export const isKeptOnTop = (win: OnTopWindow): boolean => !win.isDestroyed() && win.isAlwaysOnTop()

/** Keeps the window in front, or lets it go back among the others; returns the state it is in now. A window that is gone is left alone. */
export function toggleKeptOnTop(win: OnTopWindow): boolean {
  if (win.isDestroyed()) return false
  const next = !win.isAlwaysOnTop()
  if (next) win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL)
  else win.setAlwaysOnTop(false)
  return next
}
