// Pure parts of the browser comparison bench (scripts/compare-browsers.mjs): reading what `ps`, `top`, `ioreg` and `pmset` print, adding
// up the processes of one browser, the medians over several passes, and the report tables. Nothing here runs a command or touches a
// file, so every rule is tested on frozen outputs (bench-core.test.ts). The script loads this file with Node's type stripping: no
// import, no enum, no parameter property.

export const BENCH_SCHEMA = 'lucium-compare-browsers/1'

/** The columns asked of `ps` (the executable path, never the arguments: a command line can hold a page title or an address). */
export const PS_COLUMNS = 'pid=,ppid=,rss=,time=,comm='

export interface PsRow {
  pid: number
  ppid: number
  /** Resident memory in KiB, shared pages included. */
  rssKiB: number
  /** CPU time used since the process started, user + system. */
  cpuSeconds: number
  /** Full path of the executable. */
  command: string
}

/** `ps` prints [[days-]hours:]minutes:seconds.hundredths; the decimal mark follows the locale of whoever ran it. Null for anything else. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(text.trim())
  if (!match) return null
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3])
  const seconds = Number((match[4] ?? '').replace(',', '.'))
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds
}

/** The rows of `ps -axo pid=,ppid=,rss=,time=,comm=`. A line that is not a row is counted, so that the caller can say so. */
export function parsePs(output: string): { rows: PsRow[]; skipped: number } {
  const rows: PsRow[] = []
  let skipped = 0
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    const cpuSeconds = match ? parseCpuTime(match[4] ?? '') : null
    if (!match || cpuSeconds === null) {
      skipped++
      continue
    }
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpuSeconds, command: match[5] ?? '' })
  }
  return { rows, skipped }
}

/** The processes in `rootPids` and everything below them, by pid. Pid 0 and 1 are never a root (launchd would take the whole machine). */
export function descendantsOf(rows: readonly PsRow[], rootPids: readonly number[]): PsRow[] {
  const byPid = new Map<number, PsRow>()
  const byParent = new Map<number, number[]>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const siblings = byParent.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else byParent.set(row.ppid, [row.pid])
  }
  const seen = new Set<number>()
  const found: PsRow[] = []
  const queue = rootPids.filter((pid) => pid > 1)
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue
    seen.add(next)
    const row = byPid.get(next)
    if (row) found.push(row)
    queue.push(...(byParent.get(next) ?? []))
  }
  return found.sort((a, b) => a.pid - b.pid)
}

/** The main processes of an application: the executable path ends with `mainSuffix` (for example `Google Chrome.app/Contents/MacOS/Google Chrome`). */
export function findMainPids(rows: readonly PsRow[], mainSuffix: string, excludePids: ReadonlySet<number> = new Set()): number[] {
  return rows.filter((row) => !excludePids.has(row.pid) && row.command.endsWith(`/${mainSuffix}`)).map((row) => row.pid)
}

export interface ProcessSelector {
  /** The browser's own process (one we started, or Arc's, which we only read) and its whole tree. */
  rootPids: readonly number[]
  /** Safari's content, network and graphics processes are children of launchd, not of Safari: they are taken by a piece of their path... */
  pathIncludes?: readonly string[]
  /** ...unless they were already running before the browser was launched (another application's web view). The tree is not concerned. */
  excludePids?: ReadonlySet<number>
}

export function selectBrowserProcesses(rows: readonly PsRow[], selector: ProcessSelector): PsRow[] {
  const chosen = new Map<number, PsRow>()
  for (const row of descendantsOf(rows, selector.rootPids)) chosen.set(row.pid, row)
  const pieces = selector.pathIncludes ?? []
  const excluded = selector.excludePids ?? new Set<number>()
  if (pieces.length > 0) {
    for (const row of rows) {
      if (chosen.has(row.pid) || excluded.has(row.pid)) continue
      if (pieces.some((piece) => row.command.includes(piece))) chosen.set(row.pid, row)
    }
  }
  return [...chosen.values()].sort((a, b) => a.pid - b.pid)
}

export interface ProcSample {
  /** Milliseconds, any origin: only differences count. */
  tMs: number
  procs: readonly PsRow[]
}

