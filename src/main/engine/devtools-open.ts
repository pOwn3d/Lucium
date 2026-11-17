// Opens the developer tools of a page and brings them to the panel or the mode a command asked for, and says what happened. The page's
// `webContents` is passed in through the small interface below (nothing of Electron is imported: the port stays thin and this is testable).
//
// What was wrong before: the call into the DevTools frontend was made after a fixed 400 ms (too early on a loaded machine: the panel stayed
// the Elements one, or the picking mode was not entered), its failure was only written to the journal, and a window that was not there was
// ignored without a word. Now the call is repeated until the frontend shows what was asked, and every way it can fail comes back as an
// outcome that the shell turns into a notice.

import { devToolsReply, devToolsScript, devToolsStep, type DevToolsFailure, type DevToolsOutcome, type DevToolsRequest } from '@shared/devtools-request'

/** The DevTools window's own page, as far as this needs it. */
export interface DevToolsFrontend {
  isDestroyed(): boolean
  executeJavaScript(code: string): Promise<unknown>
  focus(): void
}

/** The page whose tools these are (an Electron `WebContents` fits). */
export interface DevToolsHost {
  isDevToolsOpened(): boolean
  /** Without a mode, Electron opens the tools on the dock side last used (the one the user chose in them, kept by Chromium). */
  openDevTools(options?: { mode: 'left' | 'right' | 'bottom' | 'undocked' | 'detach' }): void
  inspectElement(x: number, y: number): void
  once(event: 'devtools-opened', listener: () => void): unknown
  removeListener(event: 'devtools-opened', listener: () => void): unknown
  readonly devToolsWebContents: DevToolsFrontend | null
}

export interface DevToolsTiming {
  /** How long the window may take to report that it is open. */
  openMs: number
  /** How long the frontend may take to offer its calls and show what was asked once the window is open. */
  frontendMs: number
  /** The pause between two asks while it does not. */
  retryMs: number
  /** How long what was asked must be still shown before it counts: the frontend restores the panel it was last on when it ends loading, over a call made before. */
  settleMs: number
}

export const DEVTOOLS_TIMING: Readonly<DevToolsTiming> = { openMs: 10_000, frontendMs: 8_000, retryMs: 100, settleMs: 400 }

const fail = (reason: DevToolsFailure, detail?: string): DevToolsOutcome => ({ ok: false, reason, ...(detail === undefined ? {} : { detail }) })
const OK: DevToolsOutcome = { ok: true }
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Runs `start` (which makes the window open) and waits for the window to say it is open. */
function openWith(host: DevToolsHost, start: () => void, timing: DevToolsTiming): Promise<DevToolsOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: DevToolsOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      host.removeListener('devtools-opened', onOpen)
      resolve(outcome)
    }
    const onOpen = (): void => finish(OK)
    const timer = setTimeout(() => finish(fail('not-opened', `no devtools-opened after ${timing.openMs} ms`)), timing.openMs)
    host.once('devtools-opened', onOpen)
    try {
      start()
    } catch (error) {
      finish(fail('not-opened', messageOf(error)))
    }
  })
}

/** Asks the window for a panel or for the picking mode, again and again until its frontend shows it, and still shows it a moment later. */
async function drive(frontend: DevToolsFrontend, request: DevToolsRequest, timing: DevToolsTiming): Promise<DevToolsOutcome> {
  const step = devToolsStep(request)
  if (step.kind === 'raise') return OK
  const deadline = Date.now() + timing.frontendMs
  // The picking mode is a toggle: once it was asked for, the window is only looked at (until it turns out it lost it).
  let asked = false
  const ask = async (call: boolean): Promise<'done' | 'pending' | 'waiting' | DevToolsOutcome> => {
    try {
      return devToolsReply(await frontend.executeJavaScript(devToolsScript(step, { call })))
    } catch (error) {
      return frontend.isDestroyed() ? fail('closed', messageOf(error)) : fail('script', messageOf(error))
    }
  }
  let last = 'waiting'
  for (;;) {
    if (frontend.isDestroyed()) return fail('closed')
    const answer = await ask(!(asked && step.kind === 'inspect'))
    if (typeof answer === 'object') return answer
    last = answer
    if (answer === 'done') {
      // Shown: but a frontend that has not ended loading puts back the panel it was last on. Look again after a moment.
      await pause(timing.settleMs)
      if (frontend.isDestroyed()) return fail('closed')
      const again = await ask(false)
      if (typeof again === 'object') return again
      if (again === 'done') return OK
      last = `${again} after done`
      asked = false
    } else if (answer === 'pending') asked = true
    if (Date.now() >= deadline) return fail('frontend', `the frontend still answers "${last}" after ${timing.frontendMs} ms`)
    await pause(timing.retryMs)
  }
}

/** The window of the tools open on `request`: opened if it was not, shown on its panel, or put in front when only the tools were asked for. Never rejects. */
export async function showDevTools(host: DevToolsHost, request: DevToolsRequest, timing: DevToolsTiming = DEVTOOLS_TIMING): Promise<DevToolsOutcome> {
  const wasOpen = host.isDevToolsOpened()
  if (!wasOpen) {
    const opened = await openWith(host, () => host.openDevTools(), timing)
    if (!opened.ok) return opened
  }
  const frontend = host.devToolsWebContents
  if (!frontend || frontend.isDestroyed()) return fail('closed', 'the window of the tools is gone')
  // Already open and only the tools asked for: bring them forward; freshly opened, they are in front already.
  if (wasOpen && devToolsStep(request).kind === 'raise') {
    try {
      frontend.focus()
    } catch (error) {
      return fail('script', messageOf(error))
    }
  }
  return drive(frontend, request, timing)
}

/**
 * "Inspecter l'élément": the tools open (if they were not) on the element at this point of the page, as the page shows it. Never rejects.
 * `inspectElement` alone opens them docked into the window (measured: as big as the page they inspect, and in the way of it) when the
 * window is not open yet: it is opened first, with the dock side last chosen (see showDevTools), and then pointed at the element.
 */
export async function inspectDevToolsAt(host: DevToolsHost, point: { x: number; y: number }, timing: DevToolsTiming = DEVTOOLS_TIMING): Promise<DevToolsOutcome> {
  const inspect = (): void => host.inspectElement(point.x, point.y)
  if (!host.isDevToolsOpened()) {
    return openWith(
      host,
      () => {
        host.openDevTools()
        inspect()
      },
      timing
    )
  }
  try {
    inspect()
    return OK
  } catch (error) {
    return fail('script', messageOf(error))
  }
}
