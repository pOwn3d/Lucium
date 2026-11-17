import { describe, expect, it } from 'vitest'
import {
  BENCH_SCHEMA,
  batteryDischargeW,
  benchBrowserEnv,
  isMeasuredByDefault,
  buildReport,
  costPerTab,
  descendantsOf,
  estimateDurationS,
  findMainPids,
  formatNumber,
  inputDuringWindow,
  isValidRun,
  median,
  parseCpuTime,
  parseHidIdleNs,
  parseIoregBattery,
  parseLowPowerMode,
  parsePmsetBatt,
  parsePs,
  parseTop,
  quietWarnings,
  redactHome,
  renderMarkdown,
  rotateOrder,
  selectBrowserProcesses,
  stat,
  sumTop,
  summarizeBaseline,
  summarizeRuns,
  summarizeWindow,
  systemLoadW,
  toSigned64,
  type BrowserInfo,
  type PsRow,
  type RunResult
} from './bench-core'

const NNBSP = ' '

const row = (pid: number, ppid: number, rssKiB: number, cpuSeconds: number, command = `/x/p${pid}`): PsRow => ({ pid, ppid, rssKiB, cpuSeconds, command })

describe('parseCpuTime', () => {
  it('reads the formats ps prints, with a dot or a comma', () => {
    expect(parseCpuTime('0:00.04')).toBeCloseTo(0.04)
    expect(parseCpuTime('46:52.50')).toBeCloseTo(2812.5)
    expect(parseCpuTime('1:02:03.45')).toBeCloseTo(3723.45)
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
    expect(parseCpuTime(' 0:01,50 ')).toBeCloseTo(1.5)
  })
  it('refuses what is not a CPU time', () => {
    for (const text of ['', 'abc', '12', '1:2:3:4', '-', '0:xx']) expect(parseCpuTime(text)).toBeNull()
  })
})

describe('parsePs', () => {
  const output = [
    '    1     0  20976  46:52.50 /sbin/launchd',
    '  500     1 400000   3:10.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  501   500 150000   1:00.25 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/156/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
    '',
    'this is not a row',
    '  502   500  abc   0:01.00 /x/y',
    '  503   500  1000  nope /x/z'
  ].join('\n')

  it('reads the executable path whole, spaces and brackets included, and counts the lines that are not rows', () => {
    const { rows, skipped } = parsePs(output)
    expect(rows.map((r) => r.pid)).toEqual([1, 500, 501])
    expect(rows[2]).toEqual({
      pid: 501,
      ppid: 500,
      rssKiB: 150000,
      cpuSeconds: 60.25,
      command: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/156/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)'
    })
    expect(skipped).toBe(3)
  })
})

describe('descendantsOf', () => {
  const rows = [row(1, 0, 1, 1), row(10, 1, 1, 1), row(11, 10, 1, 1), row(12, 11, 1, 1), row(13, 10, 1, 1), row(20, 1, 1, 1), row(21, 20, 1, 1)]

  it('takes a root and everything below it, and nothing else', () => {
    expect(descendantsOf(rows, [10]).map((r) => r.pid)).toEqual([10, 11, 12, 13])
    expect(descendantsOf(rows, [10, 20]).map((r) => r.pid)).toEqual([10, 11, 12, 13, 20, 21])
  })
  it('never takes the whole machine: pid 1 and 0 are not roots', () => {
    expect(descendantsOf(rows, [1])).toEqual([])
    expect(descendantsOf(rows, [0, 1, 20]).map((r) => r.pid)).toEqual([20, 21])
  })
  it('does not follow a child that points to launchd', () => {
    // A row whose parent is 1 is not a child of anything we started.
    expect(descendantsOf([row(10, 1, 1, 1), row(11, 1, 1, 1)], [10]).map((r) => r.pid)).toEqual([10])
  })
  it('ends on a loop of parents', () => {
    expect(descendantsOf([row(10, 11, 1, 1), row(11, 10, 1, 1)], [10]).map((r) => r.pid)).toEqual([10, 11])
  })
  it('ignores a root that has left', () => {
    expect(descendantsOf(rows, [999])).toEqual([])
  })
})

