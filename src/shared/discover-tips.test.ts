import { describe, expect, it } from 'vitest'
import {
  DISCOVER_PATH_STEPS,
  cleanDiscoverDay,
  cleanDiscoverPath,
  dayKey,
  discoverTipEntry,
  pathProgress,
  putTipAwayPatch,
  resetPathPatch,
  showTipToday,
  tickStepPatch,
  tipSettingPatch
} from './discover-tips'
import { ALL_DISCOVER_ENTRIES, discoverOff } from './discover'
import { defaultSettings } from './model'

const ids = (list: readonly { id: string }[]): string[] => list.map((entry) => entry.id)
const pool = (names: string[]) => names.map((id) => ({ id }))

describe('the days', () => {
  it('writes the local day, not the UTC one', () => {
    expect(dayKey(new Date(2026, 10, 22, 23, 59))).toBe('2026-11-22')
    expect(dayKey(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05')
  })

  it('keeps a real day of the calendar and nothing else', () => {
    expect(cleanDiscoverDay('2026-11-22')).toBe('2026-11-22')
    for (const bad of ['', '2026-02-30', '2026-13-01', '22/11/2026', '2026-1-1', 20261122, null, undefined, {}, ['2026-11-22'], '2026-11-22\n']) {
      expect(cleanDiscoverDay(bad)).toBe('')
    }
  })
})

describe('the tip of the day', () => {
  const entries = pool(['a', 'b', 'c'])

  it('is the same all day and changes the next day, going round the pool', () => {
    const today = discoverTipEntry(entries, '2026-11-22', () => false)
    expect(discoverTipEntry(entries, '2026-11-22', () => false)).toBe(today)
    const next = discoverTipEntry(entries, '2026-11-23', () => false)
    expect(next).not.toBe(today)
    expect(discoverTipEntry(entries, '2026-11-25', () => false)).toBe(today)
  })

  it('shows a different function each day until the pool has been through', () => {
    const seen = new Set<string>()
    for (let day = 1; day <= 3; day++) seen.add(discoverTipEntry(entries, `2026-12-0${day}`, () => false)!.id)
    expect(seen.size).toBe(3)
  })

  it('never offers a function that is switched off', () => {
    for (let day = 1; day <= 9; day++) expect(discoverTipEntry(entries, `2026-12-0${day}`, (entry) => entry.id === 'b')!.id).not.toBe('b')
  })

  it('has no tip when nothing can be offered', () => {
    expect(discoverTipEntry([], '2026-11-22', () => false)).toBeNull()
    expect(discoverTipEntry(entries, '2026-11-22', () => true)).toBeNull()
    expect(discoverTipEntry(entries, '', () => false)).toBeNull()
  })

  it('draws from real cards of the catalogue, never an unreachable one', () => {
    const settings = defaultSettings()
    const tip = discoverTipEntry(ALL_DISCOVER_ENTRIES, '2026-11-22', (entry) => discoverOff(entry, settings))
    expect(tip).not.toBeNull()
    expect(ids(ALL_DISCOVER_ENTRIES)).toContain(tip!.id)
    expect(discoverOff(tip!, settings)).toBe(false)
  })
})

describe('when the tip shows', () => {
  const base = { discoverTip: true, discoverTipDay: '' }

  it('shows by default to someone who has never seen it', () => {
    expect(defaultSettings().discoverTip).toBe(true)
    expect(showTipToday(base, '2026-11-22')).toBe(true)
  })

  it('is not shown a second time the same day once it has been put away', () => {
    expect(showTipToday({ ...base, discoverTipDay: '2026-11-22' }, '2026-11-22')).toBe(false)
    expect(showTipToday({ ...base, discoverTipDay: '2026-11-22' }, '2026-11-23')).toBe(true)
  })

  it('is never shown when the person switched it off', () => {
    expect(showTipToday({ ...base, discoverTip: false }, '2026-11-22')).toBe(false)
  })

  it('writes the day it was put away, and the one-click switch', () => {
    expect(putTipAwayPatch('2026-11-22')).toEqual({ discoverTipDay: '2026-11-22' })
    expect(tipSettingPatch(false)).toEqual({ discoverTip: false })
    // Turning it back on shows it at once, even on a day it had been put away.
    expect(tipSettingPatch(true)).toEqual({ discoverTip: true, discoverTipDay: '' })
  })
})

describe('the path « Parcours de découverte »', () => {
  it('has three to five steps, each a card of the catalogue the person can start from', () => {
    expect(DISCOVER_PATH_STEPS.length).toBeGreaterThanOrEqual(3)
    expect(DISCOVER_PATH_STEPS.length).toBeLessThanOrEqual(5)
    for (const step of DISCOVER_PATH_STEPS) expect(ids(ALL_DISCOVER_ENTRIES)).toContain(step)
    expect(new Set(DISCOVER_PATH_STEPS).size).toBe(DISCOVER_PATH_STEPS.length)
  })

  it('reads a saved list as known steps only, each once, in the order of the path', () => {
    const [first, , third] = DISCOVER_PATH_STEPS
    expect(cleanDiscoverPath([third, 'nope', first, first, 7, null, '__proto__', {}])).toEqual([first, third])
    for (const bad of ['texte', 7, null, undefined, {}, true]) expect(cleanDiscoverPath(bad)).toEqual([])
  })

  it('ticks and unticks a step, and starts over', () => {
    const [first, second] = DISCOVER_PATH_STEPS
    expect(tickStepPatch([], first, true)).toEqual({ discoverPath: [first] })
    expect(tickStepPatch([second], first, true)).toEqual({ discoverPath: [first, second] })
    expect(tickStepPatch([first, second], first, true)).toEqual({ discoverPath: [first, second] })
    expect(tickStepPatch([first, second], first, false)).toEqual({ discoverPath: [second] })
    expect(tickStepPatch([], 'not-a-step', true)).toEqual({ discoverPath: [] })
    expect(resetPathPatch()).toEqual({ discoverPath: [] })
  })

  it('counts what is done, ignoring a step that no longer exists', () => {
    const [first, second] = DISCOVER_PATH_STEPS
    expect(pathProgress([])).toEqual({ done: 0, total: DISCOVER_PATH_STEPS.length, complete: false })
    expect(pathProgress([first, second, 'gone'])).toEqual({ done: 2, total: DISCOVER_PATH_STEPS.length, complete: false })
    expect(pathProgress([...DISCOVER_PATH_STEPS])).toEqual({ done: DISCOVER_PATH_STEPS.length, total: DISCOVER_PATH_STEPS.length, complete: true })
  })
})
