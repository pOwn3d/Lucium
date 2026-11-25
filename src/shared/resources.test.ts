import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import {
  heldReport,
  othersGpuLine,
  othersHint,
  type ResourceReport,
  GAUGE_WARN_PERCENT,
  RESOURCE_TABS_MAX,
  RESOURCE_TABS_MORE_MAX,
  hasMoreTabs,
  cpuOf,
  formatMemory,
  formatPercent,
  gaugeTip,
  heaviestTabs,
  isHot,
  memoryGauge,
  memoryOf,
  meterShare,
  MEASURED_GAIN_MIN_MB,
  measuredGain,
  releaseFigures,
  releaseNotice,
  releaseSitesWarning,
  undoNotice,
  parseResourceAction,
  releasePreviews,
  resourceReport,
  viewOf,
  sameGauge,
  type ReleaseOutcome,
  type ResourceTab
} from './resources'
import { frenchSpaces } from './french-typography'

const tab = (tabId: string, memoryMb: number, cpu = 0, extra: Partial<ResourceTab> = {}): ResourceTab => ({ tabId, name: tabId, url: `https://${tabId}.example/`, memoryMb, cpu, ...extra })
const GB = 1024

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

describe('the ring at the foot of the sidebar', () => {
  it('fills with the share of the Mac’s memory the browser holds', () => {
    const gauge = memoryGauge(4 * GB, 16 * GB, 1)
    expect(gauge.percent).toBe(25)
    expect(gauge.warn).toBe(false)
    expect(gauge.pressure).toBe(false)
  })

  it(`turns amber from ${GAUGE_WARN_PERCENT} %, not before`, () => {
    expect(memoryGauge(8 * GB, 16 * GB, null).warn).toBe(true)
    expect(memoryGauge(7.8 * GB, 16 * GB, null).warn).toBe(false)
  })

  it('turns amber when macOS says memory is short (level 2 or 4), whatever the share', () => {
    for (const level of [2, 4]) {
      const gauge = memoryGauge(1 * GB, 16 * GB, level)
      expect(gauge.pressure, `level ${level}`).toBe(true)
      expect(gauge.warn, `level ${level}`).toBe(true)
    }
    // Normal, or not read (another system, sysctl failed): the share alone decides.
    expect(memoryGauge(1 * GB, 16 * GB, 1).warn).toBe(false)
    expect(memoryGauge(1 * GB, 16 * GB, null).warn).toBe(false)
  })

  it('rounds the memory to what the tooltip says, so that a small change is the same ring and publishes nothing', () => {
    const before = memoryGauge(8_480, 16 * GB, 1)
    const after = memoryGauge(8_520, 16 * GB, 1)
    expect(before.memoryMb).toBe(8_500)
    expect(sameGauge(before, after)).toBe(true)
    expect(sameGauge(before, memoryGauge(8_700, 16 * GB, 1))).toBe(false)
    expect(sameGauge(before, memoryGauge(8_480, 16 * GB, 2))).toBe(false)
    expect(sameGauge(null, null)).toBe(true)
    expect(sameGauge(before, null)).toBe(false)
  })

  it('stays within 0 and 100 % for figures that are not', () => {
    expect(memoryGauge(40 * GB, 16 * GB, 1).percent).toBe(100)
    expect(memoryGauge(Number.NaN, 16 * GB, 1).percent).toBe(0)
    expect(memoryGauge(4 * GB, 0, 1).percent).toBe(0)
  })

  it('gives its figures in the tooltip, and what macOS says under pressure', () => {
    expect(gaugeTip(memoryGauge(8.3 * GB, 16 * GB, 1))).toBe(frenchSpaces('Mémoire du navigateur : 8,3 Go sur 16 Go (52 %)'))
    expect(gaugeTip(memoryGauge(8.3 * GB, 16 * GB, 2))).toBe(frenchSpaces('Mémoire du navigateur : 8,3 Go sur 16 Go (52 %) · macOS signale que la mémoire manque'))
    // Before its first reading, its name only.
    expect(gaugeTip(undefined)).toBe('Ressources du navigateur')
    setLanguage('en')
    expect(gaugeTip(memoryGauge(8.3 * GB, 16 * GB, 1))).toBe('Browser memory: 8.3 GB of 16 GB (52%)')
  })
})