describe('findMainPids and selectBrowserProcesses', () => {
  const main = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const helper = '/Applications/Google Chrome.app/Contents/Frameworks/G.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper'
  const rows = [row(200, 1, 1, 1, main), row(201, 200, 1, 1, helper), row(300, 1, 1, 1, main), row(301, 300, 1, 1, helper)]

  it('finds the main processes only, and leaves out the ones that were there before', () => {
    expect(findMainPids(rows, 'Google Chrome.app/Contents/MacOS/Google Chrome')).toEqual([200, 300])
    expect(findMainPids(rows, 'Google Chrome.app/Contents/MacOS/Google Chrome', new Set([200]))).toEqual([300])
  })

  it('keeps the tree of the instance we started and not the one the user had open', () => {
    expect(selectBrowserProcesses(rows, { rootPids: [300] }).map((r) => r.pid)).toEqual([300, 301])
  })

  it('takes the web-view processes of Safari by their path, except the ones that existed before, and keeps a root that was already running', () => {
    const safari = '/System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari'
    const webContent = '/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'
    const networking = '/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking'
    const all = [row(100, 1, 1, 1, safari), row(90, 1, 1, 1, webContent), row(101, 1, 1, 1, webContent), row(102, 1, 1, 1, networking), row(103, 1, 1, 1, '/usr/bin/other')]
    const picked = selectBrowserProcesses(all, { rootPids: [100], pathIncludes: ['com.apple.WebKit.'], excludePids: new Set([90, 100]) })
    expect(picked.map((r) => r.pid)).toEqual([100, 101, 102])
  })
})

describe('summarizeWindow', () => {
  const A = '/x/a'
  const B = '/x/b'
  const C = '/x/c'
  const samples = [
    { tMs: 1000, procs: [row(1, 0, 1024, 10, A), row(2, 1, 2048, 5, B)] },
    { tMs: 31000, procs: [row(1, 0, 2048, 25, A), row(2, 1, 2048, 5, B), row(3, 1, 1024, 2, C)] },
    { tMs: 61000, procs: [row(1, 0, 2048, 40, A), row(3, 1, 2048, 8, C)] }
  ]

  it('adds up what each process used between the samples, the ones that were born or left during the window included', () => {
    const stats = summarizeWindow(samples)
    expect(stats?.durationS).toBe(60)
    // A 15 + 15, B 0, C (born in the window) 2 + 6.
    expect(stats?.cpuSeconds).toBeCloseTo(38)
    expect(stats?.cpuPercent).toBeCloseTo(63.3333, 3)
    expect(stats?.rssMiBMean).toBeCloseTo(4)
    expect(stats?.rssMiBMax).toBeCloseTo(5)
    expect(stats?.rssMiBLast).toBeCloseTo(4)
    expect(stats?.processesMean).toBeCloseTo(7 / 3)
    expect(stats?.processesMax).toBe(3)
    expect(stats?.samples).toBe(3)
  })

  it('does not count the CPU time a process had before the window', () => {
    const stats = summarizeWindow([
      { tMs: 0, procs: [row(1, 0, 1024, 9000, A)] },
      { tMs: 10000, procs: [row(1, 0, 1024, 9005, A)] }
    ])
    expect(stats?.cpuSeconds).toBeCloseTo(5)
    expect(stats?.cpuPercent).toBeCloseTo(50)
  })

  it('counts a process that started again under the same pid from zero, never a negative time', () => {
    const stats = summarizeWindow([
      { tMs: 0, procs: [row(1, 0, 1024, 100, A)] },
      { tMs: 10000, procs: [row(1, 0, 1024, 3, A)] }
    ])
    expect(stats?.cpuSeconds).toBeCloseTo(3)
  })

  it('takes a pid reused by another program for another process', () => {
    const stats = summarizeWindow([
      { tMs: 0, procs: [row(1, 0, 1024, 100, A)] },
      { tMs: 10000, procs: [row(1, 0, 1024, 104, B)] }
    ])
    // The process A left (its last known time is its last sample); B is new and has used its 104 s since its start, during the window.
    expect(stats?.cpuSeconds).toBeCloseTo(104)
  })

  it('has no window to speak of with one sample, or a clock that does not advance', () => {
    expect(summarizeWindow([])).toBeNull()
    expect(summarizeWindow([samples[0]!])).toBeNull()
    expect(summarizeWindow([{ tMs: 5, procs: [] }, { tMs: 5, procs: [] }])).toBeNull()
    expect(summarizeWindow([{ tMs: 5, procs: [] }, { tMs: 9, procs: [] }, { tMs: 7, procs: [] }])).toBeNull()
  })
})

