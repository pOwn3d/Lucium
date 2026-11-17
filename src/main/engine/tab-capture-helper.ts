// The helper page of a capture of the sound of a tab by an extension (tab-capture.ts). An ordinary web contents in a window that is never shown, in the session of the
// tab it listens to, with one thing of Lucium's and no more: a function that sends a chunk of sound to the main process (preload/capture-helper.ts). It asks for the stream
// (the engine answers it with the sound of the tab, and its own picture, which it takes off at once), reads the samples of the sound and sends them (shared/tab-capture-pcm.ts,
// `HELPER_SCRIPT`: one fixed text, no parameter). It exists for one capture, and is destroyed with it.
// It is loaded from a fixed address of the session (shared/capture-helper-page.ts, served by engine/internal-pages.ts to this load alone): a secure context, which an
// `about:blank` window is not, so that it has `navigator.mediaDevices` at all.

import { join } from 'node:path'
import { BrowserWindow, type Session } from 'electron'
import { CAPTURE_HELPER_URL } from '@shared/capture-helper-page'
import { HELPER_SCRIPT } from '@shared/tab-capture-pcm'
import type { CaptureHelper } from './tab-capture'

export interface HelperHooks {
  /** The page went away by itself (its window was closed, its process died): the capture it carried is over. Not called for a page `close()` destroyed. */
  gone(contentsId: number): void
  warn(message: string, detail?: unknown): void
}

/** The preload of the helper page (built with the others, `out/preload`): a window's preload is read by Electron itself, from the archive too, so it is not unpacked. */
export function captureHelperPreloadPath(mainDir: string = __dirname): string {
  return join(mainDir, '../preload/capture-helper.js')
}

/**
 * Makes the helper page in `session`. It loads its fixed address and nothing else (`loadHeader`: the line of headers that makes the load the engine's, which the session
 * answers to and to nobody else), and begins to read the sound once asked (`start`).
 */
export function openCaptureHelper(session: Session, hooks: HelperHooks, loadHeader: string): CaptureHelper {
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    // A page nobody looks at must keep its timers and the reading of its sound running.
    webPreferences: { session, preload: captureHelperPreloadPath(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, spellcheck: false, backgroundThrottling: false }
  })
  const contents = window.webContents
  const contentsId = contents.id
  let over = false
  const gone = (): void => {
    if (over) return
    over = true
    hooks.gone(contentsId)
  }
  // Never navigable, never a window of its own: whatever the page is made to do, it stays on its address and opens nothing.
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('render-process-gone', gone)
  window.on('closed', gone)
  const loading = window.loadURL(CAPTURE_HELPER_URL, { extraHeaders: loadHeader }).then(() => undefined)
  loading.catch((error: unknown) => hooks.warn(`[tab-capture] the helper page ${contentsId} could not load its page:`, error))
  return {
    contentsId,
    async start(): Promise<void> {
      await loading
      if (window.isDestroyed()) throw new Error('the helper page is gone')
      // `true`: the call is made as if a click had just been made in the page, which a request for a screen asks for.
      const begun: unknown = await contents.executeJavaScript(HELPER_SCRIPT, true)
      if (begun !== true) throw new Error('the helper page did not begin to read the sound')
    },
    close(): void {
      over = true
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
