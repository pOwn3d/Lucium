import { describe, expect, it } from 'vitest'
import {
  appEnvironment,
  budgetGaps,
  budgetIncoherences,
  classifyProcess,
  compareReports,
  cpuMeanPercent,
  DEFAULT_OPTIONS,
  deriveCosts,
  descendantsOf,
  evaluateBudget,
  exitCodeFor,
  formatMarker,
  formatValue,
  limitOf,
  MARKER_PREFIX,
  MEASURES,
  memorySample,
  mergeRuns,
  median,
  pageHtml,
  PAGE_TITLE_PREFIX,
  parseBudget,
  parseCpuTime,
  parseMarkerLine,
  parsePagePath,
  parsePagesBase,
  parsePsOutput,
  parseReport,
  proposeBudget,
  PS_ARGS,
  readFeaturesCost,
  renderReport,
  renderTable,
  resolveOptions,
  sameMachine,
  SCENARIO_IDS,
  SCENARIOS,
  summarizeSteady,
  takeSnapshot,
  type Budget,
  type MachineInfo,
  type Measures,
  type PerfReport,
  type Verdict
} from './perf-core'

// ---------- ps, frozen ----------
// Two listings of `ps -axww -o pid=,ppid=,rss=,time=,command=` 30 seconds apart. The application under test is the process 51200 (started by the
// script, pid 880). Around it: a copy of the same application that someone is really using (61000), another browser (412) and the system, whose
// numbers must never end up in a measure. Between the two listings a tab closes (51300) and another opens (51310).

const HELPERS = '/repo/node_modules/electron/dist/Electron.app/Contents/Frameworks'
const PS_T0 = `
    1     0  21952  46:51.98 /sbin/launchd
  412     1  88112   3:12.40 /Applications/Arc.app/Contents/MacOS/Arc
  420   412  61200   0:41.07 /Applications/Arc.app/Contents/Frameworks/Arc Helper (Renderer).app/Contents/MacOS/Arc Helper (Renderer) --type=renderer --lang=fr
  431   412 140300 1257:57.12 /Applications/Arc.app/Contents/Frameworks/Arc Helper (GPU).app/Contents/MacOS/Arc Helper (GPU) --type=gpu-process
  880   700  64000   0:02.10 node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/perf.mjs
51200   880  95672   0:12.50 /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --smoke --user-data-dir=/var/folders/zz/T/lucium-perf-AbC123
51210 51200 143360   0:08.20 ${HELPERS}/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process --user-data-dir=/var/folders/zz/T/lucium-perf-AbC123
51211 51200  47104   0:01.10 ${HELPERS}/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService
51212 51200  36864   0:00.40 ${HELPERS}/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=storage.mojom.StorageService
51220 51200  90112   0:03.30 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
51221 51200  81920   0:01.20 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
51222 51200  76800   0:00.90 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
51240 51200  12288   0:00.05 ${HELPERS}/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler
51300 51200  55296   0:00.50 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
61000   900 120000 100:04.00 /Applications/Lucium.app/Contents/MacOS/Lucium
61001 61000 200000  20:00.00 /Applications/Lucium.app/Contents/Frameworks/Lucium Helper (Renderer).app/Contents/MacOS/Lucium Helper (Renderer) --type=renderer
61002 61000 150000  30:00.00 /Applications/Lucium.app/Contents/Frameworks/Lucium Helper (GPU).app/Contents/MacOS/Lucium Helper (GPU) --type=gpu-process
`

const PS_T1 = `
    1     0  21952  46:52.10 /sbin/launchd
  412     1  88200   3:12.90 /Applications/Arc.app/Contents/MacOS/Arc
51200   880  96000   0:13.70 /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --smoke --user-data-dir=/var/folders/zz/T/lucium-perf-AbC123
51210 51200 144000   0:08.90 ${HELPERS}/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process --user-data-dir=/var/folders/zz/T/lucium-perf-AbC123
51211 51200  47200   0:01.25 ${HELPERS}/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=network.mojom.NetworkService
51212 51200  36864   0:00.40 ${HELPERS}/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=storage.mojom.StorageService
51220 51200  90500   0:03.60 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
51221 51200  81920   0:01.25 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
51222 51200  76800   0:00.95 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
51240 51200  12288   0:00.05 ${HELPERS}/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler
51310 51200  58368   0:00.60 ${HELPERS}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --lang=fr
61000   900 121000 100:09.00 /Applications/Lucium.app/Contents/MacOS/Lucium
`

const ROOT = 51200

describe('parseCpuTime', () => {
  it('reads the forms ps prints', () => {
    expect(parseCpuTime('0:03.41')).toBeCloseTo(3.41, 5)
    expect(parseCpuTime('1257:57.12')).toBeCloseTo(75477.12, 5)
    expect(parseCpuTime('1:02:03')).toBe(3723)
    expect(parseCpuTime('1:02:03.50')).toBeCloseTo(3723.5, 5)
    expect(parseCpuTime('2-01:00:00')).toBe(2 * 86400 + 3600)
    expect(parseCpuTime('  12:34 ')).toBe(754)
  })

  it('refuses what is not a CPU time, and seconds past 59', () => {
    for (const text of ['', 'abc', '12', '1:2:3:4', '0:75.00', '1:02:99', '-1:00', '0:03,41']) expect(parseCpuTime(text), JSON.stringify(text)).toBeNull()
  })
})