export interface WindowStats {
  durationS: number
  samples: number
  processesMean: number
  processesMax: number
  rssMiBMean: number
  rssMiBMax: number
  rssMiBLast: number
  /** CPU time used by the processes during the window, the ones that appeared or left during it included up to the last time they were seen. */
  cpuSeconds: number
  /** 100 = one core fully used for the whole window. */
  cpuPercent: number
}

const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length

/**
 * What the processes of a browser did between the first and the last sample. The CPU is the difference of the CPU times (`ps %cpu` is a
 * decaying average that the system keeps for its own purposes, not an average over our window); the memory is the sum of the resident sizes
 * at each sample. Null when there is no window (fewer than two samples, or the clock did not advance).
 */
export function summarizeWindow(samples: readonly ProcSample[]): WindowStats | null {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || samples.length < 2) return null
  if (samples.some((s, i) => i > 0 && s.tMs <= (samples[i - 1]?.tMs ?? 0))) return null
  const durationS = (last.tMs - first.tMs) / 1000
  if (!(durationS > 0)) return null

  const previous = new Map<string, number>()
  let cpuSeconds = 0
  samples.forEach((sample, index) => {
    for (const proc of sample.procs) {
      // A pid reused by another program is another process.
      const key = `${proc.pid}\u0000${proc.command}`
      const before = previous.get(key)
      if (before === undefined) {
        // Present at the start: only what comes after counts. Born during the window: everything it has used was used during it.
        if (index > 0) cpuSeconds += proc.cpuSeconds
      } else {
        // A CPU time that went down is a process that started again under the same pid and path.
        cpuSeconds += proc.cpuSeconds >= before ? proc.cpuSeconds - before : proc.cpuSeconds
      }
      previous.set(key, proc.cpuSeconds)
    }
  })

  const rss = samples.map((s) => s.procs.reduce((sum, p) => sum + p.rssKiB, 0) / 1024)
  const counts = samples.map((s) => s.procs.length)
  return {
    durationS,
    samples: samples.length,
    processesMean: mean(counts),
    processesMax: Math.max(...counts),
    rssMiBMean: mean(rss),
    rssMiBMax: Math.max(...rss),
    rssMiBLast: rss[rss.length - 1] ?? 0,
    cpuSeconds,
    cpuPercent: (cpuSeconds / durationS) * 100
  }
}

// ---------- top: footprint and energy impact, without administrator rights ----------

export interface TopRow {
  pid: number
  /** Physical footprint (what Activity Monitor calls Memory), in MiB. */
  footprintMiB: number
  /** The "power" column: the energy impact over the last interval, a unitless score of the system. */
  power: number
}

const TOP_UNITS: Record<string, number> = { '': 1 / (1024 * 1024), K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }

/** The last block of `top -l 2 -s N -stats pid,mem,power` (the first one is the total since the start, the last one covers the N seconds). */
export function parseTop(output: string): { rows: TopRow[]; blocks: number } {
  let rows: TopRow[] = []
  let blocks = 0
  for (const line of output.split('\n')) {
    if (/^\s*PID\s+MEM\s+POWER\s*$/.test(line)) {
      blocks++
      rows = []
      continue
    }
    const match = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)([KMGT]?)[+-]?\s+(\d+(?:[.,]\d+)?)\s*$/.exec(line)
    if (!match || blocks === 0) continue
    rows.push({
      pid: Number(match[1]),
      footprintMiB: Number((match[2] ?? '').replace(',', '.')) * (TOP_UNITS[match[3] ?? ''] ?? 1),
      power: Number((match[4] ?? '').replace(',', '.'))
    })
  }
  return { rows, blocks }
}

export interface TopSum {
  footprintMiB: number
  energyImpact: number
  /** How many of the wanted pids `top` listed; the others had left, or were not readable. */
  matched: number
  missing: number
}

export function sumTop(rows: readonly TopRow[], pids: ReadonlySet<number>): TopSum {
  let footprintMiB = 0
  let energyImpact = 0
  let matched = 0
  for (const row of rows) {
    if (!pids.has(row.pid)) continue
    footprintMiB += row.footprintMiB
    energyImpact += row.power
    matched++
  }
  return { footprintMiB, energyImpact, matched, missing: pids.size - matched }
}

// ---------- ioreg and pmset: the battery ----------

export interface BatteryReading {
  externalConnected: boolean | null
  isCharging: boolean | null
  /** Negative while the battery gives current. */
  amperageMA: number | null
  voltageMV: number | null
  /** What the whole machine draws (display, chips, disks...), in mW. */
  systemLoadMW: number | null
  /** Negative while the battery gives power. */
  batteryPowerMW: number | null
}

