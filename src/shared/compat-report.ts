// The report of an engine run (`pnpm test:engine` writes it) and its comparison with the reference kept in compat/baseline-electron-<version>.json.
// The comparison used to be a `diff` made by hand against a file two versions old; `pnpm compat:compare` (scripts/compat-compare.mjs) makes it with
// the functions below, and says what an Electron upgrade took away. No Electron, no Node here: the script and the unit tests both load this file.

/** One check as a report keeps it: its name and how it ended. The detail of a check (ports, paths, times) changes from run to run and is left out. */
export interface ReportCheck {
  name: string
  ok: boolean
  skipped?: true
}

export interface ReportSuite {
  /** 0 when the suite passed. */
  code: number
  checks: ReportCheck[]
}

/** What the API probe (compat/api-probe) found in the worker of an extension. */
export interface ApiProbe {
  present: number
  missing: string[]
  calls: Record<string, string>
}

export interface CompatReport {
  engine: { name: string; version: string; chromium: string }
  /** The suites that ran, by the name of the table of suites (src/main/smoke-suites.ts). */
  suites: Record<string, ReportSuite>
  apiProbe: ApiProbe | null
  /** Whether a declarativeNetRequest rule of an extension stopped the request it covers; null when it was not measured. */
  declarativeNetRequestEnforced: boolean | null
  /**
   * What the suite `probes-ext` saw of each request rule and each chrome.webRequest event of an extension, by key (`dnr.session.block`,
   * `webRequest.onCompleted`...): `applied`, or why not (main/smoke-probe-kit.ts). Null when the suite did not run.
   */
  extensionNetworkRules: Record<string, string> | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// A host of the machine itself followed by its port: `localhost`, a name under it (`p.localhost`), an IPv4 address, a bracketed IPv6 one.
const LOCAL_SERVER_PORT = /(?<![\w.-])((?:[a-z0-9-]+\.)*localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d{1,5}(?!\d)/gi

/**
 * The name of a check as a report keeps it. The suites that fill sites start their local server on a port the system picks, and put the host in
 * the name of the check (`127.0.0.1:64949 finished filling its storage`): the port changes from run to run, so it is written `<port>`, and the
 * same check keeps the same name in the reference and in the run.
 */
export const normalizeCheckName = (name: string): string => name.replace(LOCAL_SERVER_PORT, '$1:<port>')

function checksOf(value: unknown, where: string): ReportCheck[] {
  if (!Array.isArray(value)) throw new Error(`${where}: "checks" is not a list`)
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['ok'] !== 'boolean') throw new Error(`${where}: check ${index} has no name or no result`)
    const name = normalizeCheckName(entry['name'])
    return entry['skipped'] === true ? { name, ok: entry['ok'], skipped: true } : { name, ok: entry['ok'] }
  })
}

function apiProbeOf(value: unknown): ApiProbe | null {
  // The probe answers once per worker start: the first answer is the one a report keeps.
  const first = Array.isArray(value) ? value[0] : value
  if (!isRecord(first)) return null
  const calls = isRecord(first['calls']) ? Object.fromEntries(Object.entries(first['calls']).map(([name, result]) => [name, String(result)])) : {}
  return { present: typeof first['present'] === 'number' ? first['present'] : 0, missing: Array.isArray(first['missing']) ? first['missing'].map(String) : [], calls }
}

/**
 * Reads a report or a reference, whatever wrote it, and keeps what is compared: the names of the checks without the port of a local server
 * (normalizeCheckName). Two shapes are read: the one of a run (`suites`), and the one of the first reference (compat/baseline-electron-45.0.0.json:
 * the checks of the principal suite alone, at the top). Anything else is refused with the reason.
 */
export function readReport(raw: unknown, where: string): CompatReport {
  if (!isRecord(raw)) throw new Error(`${where}: not a report (an object is expected)`)
  const engine = raw['engine']
  if (!isRecord(engine) || typeof engine['version'] !== 'string' || typeof engine['chromium'] !== 'string') throw new Error(`${where}: no engine version`)
  const suites: Record<string, ReportSuite> = {}
  if (isRecord(raw['suites'])) {
    for (const [name, suite] of Object.entries(raw['suites'])) {
      if (!isRecord(suite)) throw new Error(`${where}: the suite "${name}" is not an object`)
      suites[name] = { code: typeof suite['code'] === 'number' ? suite['code'] : 1, checks: checksOf(suite['checks'], `${where}, suite "${name}"`) }
    }
  } else if (Array.isArray(raw['checks'])) {
    const checks = checksOf(raw['checks'], where)
    suites['main'] = { code: checks.some((check) => !check.ok) ? 1 : 0, checks }
  } else {
    throw new Error(`${where}: neither "suites" nor "checks"`)
  }
  const compat = isRecord(raw['compat']) ? raw['compat']['declarativeNetRequestEnforced'] : raw['declarativeNetRequestEnforced']
  return {
    engine: { name: typeof engine['name'] === 'string' ? engine['name'] : 'electron', version: engine['version'], chromium: engine['chromium'] },
    suites,
    apiProbe: apiProbeOf(raw['apiProbe']),
    declarativeNetRequestEnforced: typeof compat === 'boolean' ? compat : null,
    extensionNetworkRules: isRecord(raw['extensionNetworkRules']) ? Object.fromEntries(Object.entries(raw['extensionNetworkRules']).map(([key, state]) => [key, String(state)])) : null
  }
}