describe('parsePsOutput', () => {
  it('reads every row, keeping the command whole (it holds spaces)', () => {
    const rows = parsePsOutput(PS_T0)
    expect(rows).toHaveLength(17)
    const gpu = rows.find((row) => row.pid === 51210)!
    expect(gpu).toMatchObject({ ppid: 51200, rssKb: 143360, cpuSeconds: 8.2 })
    expect(gpu.command).toContain('Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process')
    expect(rows.find((row) => row.pid === 431)!.cpuSeconds).toBeCloseTo(75477.12, 5)
  })

  it('skips blank lines and nothing else', () => {
    expect(parsePsOutput('\n\n')).toEqual([])
    expect(parsePsOutput('  7  1  100  0:00.01 /bin/x\n\n')).toHaveLength(1)
  })

  it('stops on a line that is not a row, quoting only its numbers', () => {
    expect(() => parsePsOutput('    1     0  21952  46:51.98 /sbin/launchd\nPID PPID RSS TIME COMMAND secret-argument')).toThrow(/ligne inattendue/)
    expect(() => parsePsOutput('7 1 100 notatime /usr/bin/secret-tool --token=abc')).toThrow(/7 1 100 notatime … /)
    try {
      parsePsOutput('7 1 100 notatime /usr/bin/secret-tool --token=abc')
    } catch (error) {
      expect(String(error)).not.toContain('secret-tool')
    }
  })

  it('asks ps for the columns the parser reads, in that order', () => {
    expect(PS_ARGS).toEqual(['-axww', '-o', 'pid=,ppid=,rss=,time=,command='])
  })
})

describe('the process tree', () => {
  it('holds the root and what is below it, and nothing of other applications', () => {
    const tree = descendantsOf(parsePsOutput(PS_T0), ROOT)
    expect(tree.map((row) => row.pid)).toEqual([51200, 51210, 51211, 51212, 51220, 51221, 51222, 51240, 51300])
  })

  it('follows grandchildren, and is empty when the root is gone', () => {
    const rows = parsePsOutput(`${PS_T0}\n51500 51220 1000 0:00.01 /usr/bin/say hello`)
    expect(descendantsOf(rows, ROOT).map((row) => row.pid)).toContain(51500)
    expect(descendantsOf(rows, 99999)).toEqual([])
    expect(takeSnapshot(rows, 99999, 0)).toBeNull()
  })

  it('does not loop on a listing whose parents form a cycle', () => {
    const rows = parsePsOutput('10 11 1 0:00.01 /a\n11 10 1 0:00.01 /b')
    expect(descendantsOf(rows, 10).map((row) => row.pid)).toEqual([10, 11])
  })

  it('tells the kinds of process from the flag Chromium gives its children', () => {
    const snapshot = takeSnapshot(parsePsOutput(PS_T0), ROOT, 0)!
    const kinds = Object.fromEntries(snapshot.processes.map((process) => [process.pid, process.kind]))
    expect(kinds).toEqual({ 51200: 'main', 51210: 'gpu', 51211: 'utility', 51212: 'utility', 51220: 'renderer', 51221: 'renderer', 51222: 'renderer', 51240: 'other', 51300: 'renderer' })
    expect(classifyProcess('/Electron . --smoke', true)).toBe('main')
    expect(classifyProcess('/Electron . --smoke', false)).toBe('other')
    // A path that happens to hold the flag is not the flag.
    expect(classifyProcess('/tmp/x--type=renderer/tool', false)).toBe('other')
  })
})

describe('memory and processor of the tree', () => {
  const first = takeSnapshot(parsePsOutput(PS_T0), ROOT, 1_000)!
  const last = takeSnapshot(parsePsOutput(PS_T1), ROOT, 31_000)!

  it('sums the resident memory by kind, in MB, the total counting every process of the tree', () => {
    expect(memorySample(first)).toEqual({ rssTotalMb: 624.4, rssMainMb: 93.4, rssRendererMb: 297, rssGpuMb: 140, rssUtilityMb: 82, processCount: 9 })
    expect(memorySample(last)).toEqual({ rssTotalMb: 628.8, rssMainMb: 93.8, rssRendererMb: 300.4, rssGpuMb: 140.6, rssUtilityMb: 82.1, processCount: 9 })
  })

  it('computes the mean CPU use from the CPU time each process used in between', () => {
    // 1,20 + 0,70 + 0,15 + 0 + 0,30 + 0,05 + 0,05 + 0 for the old ones, and all of the 0,60 of the tab that opened in between, over 30 s.
    expect(cpuMeanPercent(first, last)).toBe(10.2)
  })

  it('does not count what a process that ended used (its last seconds are in no listing), nor a negative difference', () => {
    const quiet = { ...last, processes: last.processes.filter((process) => process.pid !== 51310) }
    expect(cpuMeanPercent(first, quiet)).toBe(8.2)
    const reused = { at: last.at, processes: [{ pid: 51200, kind: 'main' as const, rssKb: 1, cpuSeconds: 0.1 }] }
    expect(cpuMeanPercent(first, reused)).toBe(0)
  })

  it('refuses two snapshots that are not in order', () => {
    expect(() => cpuMeanPercent(last, first)).toThrow(RangeError)
    expect(() => cpuMeanPercent(first, first)).toThrow(RangeError)
  })

  it('summarizes a series: the median of the memory, the mean CPU from first to last, and the CPU of each interval', () => {
    const middle = takeSnapshot(parsePsOutput(PS_T1), ROOT, 16_000)!
    const summary = summarizeSteady([first, middle, last])
    expect(summary.measures).toEqual({ rssTotalMb: 628.8, rssMainMb: 93.8, rssRendererMb: 300.4, rssGpuMb: 140.6, rssUtilityMb: 82.1, processCount: 9, cpuMeanPct: 10.2 })
    expect(summary.cpuIntervals).toHaveLength(2)
    expect(() => summarizeSteady([first])).toThrow(/au moins deux instantanés/)
  })

  it('takes the median, so that one spike moves nothing', () => {
    expect(median([5, 1, 100])).toBe(5)
    expect(median([1, 2, 3, 10])).toBe(2.5)
    expect(() => median([])).toThrow(RangeError)
    expect(mergeRuns([{ rssTotalMb: 100 }, { rssTotalMb: 900 }, { rssTotalMb: 110 }])).toEqual({ rssTotalMb: 110 })
    expect(mergeRuns([{ cpuMeanPct: 1 }, { rssTotalMb: 7 }])).toEqual({ cpuMeanPct: 1, rssTotalMb: 7 })
  })
})

