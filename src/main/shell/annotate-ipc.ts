// IPC of the annotation sheet that follows a capture (shared/annotate.ts, shell/capture.ts): the sheet asks for the picture it is open for,
// and sends back its choice. Registered for each window with the window's own scoped IPC and guard (see registerIpc).

import { BrowserWindow, ShareMenu, shell, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import type { AnnotateReply } from '@shared/annotate'
import type { Browser } from './browser'
import { finishAnnotation } from './capture'
import type { ScopedIpc } from './ipc-scope'
import { t } from '@shared/i18n'

export function registerAnnotateIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, win: BrowserWindow): void {
  // The picture is given only while the sheet opened for that id is the panel on screen: the setting, the id and the panel are all in `heldCapture`.
  ipcMain.handle(Channel.annotateImage, (e, id: unknown): string | null => {
    if (!guard(e.sender, Channel.annotateImage)) return null
    const held = browser.heldCapture(id)
    return held ? `data:image/png;base64,${held.png.toString('base64')}` : null
  })

  ipcMain.handle(Channel.annotateDone, async (e, raw: unknown): Promise<AnnotateReply> => {
    if (!guard(e.sender, Channel.annotateDone)) return { ok: false, message: t('feature.demande-refusee') }
    return finishAnnotation(
      {
        holdCapture: (png, suffix) => browser.holdCapture(png, suffix),
        openOverlay: (request) => browser.openOverlay(request),
        currentOverlay: () => browser.currentOverlay(),
        dropCapture: (id) => browser.dropCapture(id),
        heldCapture: (id) => browser.heldCapture(id),
        closeOverlay: () => browser.closeOverlay(),
        showToast: (message) => browser.showToast(message),
        shareFile: (path) => new ShareMenu({ filePaths: [path] }).popup({ window: BrowserWindow.fromWebContents(e.sender) ?? win }),
        openFile: (path) => void shell.openPath(path)
      },
      raw
    )
  })
}