const TWO_64 = 1n << 64n

/** ioreg prints a negative 64-bit number as the unsigned number that has the same bits. */
export function toSigned64(text: string): number | null {
  if (!/^-?\d+$/.test(text)) return null
  const value = BigInt(text)
  return Number(value >= TWO_64 / 2n ? value - TWO_64 : value)
}

function ioregNumber(text: string, key: string): number | null {
  const match = new RegExp(`^[\\s|+-]*"${key}" = (-?\\d+)\\s*$`, 'm').exec(text)
  return match ? toSigned64(match[1] ?? '') : null
}

function ioregFlag(text: string, key: string): boolean | null {
  const match = new RegExp(`^[\\s|+-]*"${key}" = (Yes|No)\\s*$`, 'm').exec(text)
  return match ? match[1] === 'Yes' : null
}

/** `ioreg -rn AppleSmartBattery -w0`. Null when the machine has no battery (the entry is absent). */
export function parseIoregBattery(text: string): BatteryReading | null {
  const external = ioregFlag(text, 'ExternalConnected')
  const voltage = ioregNumber(text, 'Voltage')
  if (external === null && voltage === null) return null
  const telemetry = (key: string): number | null => {
    const match = new RegExp(`"${key}"=(\\d+)`).exec(text)
    return match ? toSigned64(match[1] ?? '') : null
  }
  return {
    externalConnected: external,
    isCharging: ioregFlag(text, 'IsCharging'),
    amperageMA: ioregNumber(text, 'InstantAmperage') ?? ioregNumber(text, 'Amperage'),
    voltageMV: voltage,
    systemLoadMW: telemetry('SystemLoad'),
    batteryPowerMW: telemetry('BatteryPower')
  }
}

/** Watts the battery gives, 0 when it does not (plugged in, charging), null when the reading cannot say. */
export function batteryDischargeW(reading: BatteryReading): number | null {
  if (reading.externalConnected === true) return 0
  if (reading.batteryPowerMW !== null) return Math.max(0, -reading.batteryPowerMW) / 1000
  if (reading.amperageMA !== null && reading.voltageMV !== null) return (Math.max(0, -reading.amperageMA) * reading.voltageMV) / 1_000_000
  return null
}

export function systemLoadW(reading: BatteryReading): number | null {
  return reading.systemLoadMW === null ? null : reading.systemLoadMW / 1000
}

export interface PmsetBatt {
  source: 'ac' | 'battery' | null
  /** Whole percent: too coarse to measure a few minutes of use, good to know where the run started. */
  percent: number | null
  state: string | null
}

export function parsePmsetBatt(text: string): PmsetBatt {
  const source = /drawing from '([^']*)'/.exec(text)?.[1]
  const line = /(\d{1,3})%;\s*([^;]*);/.exec(text)
  return {
    source: source === undefined ? null : /battery/i.test(source) ? 'battery' : /ac power/i.test(source) ? 'ac' : null,
    percent: line ? Number(line[1]) : null,
    state: line ? (line[2] ?? '').trim() : null
  }
}

/** `pmset -g`: whether the system's low power mode is on; null when the output does not say. */
export function parseLowPowerMode(text: string): boolean | null {
  const low = /^\s*lowpowermode\s+(\d)\s*$/m.exec(text)
  if (low) return low[1] === '1'
  // Newer systems print the mode: 0 automatic, 1 low power, 2 high power.
  const mode = /^\s*powermode\s+(\d)\s*$/m.exec(text)
  return mode ? mode[1] === '1' : null
}

// ---------- Lucium's throw-away profile ----------

/** The value of `STATE_VERSION` in the text of src/shared/model.ts; null when the declaration no longer has this form. */
export function readStateVersion(modelSource: string): number | null {
  const match = /^export const STATE_VERSION = (\d+)\s*$/m.exec(modelSource)
  return match ? Number(match[1]) : null
}

/**
 * The state file of the profile the bench gives Lucium: one space, no tab, and the links that come from outside open as tabs of the
 * window (by default they open in a mini window, which is not what the other browsers do with the same address). The background look
 * for a new version is off: a run of the bench must not read the feed of versions, which the site counts as a check by a person, nor be
 * measured while it does. Everything else is what the application fills in itself when it reads the file.
 */