// ---------- the budget ----------

const REFERENCE = { machine: 'Mac16,5', os: 'macOS 27.0.1', cpu: 'Apple M4 Max', memoryGb: 36, electron: '45.0.0' }
const steady = (total: number, cpu: number) => ({ rssTotalMb: { baseline: total }, cpuMeanPct: { baseline: cpu } })
const makeBudget = (patch: Partial<Budget> = {}): Budget => ({
  version: 1,
  provisional: false,
  defaultMarginPercent: 25,
  reference: REFERENCE,
  scenarios: {
    'startup-cold': { readyMs: { baseline: 3000 } },
    'idle-empty': steady(700, 3),
    'tabs-10': steady(1300, 4),
    'tabs-50': steady(3300, 8),
    'features-off': steady(1250, 3),
    'features-on': steady(1450, 6)
  },
  ...patch
})

const MACHINE: MachineInfo = { os: 'macOS 27.0.1', arch: 'arm64', cpu: 'Apple M4 Max', cores: 16, memoryGb: 36, node: '26.12.1', electron: '45.0.0' }
const makeReport = (results: PerfReport['results'], failures: PerfReport['failures'] = {}): PerfReport => ({
  version: 1,
  generatedAt: '2026-10-24T22:00:00.000Z',
  machine: MACHINE,
  options: { repeat: 1, cpuSeconds: 30, settleSeconds: 10, startupRuns: 3 },
  results,
  failures
})
const run = (measures: Measures) => ({ runs: 1, measures })

describe('limitOf', () => {
  it('adds the margin in percent to the baseline', () => {
    expect(limitOf('rssTotalMb', { baseline: 700 }, 25)).toBe(875)
    expect(limitOf('rssTotalMb', { baseline: 700, marginPercent: 10 }, 25)).toBe(770)
  })

  it('never sits closer to the baseline than the noise of the measure', () => {
    // 25 % of 3 % of CPU is 0,75: below the 3 points of noise.
    expect(limitOf('cpuMeanPct', { baseline: 3 }, 25)).toBe(3 + MEASURES.cpuMeanPct.slack)
    expect(limitOf('readyMs', { baseline: 1000 }, 10)).toBe(1000 + MEASURES.readyMs.slack)
  })
})

describe('parseBudget', () => {
  it('accepts a complete file', () => {
    expect(parseBudget(makeBudget())).toEqual({ budget: makeBudget(), errors: [] })
    expect(budgetGaps(makeBudget())).toEqual([])
  })

  it('refuses a scenario that does not exist, naming the ones that do', () => {
    const budget = makeBudget({ scenarios: { ...makeBudget().scenarios, 'tabs-500': steady(1, 1) } as never })
    const { budget: parsed, errors } = parseBudget(budget)
    expect(parsed).toBeNull()
    expect(errors.join('\n')).toContain('scénario inconnu : tabs-500')
    expect(errors.join('\n')).toContain('tabs-50')
  })

  it('refuses a measure that does not exist, and one the scenario does not make', () => {
    const scenarios = { ...makeBudget().scenarios, 'idle-empty': { ...steady(700, 3), swapMb: { baseline: 1 }, readyMs: { baseline: 5 } } } as never
    const { errors } = parseBudget(makeBudget({ scenarios }))
    expect(errors).toContain('idle-empty : mesure inconnue : swapMb')
    expect(errors).toContain('idle-empty : ce scénario ne fait pas la mesure readyMs')
  })

  it('refuses numbers that are not numbers, a negative baseline and a margin out of range', () => {
    const bad = (entry: unknown) => parseBudget(makeBudget({ scenarios: { 'idle-empty': { rssTotalMb: entry, cpuMeanPct: { baseline: 3 } } } as never })).errors
    expect(bad({ baseline: '700' })).toHaveLength(1)
    expect(bad({ baseline: -1 })).toHaveLength(1)
    expect(bad({ baseline: 1, marginPercent: 900 })).toHaveLength(1)
    expect(bad({ baseline: 1, marginPercent: -5 })).toHaveLength(1)
    expect(bad({ baseline: 1, limit: 5 })).toEqual(['idle-empty.rssTotalMb : clé inconnue : limit'])
    expect(bad(700)).toHaveLength(1)
  })

  it('refuses a wrong version, a missing reference machine, a stray key and a margin out of range', () => {
    expect(parseBudget({ ...makeBudget(), version: 2 }).errors[0]).toContain('version inconnue')
    expect(parseBudget({ ...makeBudget(), reference: undefined }).errors.join()).toContain('reference manquante')
    expect(parseBudget({ ...makeBudget(), reference: { ...REFERENCE, cpu: '' } }).errors.join()).toContain('reference.cpu')
    expect(parseBudget({ ...makeBudget(), surprise: 1 }).errors).toContain('clé inconnue : surprise')
    expect(parseBudget({ ...makeBudget(), defaultMarginPercent: -1 }).errors.join()).toContain('defaultMarginPercent')
    expect(parseBudget({ ...makeBudget(), provisional: 'yes' }).errors.join()).toContain('provisional')
    expect(parseBudget([]).errors).toHaveLength(1)
  })

  it('lists the limits a scenario must have and the file does not give', () => {
    const budget = makeBudget()
    delete budget.scenarios['tabs-50']
    delete budget.scenarios['startup-cold']
    expect(budgetGaps(budget)).toEqual(['startup-cold.readyMs', 'tabs-50.rssTotalMb', 'tabs-50.cpuMeanPct'])
  })
})

