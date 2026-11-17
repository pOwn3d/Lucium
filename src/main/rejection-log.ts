// A promise that fails with nobody listening becomes, by Node's default, an uncaught exception, and Electron answers that with a native alert in
// the middle of the user's work. Every call the application makes on purpose catches its own failure; this is the net for the one that does not:
// the failure is written to the log with what is known of it, and the application goes on. (The engine test keeps the default: it must fail.)
//
// The same net holds an exception nothing caught (a listener of a timer, of an IPC message, of the engine): `logUncaughtExceptions`. Why going on is
// the policy, and not quitting: Electron's own answer to such an exception is a modal box, after which the process goes on exactly as it does here;
// the net only takes away the box, which blocked the window and came back at every tick of a timer that throws. Going on cannot write a damaged
// state over a good one: the reducer is pure and the store takes its result only once it has returned (a throw leaves the state as it was), every
// file is written aside and renamed in place whole, and a file found unreadable at launch is set aside, never overwritten. And nothing is hidden: the
// stack goes to the log of Settings › Général › État de Lucium, the user is told once per session where to find it (`first`), the failures of the
// files keep their own notices, and the engine test still ends on the first one.

/**
 * `console.error` as it is when a line is written, not when the net is installed: the nets are put in place before main() wraps the console for the
 * log of État de Lucium (error-log.ts), and a function taken then would write past that log.
 */
const consoleError = (...args: unknown[]): void => console.error(...args)

/** How many are written; the next ones are counted in one last line, so that a loop of failures cannot fill the log. */
export const REJECTIONS_LOGGED_MAX = 100
const REASON_MAX_CHARS = 2000

export interface RejectionSource {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

/** What went wrong, as text: the stack of an error, else its message, else whatever was thrown. Never throws, never longer than a few lines. */
export function describeReason(reason: unknown): string {
  let text: string
  try {
    text = reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : typeof reason === 'string' ? reason : JSON.stringify(reason) ?? String(reason)
  } catch (error) {
    // An object that cannot be turned into text (a cycle, no prototype): the log says so instead of losing the line.
    text = `(a ${typeof reason} that cannot be written: ${(error as Error).message})`
  }
  return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS)}…` : text
}

/** Writes each unhandled rejection to the log and keeps going. Answers how many were seen so far (for the tests). */
export function logUnhandledRejections(source: RejectionSource = process, log: (...args: unknown[]) => void = consoleError, uptime: () => number = () => process.uptime()): () => number {
  let seen = 0
  source.on('unhandledRejection', (reason) => {
    seen++
    if (seen <= REJECTIONS_LOGGED_MAX) log(`[main] a promise was rejected and nothing handled it (n° ${seen}, ${Math.round(uptime())} s after launch); the application goes on:`, describeReason(reason))
    else if (seen === REJECTIONS_LOGGED_MAX + 1) log(`[main] more than ${REJECTIONS_LOGGED_MAX} unhandled rejections: the next ones are not written`)
  })
  return () => seen
}

/** How many uncaught exceptions are written; the next ones are counted in one last line. */
export const EXCEPTIONS_LOGGED_MAX = 100

export interface ExceptionSource {
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown
}

/**
 * Writes each exception nothing caught to the log and keeps going (the policy: see the top of this file). `first` is called once, at the first one,
 * after the line is written (main() tells the user there); what it throws is written too, never thrown again. Answers how many were seen so far.
 */
export function logUncaughtExceptions(source: ExceptionSource = process, log: (...args: unknown[]) => void = consoleError, uptime: () => number = () => process.uptime(), first?: () => void): () => number {
  let seen = 0
  source.on('uncaughtException', (error) => {
    seen++
    if (seen <= EXCEPTIONS_LOGGED_MAX) log(`[main] an exception was not caught (n° ${seen}, ${Math.round(uptime())} s after launch); the application goes on:`, describeReason(error))
    else if (seen === EXCEPTIONS_LOGGED_MAX + 1) log(`[main] more than ${EXCEPTIONS_LOGGED_MAX} uncaught exceptions: the next ones are not written`)
    if (seen !== 1 || !first) return
    try {
      first()
    } catch (failure) {
      log('[main] the notice of an uncaught exception could not be shown:', describeReason(failure))
    }
  })
  return () => seen
}
