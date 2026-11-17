// Loaded into the main frame of every web page (registered by the engine, see electron-engine-preloads.ts; Electron loads a preload into the main
// frame only, so the frames of a page keep Electron's own functions: a native sheet for `alert()` and `confirm()`, a `prompt()` that answers null
// without showing anything).
// Electron does not show the box of `window.prompt()`, so a site that asks for a value that way (a master password, a name) gets nothing and
// stops; and it shows `alert()` and `confirm()` as a sheet of macOS that does not say which site asks, and that a tab behind the one on screen can
// put over it. This replaces the three functions in the main world with functions that ask the main process, which puts a box of ours over the
// tab of the page (once that tab is on screen) and answers once the user has. The page waits for it, as it does in any browser: the message is
// synchronous (`ipcRenderer.sendSync`), so the page's script does not go on before the answer, and the main process answers late (`returnValue`).
// The page sees functions named `alert`, `confirm` and `prompt`, plain properties of `window` that it can still assign to. It is given no other way
// to the main process: the channels live in this isolated world, and the main process checks who sends on them (engine/electron-engine-preloads.ts).

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE_DIALOG, bridgedDialogsOf, dialogPayloadOf, isDialogNative, isPageDialogKind, isPromptStopped, pageResultOf, type PageDialogKind } from '../shared/page-dialog'
import { canReachMainWorld } from './main-world'

type Ask = (kind: PageDialogKind, message: string, defaultValue: string) => unknown

/** Self-contained on purpose: Electron serializes this function and runs it in the main world, before the scripts of the page. */
function mainWorldDialogs(ask: Ask, kinds: readonly PageDialogKind[]): void {
  // Taken now: a page that replaces them later must not be able to steer the calls below.
  const applyNative = Reflect.apply
  const currentEvent = Object.getOwnPropertyDescriptor(window, 'event')?.get
  const typeOfEvent = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  // Chromium shows no box from the handler of an event of a page being left (`beforeunload`, `pagehide`, `unload`): the call returns at once. So do
  // these, without a message, or a page could hold the user on the way out. Read on the event being handled, not on a flag set by a listener of
  // ours: a listener for those events would keep the page out of the back-forward cache, or make every navigation wait for the page.
  const leaving = (): boolean => {
    const event: unknown = currentEvent ? applyNative(currentEvent, window, []) : undefined
    if (typeof event !== 'object' || event === null || !typeOfEvent || (event as Event).isTrusted !== true) return false
    const type: unknown = applyNative(typeOfEvent, event, [])
    return type === 'beforeunload' || type === 'pagehide' || type === 'unload'
  }
  // The arguments as each function converts them: alert() with none shows nothing, alert(undefined) shows "undefined" (an overload of its own); the
  // arguments of confirm() and prompt() are optional strings, so undefined is "". Anything else is converted to text (null is "null", a symbol throws).
  const textsOf: Record<PageDialogKind, (args: unknown[]) => [string, string]> = {
    alert: (args) => [args.length === 0 ? '' : `${args[0]}`, ''],
    confirm: (args) => [args[0] === undefined ? '' : `${args[0]}`, ''],
    prompt: (args) => [args[0] === undefined ? '' : `${args[0]}`, args[1] === undefined ? '' : `${args[1]}`]
  }
  // What each one returns without a box: the answer of a cancel.
  const quiet: Record<PageDialogKind, unknown> = { alert: undefined, confirm: false, prompt: null }
  const own = window as unknown as Record<PageDialogKind, unknown>
  for (const kind of kinds) {
    const native = own[kind]
    if (typeof native !== 'function') continue
    own[kind] = new Proxy(native as (...args: unknown[]) => unknown, {
      apply(target, thisArg, args: unknown[]) {
        // A call on anything but the window is not a call of the page's own function: the native one answers it.
        if (thisArg !== undefined && thisArg !== null && thisArg !== window) return applyNative(target, thisArg, args)
        const [message, defaultValue] = textsOf[kind](args)
        return leaving() ? quiet[kind] : ask(kind, message, defaultValue)
      }
    })
  }
}

/** Electron's own alert() and confirm() of this document, taken before anything else runs: what a call gets when Lucium has no box for it. */
const nativeOf = { alert: window.alert, confirm: window.confirm }

/**
 * The user ticked "stop this page" (the main process said so in a reply): this document gets the answer of a cancel at once from now on, without a
 * message, whichever of the three functions it calls. This preload runs again for each document, as the main process starts a new count for each
 * (`DialogGuard.reset`).
 */
let stopped = false

/** The page's own function: Electron's sheet for alert() and confirm(), null for prompt() (Electron shows nothing for it). */
function withoutBox(kind: PageDialogKind, message: string): string | boolean | null | undefined {
  const native = kind === 'prompt' ? undefined : nativeOf[kind]
  return typeof native === 'function' ? (Reflect.apply(native, window, [message]) as boolean | undefined) : pageResultOf(kind, null)
}

/** Waits for the user. The page gets what its call returns: nothing for alert(), true or false for confirm(), a string or null for prompt(). */
function ask(kind: unknown, message: string, defaultValue: string): string | boolean | null | undefined {
  // Only the functions of the main world above call this, with their own name.
  if (!isPageDialogKind(kind)) return undefined
  if (stopped) return pageResultOf(kind, null)
  let reply: unknown
  try {
    reply = ipcRenderer.sendSync(PAGE_DIALOG[kind], dialogPayloadOf(kind, message, defaultValue))
  } catch (error) {
    // What the page had before the bridge; the console says why it did not work.
    console.warn(`[lucium] ${kind}() could not reach the browser:`, error instanceof Error ? error.message : String(error))
    return withoutBox(kind, message)
  }
  if (isPromptStopped(reply)) stopped = true
  return isDialogNative(reply) ? withoutBox(kind, message) : pageResultOf(kind, reply)
}

// A document without context isolation (an offscreen document of an extension) is not a tab: it keeps its functions, and `contextBridge` would only refuse (main-world.ts).
if (canReachMainWorld()) {
  try {
    contextBridge.executeInMainWorld({ func: mainWorldDialogs, args: [ask, bridgedDialogsOf(window.origin, window.location.protocol)] })
  } catch (error) {
    // A document without a main world to patch (a sandboxed frame, a page being replaced): it keeps the functions it has.
    console.warn('[lucium] the dialog bridge could not be installed in this frame:', error instanceof Error ? error.message : String(error))
  }
}