describe('evaluateBudget', () => {
  const budget = makeBudget()
  const verdictOf = (verdicts: Verdict[], scenario: string, measure: string) => verdicts.find((verdict) => verdict.scenario === scenario && verdict.measure === measure)

  it('passes a value within its limit, and a value equal to it', () => {
    const verdicts = evaluateBudget({ 'idle-empty': run({ rssTotalMb: 875, cpuMeanPct: 2 }) }, budget)
    expect(verdictOf(verdicts, 'idle-empty', 'rssTotalMb')).toMatchObject({ status: 'ok', limit: 875, baseline: 700, marginPercent: 25 })
    expect(verdictOf(verdicts, 'idle-empty', 'cpuMeanPct')?.status).toBe('ok')
  })

  it('fails a value above its limit', () => {
    const verdicts = evaluateBudget({ 'idle-empty': run({ rssTotalMb: 875.1, cpuMeanPct: 6.1 }) }, budget)
    expect(verdictOf(verdicts, 'idle-empty', 'rssTotalMb')?.status).toBe('over')
    expect(verdictOf(verdicts, 'idle-empty', 'cpuMeanPct')?.status).toBe('over')
  })

  it('says “missing” for a limit whose measure was not produced, which is never a pass', () => {
    const verdicts = evaluateBudget({ 'idle-empty': run({ rssTotalMb: 700 }) }, budget)
    expect(verdictOf(verdicts, 'idle-empty', 'cpuMeanPct')).toMatchObject({ status: 'missing', value: null })
  })

  it('shows a value that has no limit, and leaves out the scenarios that did not run', () => {
    const verdicts = evaluateBudget({ 'tabs-10': run({ rssTotalMb: 1000, cpuMeanPct: 1, rssGpuMb: 150 }) }, budget)
    expect(verdictOf(verdicts, 'tabs-10', 'rssGpuMb')).toMatchObject({ status: 'unbudgeted', limit: null, value: 150 })
    expect(verdicts.every((verdict) => verdict.scenario === 'tabs-10')).toBe(true)
  })

  it('lists the scenarios and the measures in the order of the report', () => {
    const verdicts = evaluateBudget({ 'tabs-10': run({ cpuMeanPct: 1, rssTotalMb: 1 }), 'startup-cold': run({ readyMs: 2000 }) }, budget)
    expect(verdicts.map((verdict) => `${verdict.scenario}.${verdict.measure}`)).toEqual(['startup-cold.readyMs', 'tabs-10.rssTotalMb', 'tabs-10.cpuMeanPct'])
  })
})

describe('proposeBudget', () => {
  it('makes the measures of the run the baselines, keeps the margin an entry had and the entries of scenarios not run', () => {
    const previous = makeBudget({ provisional: true, scenarios: { ...makeBudget().scenarios, 'tabs-10': { rssTotalMb: { baseline: 1300, marginPercent: 40 }, cpuMeanPct: { baseline: 4 } } } })
    const report = makeReport({ 'tabs-10': run({ rssTotalMb: 1111.11, cpuMeanPct: 2.5, processCount: 17 }) })
    const next = proposeBudget(previous, report, { ...REFERENCE, cpu: 'Autre' })
    expect(next.scenarios['tabs-10']).toEqual({ rssTotalMb: { baseline: 1111.1, marginPercent: 40 }, cpuMeanPct: { baseline: 2.5 }, processCount: { baseline: 17 } })
    expect(next.scenarios['tabs-50']).toEqual(previous.scenarios['tabs-50'])
    expect(next.reference.cpu).toBe('Autre')
    expect(parseBudget(next).errors).toEqual([])
  })

  it('stays provisional until a run has measured every scenario, and never goes back', () => {
    const everything = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, run(scenario.kind === 'startup' ? { readyMs: 2000 } : { rssTotalMb: 500, cpuMeanPct: 1 })]))
    expect(proposeBudget(makeBudget({ provisional: true }), makeReport({ 'tabs-10': run({ rssTotalMb: 1, cpuMeanPct: 1 }) }), REFERENCE).provisional).toBe(true)
    expect(proposeBudget(makeBudget({ provisional: true }), makeReport(everything), REFERENCE).provisional).toBe(false)
    expect(proposeBudget(makeBudget({ provisional: false }), makeReport({ 'tabs-10': run({ rssTotalMb: 1, cpuMeanPct: 1 }) }), REFERENCE).provisional).toBe(false)
  })

  it('does not change the budget it was given', () => {
    const previous = makeBudget()
    const before = JSON.stringify(previous)
    proposeBudget(previous, makeReport({ 'tabs-10': run({ rssTotalMb: 1, cpuMeanPct: 1 }) }), REFERENCE)
    expect(JSON.stringify(previous)).toBe(before)
  })
})

