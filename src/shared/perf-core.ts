// The pure part of `pnpm perf` (scripts/perf.mjs): reading `ps`, summing the process tree, the budget file, the comparison with an earlier run
// and the report. Nothing here starts a process or reads a file, so every rule has a test (perf-core.test.ts) on frozen `ps` output.
//
// Self-contained on purpose: scripts/perf.mjs loads this file with Node's own TypeScript stripping, so it imports nothing at run time and only
// uses syntax that can be erased (no enum, no namespace, no parameter property, no import without `type`). perf-core.test.ts loads it that way too.

// ---------- measures ----------

export interface MeasureInfo {
  /** French, as the report shows it. */
  label: string
  /** '' for a count. */
  unit: string
  /**
   * The smallest difference that is not noise, in the unit of the measure. A limit never sits closer than this to its baseline, and a change
   * smaller than this is never reported as a regression (a baseline of 0,4 % plus 25 % would otherwise fail at 0,5 %).
   */
  slack: number
}

/** The order of the keys is the order of the report. */
export const MEASURES = {
  readyMs: { label: 'Fenêtre prête', unit: 'ms', slack: 500 },
  rssTotalMb: { label: 'Mémoire résidente totale', unit: 'Mo', slack: 32 },
  rssMainMb: { label: 'Processus principal', unit: 'Mo', slack: 16 },
  rssRendererMb: { label: 'Rendus : interface et pages', unit: 'Mo', slack: 32 },
  rssGpuMb: { label: 'Processus GPU', unit: 'Mo', slack: 16 },
  rssUtilityMb: { label: 'Utilitaires : réseau, stockage', unit: 'Mo', slack: 16 },
  processCount: { label: 'Nombre de processus', unit: '', slack: 2 },
  cpuMeanPct: { label: 'Processeur (moyenne)', unit: '%', slack: 3 }
} as const satisfies Record<string, MeasureInfo>

export type MeasureId = keyof typeof MEASURES

export const MEASURE_IDS = Object.keys(MEASURES) as MeasureId[]

export type Measures = Partial<Record<MeasureId, number>>

// ---------- scenarios ----------

/** `startup`: the application is started and stopped as soon as its window is ready. `steady`: it is prepared, left alone, then sampled. */
export type ScenarioKind = 'startup' | 'steady'

export type FeaturesMode = 'default' | 'on' | 'off'

export interface Scenario {
  id: string
  label: string
  kind: ScenarioKind
  /** Tabs of local pages opened before the measure. */
  tabs: number
  /** `default`: the settings of a new profile. `on`/`off`: every optional feature of the registry (perf-features.ts says which are left aside). */
  features: FeaturesMode
  /** What the scenario measures, in report order. */
  measures: readonly MeasureId[]
  /** What the budget file must give a limit for. */
  required: readonly MeasureId[]
}

const STEADY_MEASURES = ['rssTotalMb', 'rssMainMb', 'rssRendererMb', 'rssGpuMb', 'rssUtilityMb', 'processCount', 'cpuMeanPct'] as const
const STEADY_REQUIRED = ['rssTotalMb', 'cpuMeanPct'] as const

export const SCENARIOS = [
  { id: 'startup-cold', label: 'Démarrage à froid', kind: 'startup', tabs: 0, features: 'default', measures: ['readyMs'], required: ['readyMs'] },
  { id: 'idle-empty', label: 'Au repos, fenêtre vide', kind: 'steady', tabs: 0, features: 'default', measures: STEADY_MEASURES, required: STEADY_REQUIRED },
  { id: 'tabs-10', label: '10 onglets', kind: 'steady', tabs: 10, features: 'default', measures: STEADY_MEASURES, required: STEADY_REQUIRED },
  { id: 'tabs-50', label: '50 onglets', kind: 'steady', tabs: 50, features: 'default', measures: STEADY_MEASURES, required: STEADY_REQUIRED },
  { id: 'features-off', label: '10 onglets, toutes les fonctions coupées', kind: 'steady', tabs: 10, features: 'off', measures: STEADY_MEASURES, required: STEADY_REQUIRED },
  { id: 'features-on', label: '10 onglets, toutes les fonctions allumées', kind: 'steady', tabs: 10, features: 'on', measures: STEADY_MEASURES, required: STEADY_REQUIRED }
] as const satisfies readonly Scenario[]

export type ScenarioId = (typeof SCENARIOS)[number]['id']

export const SCENARIO_IDS: readonly ScenarioId[] = SCENARIOS.map((scenario) => scenario.id)

const SCENARIO_BY_ID: ReadonlyMap<string, Scenario> = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]))

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIO_BY_ID.get(id)
}

// ---------- what the application tells the script ----------

/** The prefix of the lines the measuring mode of the application prints on its standard output (src/main/smoke-perf.ts, index.ts). */
export const MARKER_PREFIX = 'LUCIUM_PERF_'

export interface ReadyInfo {
  scenario: string
  tabs: number
  /** Features the scenario switched on or off, by id; the other features keep the setting of a new profile. */
  featuresOn: string[]
  featuresOff: string[]
  liveTabs: number
}

export type Marker = { kind: 'shown'; uptimeMs: number } | { kind: 'ready'; info: ReadyInfo } | { kind: 'error'; message: string }

