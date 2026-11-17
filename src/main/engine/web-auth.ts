import { BrowserWindow, type Session, type WebContents } from 'electron'
import { AUTH_ERRORS, isAuthPageUrl, isAuthRedirect } from '@shared/chrome-compat'
import { authWindowTitle, AuthFlowLimiter } from '@shared/web-auth'
import { pageDialogPreferences } from '@shared/page-dialog'
import { popupKey } from '@shared/popup'
import type { WebAuthRequest } from './types'

const WINDOW_WIDTH = 500
const WINDOW_HEIGHT = 700
/** An interactive flow waits for the user for this long at most. */
const INTERACTIVE_TIMEOUT_MS = 10 * 60 * 1000

const limiter = new AuthFlowLimiter()
/** The pages of the flows that are running: the engine refuses them downloads and permission prompts (see `isAuthContents`). */
const authContents = new Set<number>()

/**
 * Marks the page of a view that nobody sees as one that may ask for nothing and start no download (a page read for a watch is one). Returns
 * the call that takes the mark off.
 */
export function markHiddenContents(id: number): () => void {
  authContents.add(id)
  return () => authContents.delete(id)
}

/** Whether this is the page of an authorization flow. It has no address bar, so it gets nothing that needs the user's attention but the sign-in. */
export function isAuthContents(contents: WebContents | null | undefined): boolean {
  return contents != null && authContents.has(contents.id)
}

/**
 * chrome.identity.launchWebAuthFlow: loads an authorization page in a window of the profile's own session (so the sites the user is
 * signed in to there are signed in) and resolves with the first address on `https://<extension id>.chromiumapp.org/`, which the
 * window never loads. A flow without interaction runs in a hidden window and only succeeds if the server redirects on its own.
 */
export function runWebAuthFlow(ses: Session, request: WebAuthRequest): Promise<string> {
  if (!isAuthPageUrl(request.url)) return Promise.reject(new Error(AUTH_ERRORS.invalidUrl))
  // One flow per extension, a few in all: a page cannot be asked for in a loop to fill the screen or the memory.
  const release = limiter.acquire(request.extensionId)
  if (!release) return Promise.reject(new Error(request.interactive ? AUTH_ERRORS.alreadyRunning : AUTH_ERRORS.pageLoadFailed))
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      show: request.interactive,
      title: authWindowTitle(request.url),
      // As a popup: dialogs in a row can be silenced. And no sound without a gesture: the address is the extension's choice, and the window of
      // a flow without interaction is one nobody sees.
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        ...pageDialogPreferences(),
        autoplayPolicy: 'document-user-activation-required'
      }
    })
    const wc = win.webContents
    const contentsId = wc.id
    authContents.add(contentsId)
    let finished = false
    let loaded = false

    const finish = (outcome: { url: string } | { error: string }) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      release()
      authContents.delete(contentsId)
      if (!win.isDestroyed()) win.destroy()
      if ('url' in outcome) resolve(outcome.url)
      else reject(new Error(outcome.error))
    }

    /** Stops the window from loading the end of the flow and reports it; refuses what is not a web page. */
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isAuthRedirect(url, request.extensionId)) {
        event.preventDefault()
        finish({ url })
      } else if (!isAuthPageUrl(url)) {
        event.preventDefault()
        finish({ error: AUTH_ERRORS.pageLoadFailed })
      }
    }
    wc.on('will-navigate', (event, url) => guard(event, url))
    wc.on('will-redirect', (event, url) => guard(event, url))
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // The menu of the application belongs to the tabs of the window behind: here ⌘W closes this window and ⌘R reloads this page, and the
    // other commands of the menu are kept from it (the same rule as for a popup).
    wc.on('before-input-event', (event, input) => {
      const action = popupKey(input, process.platform)
      if (action === 'pass') return
      event.preventDefault()
      if (win.isDestroyed()) return
      if (action === 'close') win.close()
      else if (action === 'reload') wc.reload()
    })
    // The user closing the window is never held back by a page asking to confirm leaving it.
    wc.on('will-prevent-unload', (event) => event.preventDefault())
    // The window has no address bar: its title is the only thing that says where the user is, so the page does not get to write it,
    // and it follows the host the page is on now.
    win.on('page-title-updated', (event) => event.preventDefault())
    wc.on('did-navigate', (_event, url) => {
      if (!win.isDestroyed()) win.setTitle(authWindowTitle(url))
    })
    wc.on('render-process-gone', () => finish({ error: AUTH_ERRORS.pageLoadFailed }))

    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      // -3 is a navigation that was cancelled, which is how the end of the flow is stopped.
      if (isMainFrame && code !== -3) finish({ error: AUTH_ERRORS.pageLoadFailed })
    })
    wc.on('did-stop-loading', () => {
      loaded = true
      if (!request.interactive && request.abortOnLoad) finish({ error: AUTH_ERRORS.interactionRequired })
    })
    // The user closed the window of an interactive flow.
    win.on('closed', () => finish({ error: AUTH_ERRORS.userRejected }))

    const timer = setTimeout(
      () => finish({ error: request.interactive ? AUTH_ERRORS.userRejected : loaded ? AUTH_ERRORS.interactionRequired : AUTH_ERRORS.pageLoadTimedOut }),
      request.interactive ? INTERACTIVE_TIMEOUT_MS : request.timeoutMs
    )

    // A load stopped on purpose (the end of the flow) also rejects: by then the flow has finished and this does nothing.
    wc.loadURL(request.url).catch(() => finish({ error: AUTH_ERRORS.pageLoadFailed }))
  })
}