// ---------- comparison ----------

describe('compareReports', () => {
  const before = makeReport({ 'tabs-10': run({ rssTotalMb: 1000, cpuMeanPct: 2, processCount: 18 }), 'idle-empty': run({ rssTotalMb: 700 }) })
  const changeOf = (after: PerfReport, measure: string, maxPercent = 15) => compareReports(before, after, maxPercent).find((change) => change.measure === measure)!

  it('flags a growth beyond the percentage that is also beyond the noise', () => {
    const change = changeOf(makeReport({ 'tabs-10': run({ rssTotalMb: 1200 }) }), 'rssTotalMb')
    expect(change).toMatchObject({ before: 1000, after: 1200, delta: 200, deltaPercent: 20, regression: true, improvement: false })
  })

  it('does not flag a growth within the percentage, or within the noise of the measure', () => {
    expect(changeOf(makeReport({ 'tabs-10': run({ rssTotalMb: 1100 }) }), 'rssTotalMb').regression).toBe(false)
    // 2 -> 4 % of CPU doubled, but 2 points are not more than the noise.
    expect(changeOf(makeReport({ 'tabs-10': run({ cpuMeanPct: 4 }) }), 'cpuMeanPct')).toMatchObject({ deltaPercent: 100, regression: false })
    // 18 -> 20 processes is 11 %: under the percentage as well.
    expect(changeOf(makeReport({ 'tabs-10': run({ processCount: 20 }) }), 'processCount').regression).toBe(false)
  })

  it('takes the percentage given', () => {
    expect(changeOf(makeReport({ 'tabs-10': run({ rssTotalMb: 1100 }) }), 'rssTotalMb', 5).regression).toBe(true)
  })

  it('marks the same move down as an improvement, never as a regression', () => {
    const change = changeOf(makeReport({ 'tabs-10': run({ rssTotalMb: 700 }) }), 'rssTotalMb')
    expect(change).toMatchObject({ delta: -300, deltaPercent: -30, regression: false, improvement: true })
  })

  it('compares only what both reports have, and copes with an earlier value of 0', () => {
    const changes = compareReports(before, makeReport({ 'tabs-10': run({ rssTotalMb: 1000 }), 'tabs-50': run({ rssTotalMb: 3000 }) }), 15)
    expect(changes.map((change) => `${change.scenario}.${change.measure}`)).toEqual(['tabs-10.rssTotalMb'])
    const zero = compareReports(makeReport({ 'tabs-10': run({ cpuMeanPct: 0 }) }), makeReport({ 'tabs-10': run({ cpuMeanPct: 9 }) }), 15)
    expect(zero[0]).toMatchObject({ deltaPercent: null, regression: true })
  })
})

describe('parseReport', () => {
  it('accepts a report this script wrote', () => {
    expect(parseReport(JSON.parse(JSON.stringify(makeReport({ 'tabs-10': run({ rssTotalMb: 1 }) })))).errors).toEqual([])
  })

  it('refuses a file that is not one, naming why', () => {
    expect(parseReport('x').errors).toHaveLength(1)
    expect(parseReport({ version: 2 }).errors.join()).toContain('version')
    const odd = { ...makeReport({}), results: { 'tabs-9': { measures: {} }, 'tabs-10': { measures: { rssTotalMb: 'lots', swap: 1 } }, 'tabs-50': {} } }
    const errors = parseReport(odd).errors.join('\n')
    expect(errors).toContain('scénario inconnu dans le rapport : tabs-9')
    expect(errors).toContain('tabs-10.rssTotalMb')
    expect(errors).toContain('mesure inconnue : swap')
    expect(errors).toContain('tabs-50 : mesures manquantes')
  })
})

describe('sameMachine', () => {
  it('compares the processor, the architecture, the cores and the memory, and nothing that changes with an update', () => {
    expect(sameMachine(MACHINE, { ...MACHINE, os: 'macOS 27.1', node: '27.0.0', electron: '46.0.0' })).toBe(true)
    expect(sameMachine(MACHINE, { ...MACHINE, memoryGb: 36.2 })).toBe(true)
    for (const other of [{ cpu: 'Apple M1' }, { arch: 'x64' }, { cores: 8 }, { memoryGb: 16 }]) expect(sameMachine(MACHINE, { ...MACHINE, ...other }), JSON.stringify(other)).toBe(false)
  })
})