describe('parseTop and sumTop', () => {
  const output = [
    'Processes: 600 total, 3 running',
    'PID    MEM   POWER',
    '1      10M   0.0',
    '400    9G    99.0',
    '',
    'Processes: 600 total, 3 running',
    'PID    MEM   POWER',
    '400    1G    12.5',
    '401    512M+ 3.25',
    '402    2048K 0.0',
    '403    900K- 0,5',
    '404    1.5G  1.0',
    'not a row'
  ].join('\n')

  it('reads the last block only, with the units and the signs top prints', () => {
    const { rows, blocks } = parseTop(output)
    expect(blocks).toBe(2)
    expect(rows.map((r) => r.pid)).toEqual([400, 401, 402, 403, 404])
    expect(rows[0]).toEqual({ pid: 400, footprintMiB: 1024, power: 12.5 })
    expect(rows[1]?.footprintMiB).toBe(512)
    expect(rows[2]?.footprintMiB).toBe(2)
    expect(rows[3]?.footprintMiB).toBeCloseTo(900 / 1024)
    expect(rows[3]?.power).toBe(0.5)
    expect(rows[4]?.footprintMiB).toBe(1536)
  })

  it('finds nothing in an output without the header', () => {
    expect(parseTop('400 1G 1.0\n')).toEqual({ rows: [], blocks: 0 })
  })

  it('adds up the wanted pids and says how many top did not list', () => {
    const { rows } = parseTop(output)
    const sum = sumTop(rows, new Set([400, 401, 999]))
    expect(sum.footprintMiB).toBe(1536)
    expect(sum.energyImpact).toBeCloseTo(15.75)
    expect(sum.matched).toBe(2)
    expect(sum.missing).toBe(1)
  })
})

