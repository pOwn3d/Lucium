import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import {
  heldReport,
  type ResourceReport,
  GAUGE_WARN_PERCENT,
  RESOURCE_TABS_MAX,
  cpuOf,
  formatMemory,
  formatPercent,
  gaugeTip,
  heaviestTabs,
  isHot,
  memoryGauge,
  memoryOf,
  meterShare,
  parseResourceAction,
  resourceReport,
  sameGauge,
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
    const report = resourceReport(raw, [tab('a', 600, 30)], 1, memoryGauge(800, 16 * GB, 1))
    expect(report.memoryMb).toBe(800)
    expect(report.cpu).toBe(33.3)
    expect(report.hidden).toBe(1)
  })

  it(`lists the ${RESOURCE_TABS_MAX} heaviest tabs: memory first, the processor to break a tie`, () => {
    const tabs = [tab('a', 100), tab('b', 584, 1), tab('c', 574, 9), tab('d', 278), tab('e', 584, 7.4), tab('f', 205), tab('g', 172)]
    expect(heaviestTabs(tabs).map((t) => t.tabId)).toEqual(['e', 'b', 'c', 'd', 'f'])
    expect(resourceReport([], tabs, 0, memoryGauge(0, GB, null)).tabs).toHaveLength(RESOURCE_TABS_MAX)
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
    expect(parseResourceAction({ kind: 'sleep-hidden', tabId: 'ignored' })).toEqual({ kind: 'sleep-hidden' })
    expect(parseResourceAction({ kind: 'task-manager' })).toEqual({ kind: 'task-manager' })
  })

  it('refuse anything else', () => {
    for (const raw of [null, 'sleep', 42, {}, { kind: 'kill', tabId: 't1' }, { kind: 'sleep' }, { kind: 'close', tabId: '' }, { kind: 'show', tabId: 7 }, { kind: 'sleep', tabId: 'x'.repeat(257) }]) {
      expect(parseResourceAction(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

// The figures come every 2 s, sorted by weight. Under the pointer the rows keep their places: ☾ and ✕ act on the tab a person aimed at.
describe('heldReport', () => {
  const report = (tabs: ResourceTab[], memoryMb = 1000): ResourceReport => ({ memoryMb, cpu: 10, gauge: memoryGauge(4 * 1024, 16 * 1024, 1), tabs, hidden: 0 })
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
})