describe('exitCodeFor', () => {
  const verdict = (status: Verdict['status']): Verdict => ({ scenario: 'tabs-10', measure: 'rssTotalMb', value: 1, baseline: 1, limit: 2, marginPercent: 25, status })
  const none = { changes: [], failures: {} }

  it('is 0 inside the budget, 1 over it or on a regression, 2 when something could not be measured', () => {
    expect(exitCodeFor({ ...none, verdicts: [verdict('ok'), verdict('unbudgeted')] })).toBe(0)
    expect(exitCodeFor({ ...none, verdicts: [verdict('ok'), verdict('over')] })).toBe(1)
    expect(exitCodeFor({ verdicts: [verdict('ok')], changes: [{ scenario: 'tabs-10', measure: 'rssTotalMb', before: 1, after: 9, delta: 8, deltaPercent: 800, regression: true, improvement: false }], failures: {} })).toBe(1)
    expect(exitCodeFor({ ...none, verdicts: [verdict('missing')] })).toBe(2)
    expect(exitCodeFor({ verdicts: [verdict('over')], changes: [], failures: { 'tabs-50': 'crash' } })).toBe(2)
  })
})

// ---------- derived figures and the text ----------

describe('deriveCosts', () => {
  it('derives the cost of a tab and of the features from the scenarios that made them', () => {
    const costs = deriveCosts({
      'idle-empty': run({ rssTotalMb: 700 }),
      'tabs-10': run({ rssTotalMb: 1300 }),
      'tabs-50': run({ rssTotalMb: 3300 }),
      'features-off': run({ rssTotalMb: 1250, cpuMeanPct: 3, processCount: 18 }),
      'features-on': run({ rssTotalMb: 1450, cpuMeanPct: 6.5, processCount: 19 })
    })
    expect(costs).toEqual({ perTabFirstTenMb: 60, perTabNextFortyMb: 50, featuresMemoryMb: 200, featuresCpuPct: 3.5, featuresProcesses: 1 })
  })

  it('leaves out what a missing scenario would have given', () => {
    expect(deriveCosts({ 'tabs-10': run({ rssTotalMb: 1300 }) })).toEqual({ perTabFirstTenMb: null, perTabNextFortyMb: null, featuresMemoryMb: null, featuresCpuPct: null, featuresProcesses: null })
  })
})

describe('the text of the report', () => {
  it('writes figures with a decimal comma, whole numbers for milliseconds and counts, and a dash for nothing', () => {
    expect(formatValue('rssTotalMb', 1234.56)).toBe('1234,6')
    expect(formatValue('cpuMeanPct', 0.25)).toBe('0,3')
    expect(formatValue('readyMs', 2345.6)).toBe('2346')
    expect(formatValue('processCount', 18)).toBe('18')
    expect(formatValue('rssTotalMb', null)).toBe('—')
  })

  it('pads a table so that it reads as text and as Markdown', () => {
    const table = renderTable(['Nom', 'Valeur'], [['a', '1'], ['longer', '22,5']], [1])
    expect(table.split('\n')).toEqual(['| Nom    | Valeur |', '| ------ | -----: |', '| a      |      1 |', '| longer |   22,5 |'])
  })

  const budget = makeBudget()
  const report = makeReport({ 'idle-empty': run({ rssTotalMb: 900, cpuMeanPct: 1.25 }), 'tabs-10': run({ rssTotalMb: 1300, cpuMeanPct: 4 }) })

  it('lists each measure with its value, its limit, its margin and its verdict', () => {
    const text = renderReport({ report, verdicts: evaluateBudget(report.results, budget), budget })
    const line = text.split('\n').find((row) => row.includes('Mémoire résidente totale') && row.includes('idle-empty'))!
    expect(line).toContain('900,0')
    expect(line).toContain('875,0')
    expect(line).toContain('+25 %')
    expect(line).toContain('DÉPASSÉ')
    expect(text.split('\n').find((row) => row.includes('tabs-10') && row.includes('Mémoire résidente totale'))).toContain('ok')
    expect(text).toContain('1 seuil(s) dépassé(s), 0 mesure(s) manquante(s).')
  })

  it('says so when nothing is over, when the budget is provisional, and when a scenario failed', () => {
    const fine = makeReport({ 'tabs-10': run({ rssTotalMb: 1300, cpuMeanPct: 4 }) }, { 'tabs-50': 'l’application s’est arrêtée' })
    const text = renderReport({ report: fine, verdicts: evaluateBudget(fine.results, budget), budget: makeBudget({ provisional: true }) })
    expect(text).toContain('Aucun seuil dépassé.')
    expect(text).toContain('provisoires')
    expect(text).toContain('- tabs-50 : l’application s’est arrêtée')
  })

  it('shows the comparison with its regressions, and warns when the earlier run was on another machine', () => {
    const earlier = makeReport({ 'tabs-10': run({ rssTotalMb: 1000, cpuMeanPct: 4 }) })
    const now = makeReport({ 'tabs-10': run({ rssTotalMb: 1300, cpuMeanPct: 4 }) })
    const text = renderReport({ report: now, verdicts: evaluateBudget(now.results, budget), changes: compareReports(earlier, now, 15), otherMachine: { ...MACHINE, cpu: 'Apple M1' }, budget })
    expect(text).toContain('RÉGRESSION')
    expect(text).toContain('1 régression(s).')
    expect(text).toContain('autre machine (Apple M1')
    expect(renderReport({ report: now, verdicts: [], changes: [], budget })).toContain('Aucun scénario en commun')
  })

  it('names the cost of a tab and of the features when it can derive them', () => {
    const all = makeReport({
      'idle-empty': run({ rssTotalMb: 700 }),
      'tabs-10': run({ rssTotalMb: 1300 }),
      'features-off': run({ rssTotalMb: 1250, cpuMeanPct: 3, processCount: 18 }),
      'features-on': run({ rssTotalMb: 1450, cpuMeanPct: 6, processCount: 19 })
    })
    const text = renderReport({ report: all, verdicts: [], budget })
    expect(text).toContain('de la fenêtre vide à 10 onglets : 60,0 Mo')
    expect(text).toContain('+200,0 Mo, +3,0 % de processeur, +1 processus')
  })

  it('says that a difference between the features on and off is not a cost when it is below zero beyond the noise, or within it', () => {
    const withFeatures = (on: number, off: number): string =>
      renderReport({ report: makeReport({ 'features-off': run({ rssTotalMb: off }), 'features-on': run({ rssTotalMb: on }) }), verdicts: [], budget })
    // The run the budget was calibrated on: the features « saved » 160 MB.
    const lighter = withFeatures(1409.7, 1570.3)
    expect(lighter).toContain('−160,6 Mo')
    expect(lighter).toContain('Ce chiffre n’est pas un coût')
    expect(lighter).toContain('--repeat 3')
    const same = withFeatures(1420, 1400)
    expect(same).toContain('dans le bruit toléré de la mesure (32 Mo)')
    expect(same).not.toContain('n’est pas un coût')
    const heavier = withFeatures(1600, 1400)
    expect(heavier).not.toContain('bruit toléré')
    expect(heavier).not.toContain('n’est pas un coût')
  })

  it('reads the difference by the slack of its measure', () => {
    expect(readFeaturesCost('rssTotalMb', -33)).toBe('not-comparable')
    expect(readFeaturesCost('rssTotalMb', -32)).toBe('within-noise')
    expect(readFeaturesCost('rssTotalMb', 32)).toBe('within-noise')
    expect(readFeaturesCost('rssTotalMb', 33)).toBe('cost')
    expect(readFeaturesCost('rssMainMb', -17)).toBe('not-comparable')
  })

  it('names the baselines of a budget that put the features on below the features off, and says to calibrate again', () => {
    const scenarios = { 'features-off': { rssTotalMb: { baseline: 1570.3 }, rssMainMb: { baseline: 224.9 }, rssRendererMb: { baseline: 1195.4 }, rssGpuMb: { baseline: 95 } }, 'features-on': { rssTotalMb: { baseline: 1409.7 }, rssMainMb: { baseline: 190.2 }, rssRendererMb: { baseline: 1092.7 }, rssGpuMb: { baseline: 60 } } }
    const incoherent = makeBudget({ scenarios })
    expect(budgetIncoherences(incoherent)).toEqual([
      { measure: 'rssTotalMb', on: 1409.7, off: 1570.3 },
      { measure: 'rssMainMb', on: 190.2, off: 224.9 },
      { measure: 'rssRendererMb', on: 1092.7, off: 1195.4 }
    ])
    const text = renderReport({ report, verdicts: [], budget: incoherent })
    expect(text).toContain('## Seuils incohérents')
    expect(text).toContain('Mémoire résidente totale : 1409,7 Mo allumées, 1570,3 Mo coupées.')
    expect(text).toContain('pnpm perf --repeat 3 --write-budget')
    // A budget whose two scenarios agree, or that lacks one of them, has nothing to say.
    expect(budgetIncoherences(budget)).toEqual([])
    expect(budgetIncoherences(makeBudget({ scenarios: { 'features-on': { rssTotalMb: { baseline: 100 } } } }))).toEqual([])
    expect(renderReport({ report, verdicts: [], budget })).not.toContain('Seuils incohérents')
  })
})