describe('the battery', () => {
  const onBattery = [
    '+-o AppleSmartBattery  <class AppleSmartBattery, id 0x1, registered, matched, active, busy 0 (0 ms), retain 5>',
    '  {',
    '    "ExternalConnected" = No',
    '    "Voltage" = 11000',
    '    "CurrentCapacity" = 31',
    '    "InstantAmperage" = 18446744073709549616',
    '    "Amperage" = 18446744073709549616',
    '    "IsCharging" = No',
    '    "PowerTelemetryData" = {"AccumulatedSystemLoad"=999,"SystemLoad"=22100,"AccumulatedBatteryPower"=5,"BatteryPower"=18446744073709529616}',
    '  }'
  ].join('\n')

  it('reads a negative 64-bit number printed as an unsigned one', () => {
    expect(toSigned64('18446744073709549616')).toBe(-2000)
    expect(toSigned64('5')).toBe(5)
    expect(toSigned64('-5')).toBe(-5)
    expect(toSigned64('x')).toBeNull()
  })

  it('reads what the machine and the battery draw', () => {
    const reading = parseIoregBattery(onBattery)
    expect(reading).toEqual({ externalConnected: false, isCharging: false, amperageMA: -2000, voltageMV: 11000, systemLoadMW: 22100, batteryPowerMW: -22000 })
    expect(reading && batteryDischargeW(reading)).toBe(22)
    expect(reading && systemLoadW(reading)).toBe(22.1)
  })

  it('uses voltage and current when the telemetry is not there', () => {
    const text = onBattery.replace(/^.*PowerTelemetryData.*$/m, '')
    const reading = parseIoregBattery(text)
    expect(reading?.systemLoadMW).toBeNull()
    expect(reading && systemLoadW(reading)).toBeNull()
    expect(reading && batteryDischargeW(reading)).toBeCloseTo(22)
  })

  it('draws nothing from the battery on mains power', () => {
    const reading = parseIoregBattery(onBattery.replace('"ExternalConnected" = No', '"ExternalConnected" = Yes'))
    expect(reading?.externalConnected).toBe(true)
    expect(reading && batteryDischargeW(reading)).toBe(0)
  })

  it('has no reading on a machine without a battery', () => {
    expect(parseIoregBattery('')).toBeNull()
    expect(parseIoregBattery('No matching services')).toBeNull()
  })

  it('reads pmset', () => {
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t31%; discharging; 1:33 remaining present: true")).toEqual({ source: 'battery', percent: 31, state: 'discharging' })
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true")).toEqual({ source: 'ac', percent: 100, state: 'charged' })
    expect(parsePmsetBatt('')).toEqual({ source: null, percent: null, state: null })
  })
})

describe('user activity', () => {
  it('reads the idle time', () => {
    expect(parseHidIdleNs('    | |   "HIDIdleTime" = 683150747750')).toBe(683150747750)
    expect(parseHidIdleNs('nothing')).toBeNull()
  })

  it('is quiet while the idle time grows as fast as the clock', () => {
    expect(inputDuringWindow([{ tMs: 0, idleNs: 50e9 }, { tMs: 5000, idleNs: 55e9 }, { tMs: 10000, idleNs: 60e9 }])).toBe(false)
  })

  it('sees a key pressed during the window, and not one pressed just before it', () => {
    expect(inputDuringWindow([{ tMs: 0, idleNs: 50e9 }, { tMs: 5000, idleNs: 55e9 }, { tMs: 10000, idleNs: 3e9 }])).toBe(true)
    expect(inputDuringWindow([{ tMs: 0, idleNs: 0.2e9 }, { tMs: 5000, idleNs: 5.2e9 }, { tMs: 10000, idleNs: 10.2e9 }])).toBe(false)
  })

  it('forgives the jitter of the sampling', () => {
    expect(inputDuringWindow([{ tMs: 0, idleNs: 50e9 }, { tMs: 10000, idleNs: 9.0e9 }])).toBe(false)
    expect(inputDuringWindow([{ tMs: 0, idleNs: 50e9 }, { tMs: 10000, idleNs: 8.0e9 }])).toBe(true)
  })
})

describe('median and stat', () => {
  it('takes the middle, or the mean of the two middle ones', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([7])).toBe(7)
  })
  it('ignores what is not a number, and has nothing to say without numbers', () => {
    expect(median([null, 5, undefined, Number.NaN, 1, 3])).toBe(3)
    expect(median([])).toBeNull()
    expect(median([null])).toBeNull()
    expect(stat([4, null, 2, 8])).toEqual({ median: 4, min: 2, max: 8 })
    expect(stat([])).toEqual({ median: null, min: null, max: null })
  })
})

const run = (over: Partial<RunResult> & { rss?: number; cpu?: number; processes?: number }): RunResult => {
  const { rss = 100, cpu = 10, processes = 5, ...rest } = over
  return {
    browserId: 'chrome',
    tabs: 10,
    pass: 1,
    window: { durationS: 60, samples: 13, processesMean: processes, processesMax: processes, rssMiBMean: rss, rssMiBMax: rss, rssMiBLast: rss, cpuSeconds: cpu * 0.6, cpuPercent: cpu },
    footprintMiB: rss * 0.8,
    energyImpact: 20,
    systemLoadW: 15,
    batteryDischargeW: 15,
    onBattery: true,
    batteryPercentStart: 80,
    batteryPercentEnd: 79,
    pagesExpected: 10,
    pagesLoaded: 10,
    pagesVisible: 1,
    inputDuringWindow: false,
    warnings: [],
    ...rest
  }
}