export function formatMarker(marker: Marker): string {
  if (marker.kind === 'shown') return `${MARKER_PREFIX}SHOWN ${Math.round(marker.uptimeMs)}`
  if (marker.kind === 'ready') return `${MARKER_PREFIX}READY ${JSON.stringify(marker.info)}`
  return `${MARKER_PREFIX}ERROR ${marker.message.replace(/\s+/g, ' ').slice(0, 500)}`
}

// A copy of shared/record.ts on purpose: this file imports nothing at run time (see the head of the file).
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * A line of the application's output as a marker; null for any other line (the application prints plenty of those). A line that carries the
 * prefix but cannot be read is an `error` marker, so that the run stops with the reason instead of waiting for a marker that never comes.
 */
export function parseMarkerLine(line: string): Marker | null {
  if (!line.startsWith(MARKER_PREFIX)) return null
  const rest = line.slice(MARKER_PREFIX.length)
  const space = rest.indexOf(' ')
  const word = space < 0 ? rest : rest.slice(0, space)
  const payload = space < 0 ? '' : rest.slice(space + 1).trim()
  const unreadable = (): Marker => ({ kind: 'error', message: `marqueur ${word} illisible : « ${payload.slice(0, 60)} »` })
  if (word === 'SHOWN') {
    const uptimeMs = Number(payload)
    return payload !== '' && Number.isFinite(uptimeMs) && uptimeMs >= 0 ? { kind: 'shown', uptimeMs } : unreadable()
  }
  if (word === 'ERROR') return { kind: 'error', message: payload }
  if (word === 'READY') {
    let raw: unknown
    try {
      raw = JSON.parse(payload)
    } catch {
      return unreadable()
    }
    if (!isRecord(raw) || typeof raw['scenario'] !== 'string' || !isCount(raw['tabs']) || !isCount(raw['liveTabs']) || !isStringList(raw['featuresOn']) || !isStringList(raw['featuresOff'])) return unreadable()
    return { kind: 'ready', info: { scenario: raw['scenario'], tabs: raw['tabs'], liveTabs: raw['liveTabs'], featuresOn: raw['featuresOn'], featuresOff: raw['featuresOff'] } }
  }
  return null
}

// ---------- the pages the tabs show ----------

/** The title of every page the script serves: the application knows a tab has loaded when it carries it. */
export const PAGE_TITLE_PREFIX = 'Perf page '
export const PAGE_PATH_PREFIX = '/p/'

export const pagePath = (index: number): string => `${PAGE_PATH_PREFIX}${index}`

/** The number of the page a request asks for, or null (the favicon, anything else). */
export function parsePagePath(path: string): number | null {
  const match = /^\/p\/(\d{1,4})$/.exec(path)
  return match ? Number(match[1]) : null
}

/** The address of the script's page server as the application accepts it: http, the loopback address, a port, nothing else. Null otherwise. */
export function parsePagesBase(text: string | undefined): string | null {
  const match = text === undefined ? null : /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(text)
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 65535 ? text! : null
}

/**
 * A page of ordinary weight: some structure and about 20 KB of text, no script, no image, nothing fetched from elsewhere. It measures what an
 * open tab costs, not what a particular site costs; the page differs from one tab to the next so that no tab is a copy of another.
 */