// ---------- the command line, the environment, the markers, the pages ----------

describe('resolveOptions', () => {
  it('has defaults, and all the scenarios', () => {
    expect(resolveOptions({})).toEqual({ options: { ...DEFAULT_OPTIONS, only: [...SCENARIO_IDS] }, errors: [] })
  })

  it('keeps the scenarios asked for, in the order of the report', () => {
    expect(resolveOptions({ only: 'tabs-50, idle-empty' }).options?.only).toEqual(['idle-empty', 'tabs-50'])
  })

  it('refuses a scenario that does not exist, naming the ones that do', () => {
    const { options, errors } = resolveOptions({ only: 'idle-empty,tabs-9' })
    expect(options).toBeNull()
    expect(errors.join()).toContain('scénario inconnu : tabs-9')
    expect(errors.join()).toContain('startup-cold')
    expect(resolveOptions({ only: ' , ' }).errors).toEqual(['--only : au moins un scénario est attendu'])
  })

  it('refuses numbers out of range or not numbers, all of them at once', () => {
    const { options, errors } = resolveOptions({ repeat: '0', cpuSeconds: '1', settleSeconds: 'x', startupRuns: '2.5', maxRegression: '' })
    expect(options).toBeNull()
    expect(errors).toHaveLength(5)
    expect(resolveOptions({ repeat: '3', cpuSeconds: '12.5', settleSeconds: '0' }).options).toMatchObject({ repeat: 3, cpuSeconds: 12.5, settleSeconds: 0 })
  })
})