describe('summarizeRuns', () => {
  it('takes the median of the passes, one group per browser and number of tabs', () => {
    const summary = summarizeRuns([run({ pass: 1, rss: 100 }), run({ pass: 2, rss: 300 }), run({ pass: 3, rss: 200 }), run({ browserId: 'brave', rss: 50 }), run({ tabs: 30, rss: 500, pagesExpected: 30, pagesLoaded: 30 })])
    expect(summary).toHaveLength(3)
    const chrome10 = summary.find((s) => s.browserId === 'chrome' && s.tabs === 10)
    expect(chrome10?.rssMiB).toEqual({ median: 200, min: 100, max: 300 })
    expect(chrome10?.passes).toBe(3)
    expect(chrome10?.validPasses).toBe(3)
    expect(summary.find((s) => s.browserId === 'brave')?.rssMiB.median).toBe(50)
  })

  it('leaves out a pass in which somebody touched the machine, or a page did not load', () => {
    const summary = summarizeRuns([
      run({ pass: 1, rss: 100 }),
      run({ pass: 2, rss: 300 }),
      run({ pass: 3, rss: 900, inputDuringWindow: true }),
      run({ pass: 4, rss: 800, pagesLoaded: 7, warnings: ['3 pages ne se sont pas chargées'] })
    ])
    expect(summary[0]?.rssMiB.median).toBe(200)
    expect(summary[0]?.validPasses).toBe(2)
    expect(summary[0]?.passes).toBe(4)
    expect(summary[0]?.allInvalid).toBe(false)
    expect(summary[0]?.pagesLoadedMin).toBe(7)
    expect(summary[0]?.warnings).toEqual(['3 pages ne se sont pas chargées'])
  })

  it('keeps every pass, and says so, when none is valid', () => {
    const summary = summarizeRuns([run({ rss: 100, inputDuringWindow: true }), run({ rss: 300, inputDuringWindow: true })])
    expect(summary[0]?.allInvalid).toBe(true)
    expect(summary[0]?.validPasses).toBe(0)
    expect(summary[0]?.rssMiB.median).toBe(200)
  })

  it('judges a run valid only with a window, a quiet machine, every page loaded and a page shown; a browser that cannot be asked is not held to the count', () => {
    expect(isValidRun(run({}))).toBe(true)
    expect(isValidRun(run({ window: null }))).toBe(false)
    expect(isValidRun(run({ inputDuringWindow: true }))).toBe(false)
    expect(isValidRun(run({ pagesLoaded: 9 }))).toBe(false)
    expect(isValidRun(run({ pagesLoaded: null }))).toBe(true)
    // A window hidden behind another is drawn less: no page shown, no run.
    expect(isValidRun(run({ pagesVisible: 0 }))).toBe(false)
    expect(isValidRun(run({ pagesVisible: 2 }))).toBe(true)
    expect(isValidRun(run({ pagesVisible: null }))).toBe(true)
  })
})

