// A page of the interface whose renderer died (a crash, the system ending it for memory) leaves its surface blank: nothing of the state is lost (it
// lives in the main process, store.ts), but the sidebar, the overlay or Settings no longer answer until Lucium is started again. The page is loaded
// again instead: the same web contents (so the same id, the one the IPC scope trusts), a new renderer, which asks for the snapshot as at start-up.
// A page that dies again and again is not reloaded for ever: at most UI_RELOADS_MAX times in UI_RELOAD_WINDOW_MS, then it is left as it is, the
// log says so and the user is told once (`giveUp`): a blank window with no word would look like lost tabs. Listens to the surfaces of the interface only (main/index.ts, `load`); a crashed web page has its own page (engine/error-pages.ts).

import { isCrash } from '@shared/error-pages'

/** The most reloads of one page within UI_RELOAD_WINDOW_MS: a fourth death in a minute is a page that cannot live, not an accident. */
export const UI_RELOADS_MAX = 3
export const UI_RELOAD_WINDOW_MS = 60_000

/** What the reload needs of a web contents. */
export interface CrashSource {
  on(event: 'render-process-gone', listener: (event: unknown, details: { reason: string }) => void): unknown
  isDestroyed(): boolean
  reload(): void
}

export interface CrashReloadDeps {
  now: () => number
  /** Runs the reload after the event has returned: the renderer is not started again from inside the notice of its end. */
  later: (run: () => void) => void
  log: (line: string) => void
  /** Tells the user that the page is no longer loaded again and that Lucium must be started again. Called once per run of deaths, not at each one. */
  giveUp?: (page: string) => void
}

export const CRASH_RELOAD_DEFAULTS: CrashReloadDeps = {
  now: () => Date.now(),
  later: (run) => void setTimeout(run, 0),
  log: (line) => console.error(line)
}

const watched = new WeakSet<object>()

/** Loads the interface page `page` of `contents` again each time its renderer dies, within the bound (once per web contents: a second call does nothing). */
export function reloadUiAfterCrash(contents: CrashSource, page: string, deps: CrashReloadDeps = CRASH_RELOAD_DEFAULTS): void {
  if (watched.has(contents)) return
  watched.add(contents)
  const reloads: number[] = []
  let told = false
  contents.on('render-process-gone', (_event, details) => {
    // A renderer that ended cleanly (the surface closing, the application quitting) is not a death to repair.
    if (!isCrash(details.reason)) return
    const now = deps.now()
    while (reloads.length > 0 && now - reloads[0]! >= UI_RELOAD_WINDOW_MS) reloads.shift()
    if (reloads.length >= UI_RELOADS_MAX) {
      deps.log(`[ui] the ${page} page ended again (${details.reason}): ${UI_RELOADS_MAX} reloads in a minute, it is left as it is until Lucium restarts`)
      if (!told) deps.giveUp?.(page)
      told = true
      return
    }
    told = false
    reloads.push(now)
    deps.log(`[ui] the ${page} page ended (${details.reason}): loading it again`)
    deps.later(() => {
      if (!contents.isDestroyed()) contents.reload()
    })
  })
}