export function luciumSeedState(stateVersion: number): Record<string, unknown> {
  return {
    version: stateVersion,
    spaces: [{ id: 'banc', name: 'Banc', emoji: '📏', profileId: 'default' }],
    activeSpaceId: 'banc',
    settings: { externalLinksInLittleArc: false, autoUpdate: false }
  }
}

/**
 * Whether the bench measures a browser it found. Safari has no throw-away profile: it opens in the person's own, keeps the pages of the bench in
 * its history and its iCloud tabs, and is quit at the end. So it is measured only when `--browsers` names it, never by default.
 */
export function isMeasuredByDefault(spec: { id: string; mode: string }, wanted: readonly string[] | null): boolean {
  return wanted ? wanted.includes(spec.id) : spec.mode !== 'safari'
}

/**
 * The environment of a browser the bench starts: not the one of a tool that runs the script as an Electron "node", and a home folder of the run
 * (`home`, empty) instead of the person's. With the profile given by `--user-data-dir` or `-profile`, nothing the browser reads or writes under
 * `~` (another browser's native messaging hosts, its folders of support, Lucium's guesses of the installed browsers) is the person's.
 */
export function benchBrowserEnv(env: Readonly<Record<string, string | undefined>>, home: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, HOME: home }
  delete out.ELECTRON_RUN_AS_NODE
  delete out.NODE_OPTIONS
  return out
}

// ---------- user activity ----------

/** `ioreg -c IOHIDSystem` prints the time since the last keyboard or mouse event, in nanoseconds. */
export function parseHidIdleNs(text: string): number | null {
  const match = /"HIDIdleTime" = (\d+)/.exec(text)
  return match ? Number(match[1]) : null
}

export interface IdleSample {
  /** Milliseconds since the start of the window. */
  tMs: number
  idleNs: number
}

/** Whether a key or the mouse was touched during the window: at some sample the last event is more recent than the start of the window. */
export function inputDuringWindow(samples: readonly IdleSample[], toleranceMs = 1500): boolean {
  return samples.some((s) => s.idleNs / 1e6 < s.tMs - toleranceMs)
}

// ---------- statistics over several passes ----------

export function median(values: readonly (number | null | undefined)[]): number | null {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const middle = Math.floor(clean.length / 2)
  return clean.length % 2 === 1 ? (clean[middle] ?? null) : ((clean[middle - 1] ?? 0) + (clean[middle] ?? 0)) / 2
}

export interface Stat {
  median: number | null
  min: number | null
  max: number | null
}

export function stat(values: readonly (number | null | undefined)[]): Stat {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return { median: median(clean), min: clean.length ? Math.min(...clean) : null, max: clean.length ? Math.max(...clean) : null }
}

/** One browser, one number of tabs, one pass. */
export interface RunResult {
  browserId: string
  tabs: number
  pass: number
  window: WindowStats | null
  footprintMiB: number | null
  energyImpact: number | null
  /** What the machine draws, average over the window. */
  systemLoadW: number | null
  /** What the battery gives, average over the window; 0 on mains power. */
  batteryDischargeW: number | null
  onBattery: boolean | null
  batteryPercentStart: number | null
  batteryPercentEnd: number | null
  pagesExpected: number
  /** Null when the browser cannot be asked (Arc, which we do not drive, still sends its beacons: then it is a number). */
  pagesLoaded: number | null
  /** How many pages say they are shown (one is expected: the selected tab). Null when the browser cannot say. */
  pagesVisible: number | null
  inputDuringWindow: boolean
  warnings: string[]
}

/**
 * A run counts when it has a window, nobody touched the machine, every page that was asked for did load, and a page was shown: with none
 * shown the window of the browser is hidden behind another one, and a hidden window is drawn less than the one a person looks at.
 */
export function isValidRun(run: RunResult): boolean {
  return run.window !== null && !run.inputDuringWindow && (run.pagesLoaded === null || run.pagesLoaded >= run.pagesExpected) && (run.pagesVisible === null || run.pagesVisible >= 1)
}

export interface Summary {
  browserId: string
  tabs: number
  passes: number
  validPasses: number
  /** True when no pass was valid: the figures are those of all the passes and say little. */
  allInvalid: boolean
  processes: Stat
  rssMiB: Stat
  footprintMiB: Stat
  cpuPercent: Stat
  energyImpact: Stat
  systemLoadW: Stat
  batteryDischargeW: Stat
  pagesLoadedMin: number | null
  warnings: string[]
}