describe('costPerTab', () => {
  it('divides the difference between the smallest and the largest number of tabs by the tabs added', () => {
    const summaries = summarizeRuns([
      run({ tabs: 10, rss: 1000 }),
      run({ tabs: 30, rss: 1600, pagesExpected: 30, pagesLoaded: 30, footprintMiB: 1400, energyImpact: 30 }),
      run({ browserId: 'arc', tabs: 10, rss: 2000 })
    ])
    const [chrome] = costPerTab(summaries.filter((s) => s.browserId === 'chrome'))
    expect(chrome?.rssMiB).toBe(30)
    expect(chrome?.footprintMiB).toBe(30)
    expect(chrome?.energyImpact).toBe(0.5)
    expect(chrome?.fromTabs).toBe(10)
    expect(chrome?.toTabs).toBe(30)
    // Arc has one number of tabs: no slope.
    expect(costPerTab(summaries).map((p) => p.browserId)).toEqual(['chrome'])
  })

  it('has no figure for what was not measured', () => {
    const summaries = summarizeRuns([run({ tabs: 10, energyImpact: null }), run({ tabs: 30, pagesExpected: 30, pagesLoaded: 30, energyImpact: 10 })])
    expect(costPerTab(summaries)[0]?.energyImpact).toBeNull()
  })
})

describe('summarizeBaseline', () => {
  it('measures how far the resting machine moved between the first and the last window', () => {
    const base = summarizeBaseline([
      { label: 'avant', systemLoadW: 20, backgroundCpuPercent: 10 },
      { label: 'après', systemLoadW: 22, backgroundCpuPercent: 12 }
    ])
    expect(base.meanSystemLoadW).toBe(21)
    expect(base.driftPercent).toBeCloseTo((2 / 21) * 100)
  })
  it('measures the drift whichever way the machine moved', () => {
    const base = summarizeBaseline([
      { label: 'avant', systemLoadW: 22, backgroundCpuPercent: 10 },
      { label: 'après', systemLoadW: 20, backgroundCpuPercent: 12 }
    ])
    expect(base.driftPercent).toBeCloseTo((2 / 21) * 100)
  })
  it('has no drift with one window or none', () => {
    expect(summarizeBaseline([{ label: 'a', systemLoadW: 20, backgroundCpuPercent: 1 }]).driftPercent).toBeNull()
    expect(summarizeBaseline([]).meanSystemLoadW).toBeNull()
    expect(summarizeBaseline([{ label: 'a', systemLoadW: null, backgroundCpuPercent: null }, { label: 'b', systemLoadW: null, backgroundCpuPercent: null }]).driftPercent).toBeNull()
  })
})

describe('plan helpers', () => {
  it('adds up the time of a run', () => {
    // 2 baselines of 60 s + 5 browsers x 3 passes x (2 steps x (60 + 60 + 30) + 15).
    expect(estimateDurationS({ browsers: 5, passes: 3, steps: 2, settleS: 60, windowS: 60, launchS: 30, cooldownS: 15 })).toBe(120 + 15 * 315)
  })
  it('turns the order of the browsers by one at each pass', () => {
    expect(rotateOrder(['a', 'b', 'c'], 1)).toEqual(['a', 'b', 'c'])
    expect(rotateOrder(['a', 'b', 'c'], 2)).toEqual(['b', 'c', 'a'])
    expect(rotateOrder(['a', 'b', 'c'], 3)).toEqual(['c', 'a', 'b'])
    expect(rotateOrder(['a', 'b', 'c'], 4)).toEqual(['a', 'b', 'c'])
    expect(rotateOrder([], 2)).toEqual([])
  })
})

describe('formatNumber', () => {
  it('writes French numbers', () => {
    expect(formatNumber(1234.5, 1)).toBe(`1${NNBSP}234,5`)
    expect(formatNumber(1234567, 0)).toBe(`1${NNBSP}234${NNBSP}567`)
    expect(formatNumber(12, 0)).toBe('12')
    expect(formatNumber(0.125, 2)).toBe('0,13')
    expect(formatNumber(-2.5, 1)).toBe('−2,5')
  })
  it('writes no minus sign before a zero, and a dash for no figure', () => {
    expect(formatNumber(-0.04, 1)).toBe('0,0')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber(undefined)).toBe('—')
    expect(formatNumber(Number.NaN)).toBe('—')
  })
})

