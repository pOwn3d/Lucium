// What every engine check (src/main/smoke*.ts) waits with: a pause, and a condition looked at again and again until it holds or the time is
// up (each suite used to have its own copy). Only the suites import it, so it lands in a smoke*.js chunk that the package leaves out
// (electron-builder.yml, test-code-split.test.ts). No Electron here.

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** True as soon as `condition` holds, looked at every `stepMs`; after `timeoutMs`, the answer of one last look. */
export async function pollUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number, stepMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await sleep(stepMs)
  }
  return condition()
}

/** The `waitFor` of a suite: `pollUntil` with the time it gives a condition by default and how often it looks (each suite keeps its own). */
export function waiterOf(defaultTimeoutMs: number, stepMs: number): (condition: () => boolean | Promise<boolean>, timeoutMs?: number) => Promise<boolean> {
  return (condition, timeoutMs = defaultTimeoutMs) => pollUntil(condition, timeoutMs, stepMs)
}

/**
 * A script for a page of the interface that unfolds every folded section of the site panel (the site control center keeps its sections folded until a
 * person opens one, and the rows the checks look for are inside them). Answers how many sections the panel has.
 */
const OPEN_SITE_SECTIONS = `(() => { for (const head of document.querySelectorAll('.scc-section-head[aria-expanded="false"]')) head.click(); return document.querySelectorAll('.scc-section-head').length })()`

/** Whether every section of the site panel is open. */
const SITE_SECTIONS_OPEN = `(() => { const heads = [...document.querySelectorAll('.scc-section-head')]; return heads.length > 0 && heads.every((head) => head.getAttribute('aria-expanded') === 'true') })()`

/**
 * Opens every section of the site panel and makes sure they stay open: the overlay mounts its panel again when it is asked for, and a section opened before that
 * is folded again with the new panel, so the sections are opened again until they are all open. `run` evaluates a script in the page of the overlay.
 */
export async function openSiteSections(run: (script: string) => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await run(OPEN_SITE_SECTIONS)
    await sleep(250)
    if ((await run(SITE_SECTIONS_OPEN)) === true) return true
  }
  return false
}

/** A leftover panel as the log names it: the panel, and the host (and realm) of the question it asks, so that the suite that left it can be found. */
function leftoverName(panel: string, overlay: unknown): string {
  const request = (overlay as { request?: { host?: unknown; realm?: unknown } } | null | undefined)?.request
  if (request?.host === undefined) return panel
  return `${panel} ${String(request.host)} ${String(request.realm ?? '')}`.trimEnd()
}

/**
 * Closes what an earlier suite left over the window: an open panel, and the questions queued behind it, each of which shows as the one before it
 * closes (a sign-in asked by a tab left on a 401, a list left open). A suite that reads `currentPanel()` or asks a question of its own starts from a
 * window with nothing over it; a question closed this way is a refusal. Answers the panels it closed, for the log (at most `most`), each with the host
 * of its question when the window tells it (`currentOverlay`).
 */
export function closeLeftoverPanels(browser: { currentPanel(): string | null; closeOverlay(): void; currentOverlay?(): unknown }, most = 20): string[] {
  const closed: string[] = []
  for (let panel = browser.currentPanel(); panel !== null && closed.length < most; panel = browser.currentPanel()) {
    closed.push(leftoverName(panel, browser.currentOverlay?.()))
    browser.closeOverlay()
  }
  return closed
}

// ---------------------------------------------------------------- the checks of a suite ----------------------------------------------------------------

/** One check as the report of a suite keeps it. `skipped` marks a check that was not made, with the reason in `detail`: it is neither a pass nor a failure. */
export interface CheckRecord {
  name: string
  ok: boolean
  detail?: string | undefined
  skipped?: true
}

export type CheckFn = (name: string, ok: boolean, detail?: string) => void

/** What a suite counted: every check, those that failed, those that were not made. */
export interface Tally {
  checks: number
  failed: number
  skipped: number
}