describe('the figures of the panel', () => {
  it('add up the memory and the processor of every process, as the task manager does', () => {
    const raw = [
      { pid: 1, type: 'Browser', cpu: 3.25, memoryKb: 200 * 1024 },
      { pid: 2, type: 'Tab', cpu: 30, memoryKb: 600 * 1024 },
      { pid: 3, type: 'GPU', cpu: Number.NaN, memoryKb: -5 }
    ]
    expect(memoryOf(raw)).toBe(800)
    expect(cpuOf(raw)).toBe(33.3)
    const report = resourceReport(raw, [tab('a', 600, 30)], [], memoryGauge(800, 16 * GB, 1))
    expect(report.memoryMb).toBe(800)
    expect(report.cpu).toBe(33.3)
    expect(report.levels).toEqual([])
  })

  it(`lists the ${RESOURCE_TABS_MAX} heaviest tabs: memory first, the processor to break a tie`, () => {
    const tabs = [tab('a', 100), tab('b', 584, 1), tab('c', 574, 9), tab('d', 278), tab('e', 584, 7.4), tab('f', 205), tab('g', 172)]
    expect(heaviestTabs(tabs).map((t) => t.tabId)).toEqual(['e', 'b', 'c', 'd', 'f'])
    expect(resourceReport([], tabs, [], memoryGauge(0, GB, null)).tabs).toHaveLength(RESOURCE_TABS_MAX)
  })

  it('draws the meter of a row against the heaviest tab of the list, hot for a tab that holds a lot or keeps a core busy', () => {
    const tabs = [tab('a', 600), tab('b', 300)]
    expect(meterShare(tabs[1]!, tabs)).toBe(0.5)
    expect(meterShare(tab('z', 0), [tab('z', 0)])).toBe(0)
    expect(isHot(tab('big', 1200))).toBe(true)
    expect(isHot(tab('busy', 80, 45))).toBe(true)
    expect(isHot(tab('calm', 600, 4))).toBe(false)
  })

  it('writes the sizes and the shares with the decimal mark of the language', () => {
    expect(formatMemory(584)).toBe(frenchSpaces('584 Mo'))
    expect(formatMemory(8.3 * GB)).toBe(frenchSpaces('8,3 Go'))
    expect(formatMemory(16 * GB)).toBe(frenchSpaces('16 Go'))
    expect(formatPercent(7.43)).toBe(frenchSpaces('7,4 %'))
    expect(formatPercent(33.4)).toBe(frenchSpaces('33 %'))
    expect(formatPercent(0.04)).toBe(frenchSpaces('0,0 %'))
    expect(formatPercent(0)).toBe(frenchSpaces('0 %'))
    expect(formatPercent(-1)).toBe(frenchSpaces('0 %'))
    setLanguage('en')
    expect(formatMemory(8.3 * GB)).toBe('8.3 GB')
    expect(formatPercent(7.43)).toBe('7.4%')
  })
})