export function pageHtml(index: number): string {
  const paragraphs: string[] = []
  for (let i = 0; i < 120; i++) {
    paragraphs.push(`<p>Paragraphe ${i + 1} de la page ${index}. ${'Le navigateur garde cette page ouverte pour la mesure de sa consommation. '.repeat(2)}<a href="${pagePath(index)}#p${i}">lien ${i}</a></p>`)
  }
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${PAGE_TITLE_PREFIX}${index}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:42rem;color:#222}h1{font-size:1.6rem}p{margin:0 0 .8rem}</style>
</head>
<body>
<h1>Page ${index}</h1>
${paragraphs.join('\n')}
</body>
</html>
`
}

// ---------- the environment of the application ----------

/**
 * The environment the application is started with: the one of the script, without what could change what runs (an extension loaded from the
 * environment, a dev server for the interface, Electron as a plain Node, an update feed) and with the variables of the scenario.
 */
export function appEnvironment(parent: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || key.startsWith('LUCIUM_') || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') continue
    env[key] = value
  }
  return { ...env, ...extra }
}

// ---------- ps ----------

/** What the script asks `ps` for: the pid, the parent, the resident memory (KB), the CPU time used, and the command line (last, it holds spaces). */
export const PS_ARGS: readonly string[] = ['-axww', '-o', 'pid=,ppid=,rss=,time=,command=']

export interface ProcessRow {
  pid: number
  ppid: number
  rssKb: number
  /** CPU time used since the process began, in seconds. */
  cpuSeconds: number
  command: string
}

/**
 * `ps` prints the CPU time as [[days-]hours:]minutes:seconds[.hundredths] ("0:03.41", "1257:57.12", "1:02:03", "2-01:00:00"); minutes may pass 59.
 * Null for anything else.
 */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:\.(\d+))?$/.exec(text.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds, fraction] = match
  const whole = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  if (Number(seconds) >= 60) return null
  return whole + (fraction ? Number(`0.${fraction}`) : 0)
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/

/**
 * The rows of a `ps` listing made with PS_ARGS. Blank lines are skipped; a line that is not a row throws (naming its four numeric columns only):
 * a format that changed must stop the run, not leave a measure that quietly lacks a process.
 */
export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const match = PS_LINE.exec(line)
    const cpuSeconds = match ? parseCpuTime(match[4]!) : null
    // Only the four numeric columns are quoted: the command of a process that is not ours is none of the report's business.
    if (!match || cpuSeconds === null) throw new Error(`ps: ligne inattendue (« ${line.trim().split(/\s+/).slice(0, 4).join(' ')} … »). Le format de ps a-t-il changé ?`)
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), cpuSeconds, command: match[5]! })
  }
  return rows
}

// ---------- the tree of the application ----------

/** `main` is the process the script started; the others are told by the `--type=` flag Chromium gives its children. */
export type ProcessKind = 'main' | 'gpu' | 'renderer' | 'utility' | 'other'

export function classifyProcess(command: string, isRoot: boolean): ProcessKind {
  if (isRoot) return 'main'
  const type = /(?:^|\s)--type=([\w-]+)/.exec(command)?.[1]
  if (type === 'gpu-process') return 'gpu'
  if (type === 'renderer') return 'renderer'
  if (type === 'utility') return 'utility'
  return 'other'
}

/** The process `rootPid` and everything below it, root first. Nothing else is touched: other applications, and other copies of this one, are not in it. */
export function descendantsOf(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const root = rows.find((row) => row.pid === rootPid)
  if (!root) return []
  const found: ProcessRow[] = [root]
  const seen = new Set<number>([root.pid])
  for (let next = 0; next < found.length; next++) {
    for (const child of children.get(found[next]!.pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
    }
  }
  return found
}

export interface TreeProcess {
  pid: number
  kind: ProcessKind
  rssKb: number
  cpuSeconds: number
}

export interface TreeSnapshot {
  /** Milliseconds on any clock that only goes forward; only differences count. */
  at: number
  processes: TreeProcess[]
}

/** The tree of `rootPid` in this listing, or null when the process is gone (the application crashed or quit). */
export function takeSnapshot(rows: readonly ProcessRow[], rootPid: number, at: number): TreeSnapshot | null {
  const tree = descendantsOf(rows, rootPid)
  if (tree.length === 0) return null
  return { at, processes: tree.map((row) => ({ pid: row.pid, kind: classifyProcess(row.command, row.pid === rootPid), rssKb: row.rssKb, cpuSeconds: row.cpuSeconds })) }
}

const MB = 1024
const round1 = (value: number): number => Math.round(value * 10) / 10

export interface MemorySample {
  rssTotalMb: number
  rssMainMb: number
  rssRendererMb: number
  rssGpuMb: number
  rssUtilityMb: number
  processCount: number
}

/** Resident memory by kind of process, in MB. The total also counts the processes that have no line of their own (the crash handler, a program an extension launched). */
export function memorySample(snapshot: TreeSnapshot): MemorySample {
  const mb = (kind?: ProcessKind): number => round1(snapshot.processes.filter((process) => kind === undefined || process.kind === kind).reduce((sum, process) => sum + process.rssKb, 0) / MB)
  return { rssTotalMb: mb(), rssMainMb: mb('main'), rssRendererMb: mb('renderer'), rssGpuMb: mb('gpu'), rssUtilityMb: mb('utility'), processCount: snapshot.processes.length }
}

/**
 * The mean CPU use of the whole tree between two snapshots, in percent of one core (two busy cores make 200). Each process counts for the CPU
 * time it used between the two; one that began in between counts for all of its own, one that ended in between is lost (its last seconds are
 * not in any listing), so a tree whose processes come and go reads a little low.
 */
export function cpuMeanPercent(first: TreeSnapshot, last: TreeSnapshot): number {
  const seconds = (last.at - first.at) / 1000
  if (!(seconds > 0)) throw new RangeError('cpuMeanPercent: the second snapshot must be later than the first')
  const before = new Map(first.processes.map((process) => [process.pid, process.cpuSeconds]))
  let used = 0
  for (const process of last.processes) used += Math.max(0, process.cpuSeconds - (before.get(process.pid) ?? 0))
  return round1((used / seconds) * 100)
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of nothing')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export interface SteadySummary {
  measures: Measures
  /** The mean CPU use between each pair of neighbouring snapshots: a burst that the mean hides shows here. */
  cpuIntervals: number[]
}

/** Memory is the median of the snapshots (a spike while one of them is taken does not move it); the CPU is the mean from the first to the last. */
export function summarizeSteady(snapshots: readonly TreeSnapshot[]): SteadySummary {
  if (snapshots.length < 2) throw new RangeError('summarizeSteady : au moins deux instantanés sont nécessaires')
  const samples = snapshots.map(memorySample)
  const middle = (key: keyof MemorySample): number => round1(median(samples.map((sample) => sample[key])))
  const cpuIntervals = snapshots.slice(1).map((snapshot, index) => cpuMeanPercent(snapshots[index]!, snapshot))
  return {
    measures: {
      rssTotalMb: middle('rssTotalMb'),
      rssMainMb: middle('rssMainMb'),
      rssRendererMb: middle('rssRendererMb'),
      rssGpuMb: middle('rssGpuMb'),
      rssUtilityMb: middle('rssUtilityMb'),
      processCount: Math.round(median(samples.map((sample) => sample.processCount))),
      cpuMeanPct: cpuMeanPercent(snapshots[0]!, snapshots.at(-1)!)
    },
    cpuIntervals
  }
}

/** Several runs of one scenario as one set of measures: the median of each measure. */
export function mergeRuns(runs: readonly Measures[]): Measures {
  const merged: Measures = {}
  for (const id of MEASURE_IDS) {
    const values = runs.map((run) => run[id]).filter((value): value is number => typeof value === 'number')
    if (values.length > 0) merged[id] = round1(median(values))
  }
  return merged
}

// ---------- the report ----------

export interface MachineInfo {
  os: string
  arch: string
  cpu: string
  cores: number
  memoryGb: number
  node: string
  electron: string
}

export interface ScenarioResult {
  runs: number
  measures: Measures
  /** Free-form figures worth keeping next to the measures (the CPU intervals of each run, the features switched on). Never compared. */
  details?: Record<string, unknown>
}

export interface PerfReport {
  version: 1
  generatedAt: string
  machine: MachineInfo
  options: { repeat: number; cpuSeconds: number; settleSeconds: number; startupRuns: number }
  results: Partial<Record<ScenarioId, ScenarioResult>>
  /** Scenarios that could not be measured, with the reason: the run fails. */
  failures: Partial<Record<ScenarioId, string>>
}

export function parseReport(raw: unknown): { report: PerfReport | null; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { report: null, errors: ['le rapport n’est pas un objet JSON'] }
  if (raw['version'] !== 1) errors.push(`version de rapport inconnue : ${JSON.stringify(raw['version'])}`)
  if (typeof raw['generatedAt'] !== 'string') errors.push('generatedAt manquant')
  if (!isRecord(raw['machine'])) errors.push('machine manquante')
  const results = raw['results']
  if (!isRecord(results)) errors.push('results manquant')
  else {
    for (const [id, result] of Object.entries(results)) {
      if (!SCENARIO_BY_ID.has(id)) errors.push(`scénario inconnu dans le rapport : ${id}`)
      else if (!isRecord(result) || !isRecord(result['measures'])) errors.push(`${id} : mesures manquantes`)
      else {
        for (const [measure, value] of Object.entries(result['measures'])) {
          if (!(measure in MEASURES)) errors.push(`${id} : mesure inconnue : ${measure}`)
          else if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${id}.${measure} : ce n’est pas un nombre`)
        }
      }
    }
  }
  return errors.length > 0 ? { report: null, errors } : { report: raw as unknown as PerfReport, errors }
}