describe('appEnvironment', () => {
  it('drops what could change what runs, keeps the rest, and adds the variables of the scenario', () => {
    const env = appEnvironment(
      { PATH: '/usr/bin', HOME: '/Users/x', LUCIUM_EXTENSIONS: '/ext', LUCIUM_UPDATE_FEED: 'https://feed', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://localhost:5173', NODE_OPTIONS: '--inspect', EMPTY: undefined },
      { LUCIUM_SMOKE_ONLY: 'perf' }
    )
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', LUCIUM_SMOKE_ONLY: 'perf' })
  })
})

describe('the lines the application prints', () => {
  const info = { scenario: 'tabs-10', tabs: 10, liveTabs: 10, featuresOn: ['sleep'], featuresOff: ['lock'] }

  it('round-trips', () => {
    for (const marker of [{ kind: 'shown' as const, uptimeMs: 1234 }, { kind: 'ready' as const, info }, { kind: 'error' as const, message: 'la page 3 ne s’est pas chargée' }]) {
      expect(parseMarkerLine(formatMarker(marker))).toEqual(marker)
    }
    expect(formatMarker({ kind: 'shown', uptimeMs: 1234.6 })).toBe(`${MARKER_PREFIX}SHOWN 1235`)
  })

  it('ignores every other line', () => {
    for (const line of ['', '[smoke] skipped openExternal', ` ${MARKER_PREFIX}SHOWN 1`, 'prefix LUCIUM_PERF_SHOWN 1', `${MARKER_PREFIX}OTHER 1`]) expect(parseMarkerLine(line), JSON.stringify(line)).toBeNull()
  })

  it('turns a line that carries the prefix but cannot be read into an error, so that the run stops with the reason', () => {
    for (const line of [`${MARKER_PREFIX}SHOWN abc`, `${MARKER_PREFIX}SHOWN -3`, `${MARKER_PREFIX}SHOWN`, `${MARKER_PREFIX}READY {`, `${MARKER_PREFIX}READY []`, `${MARKER_PREFIX}READY ${JSON.stringify({ ...info, tabs: -1 })}`, `${MARKER_PREFIX}READY ${JSON.stringify({ ...info, featuresOn: 'sleep' })}`]) {
      expect(parseMarkerLine(line), line).toMatchObject({ kind: 'error' })
    }
  })

  it('keeps an error message on one line', () => {
    expect(formatMarker({ kind: 'error', message: 'a\nb\n  c' })).toBe(`${MARKER_PREFIX}ERROR a b c`)
  })
})

describe('the pages the tabs show', () => {
  it('carries its number in the title, the one the application waits for', () => {
    expect(pageHtml(7)).toContain(`<title>${PAGE_TITLE_PREFIX}7</title>`)
  })

  it('has the weight of an ordinary page, differs from one tab to the next, and is the same each time', () => {
    const page = pageHtml(3)
    expect(page.length).toBeGreaterThan(15_000)
    expect(page.length).toBeLessThan(60_000)
    expect(page).not.toBe(pageHtml(4))
    expect(pageHtml(3)).toBe(page)
  })

  it('loads nothing: no script, no image, no stylesheet, no address of another site', () => {
    const page = pageHtml(12)
    expect(page).not.toMatch(/<script|<img|<link|<iframe|<video|@import|url\(/i)
    expect(page.match(/(?:src|href)="([^"]*)"/g)!.every((attribute) => /="\/p\/12#p\d+"$/.test(attribute))).toBe(true)
    expect(page).not.toMatch(/https?:\/\//)
  })

  it('reads the number of a page from a path, and nothing else', () => {
    expect(parsePagePath('/p/12')).toBe(12)
    for (const path of ['/p/', '/p/x', '/p/12/', '/p/12345', '/favicon.ico', '/', '/p/1?x=1', '//p/1']) expect(parsePagePath(path), path).toBeNull()
  })

  it('accepts the address of the script’s server and no other', () => {
    expect(parsePagesBase('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321')
    for (const text of [undefined, '', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'https://127.0.0.1:5000', 'http://localhost:5000', 'http://127.0.0.1:5000/', 'http://evil.example:80', 'http://127.0.0.1:5000@evil.example']) expect(parsePagesBase(text), String(text)).toBeNull()
  })
})

describe('the scenarios', () => {
  it('have unique ids, measures the budget can name, and required measures among their own', () => {
    expect(new Set(SCENARIO_IDS).size).toBe(SCENARIOS.length)
    for (const scenario of SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      for (const measure of scenario.measures) expect(measure in MEASURES, `${scenario.id}.${measure}`).toBe(true)
      for (const measure of scenario.required) expect(scenario.measures as readonly string[], `${scenario.id}.${measure}`).toContain(measure)
    }
  })

  it('make the measures their kind needs: the start-up one only the time, the others memory and processor', () => {
    for (const scenario of SCENARIOS) {
      if (scenario.kind === 'startup') expect(scenario.measures).toEqual(['readyMs'])
      else {
        expect(scenario.measures).toContain('rssTotalMb')
        expect(scenario.measures).toContain('cpuMeanPct')
        expect(scenario.measures).not.toContain('readyMs')
      }
    }
  })

  it('cover what was asked: an empty window, 10 and 50 tabs, every feature off and on, and a cold start', () => {
    const by = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, scenario]))
    expect(by['idle-empty']).toMatchObject({ tabs: 0, features: 'default' })
    expect(by['tabs-10']).toMatchObject({ tabs: 10, features: 'default' })
    expect(by['tabs-50']).toMatchObject({ tabs: 50, features: 'default' })
    expect(by['features-off']).toMatchObject({ tabs: 10, features: 'off' })
    expect(by['features-on']).toMatchObject({ tabs: 10, features: 'on' })
    expect(by['startup-cold']).toMatchObject({ kind: 'startup' })
    expect(DEFAULT_OPTIONS.cpuSeconds).toBe(30)
  })
})