export interface Comparison {
  /** What the reference had and the run lost: any line here fails the comparison. */
  regressions: string[]
  /** What the run has and the reference had not, or what got better: to read, then to keep by writing a new reference. */
  news: string[]
  /** Checks of the reference the run no longer makes, each with the reason given for it (readExplanations): they do not fail the comparison. */
  explained: string[]
  /** The explanations that matched nothing the run lost: the check is still made, or its name is written wrong. */
  unusedExplanations: string[]
}

type CheckState = 'passed' | 'failed' | 'skipped'

const stateOf = (check: ReportCheck): CheckState => (check.skipped ? 'skipped' : check.ok ? 'passed' : 'failed')

function statesByName(checks: readonly ReportCheck[]): Map<string, CheckState[]> {
  const states = new Map<string, CheckState[]>()
  for (const check of checks) {
    const list = states.get(check.name)
    if (list === undefined) states.set(check.name, [stateOf(check)])
    else list.push(stateOf(check))
  }
  return states
}

/**
 * Pairs the times a name was made in the reference with the times it was made in the run. A suite can make the same check several times (one per
 * site it fills): a name is known by its count, and the run loses one only when it proves it fewer times than the reference did. Passes are paired
 * with passes first.
 *   lost   for each pass of the reference left without a pass: how the run made it instead, or `missing` when it made it fewer times
 *   fixed  for each pass of the run that finds a check of the reference that did not pass: how the reference had it
 *   added  how the run made the name in the times beyond those of the reference
 */
function pairStates(before: readonly CheckState[], after: readonly CheckState[]): { lost: Array<CheckState | 'missing'>; fixed: CheckState[]; added: CheckState[] } {
  const passedBefore = before.filter((state) => state === 'passed').length
  const passedAfter = after.filter((state) => state === 'passed').length
  const both = Math.min(passedBefore, passedAfter)
  let passesLeft = passedAfter - both
  const othersAfter = after.filter((state) => state !== 'passed')
  const lost = Array.from({ length: passedBefore - both }, () => othersAfter.shift() ?? ('missing' as const))
  const fixed: CheckState[] = []
  for (const state of before) {
    if (state === 'passed') continue
    if (passesLeft > 0) {
      fixed.push(state)
      passesLeft--
    } else othersAfter.shift()
  }
  return { lost, fixed, added: [...Array.from({ length: passesLeft }, () => 'passed' as const), ...othersAfter] }
}

/**
 * Reads the file of explanations `pnpm compat:compare --explained <file>` takes: `{ "<name of a check>": "<why it is no longer made>" }`, one
 * entry per check of the reference that was removed or renamed on purpose. The names are read as reports are (normalizeCheckName). Anything else
 * is refused with the reason: an explanation without a reason would let a lost check pass unread.
 */
export function readExplanations(raw: unknown, where: string): Record<string, string> {
  if (!isRecord(raw)) throw new Error(`${where}: not a list of explanations (an object { "<name of a check>": "<reason>" } is expected)`)
  const explanations: Record<string, string> = {}
  for (const [name, reason] of Object.entries(raw)) {
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`${where}: "${name}" has no reason`)
    explanations[normalizeCheckName(name)] = reason.trim()
  }
  return explanations
}

/**
 * Sets a run against the reference. A regression is something the reference proved and the run does not: a check that passed and now fails, is
 * skipped or is no longer made, a suite that no longer runs, a chrome.* API that was there and is missing, a call that answered and no longer does,
 * a request rule that was applied and is not (the one rule of the principal suite, and each rule and event the suite `probes-ext` measures). A check that failed in the reference and still fails is not one: the reference records it as known.
 * A check that is no longer made and has an explanation (readExplanations) is listed with its reason instead: a check can be removed or renamed on
 * purpose. One that fails or is skipped is never explained away: it is still made, and does not prove what it proved.
 */