// ---------- the budget ----------

export interface BudgetEntry {
  /** What the reference machine measured. */
  baseline: number
  /** Percent above the baseline that is still fine; absent: the file's `defaultMarginPercent`. */
  marginPercent?: number
}

export interface Reference {
  machine: string
  os: string
  cpu: string
  memoryGb: number
  electron: string
}

export interface Budget {
  version: 1
  /** True while the baselines are estimates, not measures (pnpm perf --write-budget makes them measures). */
  provisional: boolean
  defaultMarginPercent: number
  reference: Reference
  scenarios: Partial<Record<ScenarioId, Partial<Record<MeasureId, BudgetEntry>>>>
}

const MAX_MARGIN_PERCENT = 500

/** The most a measure may read: the baseline plus the margin, but never closer to it than the slack of the measure. */
export function limitOf(measure: MeasureId, entry: BudgetEntry, defaultMarginPercent: number): number {
  const margin = entry.marginPercent ?? defaultMarginPercent
  return round1(entry.baseline + Math.max((entry.baseline * margin) / 100, MEASURES[measure].slack))
}

const TOP_KEYS = ['version', 'provisional', 'defaultMarginPercent', 'reference', 'scenarios', 'comment']
const REFERENCE_KEYS = ['machine', 'os', 'cpu', 'memoryGb', 'electron']

