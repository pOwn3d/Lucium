// A wait with a limit, for a page that may never answer (shell/browser-sleep.ts): pure, the clock is the one of the caller.

/** What `withDeadline` gives when the limit came before the work. */
export const TIMED_OUT = Symbol('timed-out')

/**
 * Runs `work` and resolves with its result, or with `TIMED_OUT` once `ms` have passed: the caller goes on without it. The work cannot be stopped, so it is
 * told when its time is up (`expired()`) and must then do nothing more that matters. A failure after the limit is only logged (nobody waits for it any more);
 * a failure before it is the caller's, as without a limit.
 */
export function withDeadline<T>(ms: number, work: (expired: () => boolean) => Promise<T>): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    let over = false
    const timer = setTimeout(() => {
      over = true
      resolve(TIMED_OUT)
    }, ms)
    work(() => over).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        if (over) console.warn('[deadline] the work failed after its time was up:', error instanceof Error ? error.message : String(error))
        else reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}