export function summarizeRuns(runs: readonly RunResult[]): Summary[] {
  const groups = new Map<string, RunResult[]>()
  for (const run of runs) {
    const key = `${run.browserId}\u0000${run.tabs}`
    const group = groups.get(key)
    if (group) group.push(run)
    else groups.set(key, [run])
  }
  return [...groups.values()].map((group) => {
    const valid = group.filter(isValidRun)
    const used = valid.length > 0 ? valid : group
    const first = group[0] as RunResult
    const loaded = group.map((r) => r.pagesLoaded).filter((v): v is number => v !== null)
    const warnings = [...new Set(group.flatMap((r) => r.warnings))]
    return {
      browserId: first.browserId,
      tabs: first.tabs,
      passes: group.length,
      validPasses: valid.length,
      allInvalid: valid.length === 0,
      processes: stat(used.map((r) => r.window?.processesMean)),
      rssMiB: stat(used.map((r) => r.window?.rssMiBMean)),
      footprintMiB: stat(used.map((r) => r.footprintMiB)),
      cpuPercent: stat(used.map((r) => r.window?.cpuPercent)),
      energyImpact: stat(used.map((r) => r.energyImpact)),
      systemLoadW: stat(used.map((r) => r.systemLoadW)),
      batteryDischargeW: stat(used.map((r) => r.batteryDischargeW)),
      pagesLoadedMin: loaded.length ? Math.min(...loaded) : null,
      warnings
    }
  })
}

export interface PerTab {
  browserId: string
  fromTabs: number
  toTabs: number
  rssMiB: number | null
  footprintMiB: number | null
  energyImpact: number | null
}

/**
 * What one more tab costs, between two numbers of tabs: the difference of the medians over the number of tabs added. It does not depend on
 * what the browser holds at the start, nor, for Arc, on the tabs the user already had.
 */
export function costPerTab(summaries: readonly Summary[]): PerTab[] {
  const byBrowser = new Map<string, Summary[]>()
  for (const s of summaries) byBrowser.set(s.browserId, [...(byBrowser.get(s.browserId) ?? []), s])
  const out: PerTab[] = []
  for (const [browserId, list] of byBrowser) {
    const sorted = [...list].sort((a, b) => a.tabs - b.tabs)
    const from = sorted[0]
    const to = sorted[sorted.length - 1]
    if (!from || !to || to.tabs <= from.tabs) continue
    const span = to.tabs - from.tabs
    const per = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : (b - a) / span)
    out.push({
      browserId,
      fromTabs: from.tabs,
      toTabs: to.tabs,
      rssMiB: per(from.rssMiB.median, to.rssMiB.median),
      footprintMiB: per(from.footprintMiB.median, to.footprintMiB.median),
      energyImpact: per(from.energyImpact.median, to.energyImpact.median)
    })
  }
  return out
}

export interface BaselineSummary {
  /** Machine at rest with no browser, measured before and after the run. */
  windows: { label: string; systemLoadW: number | null; backgroundCpuPercent: number | null }[]
  meanSystemLoadW: number | null
  /** Difference between the first and the last window, in percent of their mean: the larger it is, the less the run can be trusted. */
  driftPercent: number | null
}

export function summarizeBaseline(windows: BaselineSummary['windows']): BaselineSummary {
  const loads = windows.map((w) => w.systemLoadW).filter((v): v is number => v !== null)
  const meanLoad = loads.length ? mean(loads) : null
  const first = loads[0]
  const last = loads[loads.length - 1]
  const drift = first !== undefined && last !== undefined && loads.length >= 2 && meanLoad ? (Math.abs(last - first) / meanLoad) * 100 : null
  return { windows, meanSystemLoadW: meanLoad, driftPercent: drift }
}

/** Windows in which the machine, with no browser started, was already busy: whatever the browsers show is then partly the machine's. */
export function quietWarnings(windows: BaselineSummary['windows'], limitPercent = 60): string[] {
  return windows
    .filter((w) => w.backgroundCpuPercent !== null && w.backgroundCpuPercent > limitPercent)
    .map((w) => `La machine n'était pas au repos (${w.label} : ${formatNumber(w.backgroundCpuPercent, 0)} % d'un cœur utilisé sans navigateur) : fermer les autres applications et recommencer.`)
}