/** Reads perf-budget.json. Everything that cannot be what it says (a scenario that does not exist, a measure the scenario does not make, a missing limit) is an error. */
export function parseBudget(raw: unknown): { budget: Budget | null; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { budget: null, errors: ['le fichier de seuils n’est pas un objet JSON'] }
  for (const key of Object.keys(raw)) if (!TOP_KEYS.includes(key)) errors.push(`clé inconnue : ${key}`)
  if (raw['version'] !== 1) errors.push(`version inconnue : ${JSON.stringify(raw['version'])} (attendu : 1)`)
  if (typeof raw['provisional'] !== 'boolean') errors.push('provisional doit être vrai ou faux')
  const margin = raw['defaultMarginPercent']
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > MAX_MARGIN_PERCENT) errors.push(`defaultMarginPercent doit être un nombre de 0 à ${MAX_MARGIN_PERCENT}`)
  const reference = raw['reference']
  if (!isRecord(reference)) errors.push('reference manquante (la machine sur laquelle les seuils ont été relevés)')
  else {
    for (const key of Object.keys(reference)) if (!REFERENCE_KEYS.includes(key)) errors.push(`reference : clé inconnue : ${key}`)
    for (const key of REFERENCE_KEYS) {
      const value = reference[key]
      if (key === 'memoryGb' ? typeof value !== 'number' || !(value > 0) : typeof value !== 'string' || value.trim() === '') errors.push(`reference.${key} manquant ou invalide`)
    }
  }
  const scenarios = raw['scenarios']
  if (!isRecord(scenarios)) errors.push('scenarios manquant')
  else {
    for (const [id, measures] of Object.entries(scenarios)) {
      const scenario = SCENARIO_BY_ID.get(id)
      if (!scenario) {
        errors.push(`scénario inconnu : ${id} (connus : ${SCENARIO_IDS.join(', ')})`)
        continue
      }
      if (!isRecord(measures)) {
        errors.push(`${id} : doit être un objet de mesures`)
        continue
      }
      for (const [measure, entry] of Object.entries(measures)) {
        if (!(measure in MEASURES)) errors.push(`${id} : mesure inconnue : ${measure}`)
        else if (!scenario.measures.includes(measure as MeasureId)) errors.push(`${id} : ce scénario ne fait pas la mesure ${measure}`)
        else if (!isRecord(entry)) errors.push(`${id}.${measure} : doit être { "baseline": nombre }`)
        else {
          for (const key of Object.keys(entry)) if (key !== 'baseline' && key !== 'marginPercent') errors.push(`${id}.${measure} : clé inconnue : ${key}`)
          const baseline = entry['baseline']
          if (typeof baseline !== 'number' || !Number.isFinite(baseline) || baseline < 0) errors.push(`${id}.${measure} : baseline doit être un nombre positif ou nul`)
          const own = entry['marginPercent']
          if (own !== undefined && (typeof own !== 'number' || !Number.isFinite(own) || own < 0 || own > MAX_MARGIN_PERCENT)) errors.push(`${id}.${measure} : marginPercent doit être un nombre de 0 à ${MAX_MARGIN_PERCENT}`)
        }
      }
    }
  }
  return errors.length > 0 ? { budget: null, errors } : { budget: raw as unknown as Budget, errors }
}

/** The limits the file must give and does not: one line per scenario and measure. */
export function budgetGaps(budget: Budget): string[] {
  const gaps: string[] = []
  for (const scenario of SCENARIOS) {
    for (const measure of scenario.required) if (!budget.scenarios[scenario.id]?.[measure]) gaps.push(`${scenario.id}.${measure}`)
  }
  return gaps
}

export type Status = 'ok' | 'over' | 'missing' | 'unbudgeted'

export interface Verdict {
  scenario: ScenarioId
  measure: MeasureId
  value: number | null
  baseline: number | null
  limit: number | null
  marginPercent: number | null
  status: Status
}

/**
 * Each measure of each scenario that ran, against its limit. `over`: above it (a value equal to the limit passes). `missing`: the budget has
 * a limit and the run produced no value (a measure that failed is never a pass). `unbudgeted`: a value with no limit in the file. A scenario
 * that was not run (`--only`) is not listed.
 */
export function evaluateBudget(results: PerfReport['results'], budget: Budget): Verdict[] {
  const verdicts: Verdict[] = []
  for (const scenario of SCENARIOS) {
    const result = results[scenario.id]
    if (!result) continue
    for (const measure of scenario.measures) {
      const value = result.measures[measure] ?? null
      const entry = budget.scenarios[scenario.id]?.[measure]
      if (!entry) {
        if (value !== null) verdicts.push({ scenario: scenario.id, measure, value, baseline: null, limit: null, marginPercent: null, status: 'unbudgeted' })
        continue
      }
      const limit = limitOf(measure, entry, budget.defaultMarginPercent)
      const marginPercent = entry.marginPercent ?? budget.defaultMarginPercent
      const status: Status = value === null ? 'missing' : value > limit ? 'over' : 'ok'
      verdicts.push({ scenario: scenario.id, measure, value, baseline: entry.baseline, limit, marginPercent, status })
    }
  }
  return verdicts
}

/**
 * The budget after a run: every measure of every scenario the run made becomes the baseline (the margin an entry had is kept), the other
 * entries stay. It stays provisional until a run has measured every scenario.
 */
export function proposeBudget(previous: Budget, report: PerfReport, reference: Reference): Budget {
  const scenarios: Budget['scenarios'] = JSON.parse(JSON.stringify(previous.scenarios)) as Budget['scenarios']
  for (const scenario of SCENARIOS) {
    const result = report.results[scenario.id]
    if (!result) continue
    const entries: Partial<Record<MeasureId, BudgetEntry>> = scenarios[scenario.id] ?? {}
    for (const measure of scenario.measures) {
      const value = result.measures[measure]
      if (value === undefined) continue
      const own = entries[measure]?.marginPercent
      entries[measure] = own === undefined ? { baseline: round1(value) } : { baseline: round1(value), marginPercent: own }
    }
    scenarios[scenario.id] = entries
  }
  const measuredEverything = SCENARIOS.every((scenario) => report.results[scenario.id] !== undefined)
  return { version: 1, provisional: previous.provisional && !measuredEverything, defaultMarginPercent: previous.defaultMarginPercent, reference, scenarios }
}

// ---------- comparison with an earlier run ----------

export interface Change {
  scenario: ScenarioId
  measure: MeasureId
  before: number
  after: number
  delta: number
  /** Null when the earlier value was 0. */
  deltaPercent: number | null
  regression: boolean
  improvement: boolean
}

