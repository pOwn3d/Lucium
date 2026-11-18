// The menu of the application opened as a popup, for a window that has no menu bar: on Windows the three buttons of the system lie over the window and
// the page draws the title bar, so the menu bar has no place there (Electron shows none in a window without a frame) and the button ☰ of the toolbar
// stands for it. The menu is the one already installed (shell/app-menu-wiring.ts), the same entries and the same shortcuts; nothing is built here.

/** The part of Electron's `Menu` this needs. */
export interface PopupMenu<Window> {
  popup(options: { window: Window; x: number; y: number }): void
}

/** Opens `menu` at `at` (points of `window`). False when the application has no menu installed (nothing opens). */
export function popupApplicationMenu<Window>(menu: PopupMenu<Window> | null, window: Window, at: { x: number; y: number }): boolean {
  if (!menu) return false
  menu.popup({ window, x: at.x, y: at.y })
  return true
}
