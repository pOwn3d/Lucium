// IPC of the small usage features: naming a window, going to a named window, the sidebar of a window (docked, its side), putting the page back to
// 100 % from the toolbar.
// Registered for each window with the window's own scoped IPC and guard (see registerIpc).

import type { BrowserWindow, WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { parseWindowSidebarChange } from '@shared/window-sidebar'
import type { StateStore } from '../store'
import type { ScopedIpc } from './ipc-scope'
import type { Browser } from './browser'
import { getWindowManager } from './window-manager-holder'

export function registerUsageIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: StateStore, win: BrowserWindow): void {
  // The name of the window the message comes from. Anything but text is a refusal; text is cleaned by the manager (length, control characters).
  ipcMain.on(Channel.setWindowName, (e, raw: unknown) => {
    if (!guard(e.sender, Channel.setWindowName)) return
    if (!store.get().settings.nameWindows) return console.warn('[windows] a name was refused: windows cannot be named (Réglages › Général)')
    if (typeof raw !== 'string') return console.warn('[windows] a name that is not text was refused')
    const manager = getWindowManager()
    const record = manager.recordOf(win)
    if (!record || !manager.setName(record.id, raw)) console.warn('[windows] the window to name is not known to the manager')
    browser.closeOverlay()
  })

  // « Barre de cette fenêtre »: the window the message comes from docks its sidebar or chooses its side. A change of another shape is refused whole.
  ipcMain.on(Channel.windowSidebar, (e, raw: unknown) => {
    if (!guard(e.sender, Channel.windowSidebar)) return
    const change = parseWindowSidebarChange(raw)
    if (!change) return console.warn('[windows] a change of the sidebar of a window was refused: it is none of the known ones')
    browser.changeWindowSidebar(change)
  })

  ipcMain.on(Channel.goToWindow, (e, id: unknown) => {
    if (!guard(e.sender, Channel.goToWindow)) return
    if (!store.get().settings.nameWindows || typeof id !== 'string') return
    browser.closeOverlay()
    if (!getWindowManager().focusWindow(id)) console.warn('[windows] the window to go to is gone')
  })

  // ⌘0 for the mark of the toolbar: the zoom of the site on screen is forgotten, in this window.
  ipcMain.on(Channel.resetZoom, (e) => {
    if (guard(e.sender, Channel.resetZoom)) browser.zoom(0)
  })
}