/**
 * The measures both reports have. A regression grows by more than `maxRegressionPercent` AND by more than the slack of the measure (a CPU
 * figure going from 0,2 to 0,4 % doubled and means nothing). An improvement is the same, downwards.
 */
export function compareReports(before: PerfReport, after: PerfReport, maxRegressionPercent: number): Change[] {
  const changes: Change[] = []
  for (const scenario of SCENARIOS) {
    const was = before.results[scenario.id]
    const now = after.results[scenario.id]
    if (!was || !now) continue
    for (const measure of scenario.measures) {
      const b = was.measures[measure]
      const a = now.measures[measure]
      if (b === undefined || a === undefined) continue
      const delta = round1(a - b)
      const deltaPercent = b === 0 ? null : round1(((a - b) / b) * 100)
      const slack = MEASURES[measure].slack
      const beyond = (direction: 1 | -1): boolean => direction * delta > slack && (deltaPercent === null || direction * deltaPercent > maxRegressionPercent)
      changes.push({ scenario: scenario.id, measure, before: b, after: a, delta, deltaPercent, regression: beyond(1), improvement: beyond(-1) })
    }
  }
  return changes
}

/** Whether two reports come from machines that cannot be compared figure for figure. */
export function sameMachine(a: MachineInfo, b: MachineInfo): boolean {
  return a.cpu === b.cpu && a.arch === b.arch && a.cores === b.cores && Math.round(a.memoryGb) === Math.round(b.memoryGb)
}

/** 0: all within the budget. 1: a limit passed or a regression. 2: something could not be measured (it says nothing about the budget). */
export function exitCodeFor(input: { verdicts: readonly Verdict[]; changes: readonly Change[]; failures: Readonly<Record<string, string>> }): 0 | 1 | 2 {
  if (Object.keys(input.failures).length > 0 || input.verdicts.some((verdict) => verdict.status === 'missing')) return 2
  if (input.verdicts.some((verdict) => verdict.status === 'over') || input.changes.some((change) => change.regression)) return 1
  return 0
}

// ---------- what the figures say together ----------

export interface DerivedCosts {
  /** What a tab adds, from the empty window to 10 tabs, and from 10 to 50 (the second is the steadier figure). */
  perTabFirstTenMb: number | null
  perTabNextFortyMb: number | null
  /** All features on minus all features off, with the same 10 tabs. */
  featuresMemoryMb: number | null
  featuresCpuPct: number | null
  featuresProcesses: number | null
}

export function deriveCosts(results: PerfReport['results']): DerivedCosts {
  const value = (id: ScenarioId, measure: MeasureId): number | null => results[id]?.measures[measure] ?? null
  const diff = (a: number | null, b: number | null, divisor = 1): number | null => (a === null || b === null ? null : round1((a - b) / divisor))
  return {
    perTabFirstTenMb: diff(value('tabs-10', 'rssTotalMb'), value('idle-empty', 'rssTotalMb'), 10),
    perTabNextFortyMb: diff(value('tabs-50', 'rssTotalMb'), value('tabs-10', 'rssTotalMb'), 40),
    featuresMemoryMb: diff(value('features-on', 'rssTotalMb'), value('features-off', 'rssTotalMb')),
    featuresCpuPct: diff(value('features-on', 'cpuMeanPct'), value('features-off', 'cpuMeanPct')),
    featuresProcesses: diff(value('features-on', 'processCount'), value('features-off', 'processCount'))
  }
}

/**
 * What the difference between « all features on » and « all features off » says, for a memory measure. Both scenarios load the same ten pages,
 * so the features can only add: a difference below zero by more than the slack of the measure is not a saving, it is the two launches not being
 * comparable (the order they ran in, what the machine was doing), and a difference within the slack is not a cost that was measured.
 */
export type FeaturesReading = 'cost' | 'within-noise' | 'not-comparable'

export function readFeaturesCost(measure: MeasureId, onMinusOff: number): FeaturesReading {
  const slack = MEASURES[measure].slack
  return onMinusOff < -slack ? 'not-comparable' : onMinusOff <= slack ? 'within-noise' : 'cost'
}

/** The memory measures of the tree a budget is checked on: the features cannot make any of them lighter than the slack. */
const FEATURES_MEMORY: readonly MeasureId[] = ['rssTotalMb', 'rssMainMb', 'rssRendererMb']

export interface BudgetIncoherence {
  measure: MeasureId
  on: number
  off: number
}

/**
 * The baselines of a budget that cannot both be right: « all features on » calibrated lighter than « all features off », by more than the slack of
 * the measure. A budget calibrated on such a run still limits each scenario, but it cannot tell what the features cost, and the limit of
 * « on » sits below the one of « off ». It is to be calibrated again (`pnpm perf --repeat 3 --write-budget`), not edited by hand.
 */
export function budgetIncoherences(budget: Budget): BudgetIncoherence[] {
  const found: BudgetIncoherence[] = []
  for (const measure of FEATURES_MEMORY) {
    const on = budget.scenarios['features-on']?.[measure]?.baseline
    const off = budget.scenarios['features-off']?.[measure]?.baseline
    if (on !== undefined && off !== undefined && readFeaturesCost(measure, on - off) === 'not-comparable') found.push({ measure, on, off })
  }
  return found
}

// ---------- the text of the report ----------