describe('the low power mode', () => {
  it('reads pmset -g', () => {
    expect(parseLowPowerMode(' sleep 1\n lowpowermode 1\n displaysleep 2')).toBe(true)
    expect(parseLowPowerMode(' lowpowermode         0\n')).toBe(false)
    expect(parseLowPowerMode(' powermode            1\n')).toBe(true)
    expect(parseLowPowerMode(' powermode            0\n')).toBe(false)
    expect(parseLowPowerMode(' sleep 1')).toBeNull()
  })
})

describe('quietWarnings', () => {
  it('names the windows in which the machine was busy with no browser started', () => {
    const warnings = quietWarnings([
      { label: 'avant', systemLoadW: 20, backgroundCpuPercent: 30 },
      { label: 'après', systemLoadW: 20, backgroundCpuPercent: 140 },
      { label: 'sans mesure', systemLoadW: null, backgroundCpuPercent: null }
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('après : 140 %')
  })
})

const browsers: BrowserInfo[] = [
  { id: 'chrome', name: 'Google Chrome', version: '156.0.8078.48', engine: null, mode: 'launched', notes: [] },
  { id: 'arc', name: 'Arc', version: '1.170', engine: null, mode: 'passive', notes: ['mesuré tel que son utilisateur l’avait laissé'] }
]

const reportInput = (over: Partial<Parameters<typeof buildReport>[0]> = {}): Parameters<typeof buildReport>[0] => ({
  date: '2026-10-25',
  machine: { model: 'Mac16,5', chip: 'Apple M4 Max', memoryGiB: 36, cores: 14, os: 'macOS 27.0.1' },
  method: { settleS: 60, windowS: 60, sampleS: 5, passes: 2, tabSteps: [10, 30] },
  powerAtStart: { source: 'battery', percent: 80, state: 'discharging' },
  lowPowerMode: false,
  baselineWindows: [{ label: 'avant', systemLoadW: 20, backgroundCpuPercent: 8 }, { label: 'après', systemLoadW: 20.5, backgroundCpuPercent: 9 }],
  browsers,
  runs: [
    run({ pass: 1, rss: 1000 }),
    run({ pass: 2, rss: 1200 }),
    run({ tabs: 30, pass: 1, rss: 1600, pagesExpected: 30, pagesLoaded: 30 }),
    run({ tabs: 30, pass: 2, rss: 1800, pagesExpected: 30, pagesLoaded: 30 }),
    run({ browserId: 'arc', rss: 2500, pagesLoaded: 10 })
  ],
  notes: ['Arc a été mesuré tel que son utilisateur l’avait laissé.'],
  ...over
})

describe('buildReport and renderMarkdown', () => {
  it('builds the figures of the report', () => {
    const report = buildReport(reportInput())
    expect(report.schema).toBe(BENCH_SCHEMA)
    expect(report.summary.map((s) => `${s.browserId}${s.tabs}`)).toEqual(['chrome10', 'chrome30', 'arc10'])
    expect(report.perTab).toHaveLength(1)
    expect(report.perTab[0]?.rssMiB).toBe((1700 - 1100) / 20)
    expect(report.conditions.warnings).toEqual([])
    expect(report.baseline.driftPercent).toBeCloseTo((0.5 / 20.25) * 100)
  })

  it('warns when the run started on mains power, in power saving mode, or on a machine that drifted', () => {
    const report = buildReport(
      reportInput({
        powerAtStart: { source: 'ac', percent: 100, state: 'charged' },
        lowPowerMode: true,
        baselineWindows: [{ label: 'avant', systemLoadW: 20, backgroundCpuPercent: 8 }, { label: 'après', systemLoadW: 30, backgroundCpuPercent: 9 }]
      })
    )
    expect(report.conditions.warnings).toHaveLength(3)
    expect(report.conditions.warnings.join(' ')).toMatch(/secteur/)
    expect(report.conditions.warnings.join(' ')).toMatch(/économie d'énergie/)
    expect(report.conditions.warnings.join(' ')).toMatch(/dérivé de 40 %/)
  })

  it('writes the tables in the order of the run, without ranking anybody', () => {
    const markdown = renderMarkdown(buildReport(reportInput()))
    expect(markdown).toContain('Mesuré le 2026-10-25 sur Mac16,5 (Apple M4 Max, 36 Gio, 14 cœurs), macOS 27.0.1.')
    expect(markdown).toContain('2 passes, 10 puis 30 onglets ouverts dans une même session, 60 s de repos avant chaque fenêtre de 60 s')
    expect(markdown).toContain('| Google Chrome | 156.0.8078.48 | — | lancé par le banc, profil jetable |')
    expect(markdown).toContain("| Arc | 1.170 | — | passif (ouvert par l'utilisateur, lu par ps) |")
    expect(markdown).toContain('## 10 onglets')
    expect(markdown).toContain('## 30 onglets')
    // chrome 10 tabs: 2/2 valid passes, 5 processes, 1 100 MiB resident (median of 1 000 and 1 200), footprint 880, CPU 10,0, impact 20,0, 15,0 W, 10/10 pages.
    expect(markdown).toContain(`| Google Chrome | 2/2 | 5 | 1${NNBSP}100 | 880 | 10,0 | 20,0 | 15,0 | 10/10 |`)
    expect(markdown.indexOf('| Google Chrome | 2/2 | 5')).toBeLessThan(markdown.indexOf('| Arc | 1/1 | 5'))
    expect(markdown).toContain('| Google Chrome | 10 et 30 onglets | 30,0 |')
    expect(markdown).toContain('Dérive entre la première et la dernière fenêtre : 2,5 %.')
    expect(markdown).toContain('## Notes')
    expect(markdown).toContain('- Arc : mesuré tel que son utilisateur l’avait laissé')
    expect(markdown).not.toContain('## Réserves')
  })

  it('lists the reserves of a run: the warnings of the passes, and a pass that was not valid', () => {
    const markdown = renderMarkdown(buildReport(reportInput({ runs: [run({ pass: 1, inputDuringWindow: true, warnings: ["Entrée clavier ou souris pendant la fenêtre"] })] })))
    expect(markdown).toContain('## Réserves')
    expect(markdown).toContain('- Google Chrome, 10 onglets : Entrée clavier ou souris pendant la fenêtre')
    expect(markdown).toContain('0/1 (aucune valide)')
  })

  it('does not break a table with a bar in a name', () => {
    const markdown = renderMarkdown(buildReport(reportInput({ browsers: [{ id: 'chrome', name: 'Chrome | test', version: null, engine: null, mode: 'launched', notes: [] }, browsers[1]!] })))
    expect(markdown).toContain('| Chrome \\| test | inconnue |')
  })
})

describe('redactHome', () => {
  it('replaces the home folder', () => {
    expect(redactHome('/Users/jane/Library/x and /Users/jane/y', '/Users/jane')).toBe('~/Library/x and ~/y')
  })
  it('leaves a text alone when the home folder is empty or the root', () => {
    expect(redactHome('/a/b', '')).toBe('/a/b')
    expect(redactHome('/a/b', '/')).toBe('/a/b')
  })
})

describe('what the bench starts', () => {
  const safari = { id: 'safari', mode: 'safari' }
  const chrome = { id: 'chrome', mode: 'chromium' }

  it('leaves Safari out unless --browsers names it: it would open in the person\'s own profile', () => {
    expect(isMeasuredByDefault(safari, null)).toBe(false)
    expect(isMeasuredByDefault(chrome, null)).toBe(true)
    expect(isMeasuredByDefault(safari, ['safari', 'lucium'])).toBe(true)
    expect(isMeasuredByDefault(chrome, ['safari', 'lucium'])).toBe(false)
  })

  it('gives every browser it starts a home folder of the run, and drops what would make Electron a node', () => {
    const env = benchBrowserEnv({ HOME: '/Users/someone', PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' }, '/tmp/run/home')
    expect(env).toEqual({ HOME: '/tmp/run/home', PATH: '/usr/bin' })
  })
})
