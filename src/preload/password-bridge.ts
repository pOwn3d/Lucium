// Loaded into the main frame of the web pages of normal tabs while the password manager is on (registered by the engine, see
// electron-engine.ts `setPasswordBridge`; Electron loads a preload into the main frame only, and private contexts never get this one).
// It does one thing: when the user submits a form that holds a password they typed, it tells the main process the username and the password,
// so that the main process can OFFER to save them. It fills nothing, answers nothing and has no way to be asked anything: the only channel is
// this one message, from here to the main process, which checks the sender (engine/password-bridge.ts) and never takes an origin from it.
//
// A submission counts only when the browser itself made the event (`isTrusted`) and the user touched the page a moment before (transient
// user activation): a page that calls `requestSubmit()` on its own, or builds events, is not heard. The listener is passive and takes no
// decision for the page: it never calls `preventDefault`, so a second password manager (an extension) sees the same form it would have seen.

import { ipcRenderer } from 'electron'
import { loginToolkit } from '../shared/login-form'
import { PASSWORD_BRIDGE, mayReportSubmit } from '../shared/passwords'

// The page's own world: these are globals here, not imports (the node build has no DOM library).
declare const document: any
declare const window: any
declare const navigator: any
declare const HTMLFormElement: any

function onSubmit(event: any): void {
  try {
    if (!mayReportSubmit(event, navigator)) return
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const seen = loginToolkit(window, document).capture(form)
    if (seen === null) return
    ipcRenderer.send(PASSWORD_BRIDGE.submitted, { username: seen.username, password: seen.password })
  } catch (error) {
    // A form this cannot read is a form that gets no offer to save; the page is not told, and nothing of its values is written to the console.
    console.warn('[lucium] a submitted form could not be read:', error instanceof Error ? error.name : typeof error)
  }
}

document.addEventListener('submit', onSubmit, { capture: true, passive: true })
