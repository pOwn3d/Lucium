// The engine tests (`--smoke`): which suites run, in which order, and the exit code of the run. main/index.ts loads this module by import() only when
// --smoke is passed, so it is a chunk of its own that the package leaves out with the suites it loads (electron-builder.yml, test-code-split.test.ts).
// The suites themselves are declared in smoke-suites.ts; what a run does with them (the time limit, the count, the summary) is in smoke-kit.ts,
// which the unit tests run.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { app, clipboard, ClipboardItem, screen, systemPreferences, type ClipboardBookmark } from 'electron'
import { screenOf, withPanelSize, type PanelSizes } from '@shared/panel-scale'
import type { SmokeContext } from './smoke'
import {
  chooseSuite,
  closeLeftoverPanels,
  exitCodeOf,
  keepClipboard,
  PINNED_SETTINGS,
  runChain,
  RunStop,
  runReportOf,
  readSkips,
  runSuite,
  saveReport,
  suiteTimeoutMs,
  summaryOf,
  watchRun,
  type ClipboardPort,
  type SuiteOutcome
} from './smoke-kit'
import { CHAIN, SUITES, type SuiteEntry } from './smoke-suites'

/**
 * What the checks assume of the machine they run on, pinned first in the throw-away profile, since the defaults depend on it:
 * - the size of the panels is 100 %: the checks measure panels and windows in the CSS pixels they were drawn in and click at those places with real mouse events.
 *   The default, « Automatique », gives a larger or a smaller size by the screen the run happens to be on (Settings › Apparence › Taille des fenêtres et des panneaux),
 *   so every screen of this machine is pinned to 100 % (the sizes themselves are checked by the unit tests of shared/panel-scale.ts);
 * - the language and the appearance: PINNED_SETTINGS (smoke-kit.ts) says which and why.
 */
function pinTestLook({ browser, store }: SmokeContext): void {
  let sizes: PanelSizes = store.get().settings.panelSizes
  for (const display of screen.getAllDisplays()) {
    const info = screenOf(display)
    if (info !== null) sizes = withPanelSize(sizes, info, 100, Date.now())
  }
  browser.dispatch({ type: 'settings/update', patch: { panelSizes: sizes, ...PINNED_SETTINGS } })
}

/** The real clipboard of the Mac, for `keepClipboard` (smoke-kit.ts): the suites write to it, and it is put back after each of them. */
const systemClipboard: ClipboardPort<Blob | ClipboardBookmark> = {
  read: () => clipboard.read(),
  write: (entries) => clipboard.write(entries.map((forms) => new ClipboardItem(forms))),
  clear: () => clipboard.clear()
}

/**
 * Runs one suite of the table under its time limit, then puts back what it must not leave behind: the panels it left over the window are closed, so
 * that the next suite starts from a window with nothing over it, and the clipboard of the Mac is what it was before the run.
 */
async function runEntry(entry: SuiteEntry, smokeContext: SmokeContext, fromEnv: string[], putClipboardBack: () => Promise<void>, stop: RunStop): Promise<SuiteOutcome> {
  const outcome = await runSuite(entry.name, () => entry.run(smokeContext, fromEnv), suiteTimeoutMs(entry.timeoutMs, process.env['LUCIUM_SMOKE_SUITE_TIMEOUT_MS']), console.log, stop)
  const leftover = closeLeftoverPanels(smokeContext.browser)
  if (leftover.length > 0) console.log(`[smoke] the suite "${entry.name}" left ${leftover.length} panel(s) open, closed now: ${leftover.join(', ')}`)
  await putClipboardBack()
  return outcome
}

/** LUCIUM_SMOKE_REPORT=<file> keeps the report of the run there, for `pnpm compat:compare`. Answers false when it could not be written. */
function writeReport(smokeContext: SmokeContext, outcomes: readonly SuiteOutcome[]): boolean {
  return saveReport(process.env['LUCIUM_SMOKE_REPORT'], runReportOf(smokeContext.engine.info(), outcomes), (file, text) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  })
}

/** Runs the suite LUCIUM_SMOKE_ONLY names (the whole chain when it is not set), then quits with the exit code of the run. `fromEnv` is the list of the
 *  extensions loaded from LUCIUM_EXTENSIONS (main/index.ts). */
export async function runSmokeSuites(smokeContext: SmokeContext, fromEnv: string[]): Promise<void> {
  const { store, history } = smokeContext
  const choice = chooseSuite(process.env['LUCIUM_SMOKE_ONLY'], SUITES.map((suite) => suite.name))
  if (choice.kind === 'unknown') {
    console.error(`[smoke] ${choice.message}`)
    app.exit(2)
    return
  }
  const only = choice.kind === 'only' ? SUITES.find((suite) => suite.name === choice.name) : undefined
  // The measurements of `pnpm perf` and of the site icons are those of the screen and the settings they run on.
  if (only?.name !== 'perf' && only?.name !== 'favicons-measure') pinTestLook(smokeContext)
  // A driver waits to be stopped or only measures: no time limit, no count, its own exit code.
  if (only?.driver) {
    app.exit(await only.run(smokeContext, fromEnv))
    return
  }
  const skips = readSkips(process.env['LUCIUM_SMOKE_SKIP'], SUITES.map((suite) => suite.name))
  if (skips.unknown.length > 0) {
    console.error(`[smoke] LUCIUM_SMOKE_SKIP names no suite: ${skips.unknown.join(', ')}. A part of the principal suite is main:<part>.`)
    app.exit(2)
    return
  }
  // An explicit LUCIUM_SMOKE_ONLY runs its suite whatever the list says; the chain leaves out the suites of the list.
  const entries = only ? [only] : CHAIN.filter((suite) => !skips.suites.has(suite.name))
  if (!only && (skips.suites.size > 0 || skips.parts.size > 0)) console.log(`[smoke] left out on request (LUCIUM_SMOKE_SKIP): ${[...skips.suites, ...[...skips.parts].map((part) => `main:${part}`)].join(', ')}`)
  const putClipboardBack = await keepClipboard(systemClipboard)
  // The run stops when the Mac sleeps, locks its screen or puts its displays to sleep, or when the application is asked to quit (smoke-kit.ts).
  const stop = new RunStop()
  const unwatch = watchRun(stop, {
    platform: process.platform,
    preferences: systemPreferences,
    app,
    now: Date.now,
    every: (ms, tick) => {
      const timer = setInterval(tick, ms)
      return () => clearInterval(timer)
    }
  })
  // A process that ends by another way than the app.exit below (one that emits Node's `exit`) still leaves the report of the suites already made, and
  // says it in the log: the comparison then names the suites that did not run, instead of finding no report.
  const made: SuiteOutcome[] = []
  const leaving = (): void => {
    console.error(`[smoke] the process is ending before the end of the run, after ${made.length} of its ${entries.length} suites`)
    writeReport(smokeContext, made)
  }
  process.once('exit', leaving)
  const outcomes = await runChain(
    entries,
    async (entry) => {
      const outcome = await runEntry(entry, smokeContext, fromEnv, putClipboardBack, stop)
      made.push(outcome)
      return outcome
    },
    stop
  )
  unwatch()
  process.off('exit', leaving)
  store.flush()
  history.flush()
  const stopped = stop.reason()
  for (const line of summaryOf(outcomes, stopped === null ? undefined : { reason: stopped, suites: entries.length })) console.log(line)
  // A report that could not be written fails the run: the comparison would read an older one.
  const written = writeReport(smokeContext, outcomes)
  app.exit(written ? exitCodeOf(outcomes, stopped !== null) : 1)
}
