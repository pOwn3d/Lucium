// The first page of a profile made after the start and the extensions that profile loads (folders loaded by hand are inherited by every new
// profile): an extension that arrives while the page is loading can cut its first request, so the page waits for the loads, for a few seconds at
// most. The engine (electron-engine.ts, `ensureProfile`) starts the loads and hands them here.

/** The longest the first page of a profile waits for its extensions: a slow or stuck load must not hold a page for ever. */
export const PROFILE_READY_MAX_MS = 4000

/**
 * What the first page of a profile waits for: every load in `loads` has ended (well or not), or `maxMs` has passed. It is null when there
 * is nothing to load, so that a profile without an extension costs its pages nothing (no promise, no timer). It never rejects; a wait
 * that ran out is logged, with `what` to say which profile.
 */
export function profileReady(loads: ReadonlyArray<Promise<unknown>>, maxMs: number, what: string): Promise<void> | null {
  if (loads.length === 0) return null
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[engine] ${what}: the extensions are still loading after ${maxMs} ms, so its pages go on without waiting for them`)
      resolve()
    }, maxMs)
    // The wait is not a reason to keep the process alive.
    timer.unref()
    void Promise.allSettled(loads).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