const SKIP_MARK = 'skipped: '

/**
 * The detail of a check that was not made: `check(name, true, skippedBecause('no system voice'))`. The check is then counted as skipped, written as such
 * to the log and to the report, and is no pass: a suite all of whose checks are skipped has verified nothing, and the summary of the run says so.
 */
export const skippedBecause = (reason: string): string => `${SKIP_MARK}${reason}`

/** What a suite leaves to the run: its count, its checks in the order they were made, and the facts it measured without judging them. */
export interface Ledger {
  tally: Tally
  records: CheckRecord[]
  facts: Record<string, unknown>
}

const newLedger = (): Ledger => ({ tally: { checks: 0, failed: 0, skipped: 0 }, records: [], facts: {} })

let currentLedger: Ledger = newLedger()

/** Starts the ledger of a new suite and answers it. The recorders made from now on write there; those of an earlier suite keep writing in theirs. */
export function beginLedger(): Ledger {
  currentLedger = newLedger()
  return currentLedger
}

/**
 * A fact a suite measured and does not judge (which chrome.* APIs the probe found, whether a request rule was applied): it goes to the report of
 * the run, where `pnpm compat:compare` sets it against the reference of the engine.
 */
export function reportFact(key: string, value: unknown): void {
  currentLedger.facts[key] = value
}

/** Where the lines of the log go. The engine run writes them as they come, so that a suite that never returns leaves its last check to read. */
type Write = (line: string) => void

/** Keeps a check in `checks`, counts it and writes it to the log at once. */
export function noteCheck(checks: CheckRecord[], name: string, ok: boolean, detail?: string, write: Write = console.log, ledger: Ledger = currentLedger): void {
  const skipped = ok && detail !== undefined && detail.startsWith(SKIP_MARK)
  const { tally } = ledger
  tally.checks++
  if (!ok) tally.failed++
  if (skipped) tally.skipped++
  const kept: CheckRecord = skipped ? { name, ok, detail, skipped: true } : { name, ok, detail }
  checks.push(kept)
  ledger.records.push(kept)
  write(`[smoke] ${skipped ? 'skip' : ok ? 'ok  ' : 'FAIL'} ${name}${(ok && !skipped) || detail === undefined ? '' : ` -- ${detail}`}`)
}

/** The `check` of a suite: every check goes to `checks`, to the count of the suite that is running and to the log, as it is made. */
export function recorderOf(checks: CheckRecord[], write: Write = console.log): CheckFn {
  const ledger = currentLedger
  return (name, ok, detail) => noteCheck(checks, name, ok, detail, write, ledger)
}

/**
 * The probe extensions a suite cannot do without, by the name of their manifest: one check for each, failed when it is not loaded. A suite that
 * returned without a word when its probe was missing passed with nothing verified (a manifest the engine refuses after an upgrade, a LUCIUM_EXTENSIONS
 * of one's own). Answers whether they are all there.
 */
export function requireProbes(loaded: ReadonlyArray<{ name: string }>, names: readonly string[], check: CheckFn): boolean {
  let all = true
  for (const name of names) {
    const found = loaded.some((extension) => extension.name === name)
    check(`the probe extension "${name}" is loaded`, found, found ? undefined : `loaded: ${loaded.map((extension) => extension.name).join(', ') || 'none'} (LUCIUM_EXTENSIONS must name its folder of compat/)`)
    all &&= found
  }
  return all
}

/**
 * One check for a folder of LUCIUM_EXTENSIONS: the extension its manifest names is among the loaded ones. The folder is looked for by that name,
 * since the check it replaces passed for every folder as soon as any one extension was loaded. A manifest that cannot be read is a failed check.
 */
