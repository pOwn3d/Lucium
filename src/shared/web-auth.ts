// The rules of the window chrome.identity.launchWebAuthFlow opens, as pure functions. The window has no address bar and shows a page an
// extension chose, so what it says about where it is, how many of them can exist, and when one may appear are not left to the page.

import { t } from './i18n'

/** At most this many flows at once in the whole application, and one per extension. */
export const MAX_AUTH_FLOWS = 4

/** How long a click or a key press counts as "the user just did something" for a flow that shows a window. */
export const GESTURE_WINDOW_MS = 10_000

/**
 * The title of the window: fixed words and the host of the page it is on now (punycode, as the network sees it, so that a look-alike
 * name does not read as the real one). The page's own `<title>` never reaches the window.
 */
export function authWindowTitle(url: string): string {
  return t('web-auth.connexion-host', { host: URL.canParse(url) ? new URL(url).host : t('web-auth.adresse-inconnue') })
}

const GESTURE_INPUTS = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart'])

/**
 * Whether an input event that reached a page is the user acting. While a debugger is attached to the page the event may be the
 * debugger's own: `Input.dispatchMouseEvent` of the DevTools protocol raises the same event as a click, and an extension that
 * attaches one could otherwise press, for itself, the button that installs an extension or opens a sign-in window. `attached` is
 * asked only for the inputs that could count.
 */
export function countsAsGesture(inputType: string, attached: () => boolean): boolean {
  return GESTURE_INPUTS.has(inputType) && !attached()
}

/** Whether the user did something (a click, a key press) recently enough for an extension to be allowed to put a window in front of them. */
export function recentGesture(lastGestureAt: number, now: number): boolean {
  return lastGestureAt > 0 && now - lastGestureAt >= 0 && now - lastGestureAt <= GESTURE_WINDOW_MS
}

/** Which flows are running: one per extension, a few in all. */
export class AuthFlowLimiter {
  private readonly running = new Set<string>()

  constructor(private readonly max = MAX_AUTH_FLOWS) {}

  /** Returns what ends the flow, or null when the extension already has one or the application has too many. */
  acquire(extensionId: string): (() => void) | null {
    if (this.running.has(extensionId) || this.running.size >= this.max) return null
    this.running.add(extensionId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.running.delete(extensionId)
    }
  }

  count(): number {
    return this.running.size
  }
}