/** How long the run will take, for the plan printed before anything starts. */
export function estimateDurationS(plan: { browsers: number; passes: number; steps: number; settleS: number; windowS: number; launchS: number; cooldownS: number }): number {
  const perStep = plan.settleS + plan.windowS + plan.launchS
  const baselines = 2 * plan.windowS
  return baselines + plan.browsers * plan.passes * (plan.steps * perStep + plan.cooldownS)
}

/** The order of the browsers for a pass: turned by one each time, so that none always comes first (a cold machine) or last (a warm one). */
export function rotateOrder<T>(items: readonly T[], pass: number): T[] {
  if (items.length === 0) return []
  const shift = (((pass - 1) % items.length) + items.length) % items.length
  return [...items.slice(shift), ...items.slice(0, shift)]
}

// ---------- the report ----------

export interface MachineInfo {
  model: string
  chip: string
  memoryGiB: number
  cores: number
  os: string
}

export interface BrowserInfo {
  id: string
  name: string
  version: string | null
  /** Engine, when it is not the browser's own version (Lucium: the Electron it runs on). */
  engine: string | null
  /** "launched": started by the bench with a throw-away profile. "passive": Arc, only read through ps; the user opened its pages. */
  mode: 'launched' | 'passive'
  notes: string[]
}

export interface BenchReport {
  schema: string
  date: string
  machine: MachineInfo
  method: { settleS: number; windowS: number; sampleS: number; passes: number; tabSteps: number[] }
  conditions: { powerAtStart: PmsetBatt; lowPowerMode: boolean | null; warnings: string[] }
  baseline: BaselineSummary
  browsers: BrowserInfo[]
  runs: RunResult[]
  summary: Summary[]
  perTab: PerTab[]
  notes: string[]
}

export function buildReport(input: {
  date: string
  machine: MachineInfo
  method: BenchReport['method']
  powerAtStart: PmsetBatt
  lowPowerMode: boolean | null
  baselineWindows: BaselineSummary['windows']
  browsers: BrowserInfo[]
  runs: RunResult[]
  notes: string[]
}): BenchReport {
  const summary = summarizeRuns(input.runs)
  const baseline = summarizeBaseline(input.baselineWindows)
  const warnings: string[] = []
  if (input.powerAtStart.source === 'ac') warnings.push("Sur secteur au départ : la décharge de la batterie n'est pas mesurable (la charge de la machine l'est).")
  if (input.lowPowerMode === true) warnings.push("Mode économie d'énergie du système actif : les navigateurs ne se comportent pas comme d'habitude.")
  warnings.push(...quietWarnings(input.baselineWindows))
  if (baseline.driftPercent !== null && baseline.driftPercent > 10) warnings.push(`La machine au repos a dérivé de ${formatNumber(baseline.driftPercent, 0)} % entre le début et la fin : ne pas publier ces chiffres.`)
  return {
    schema: BENCH_SCHEMA,
    date: input.date,
    machine: input.machine,
    method: input.method,
    conditions: { powerAtStart: input.powerAtStart, lowPowerMode: input.lowPowerMode, warnings },
    baseline,
    browsers: input.browsers,
    runs: input.runs,
    summary,
    perTab: costPerTab(summary),
    notes: input.notes
  }
}

