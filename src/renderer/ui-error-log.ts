// The log of the errors of a page of the interface: `[ui]` lines of its console, which the main process relays to its own log (Settings › Général ›
// État de Lucium, shell/ui-error-relay.ts). Apart from the root of the React surfaces (root.tsx), which uses it, so that a page with no React (the
// command window of the annotated share) writes its errors the same way without loading React for it.

import { UI_ERROR_PREFIX } from '@shared/ui-errors'

/** How many errors of a page are written to the log before it stops: a loop of failures cannot fill it. */
export const UI_ERRORS_LOGGED_MAX = 50

/** What an error event or a rejection says, on one line: the stack of an error, else its message, else the value. Never throws. */
export function describeUiError(reason: unknown): string {
  try {
    if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`
    return typeof reason === 'string' ? reason : (JSON.stringify(reason) ?? String(reason))
  } catch {
    return `(a ${typeof reason} that cannot be written)`
  }
}

/**
 * What an `error` event says, on one line. The error it carries when there is one (its stack); otherwise the event's own message and the place it
 * names. The engine hands `null` for an error it does not show (a script of another origin, the loop of a `ResizeObserver`): the message is all
 * there is then. A value thrown that is not an error (`throw 'text'`) is added after the place when the message does not already say it. Never throws.
 */
export function describeErrorEvent(event: Partial<ErrorEvent>): string {
  try {
    const thrown: unknown = event.error
    if (thrown instanceof Error) return describeUiError(thrown)
    const where = `${String(event.message ?? '')} (${String(event.filename || '?')}:${String(event.lineno ?? 0)})`
    if (thrown === null || thrown === undefined) return where
    const value = describeUiError(thrown)
    return where.includes(value) ? where : `${where}: ${value}`
  } catch (error) {
    return `(an error event that cannot be read: ${describeUiError(error)})`
  }
}

/** Writes the errors nothing caught in this page (`error`, `unhandledrejection`) to the console as `[ui]` lines, for the log of the main process. Answers how many were seen. */
export function installUiErrorLog(target: Pick<EventTarget, 'addEventListener'> = window, log: (...args: unknown[]) => void = console.error): () => number {
  let seen = 0
  const write = (what: string, detail: string): void => {
    seen++
    if (seen <= UI_ERRORS_LOGGED_MAX) log(`${UI_ERROR_PREFIX} ${what}:`, detail)
    else if (seen === UI_ERRORS_LOGGED_MAX + 1) log(`${UI_ERROR_PREFIX} more than ${UI_ERRORS_LOGGED_MAX} errors in this page: the next ones are not written`)
  }
  target.addEventListener('error', (event) => {
    write('an error was not caught', describeErrorEvent(event as Partial<ErrorEvent>))
  })
  target.addEventListener('unhandledrejection', (event) => write('a promise was rejected and nothing handled it', describeUiError((event as Partial<PromiseRejectionEvent>).reason)))
  return () => seen
}
