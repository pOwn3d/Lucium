// Loaded into the main frame of every web page (registered by the engine, see electron-engine.ts), except on the sign-in hosts of Google, where the page sees Electron as it is (shared/google-sign-in.ts).
// Chromium-based browsers give every web page `window.chrome.app`; Electron's `window.chrome` is an empty object. A large sign-in service looks for it: with a Gmail address typed in, a page without
// it answers "Impossible de vous connecter: ce navigateur ou cette application ne sont peut-être pas sécurisés", and the same page takes the address once `chrome.app` is there
// (measured in a throw-away instance; the user agent, the client hints and `chrome.csi` / `chrome.loadTimes` made no difference). The same refusal ends every
// "Se connecter avec Google" of the sites that offer it (Slack, claude.ai…).
// This defines `chrome.app` as those browsers do for a page that is not an installed web app, before the scripts of the page run. Nothing else of `window.chrome` changes.
// The same preload gives the page what it reads of a permission nobody answered yet (permission-state.ts, installed at the end of this file).

import { contextBridge } from 'electron'
import { canReachMainWorld } from './main-world'
import { mainWorldPermissionState, undecided } from './permission-state'

/** Self-contained on purpose: Electron serializes this function and runs it in the main world, before the scripts of the page. */
function mainWorldChromeApp(): void {
  // The pages of an extension have the real `chrome` (frozen, with `runtime`): it is not ours to touch.
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  try {
    const g = globalThis as { chrome?: Record<string, unknown> }
    if (typeof g.chrome !== 'object' || g.chrome === null) Object.defineProperty(g, 'chrome', { value: {}, writable: true, enumerable: true, configurable: true })
    const chrome = g.chrome!
    if ('app' in chrome) return
    // A page is never an installed app, and cannot run as one.
    const app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails(): null {
        return null
      },
      getIsInstalled(): boolean {
        return false
      },
      installState(callback?: (state: string) => void): void {
        if (typeof callback === 'function') setTimeout(() => callback('not_installed'), 0)
      },
      runningState(): string {
        return 'cannot_run'
      }
    }
    Object.defineProperty(chrome, 'app', { value: app, writable: true, enumerable: true, configurable: true })
  } catch (error) {
    // The page keeps the `chrome` it has; the console of the page says why.
    console.warn('[lucium] window.chrome.app could not be set up:', error instanceof Error ? error.message : String(error))
  }
}

// A document without context isolation (an offscreen document of an extension) is no web page, and both functions leave a page that is not http(s) alone anyway:
// `contextBridge` would only refuse there (main-world.ts).
if (canReachMainWorld()) {
  try {
    contextBridge.executeInMainWorld({ func: mainWorldChromeApp })
  } catch (error) {
    console.warn('[lucium] window.chrome.app could not be reached in the page:', error instanceof Error ? error.message : String(error))
  }

  // The other thing a page of those browsers reads and a page of Electron does not: a permission nobody answered yet (permission-state.ts).
  // It rides in this preload rather than in one of its own: every web page loads this one already.
  try {
    contextBridge.executeInMainWorld({ func: mainWorldPermissionState, args: [undecided] })
  } catch (error) {
    console.warn('[lucium] the state of the permissions could not be reached in the page:', error instanceof Error ? error.message : String(error))
  }
}