/** French number: a comma for decimals and a no-break narrow space between thousands. An empty figure is a dash. */
export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const fixed = Math.abs(value).toFixed(digits)
  const [whole = '0', fraction] = fixed.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const negative = value < 0 && Number(fixed) !== 0
  return `${negative ? '−' : ''}${grouped}${fraction ? `,${fraction}` : ''}`
}

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(' | ')} |`
  return [line(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n')
}

/** The report as Markdown. Rows follow the order of the browsers of the run: the bench ranks nobody. */
export function renderMarkdown(report: BenchReport): string {
  const browserName = (id: string) => report.browsers.find((b) => b.id === id)?.name ?? id
  const out: string[] = []
  out.push('# Comparatif de navigateurs : mémoire, processeur, énergie')
  out.push('')
  out.push(`Mesuré le ${report.date} sur ${report.machine.model} (${report.machine.chip}, ${formatNumber(report.machine.memoryGiB, 0)} Gio, ${report.machine.cores} cœurs), ${report.machine.os}.`)
  const m = report.method
  out.push(
    `Protocole : ${m.passes} passe${m.passes > 1 ? 's' : ''}, ${m.tabSteps.join(' puis ')} onglets ouverts dans une même session, ${m.settleS} s de repos avant chaque fenêtre de ${m.windowS} s (échantillon toutes les ${m.sampleS} s). Médiane des passes valides ; les minimums et maximums sont dans le fichier JSON.`
  )
  out.push('')
  out.push('## Navigateurs')
  out.push('')
  out.push(
    table(
      ['Navigateur', 'Version', 'Moteur', 'Mode'],
      report.browsers.map((b) => [b.name, b.version ?? 'inconnue', b.engine ?? '—', b.mode === 'passive' ? "passif (ouvert par l'utilisateur, lu par ps)" : 'lancé par le banc, profil jetable'])
    )
  )
  out.push('')
  for (const tabs of m.tabSteps) {
    const rows = report.summary.filter((s) => s.tabs === tabs)
    if (rows.length === 0) continue
    out.push(`## ${tabs} onglets`)
    out.push('')
    out.push(
      table(
        ['Navigateur', 'Passes valides', 'Processus', 'Mémoire résidente (Mio)', 'Empreinte (Mio)', 'CPU (% d’un cœur)', 'Impact énergétique', 'Charge machine (W)', 'Pages chargées'],
        rows.map((s) => [
          browserName(s.browserId),
          `${s.validPasses}/${s.passes}${s.allInvalid ? ' (aucune valide)' : ''}`,
          formatNumber(s.processes.median, 0),
          formatNumber(s.rssMiB.median, 0),
          formatNumber(s.footprintMiB.median, 0),
          formatNumber(s.cpuPercent.median, 1),
          formatNumber(s.energyImpact.median, 1),
          formatNumber(s.systemLoadW.median, 1),
          s.pagesLoadedMin === null ? '—' : `${s.pagesLoadedMin}/${s.tabs}`
        ])
      )
    )
    out.push('')
  }
  if (report.perTab.length > 0) {
    out.push('## Coût d’un onglet de plus')
    out.push('')
    out.push('Différence des médianes entre le plus petit et le plus grand nombre d’onglets, divisée par le nombre d’onglets ajoutés. Ne dépend ni de ce que le navigateur occupe au départ ni, pour Arc, des onglets que l’utilisateur avait déjà.')
    out.push('')
    out.push(
      table(
        ['Navigateur', 'Entre', 'Mémoire résidente (Mio/onglet)', 'Empreinte (Mio/onglet)', 'Impact énergétique (par onglet)'],
        report.perTab.map((p) => [browserName(p.browserId), `${p.fromTabs} et ${p.toTabs} onglets`, formatNumber(p.rssMiB, 1), formatNumber(p.footprintMiB, 1), formatNumber(p.energyImpact, 2)])
      )
    )
    out.push('')
  }
  out.push('## Machine au repos, sans navigateur')
  out.push('')
  out.push(
    table(
      ['Fenêtre', 'Charge machine (W)', 'CPU de fond (% d’un cœur)'],
      report.baseline.windows.map((w) => [w.label, formatNumber(w.systemLoadW, 1), formatNumber(w.backgroundCpuPercent, 1)])
    )
  )
  out.push('')
  out.push(`Dérive entre la première et la dernière fenêtre : ${report.baseline.driftPercent === null ? 'non calculable' : `${formatNumber(report.baseline.driftPercent, 1)} %`}.`)
  const flagged = [...report.conditions.warnings, ...report.summary.flatMap((s) => s.warnings.map((w) => `${browserName(s.browserId)}, ${s.tabs} onglets : ${w}`))]
  if (flagged.length > 0) {
    out.push('')
    out.push('## Réserves')
    out.push('')
    for (const w of flagged) out.push(`- ${w}`)
  }
  const notes = [...report.browsers.flatMap((b) => b.notes.map((n) => `${b.name} : ${n}`)), ...report.notes]
  if (notes.length > 0) {
    out.push('')
    out.push('## Notes')
    out.push('')
    for (const n of notes) out.push(`- ${n}`)
  }
  out.push('')
  return out.join('\n')
}

/** The home folder never goes into a published file. */
export function redactHome(text: string, home: string): string {
  return home.length > 1 ? text.split(home).join('~') : text
}