/** A figure as the report writes it: a decimal comma, no thousands separator, whole numbers for milliseconds and counts. */
export function formatValue(measure: MeasureId, value: number | null): string {
  if (value === null) return '—'
  const unit = MEASURES[measure].unit
  if (unit === 'ms' || unit === '') return String(Math.round(value))
  return value.toFixed(1).replace('.', ',')
}

const signed = (value: number, digits = 1): string => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits).replace('.', ',')}`

const width = (text: string): number => [...text].length

/** A Markdown table, columns padded so that it reads as plain text too. */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[], rightAligned: readonly number[] = []): string {
  const columns = header.map((title, index) => Math.max(width(title), 3, ...rows.map((row) => width(row[index] ?? ''))))
  const cell = (text: string, index: number): string => {
    const padding = ' '.repeat(columns[index]! - width(text))
    return rightAligned.includes(index) ? padding + text : text + padding
  }
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`
  const rule = `| ${columns.map((size, index) => (rightAligned.includes(index) ? `${'-'.repeat(size - 1)}:` : '-'.repeat(size))).join(' | ')} |`
  return [line(header), rule, ...rows.map(line)].join('\n')
}

const STATUS_TEXT: Record<Status, string> = { ok: 'ok', over: 'DÉPASSÉ', missing: 'MANQUANT', unbudgeted: 'sans seuil' }

export interface RenderInput {
  report: PerfReport
  verdicts: readonly Verdict[]
  changes?: readonly Change[]
  /** The machine of the earlier report, when it is not the same as this one. */
  otherMachine?: MachineInfo
  budget: Budget
}

export function renderReport({ report, verdicts, changes, otherMachine, budget }: RenderInput): string {
  const lines: string[] = []
  const machine = report.machine
  lines.push(`# Consommation de Lucium — ${report.generatedAt}`, '')
  lines.push(`Machine : ${machine.cpu} (${machine.cores} cœurs, ${machine.memoryGb} Go), ${machine.os} ${machine.arch}, Electron ${machine.electron}, Node ${machine.node}.`)
  lines.push(`Réglages : ${report.options.cpuSeconds} s de mesure du processeur, ${report.options.settleSeconds} s d’attente avant la mesure, ${report.options.repeat} passage(s) par scénario, ${report.options.startupRuns} démarrage(s).`)
  if (budget.provisional) lines.push('', '> Les seuils de perf-budget.json sont provisoires (estimés, pas mesurés) : lancer `pnpm perf --write-budget` sur la machine de référence.')
  else if (machine.cpu !== budget.reference.cpu) lines.push('', `> Cette machine (${machine.cpu}) n’est pas la machine de référence des seuils (${budget.reference.cpu}).`)

  const scenarioLabel = (id: ScenarioId): string => SCENARIOS.find((scenario) => scenario.id === id)!.label
  lines.push('', '## Mesures et seuils', '')
  lines.push(
    renderTable(
      ['Scénario', 'Mesure', 'Valeur', 'Seuil', 'Marge', 'État'],
      verdicts.map((verdict) => [
        `${verdict.scenario} — ${scenarioLabel(verdict.scenario)}`,
        `${MEASURES[verdict.measure].label}${MEASURES[verdict.measure].unit ? ` (${MEASURES[verdict.measure].unit})` : ''}`,
        formatValue(verdict.measure, verdict.value),
        formatValue(verdict.measure, verdict.limit),
        verdict.marginPercent === null ? '—' : `+${verdict.marginPercent} %`,
        STATUS_TEXT[verdict.status]
      ]),
      [2, 3, 4]
    )
  )
  const over = verdicts.filter((verdict) => verdict.status === 'over').length
  const missing = verdicts.filter((verdict) => verdict.status === 'missing').length
  lines.push('', over === 0 && missing === 0 ? 'Aucun seuil dépassé.' : `${over} seuil(s) dépassé(s), ${missing} mesure(s) manquante(s).`)

  const costs = deriveCosts(report.results)
  const derived: string[] = []
  if (costs.perTabFirstTenMb !== null) derived.push(`- Un onglet de plus, de la fenêtre vide à 10 onglets : ${formatValue('rssTotalMb', costs.perTabFirstTenMb)} Mo.`)
  if (costs.perTabNextFortyMb !== null) derived.push(`- Un onglet de plus, de 10 à 50 onglets : ${formatValue('rssTotalMb', costs.perTabNextFortyMb)} Mo.`)
  if (costs.featuresMemoryMb !== null) {
    derived.push(`- Toutes les fonctions allumées, par rapport à toutes coupées : ${signed(costs.featuresMemoryMb)} Mo${costs.featuresCpuPct !== null ? `, ${signed(costs.featuresCpuPct)} % de processeur` : ''}${costs.featuresProcesses !== null ? `, ${signed(costs.featuresProcesses, 0)} processus` : ''}.`)
    // A figure that is not a cost is said to be none: it must not be read as « the features cost nothing », still less as a saving.
    const reading = readFeaturesCost('rssTotalMb', costs.featuresMemoryMb)
    const slack = MEASURES.rssTotalMb.slack
    if (reading === 'not-comparable') derived.push(`  Ce chiffre n’est pas un coût : les mêmes 10 pages avec les fonctions allumées ne peuvent pas peser moins qu’avec les fonctions coupées. L’écart dépasse le bruit toléré (${slack} Mo) dans le mauvais sens : les deux scénarios ne sont pas comparables dans ce passage (ordre de lancement, état de la machine). Relancer avec \`--repeat 3\`, machine au repos.`)
    else if (reading === 'within-noise') derived.push(`  Cet écart est dans le bruit toléré de la mesure (${slack} Mo) : ce passage ne mesure pas de coût des fonctions.`)
  }
  if (derived.length > 0) lines.push('', '## Coûts déduits', '', ...derived)

  const incoherent = budgetIncoherences(budget)
  if (incoherent.length > 0) {
    lines.push('', '## Seuils incohérents', '')
    lines.push('Les références de perf-budget.json donnent « toutes les fonctions allumées » plus léger que « toutes coupées », au-delà du bruit toléré :', '')
    for (const { measure, on, off } of incoherent) lines.push(`- ${MEASURES[measure].label} : ${formatValue(measure, on)} Mo allumées, ${formatValue(measure, off)} Mo coupées.`)
    lines.push('', 'Chaque scénario garde sa limite, mais ces seuils ne disent rien du coût des fonctions. À recalibrer sur la machine de référence (`pnpm perf --repeat 3 --write-budget`, machine au repos), sans les corriger à la main.')
  }

  if (changes) {
    lines.push('', '## Comparaison avec la mesure précédente', '')
    if (otherMachine) lines.push(`> La mesure précédente vient d’une autre machine (${otherMachine.cpu}, ${otherMachine.memoryGb} Go) : les écarts valent pour elle, pas pour celle-ci.`, '')
    if (changes.length === 0) lines.push('Aucun scénario en commun avec la mesure précédente.')
    else {
      lines.push(
        renderTable(
          ['Scénario', 'Mesure', 'Avant', 'Après', 'Écart', 'Écart (%)', 'État'],
          changes.map((change) => [
            change.scenario,
            MEASURES[change.measure].label,
            formatValue(change.measure, change.before),
            formatValue(change.measure, change.after),
            signed(change.delta),
            change.deltaPercent === null ? '—' : signed(change.deltaPercent),
            change.regression ? 'RÉGRESSION' : change.improvement ? 'mieux' : 'stable'
          ]),
          [2, 3, 4, 5]
        )
      )
      const regressions = changes.filter((change) => change.regression).length
      lines.push('', regressions > 0 ? `${regressions} régression(s).` : 'Aucune régression.')
    }
  }

  const failed = Object.entries(report.failures)
  if (failed.length > 0) lines.push('', '## Scénarios en échec', '', ...failed.map(([id, reason]) => `- ${id} : ${reason}`))
  lines.push('')
  return lines.join('\n')
}