export function checkExtensionFolder(path: string, loaded: ReadonlyArray<{ name: string; version?: string }>, check: CheckFn, read: (file: string) => string): void {
  const folder = path.split('/').filter(Boolean).pop() ?? path
  let name: unknown
  try {
    name = (JSON.parse(read(`${path.replace(/\/+$/, '')}/manifest.json`)) as { name?: unknown }).name
  } catch (error) {
    check(`extension loaded: ${folder}`, false, `its manifest cannot be read: ${String((error as Error)?.message ?? error)}`)
    return
  }
  check(`extension loaded: ${folder}`, typeof name === 'string' && loaded.some((extension) => extension.name === name), `"${String(name)}" among ${loaded.map((extension) => `${extension.name}@${extension.version ?? '?'}`).join(', ') || 'none'}`)
}

// ---------------------------------------------------------------- the run of the suites ----------------------------------------------------------------

/** What LUCIUM_SMOKE_ONLY asks for: the whole chain, one suite, or a name that no suite has. */
export type SuiteChoice = { kind: 'chain' } | { kind: 'only'; name: string } | { kind: 'unknown'; message: string }

/**
 * Reads LUCIUM_SMOKE_ONLY against the names of the table of suites. A name that no suite has is refused: it used to start the whole chain without a
 * word (a typing mistake, or the name of a part of the principal suite, which goes through LUCIUM_SMOKE_ONLY=parts).
 */
export function chooseSuite(only: string | undefined, names: readonly string[]): SuiteChoice {
  if (only === undefined || only === '') return { kind: 'chain' }
  if (names.includes(only)) return { kind: 'only', name: only }
  return { kind: 'unknown', message: `LUCIUM_SMOKE_ONLY="${only}" names no suite. Suites: ${[...names].sort().join(', ')}. A part of the principal suite is run with LUCIUM_SMOKE_ONLY=parts LUCIUM_SMOKE_PARTS=<part>.` }
}

/** What `LUCIUM_SMOKE_SKIP` leaves out of a run. */
export interface SkipChoice {
  /** The suites of the chain that are not run. */
  suites: ReadonlySet<string>
  /** The parts of the principal suite that are not run (`main:<part>`). */
  parts: ReadonlySet<string>
  /** The names that are no suite of the table: a typing mistake must not run what it was meant to leave out. */
  unknown: string[]
}

/**
 * Reads LUCIUM_SMOKE_SKIP, a comma-separated list of suites to leave out of the chain (`fullscreen,sitedata`), where `main:<part>` leaves out one part of the
 * principal suite. The Smoke (macOS) workflow sets it from compat/runner-limits.json, for what a GitHub runner cannot pass and what its failures would leave
 * open for the suites after them; on the Mac it is not set, and the whole chain runs. A part is checked where the parts are (smoke.ts), a suite here.
 */
