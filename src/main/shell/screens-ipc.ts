// The screens that are connected, for Settings › Apparence › Taille des fenêtres et des panneaux: what the list and the preview draw. Read-only; nothing is
// kept and nothing is sent from the main process (the window asks when it draws, and again when it takes the focus).

import { BrowserWindow, screen, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import type { Rect, ScreenView } from '@shared/panel-scale'
import type { ScopedIpc } from './ipc-scope'
import { electronDisplays, type Displays, type ScreenSide } from './panel-scaling'

const same = (a: ScreenSide, b: ScreenSide): boolean => a.screen.key === b.screen.key && a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height

/**
 * The connected screens as the list and the preview draw them: `current` is the one the asking window (`from`) is on, `window` the main window of the
 * application (`main`) in the screen's own coordinates when its middle is on that screen, null for any other screen. A screen the system describes with no size is left out.
 */
export function panelScreenViews(displays: Displays, from: Rect | null, main: Rect | null): ScreenView[] {
  const sides = displays.all()
  const here = from === null ? null : displays.matching(from)
  const middle = main === null ? null : { x: main.x + main.width / 2, y: main.y + main.height / 2 }
  return sides.map((side) => ({
    ...side.screen,
    current: here !== null && same(side, here),
    window:
      main !== null && middle !== null && middle.x >= side.bounds.x && middle.x < side.bounds.x + side.bounds.width && middle.y >= side.bounds.y && middle.y < side.bounds.y + side.bounds.height
        ? { x: main.x - side.bounds.x, y: main.y - side.bounds.y, width: main.width, height: main.height }
        : null
  }))
}

export function registerScreensIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, win: BrowserWindow): void {
  ipcMain.handle(Channel.panelScreens, (e) => {
    if (!guard(e.sender, Channel.panelScreens)) return []
    // Electron's `screen` is read when the question comes, never before the application is ready.
    const displays = electronDisplays(screen)
    const asking = BrowserWindow.fromWebContents(e.sender)
    return panelScreenViews(displays, asking && !asking.isDestroyed() ? asking.getBounds() : null, win.isDestroyed() ? null : win.getBounds())
  })
}