// ---------- the command line ----------

export interface PerfOptions {
  only: ScenarioId[]
  repeat: number
  cpuSeconds: number
  settleSeconds: number
  startupRuns: number
  maxRegressionPercent: number
}

export const DEFAULT_OPTIONS: Omit<PerfOptions, 'only'> = { repeat: 1, cpuSeconds: 30, settleSeconds: 10, startupRuns: 3, maxRegressionPercent: 15 }

/** Checks the values of the command line; the scenarios named by `--only` must exist. Every problem is reported, not only the first. */
export function resolveOptions(raw: { only?: string; repeat?: string; cpuSeconds?: string; settleSeconds?: string; startupRuns?: string; maxRegression?: string }): { options: PerfOptions | null; errors: string[] } {
  const errors: string[] = []
  const number = (name: string, text: string | undefined, fallback: number, min: number, max: number, integer: boolean): number => {
    if (text === undefined) return fallback
    const value = Number(text)
    if (text.trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      errors.push(`--${name} : ${integer ? 'un entier' : 'un nombre'} de ${min} à ${max} est attendu (reçu : ${JSON.stringify(text)})`)
      return fallback
    }
    return value
  }
  let only: ScenarioId[] = [...SCENARIO_IDS]
  if (raw.only !== undefined) {
    const names = raw.only.split(',').map((name) => name.trim()).filter(Boolean)
    const unknown = names.filter((name) => !SCENARIO_BY_ID.has(name))
    if (names.length === 0) errors.push('--only : au moins un scénario est attendu')
    if (unknown.length > 0) errors.push(`--only : scénario inconnu : ${unknown.join(', ')} (connus : ${SCENARIO_IDS.join(', ')})`)
    only = SCENARIO_IDS.filter((id) => names.includes(id))
  }
  const options: PerfOptions = {
    only,
    repeat: number('repeat', raw.repeat, DEFAULT_OPTIONS.repeat, 1, 10, true),
    cpuSeconds: number('cpu-seconds', raw.cpuSeconds, DEFAULT_OPTIONS.cpuSeconds, 5, 600, false),
    settleSeconds: number('settle-seconds', raw.settleSeconds, DEFAULT_OPTIONS.settleSeconds, 0, 300, false),
    startupRuns: number('startup-runs', raw.startupRuns, DEFAULT_OPTIONS.startupRuns, 1, 10, true),
    maxRegressionPercent: number('max-regression', raw.maxRegression, DEFAULT_OPTIONS.maxRegressionPercent, 0, 1000, false)
  }
  return errors.length > 0 ? { options: null, errors } : { options, errors }
}