export function compareReports(reference: CompatReport, run: CompatReport, explanations: Readonly<Record<string, string>> = {}): Comparison {
  const regressions: string[] = []
  const news: string[] = []
  const explained: string[] = []
  const used = new Set<string>()
  for (const [suiteName, suite] of Object.entries(reference.suites)) {
    const now = run.suites[suiteName]
    if (now === undefined) {
      regressions.push(`suite "${suiteName}": did not run (${suite.checks.length} checks in the reference)`)
      continue
    }
    const after = statesByName(now.checks)
    const before = statesByName(suite.checks)
    for (const [name, states] of before) {
      const made = after.get(name) ?? []
      const { lost, fixed, added } = pairStates(states, made)
      const times = states.length > 1 ? ` (made ${made.length} times, ${states.length} in the reference)` : ''
      for (const state of lost) {
        if (state !== 'missing') regressions.push(`${suiteName}: ${state} (passed in the reference): ${name}`)
        else if (Object.hasOwn(explanations, name)) {
          used.add(name)
          explained.push(`${suiteName}: no longer made: ${name}${times}: ${explanations[name]}`)
        } else regressions.push(`${suiteName}: no longer made: ${name}${times}`)
      }
      for (const state of fixed) news.push(`${suiteName}: passes now (${state} in the reference): ${name}`)
      for (const state of added) {
        // A check made once more than in the reference that fails is not hidden among the news: the reference never saw it pass.
        if (state === 'failed') regressions.push(`${suiteName}: made once more, failed: ${name}`)
        else news.push(`${suiteName}: made once more (${state}): ${name}`)
      }
    }
  }
  for (const [suiteName, suite] of Object.entries(run.suites)) {
    const before = reference.suites[suiteName]
    if (before === undefined) {
      news.push(`suite "${suiteName}": new (${suite.checks.length} checks, ${suite.checks.filter((check) => !check.ok).length} failed)`)
      continue
    }
    const known = new Set(before.checks.map((check) => check.name))
    for (const check of suite.checks) {
      if (known.has(check.name)) continue
      // A new check that fails is not hidden among the new ones: the reference never saw it pass, but the run is not clean either.
      if (stateOf(check) === 'failed') regressions.push(`${suiteName}: new check, failed: ${check.name}`)
      else news.push(`${suiteName}: new check (${stateOf(check)}): ${check.name}`)
    }
  }
  if (reference.apiProbe !== null) {
    if (run.apiProbe === null) regressions.push('chrome.* APIs: the probe gave no answer (it did in the reference)')
    else {
      const wasMissing = new Set(reference.apiProbe.missing)
      for (const api of run.apiProbe.missing) if (!wasMissing.has(api)) regressions.push(`chrome.* APIs: ${api} is missing (present in the reference)`)
      for (const api of reference.apiProbe.missing) if (!run.apiProbe.missing.includes(api)) news.push(`chrome.* APIs: ${api} is present now`)
      if (run.apiProbe.present < reference.apiProbe.present) regressions.push(`chrome.* APIs: ${run.apiProbe.present} present, ${reference.apiProbe.present} in the reference`)
      for (const [call, result] of Object.entries(reference.apiProbe.calls)) {
        const after = run.apiProbe.calls[call]
        if (result === 'ok' && after !== 'ok') regressions.push(`chrome.* calls: ${call} answered "${after ?? 'nothing'}" (ok in the reference)`)
      }
    }
  }
  if (reference.declarativeNetRequestEnforced === true && run.declarativeNetRequestEnforced !== true) {
    regressions.push(`declarativeNetRequest: the rule of an extension is ${run.declarativeNetRequestEnforced === false ? 'not applied' : 'not measured'} (applied in the reference)`)
  }
  // A rule that is not applied is not a failed check while its correction is put off (it is counted as skipped): the state by key is what tells a
  // rule that was applied and no longer is, and one that is applied at last.
  for (const [key, state] of Object.entries(reference.extensionNetworkRules ?? {})) {
    const after = run.extensionNetworkRules?.[key]
    if (state === 'applied' && after !== 'applied') regressions.push(`extension network rules: ${key} is ${after ?? 'not measured'} (applied in the reference)`)
  }
  for (const [key, state] of Object.entries(run.extensionNetworkRules ?? {})) {
    const before = reference.extensionNetworkRules?.[key]
    if (state === 'applied' && before !== 'applied') news.push(`extension network rules: ${key} is applied now (${before ?? 'not measured'} in the reference)`)
  }
  return { regressions, news, explained, unusedExplanations: Object.keys(explanations).filter((name) => !used.has(name)) }
}

/** Orders versions as numbers, part by part: 45.10.0 comes after 45.2.1. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The reference a run is set against when none is named: the one of the highest version among `compat/baseline-electron-<version>.json`. */
export function latestBaseline(files: readonly string[]): string | null {
  const versioned = files.flatMap((file) => {
    const version = /^baseline-electron-(\d[\w.+-]*)\.json$/.exec(file)?.[1]
    return version === undefined ? [] : [{ file, version }]
  })
  versioned.sort((a, b) => compareVersions(b.version, a.version))
  return versioned[0]?.file ?? null
}

export const baselineName = (version: string): string => `baseline-electron-${version}.json`