export function readSkips(value: string | undefined, names: readonly string[]): SkipChoice {
  const suites = new Set<string>()
  const parts = new Set<string>()
  const unknown: string[] = []
  for (const entry of (value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')) {
    if (entry.startsWith('main:') && entry.length > 'main:'.length) parts.add(entry.slice('main:'.length))
    else if (names.includes(entry)) suites.add(entry)
    else unknown.push(entry)
  }
  return { suites, parts, unknown }
}

/** How one suite of a run ended. */
export interface SuiteOutcome {
  name: string
  /** 0 when the suite passed, anything else when it failed. */
  code: number
  tally: Tally
  /** Its checks, in the order they were made, and the facts it reported. */
  records: readonly CheckRecord[]
  facts: Readonly<Record<string, unknown>>
  ms: number
  /** Why the suite failed although its own code said 0, or how it ended otherwise: a line for the summary. */
  note?: string
  timedOut?: true
  /** The run was stopped while this suite ran (`RunStop`): it was cut short there. */
  cutShort?: true
}

/**
 * What ends a run before its last suite. The suites drive real windows with real input and read what is drawn: a Mac whose displays sleep, whose
 * screen is locked or that goes to sleep fails every check from then on for a reason that is not the application's (in the run of 12 November the
 * screen was locked during the seventh suite and the Mac slept six minutes later: the 34 suites that failed after it said nothing of the application,
 * two of them "did not return" only because the timer of their limit cannot fire while the Mac sleeps). The first reason is kept: the suite under way
 * is cut short at once, no other suite starts, the run fails and its summary says why.
 */
export class RunStop {
  private why: string | null = null
  private settle: (reason: string) => void = () => {}
  /** Settles with the reason the first time the run is stopped: the suite under way is raced against it. */
  readonly stopped: Promise<string> = new Promise<string>((resolve) => {
    this.settle = resolve
  })

  /** Null while the run may go on. */
  reason(): string | null {
    return this.why
  }

  stop(reason: string): void {
    if (this.why !== null) return
    this.why = reason
    this.settle(reason)
  }
}

/** How often the main process looks at its own clock during a run, and the longest it may go without running before the run is stopped. */
export const STALL_TICK_MS = 5000
export const STALL_LIMIT_MS = 60_000

/**
 * The watch of the main process's own clock: called by a timer every STALL_TICK_MS, it answers why the run must stop when a call comes far later
 * than the one before. Timers do not fire while the Mac sleeps, nor while the process is stopped or its main thread is blocked.
 */
export function stallWatch(startedAt: number, limitMs: number = STALL_LIMIT_MS): (now: number) => string | null {
  let last = startedAt
  return (now) => {
    const gap = now - last
    last = now
    return gap > limitMs ? `the main process did not run for ${Math.round(gap / 1000)} s: the Mac slept, or the process was stopped or blocked` : null
  }
}

/** What `watchRun` needs of Electron (`systemPreferences`, `app`) and of the clock: stand-ins in the unit tests. */
export interface RunWatchPorts {
  platform: string
  preferences: {
    subscribeWorkspaceNotification(event: string, callback: () => void): number
    unsubscribeWorkspaceNotification(id: number): void
    subscribeNotification(event: string, callback: () => void): number
    unsubscribeNotification(id: number): void
  }
  app: { on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown; off(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown }
  now(): number
  /** Calls `tick` every `ms` until the answered function is called. */
  every(ms: number, tick: () => void): () => void
}

/** What the suites cannot do on a Mac in that state, said after the reason. */
const KEEP_AWAKE = 'the checks need the screen on and unlocked (`caffeinate -d` keeps the displays on, not a screen locked by hand)'

/**
 * Stops the run when the Mac can no longer give the suites what they read: its displays go to sleep, its screen is locked, it goes to sleep, or the
 * main process did not run for a while. These are notifications of macOS, which no suite can send (security2 emits the events of `powerMonitor`
 * itself to drive the lock of the application). A quit asked of the application during the run is held and stops the run too: a run of 12 November
 * ended during mv2-blocking with code 0 and no report, quit by another application. Answers what lets go of all of it.
 */
export function watchRun(stop: RunStop, ports: RunWatchPorts): () => void {
  const workspace: number[] = []
  const distributed: number[] = []
  if (ports.platform === 'darwin') {
    workspace.push(ports.preferences.subscribeWorkspaceNotification('NSWorkspaceScreensDidSleepNotification', () => stop.stop(`the displays of the Mac went to sleep: ${KEEP_AWAKE}`)))
    workspace.push(ports.preferences.subscribeWorkspaceNotification('NSWorkspaceWillSleepNotification', () => stop.stop(`the Mac went to sleep: ${KEEP_AWAKE}`)))
    distributed.push(ports.preferences.subscribeNotification('com.apple.screenIsLocked', () => stop.stop(`the screen of the Mac was locked: ${KEEP_AWAKE}`)))
  }
  const stalled = stallWatch(ports.now())
  const cancel = ports.every(STALL_TICK_MS, () => {
    const why = stalled(ports.now())
    if (why) stop.stop(why)
  })
  const onQuit = (event: { preventDefault(): void }): void => {
    // Held: the run ends itself, with its report and a code that says it failed.
    event.preventDefault()
    stop.stop(`the application was asked to quit (${quitCallerOf(new Error().stack, /onQuit|watchRun/)})`)
  }
  ports.app.on('before-quit', onQuit)
  return () => {
    cancel()
    for (const id of workspace) ports.preferences.unsubscribeWorkspaceNotification(id)
    for (const id of distributed) ports.preferences.unsubscribeNotification(id)
    ports.app.off('before-quit', onQuit)
  }
}

/** Runs the suites in their order with `runOne`, and starts none once the run is stopped. */
export async function runChain<E>(entries: readonly E[], runOne: (entry: E) => Promise<SuiteOutcome>, stop: RunStop): Promise<SuiteOutcome[]> {
  const outcomes: SuiteOutcome[] = []
  for (const entry of entries) {
    if (stop.reason() !== null) break
    outcomes.push(await runOne(entry))
  }
  return outcomes
}

/**
 * Who asked the application to quit, read from the stack of the `before-quit` it emitted (Electron emits it at once from `app.quit()`): the frames of
 * the scripts that called, or the words that say none did (the system, the Dock, ⌘Q in a menu, another application: the run of 12 November was
 * ended by the Quit Apple Event of a utility that quits the applications left unused). `own` names the frames of the listener itself.
 */
export function quitCallerOf(stack: string | undefined, own: RegExp): string {
  const frames = (stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !own.test(line) && !/\(node:|^at node:|\(<anonymous>\)|^at <anonymous>/.test(line))
  return frames.length > 0 ? `asked by ${frames.slice(0, 3).join(' < ')}` : 'asked from outside the scripts: the system, the Dock, ⌘Q or another application (a Quit Apple Event)'
}

/** The longest a suite may take when its entry of the table says nothing. */
export const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60_000

/** The time given to a suite: LUCIUM_SMOKE_SUITE_TIMEOUT_MS (a slow machine, a debugger) before the time of its entry, before the default. */
export function suiteTimeoutMs(own: number | undefined, fromEnv: string | undefined): number {
  const asked = Number(fromEnv)
  if (fromEnv !== undefined && fromEnv !== '' && Number.isFinite(asked) && asked > 0) return asked
  return own ?? DEFAULT_SUITE_TIMEOUT_MS
}

/**
 * Runs one suite and answers how it ended, never throwing and never waiting longer than `timeoutMs`:
 * - a suite that throws is one failed suite, and the suites after it still run;
 * - a suite that does not return in time is one failed suite, named in the log (a run once stayed blocked for 23 minutes without saying where). Its
 *   promise cannot be stopped: what it still does may disturb the suites that follow, and the summary says which suite it was;
 * - a suite that says 0 without one check has verified nothing and is a failed suite;
 * - a suite under way when the run is stopped (`stop`) is cut short at once, as a failed suite that says why.
 */
export async function runSuite(name: string, run: () => Promise<number>, timeoutMs: number, write: Write = console.log, stop?: RunStop): Promise<SuiteOutcome> {
  const { tally, records, facts } = beginLedger()
  const startedAt = Date.now()
  write(`[smoke] == suite: ${name} (at most ${Math.round(timeoutMs / 1000)} s)`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs)
  })
  const stopped = stop ? stop.stopped.then((reason) => ({ reason })) : new Promise<never>(() => {})
  let outcome: SuiteOutcome
  try {
    const code = await Promise.race([run(), late, stopped])
    const ms = Date.now() - startedAt
    if (typeof code === 'object') outcome = { name, code: 1, tally, records, facts, ms, cutShort: true, note: `cut short: ${code.reason} (${tally.checks} checks made)` }
    else if (code === 'late') outcome = { name, code: 1, tally, records, facts, ms, timedOut: true, note: `the suite "${name}" did not return within ${Math.round(timeoutMs / 1000)} s (${tally.checks} checks made; what it still does may disturb the suites after it)` }
    else if (code === 0 && tally.checks === 0) outcome = { name, code: 1, tally, records, facts, ms, note: 'ended without a single check: nothing was verified' }
    else if (code === 0 && tally.failed > 0) outcome = { name, code: 1, tally, records, facts, ms, note: 'answered 0 with failed checks' }
    else outcome = { name, code, tally, records, facts, ms }
  } catch (error) {
    outcome = { name, code: 1, tally, records, facts, ms: Date.now() - startedAt, note: `threw: ${String((error as Error)?.stack ?? error)}` }
  } finally {
    clearTimeout(timer)
  }
  write(`[smoke] == ${outcomeWord(outcome)}: ${name} -- ${countsOf(outcome)}${outcome.note ? ` -- ${outcome.note}` : ''}`)
  return outcome
}

/** PASS, FAIL, or SKIP for a suite that passed without making one of its checks. */
function outcomeWord(outcome: SuiteOutcome): 'PASS' | 'FAIL' | 'SKIP' {
  if (outcome.code !== 0) return 'FAIL'
  return outcome.tally.checks === outcome.tally.skipped ? 'SKIP' : 'PASS'
}

const countsOf = ({ tally, ms }: SuiteOutcome): string => `${tally.checks} checks, ${tally.failed} failed, ${tally.skipped} skipped, ${Math.round(ms / 1000)} s`

/**
 * The summary of a run, written last: one line per suite, then the totals and the names of the suites that failed or verified nothing, and, for a run
 * that was stopped, why and how many suites of the run were not made.
 */
export function summaryOf(outcomes: readonly SuiteOutcome[], stop?: { reason: string; suites: number }): string[] {
  const lines = outcomes.map((outcome) => `[smoke] ${outcomeWord(outcome)} ${outcome.name} -- ${countsOf(outcome)}${outcome.note ? ` -- ${outcome.note.split('\n')[0]}` : ''}`)
  const sum = (pick: (tally: Tally) => number): number => outcomes.reduce((total, outcome) => total + pick(outcome.tally), 0)
  const named = (word: string): string => outcomes.filter((outcome) => outcomeWord(outcome) === word).map((outcome) => outcome.name).join(', ') || 'none'
  lines.push(`[smoke] total: ${outcomes.length} suites, ${sum((t) => t.checks)} checks, ${sum((t) => t.failed)} failed, ${sum((t) => t.skipped)} skipped`)
  lines.push(`[smoke] failed suites: ${named('FAIL')}`)
  lines.push(`[smoke] suites that verified nothing (every check skipped): ${named('SKIP')}`)
  if (stop) lines.push(`[smoke] the run was stopped after ${outcomes.length} of its ${stop.suites} suites, the others were not made: ${stop.reason}`)
  return lines
}

/**
 * The report of a run, as `pnpm compat:compare` reads it (shared/compat-report.ts): the engine, every suite with its checks (name and result, without
 * the details, which change from run to run), and the facts the suites reported.
 */
export function runReportOf(engine: { name: string; version: string; chromium: string }, outcomes: readonly SuiteOutcome[]): Record<string, unknown> {
  const facts: Record<string, unknown> = Object.assign({}, ...outcomes.map((outcome) => outcome.facts))
  const suites = Object.fromEntries(
    outcomes.map((outcome) => [outcome.name, { code: outcome.code, checks: outcome.records.map(({ name, ok, skipped }) => (skipped ? { name, ok, skipped } : { name, ok })) }])
  )
  return { engine, suites, ...facts }
}

/**
 * Writes the report of a run to `file` (nothing to do when no file is asked for). Answers false, with the reason in the log, when it could not be
 * written: the run then fails, since the comparison would read the report of an earlier run.
 */
export function saveReport(file: string | undefined, report: Record<string, unknown>, write: (file: string, text: string) => void, log: Write = console.error): boolean {
  if (file === undefined || file === '') return true
  try {
    write(file, `${JSON.stringify(report, null, 2)}\n`)
    return true
  } catch (error) {
    log(`[smoke] the report of the run could not be written to ${file}: ${String((error as Error)?.message ?? error)}`)
    return false
  }
}

/** The clipboard of the machine as a run needs it: every entry with the forms it holds, written back as records of forms, or emptied. */
export interface ClipboardPort<Form> {
  read(): Promise<Array<{ types: string[]; getType(type: string): Promise<Form> }>>
  write(entries: Array<Record<string, Form>>): Promise<void>
  clear(): void
}

/**
 * Reads what the clipboard holds and answers the function that puts it back. The suites write to the real clipboard (a copied address, a theme code),
 * and a run used to leave the last of those in place of what the person had copied. A clipboard that cannot be read or written back is said in
 * the log, with the consequence: it never stops the run.
 */
export async function keepClipboard<Form>(port: ClipboardPort<Form>, log: Write = console.error): Promise<() => Promise<void>> {
  // Every form of every entry is read now: an entry names what the clipboard holds at the time it is asked.
  const kept: Array<Record<string, Form>> = []
  let readable = true
  try {
    for (const item of await port.read()) {
      const forms: Record<string, Form> = {}
      for (const type of item.types) forms[type] = await item.getType(type)
      if (Object.keys(forms).length > 0) kept.push(forms)
    }
  } catch (error) {
    readable = false
    log(`[smoke] the clipboard could not be read before the run, so it is left as the suites leave it: ${String((error as Error)?.message ?? error)}`)
  }
  return async () => {
    if (!readable) return
    try {
      if (kept.length === 0) port.clear()
      else await port.write(kept)
    } catch (error) {
      log(`[smoke] the clipboard could not be put back as it was before the run: ${String((error as Error)?.message ?? error)}`)
    }
  }
}

/** The exit code of a run: 1 as soon as one suite failed, or when the run was stopped before its end. */
export const exitCodeOf = (outcomes: readonly SuiteOutcome[], stopped = false): number => (stopped || outcomes.some((outcome) => outcome.code !== 0) ? 1 : 0)

/**
 * What the checks assume of the settings, whatever the Mac they run on (the size of the panels, which depends on the screens, is pinned by the run):
 * - the interface is in French: the checks read the menus, the titles of the windows and the texts of the panels in French, and the default, « auto »,
 *   follows the language of the system, so a Mac or a CI runner in English showed « Settings » where the checks look for « Réglages »;
 * - the appearance is dark: the colours the checks expect are those of the dark appearance, and « Automatique » would follow the Mac.
 * The rows of a page of the Settings that wait in its fold « Plus de réglages » are reached by opening it (`OPEN_MORE_SETTINGS`).
 */
export const PINNED_SETTINGS = { interfaceTranslated: true, language: 'fr', interfaceAppearance: 'dark' } as const

/**
 * The script that opens « Plus de réglages » on the page of the Settings shown, so that every row of the page can be reached and clicked (the window keeps
 * a page's fold open while it stays open). True once the page is drawn and its fold is open, or it has none. False while the page is not drawn yet: the
 * window has its title from its creation, before its page draws anything, and a document with no fold yet is not a page whose fold is open (a row read
 * then is drawn hidden in the closed fold, and a click aimed at it lands on nothing).
 */
export const OPEN_MORE_SETTINGS = `(() => { if (!document.querySelector('.settings-content .pref-section')) return false; const b = document.querySelector('.settings-content .more-settings-toggle[aria-expanded="false"]'); if (b) b.click(); return document.querySelector('.settings-content .more-settings-toggle[aria-expanded="false"]') === null })()`

/**
 * A pattern written with ordinary spaces that also matches the non-breaking ones: the French texts of the interface get theirs when they are
 * read (shared/french-typography.ts), and a check is written the way one types. A space inside a character class is left as it is.
 */
export function anySpace(pattern: RegExp): RegExp {
  let inClass = false
  let source = ''
  for (let i = 0; i < pattern.source.length; i++) {
    const char = pattern.source[i]!
    if (char === '\\') {
      source += char + (pattern.source[++i] ?? '')
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    source += char === ' ' && !inClass ? '[ \\u00a0\\u202f]' : char
  }
  return new RegExp(source, pattern.flags)
}