describe('the actions the sidebar asks for', () => {
  it('are read again by the main process: a tab action needs a tab id', () => {
    expect(parseResourceAction({ kind: 'sleep', tabId: 't1' })).toEqual({ kind: 'sleep', tabId: 't1' })
    expect(parseResourceAction({ kind: 'close', tabId: 't1' })).toEqual({ kind: 'close', tabId: 't1' })
    expect(parseResourceAction({ kind: 'show', tabId: 't1' })).toEqual({ kind: 'show', tabId: 't1' })
    expect(parseResourceAction({ kind: 'sleep-level', level: 'low' })).toEqual({ kind: 'sleep-level', level: 'low' })
    expect(parseResourceAction({ kind: 'sleep-level', level: 'medium', tabId: 'ignored' })).toEqual({ kind: 'sleep-level', level: 'medium' })
    expect(parseResourceAction({ kind: 'sleep-level', level: 'high' })).toEqual({ kind: 'sleep-level', level: 'high' })
    expect(parseResourceAction({ kind: 'undo-level', level: 'high' })).toEqual({ kind: 'undo-level' })
    expect(parseResourceAction({ kind: 'task-manager' })).toEqual({ kind: 'task-manager' })
  })

  it('refuse anything else', () => {
    for (const raw of [null, 'sleep', 42, {}, { kind: 'kill', tabId: 't1' }, { kind: 'sleep' }, { kind: 'sleep-hidden' }, { kind: 'sleep-level' }, { kind: 'sleep-level', level: 'extreme' }, { kind: 'sleep-level', level: 7 }, { kind: 'sleep-level', level: '__proto__' }, { kind: 'close', tabId: '' }, { kind: 'show', tabId: 7 }, { kind: 'sleep', tabId: 'x'.repeat(257) }]) {
      expect(parseResourceAction(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

// The figures come every 2 s, sorted by weight. Under the pointer the rows keep their places: ☾ and ✕ act on the tab a person aimed at.
describe('heldReport', () => {
  const NO_OTHERS = { count: 0, memoryMb: 0, cpu: 0, gpuMemoryMb: 0, gpuCpu: 0 }
  const report = (tabs: ResourceTab[], memoryMb = 1000, byCpu: ResourceTab[] = tabs): ResourceReport => ({ memoryMb, cpu: 10, gauge: memoryGauge(4 * 1024, 16 * 1024, 1), tabs, others: NO_OTHERS, byCpu: { tabs: byCpu, others: NO_OTHERS }, more: { tabs, others: NO_OTHERS }, byCpuMore: { tabs: byCpu, others: NO_OTHERS }, levels: [] })
  const ids = (shown: ResourceReport): string[] => shown.tabs.map((entry) => entry.tabId)

  it('keeps every row where it is when two tabs swap ranks, and gives each its new figures', () => {
    const shown = report([tab('a', 900), tab('b', 500), tab('c', 100)])
    const held = heldReport(shown, report([tab('b', 950), tab('a', 800), tab('c', 120)], 2000))
    expect(ids(held)).toEqual(['a', 'b', 'c'])
    expect(held.tabs.map((entry) => entry.memoryMb)).toEqual([800, 950, 120])
    expect(held.memoryMb).toBe(2000)
  })

  it('keeps a row that slipped out of the list with its last figures, and adds a tab that enters at the end', () => {
    const held = heldReport(report([tab('a', 900), tab('b', 500), tab('c', 100)]), report([tab('d', 990), tab('a', 800), tab('c', 120)]))
    expect(ids(held)).toEqual(['a', 'b', 'c', 'd'])
    expect(held.tabs[1]).toEqual(tab('b', 500))
  })

  it('lets go of the row a person just put to sleep or closed here, at once and for as long as the pointer stays', () => {
    const shown = report([tab('a', 900), tab('b', 500), tab('c', 100)])
    expect(ids(heldReport(shown, report([tab('a', 900), tab('c', 100)]), new Set(['b'])))).toEqual(['a', 'c'])
    // The figures measured just before the tab went may still name it.
    expect(ids(heldReport(shown, report([tab('a', 900), tab('b', 500), tab('c', 100)]), new Set(['b'])))).toEqual(['a', 'c'])
  })

  it('is the figures as they come before anything was shown', () => {
    const next = report([tab('b', 950), tab('a', 800)])
    expect(heldReport(null, next)).toBe(next)
  })

  it('holds the ranking by processor in its places too, and lets go of a row acted on in both', () => {
    const shown = report([tab('a', 900), tab('b', 500)], 1000, [tab('b', 500, 40), tab('a', 900, 5)])
    const held = heldReport(shown, report([tab('a', 900), tab('b', 500)], 1000, [tab('a', 900, 60), tab('b', 500, 10)]))
    expect(held.byCpu.tabs.map((entry) => [entry.tabId, entry.cpu])).toEqual([['b', 10], ['a', 60]])
    const acted = heldReport(shown, report([tab('a', 900)], 1000, [tab('a', 900, 5)]), new Set(['b']))
    expect([ids(acted), acted.byCpu.tabs.map((entry) => entry.tabId)]).toEqual([['a'], ['a']])
  })
})

describe('the preview of « Libérer maintenant »', () => {
  const plan = (ids: string[], siteTabs = 0) => ({ ids, siteTabs })
  const raw = [
    { pid: 1, type: 'Browser', cpu: 5, memoryKb: 300 * 1024 },
    { pid: 2, type: 'Tab', cpu: 1.26, memoryKb: 600 * 1024 },
    { pid: 3, type: 'Tab', cpu: 2, memoryKb: 400 * 1024 },
    { pid: 4, type: 'GPU', cpu: 30, memoryKb: 1300 * 1024 }
  ]
  const pages = [{ id: 'a', pid: 2 }, { id: 'b', pid: 3 }, { id: 'c', pid: 3 }, { id: 'noproc', pid: 0 }]

  it('adds the memory and the processor of the processes whose tabs all go, each counted once', () => {
    const [low, medium, high] = releasePreviews({ low: plan(['a']), medium: plan(['a', 'b', 'c']), high: plan(['a', 'b', 'c', 'noproc'], 2) }, pages, raw)
    expect(low).toEqual({ level: 'low', count: 1, memoryMb: 600, cpu: 1.3, siteTabs: 0 })
    expect(medium).toEqual({ level: 'medium', count: 3, memoryMb: 1000, cpu: 3.3, siteTabs: 0 })
    expect(high).toEqual({ level: 'high', count: 4, memoryMb: 1000, cpu: 3.3, siteTabs: 2 })
  })

  it('counts nothing for a tab whose process another tab, that stays awake, still renders', () => {
    const [low] = releasePreviews({ low: plan(['b']), medium: plan(['b']), high: plan(['b']) }, pages, raw)
    expect(low).toEqual({ level: 'low', count: 1, memoryMb: 0, cpu: 0, siteTabs: 0 })
  })

  it('lists the three strengths, weakest first, even when there is nothing to take', () => {
    expect(releasePreviews({ low: plan([]), medium: plan([]), high: plan([]) }, [], []).map((p) => [p.level, p.count])).toEqual([['low', 0], ['medium', 0], ['high', 0]])
  })

  it(`calls a difference of totals a gain only from ${MEASURED_GAIN_MIN_MB} MB`, () => {
    expect(measuredGain(5000, 3000)).toBe(2000)
    expect(measuredGain(5000, 5000 - MEASURED_GAIN_MIN_MB)).toBe(MEASURED_GAIN_MIN_MB)
    expect(measuredGain(5000, 4980)).toBeNull()
    expect(measuredGain(5000, 5400)).toBeNull()
    expect(measuredGain(Number.NaN, 100)).toBeNull()
  })
})

describe('the words after « Libérer maintenant »', () => {
  const outcome = (slept: number, refused: Partial<ReleaseOutcome['refused']> = {}, extra: Partial<ReleaseOutcome> = {}): ReleaseOutcome => ({ level: 'medium', slept, refused: { unsent: 0, confirm: 0, other: 0, ...refused }, ...extra })

  it('says all that went, with what was measured once it is known', () => {
    expect(releaseNotice(outcome(1), null)).toBe('Onglet mis en veille')
    expect(releaseNotice(outcome(14), null)).toBe('14 onglets mis en veille')
    expect(releaseNotice(outcome(14), 2048)).toBe(frenchSpaces('14 onglets mis en veille, ≈ 2 Go libérés (mesuré).'))
    expect(releaseNotice(outcome(1), 300)).toBe(frenchSpaces('1 onglet mis en veille, ≈ 300 Mo libérés (mesuré).'))
  })

  it('says how many and why the others stayed awake, by reason', () => {
    expect(releaseNotice(outcome(11, { unsent: 2, confirm: 1 }), null)).toBe(frenchSpaces('11 sur 14 mis en veille : 2 ont du texte non envoyé, 1 demande une confirmation.'))
    expect(releaseNotice(outcome(0, { other: 3 }), 900)).toBe(frenchSpaces('0 sur 3 mis en veille : 3 sont protégés ou n’ont pas répondu.'))
    expect(releaseNotice(outcome(5, { unsent: 1, other: 1 }), null)).toBe(frenchSpaces('5 sur 7 mis en veille : 1 a du texte non envoyé, 1 est protégé ou n’a pas répondu.'))
  })

  it('says when there was nothing to put to sleep, and when another run was going on', () => {
    expect(releaseNotice(outcome(0), null)).toBe(frenchSpaces('Aucun onglet à mettre en veille : ceux qui restent sont affichés ou protégés.'))
    expect(releaseNotice(outcome(0, {}, { busy: true }), null)).toBe('Une mise en veille est déjà en cours.')
  })

  it('names no title and no address: the reasons are counts', () => {
    expect(releaseNotice(outcome(2, { unsent: 1 }), null)).not.toMatch(/https?:|\.com/)
  })

  it('is said in English too', () => {
    setLanguage('en')
    expect(releaseNotice(outcome(11, { unsent: 2, confirm: 1 }), null)).toBe('11 of 14 put to sleep: 2 have unsent text, 1 asks for confirmation.')
    expect(releaseNotice(outcome(3), 1500)).toBe('3 tabs put to sleep, ≈ 1.5 GB freed (measured).')
    expect(undoNotice(1)).toBe('1 tab is loading again in the background.')
  })

  it('says what « Annuler » is doing', () => {
    expect(undoNotice(3)).toBe('3 onglets se rechargent en arrière-plan.')
    expect(undoNotice(1)).toBe('1 onglet se recharge en arrière-plan.')
    expect(undoNotice(0)).toBe(frenchSpaces('Aucun onglet à recharger : ils ont été rouverts entre-temps.'))
  })

  it('writes the figures of a strength: the tabs and the memory, the tabs alone when no process would go, none when empty', () => {
    expect(releaseFigures({ count: 12, memoryMb: 2150 })).toBe(frenchSpaces('12 onglets · ≈ 2,1 Go'))
    expect(releaseFigures({ count: 1, memoryMb: 600 })).toBe(frenchSpaces('1 onglet · ≈ 600 Mo'))
    expect(releaseFigures({ count: 4, memoryMb: 0 })).toBe('4 onglets')
    expect(releaseFigures({ count: 0, memoryMb: 0 })).toBe('Aucun onglet')
  })

  it('warns about the kept sites only when the strongest strength takes some', () => {
    expect(releaseSitesWarning({ siteTabs: 0 })).toBeNull()
    expect(releaseSitesWarning({ siteTabs: 20 })).toBe(frenchSpaces('Dont 20 onglets de sites gardés éveillés : plus de notifications jusqu’à leur réveil.'))
  })
})

describe('what the rows leave out (« Autres processus »)', () => {
  const raw = [
    { pid: 1, type: 'Browser', cpu: 2, memoryKb: 400 * 1024 },
    { pid: 2, type: 'Tab', cpu: 1, memoryKb: 600 * 1024 },
    { pid: 3, type: 'Tab', cpu: 40, memoryKb: 300 * 1024 },
    { pid: 4, type: 'GPU', cpu: 30.04, memoryKb: 1200 * 1024 },
    { pid: 5, type: 'Tab', cpu: 0.5, memoryKb: 100 * 1024 },
    { pid: 6, type: 'Utility', cpu: 3, memoryKb: 50 * 1024 }
  ]
  const tabs = [tab('heavy', 600, 1), tab('busy', 300, 40), tab('light', 100, 0.5)]
  const pids = new Map([['heavy', 2], ['busy', 3], ['light', 5]])
  const gauge = memoryGauge(2650, 16 * GB, 1)

  it('adds up with the rows to the totals of the head: the total is the listed processes plus the others, each process once', () => {
    const report = resourceReport(raw, tabs, [], gauge, pids)
    const listed = report.tabs.reduce((sum, row) => sum + row.memoryMb, 0)
    expect(listed + report.others.memoryMb).toBe(report.memoryMb)
    expect(report.others).toEqual({ count: 3, memoryMb: 1650, cpu: 35, gpuMemoryMb: 1200, gpuCpu: 30 })
  })

  it('counts the process of a tab that did not make the list among the others (the five rows only)', () => {
    const many = [tab('big', 600), tab('b', 500), tab('c', 400), tab('d', 300), tab('e', 200), tab('small', 100)]
    const report = resourceReport(raw, many, [], gauge, new Map([['big', 2], ['b', 10], ['c', 11], ['d', 12], ['e', 13], ['small', 5]]))
    expect(report.tabs.map((row) => row.tabId)).not.toContain('small')
    // `small` is process 5: it is not a listed one, so it stays among the others with the browser, the GPU, the utility and the busy tab (3).
    expect(report.others.count).toBe(raw.length - 1)
  })

  it('counts a process shared by two listed tabs once, as theirs', () => {
    const shared = [tab('a', 600), tab('b', 600)]
    const report = resourceReport(raw, shared, [], gauge, new Map([['a', 2], ['b', 2]]))
    expect(report.others.memoryMb).toBe(report.memoryMb - 600)
  })

  it('names the graphic process on its own, and says nothing of it when it is not among the others', () => {
    setLanguage('fr')
    expect(othersGpuLine(resourceReport(raw, tabs, [], gauge, pids).others)).toBe(frenchSpaces('Dont processeur graphique : 1,2 Go · 30 %'))
    expect(othersGpuLine({ gpuMemoryMb: 0, gpuCpu: 0 })).toBeNull()
    expect(othersHint({ count: 3 })).toContain('3 processus')
  })
})

describe('the ranking by processor', () => {
  const tabs = [tab('big', 900, 2), tab('busy', 200, 45), tab('mid', 500, 9), tab('calm', 400, 0.5), tab('x', 100, 9), tab('y', 50, 30), tab('z', 10, 1)]

  it('lists the tabs that use the most processor first (memory breaks a tie), where the default ranking lists the heaviest', () => {
    expect(heaviestTabs(tabs, RESOURCE_TABS_MAX, 'cpu').map((row) => row.tabId)).toEqual(['busy', 'y', 'mid', 'x', 'big'])
    expect(heaviestTabs(tabs).map((row) => row.tabId)).toEqual(['big', 'mid', 'calm', 'busy', 'x'])
  })

  it('is carried by the report next to the ranking by memory, with the remainder of its own list, and chosen with `viewOf`', () => {
    const raw = [
      { pid: 1, type: 'Tab', cpu: 45, memoryKb: 200 * 1024 },
      { pid: 2, type: 'Tab', cpu: 2, memoryKb: 900 * 1024 },
      { pid: 3, type: 'Tab', cpu: 0, memoryKb: 20 * 1024 },
      { pid: 4, type: 'GPU', cpu: 12, memoryKb: 300 * 1024 }
    ]
    // Six tabs: `busy` (the processor) and `big` (the memory) each leave one of the others out of the five rows of the other ranking.
    const six = [tab('busy', 1, 45), tab('big', 900, 2), tab('d', 800), tab('e', 700), tab('f', 600), tab('g', 500)]
    const report = resourceReport(raw, six, [], memoryGauge(1420, 16 * GB, 1), new Map([['busy', 1], ['big', 2], ['d', 3], ['e', 7], ['f', 8], ['g', 9]]))
    expect(viewOf(report, 'memory').tabs.map((row) => row.tabId)).toEqual(['big', 'd', 'e', 'f', 'g'])
    expect(viewOf(report, 'cpu').tabs.map((row) => row.tabId)).toEqual(['busy', 'big', 'd', 'e', 'f'])
    // By memory `busy` (process 1) is left out: it is among the others, with the GPU. By processor `g` is, but its process is not one of those measured.
    expect(report.others).toMatchObject({ count: 2, memoryMb: 500, cpu: 57, gpuMemoryMb: 300 })
    expect(report.byCpu.others).toMatchObject({ count: 1, memoryMb: 300, cpu: 12, gpuMemoryMb: 300 })
  })

  it('draws the meter against the heaviest processor in this ranking', () => {
    const rows = [tab('a', 100, 40), tab('b', 900, 10)]
    expect(meterShare(rows[1]!, rows, 'cpu')).toBe(0.25)
    expect(meterShare(rows[1]!, rows)).toBe(1)
  })
})

describe('« Voir plus »: the longer list of the panel', () => {
  const many = Array.from({ length: 12 }, (_, i) => tab(`t${i}`, 1000 - i * 10, i === 8 ? 70 : 1))
  const raw = [
    { pid: 1, type: 'Browser', cpu: 2, memoryKb: 400 * 1024 },
    ...many.map((row, i) => ({ pid: 10 + i, type: 'Tab', cpu: row.cpu, memoryKb: row.memoryMb * 1024 }))
  ]
  const pids = new Map(many.map((row, i) => [row.tabId, 10 + i]))
  const report = resourceReport(raw, many, [], memoryGauge(9000, 32 * GB, 1), pids)

  it(`keeps the first ${RESOURCE_TABS_MAX} rows by default and carries up to ${RESOURCE_TABS_MORE_MAX} for « Voir plus », each list with the remainder of its own`, () => {
    expect(viewOf(report, 'memory').tabs).toHaveLength(RESOURCE_TABS_MAX)
    expect(viewOf(report, 'memory', true).tabs).toHaveLength(RESOURCE_TABS_MORE_MAX)
    expect(viewOf(report, 'cpu', true).tabs).toHaveLength(RESOURCE_TABS_MORE_MAX)
    expect(viewOf(report, 'memory', true).tabs.slice(0, RESOURCE_TABS_MAX)).toEqual(viewOf(report, 'memory').tabs)
    expect(viewOf(report, 'memory').others.count).toBe(raw.length - RESOURCE_TABS_MAX)
    expect(viewOf(report, 'memory', true).others.count).toBe(raw.length - RESOURCE_TABS_MORE_MAX)
  })

  it('names the busy tab that the five rows hide, and takes its processor out of the others', () => {
    const busy = many[8]!
    expect(viewOf(report, 'memory').tabs.map((row) => row.tabId)).not.toContain(busy.tabId)
    expect(viewOf(report, 'memory', true).tabs.map((row) => row.tabId)).toContain(busy.tabId)
    expect(viewOf(report, 'memory').others.cpu - viewOf(report, 'memory', true).others.cpu).toBeGreaterThanOrEqual(busy.cpu)
    // With the ten rows the rows and the others add up to the total of the head.
    const listed = viewOf(report, 'memory', true).tabs.reduce((sum, row) => sum + row.memoryMb, 0)
    expect(Math.round(listed + viewOf(report, 'memory', true).others.memoryMb)).toBe(report.memoryMb)
  })

  it('offers « Voir plus » only when the longer list holds rows the short one does not', () => {
    expect(hasMoreTabs(report)).toBe(true)
    const few = resourceReport(raw, many.slice(0, RESOURCE_TABS_MAX), [], memoryGauge(9000, 32 * GB, 1), pids)
    expect(hasMoreTabs(few)).toBe(false)
  })

  it('keeps the rows of the longer list in their places under the pointer, as the short one', () => {
    const swapped = resourceReport(raw, [tab('t0', 100, 1), tab('t1', 5000, 1), ...many.slice(2)], [], memoryGauge(9000, 32 * GB, 1), pids)
    expect(swapped.more.tabs[0]!.tabId).toBe('t1')
    const held = heldReport(report, swapped)
    // `t0` slipped under the others (its figures are kept) and `t10` enters at the end.
    expect(held.more.tabs.map((row) => row.tabId)).toEqual([...report.more.tabs.map((row) => row.tabId), 't10'])
    expect(held.more.tabs[0]!.memoryMb).toBe(1000)
    expect(held.more.tabs[1]!.memoryMb).toBe(5000)
  })
})
