import { describe, expect, it } from 'vitest'
import { defaultSettings, type Settings } from './model'
import { cleanFocusSettings, focusBlock, focusState, formatClock, inFocusSlot, parseClock, pauseFocusPatch, startFocusPatch, stopFocusPatch, type FocusSettings } from './focus-mode'

const base = (patch: Partial<FocusSettings> = {}): FocusSettings => ({ ...cleanFocusSettings(defaultSettings()), focusMode: true, focusSites: ['news.example.com', 'video.example'], ...patch })
const raw = (patch: Record<string, unknown>): Settings => ({ ...defaultSettings(), ...patch }) as unknown as Settings
// Local time on purpose: the slot is the user's wall clock. 2026-11-23 is a Monday.
const at = (day: number, hours: number, minutes = 0): Date => new Date(2026, 10, 22 + day, hours, minutes)

describe('focus mode: when it blocks', () => {
  it('is off by default and blocks nothing', () => {
    const settings = cleanFocusSettings(defaultSettings())
    expect(settings.focusMode).toBe(false)
    expect(focusBlock({ ...settings, focusSites: ['example.org'], focusUntil: Date.now() + 60_000 }, 'https://example.org/', Date.now())).toBeNull()
  })

  it('blocks a listed site and its subdomains while a timer runs, and not another site', () => {
    const now = 1_000_000
    const settings = base({ focusUntil: now + 60_000 })
    expect(focusBlock(settings, 'https://news.example.com/a', now)?.site).toBe('news.example.com')
    expect(focusBlock(settings, 'https://www.news.example.com/a', now)?.site).toBe('news.example.com')
    expect(focusBlock(settings, 'https://example.com/', now)).toBeNull()
    expect(focusBlock(settings, 'https://notnews.example.com.evil.test/', now)).toBeNull()
  })

  it('stops blocking when the timer has ended', () => {
    const settings = base({ focusUntil: 5_000 })
    expect(focusState(settings, 4_999)).toEqual({ active: true, by: 'timer', until: 5_000 })
    expect(focusState(settings, 5_000)).toEqual({ active: false })
  })

  it('blocks nothing with an empty list, even with a timer', () => {
    expect(focusState(base({ focusSites: [], focusUntil: 9_999_999 }), 0)).toEqual({ active: false })
  })

  it('a pause silences the timer and the slot until it ends', () => {
    const monday10 = at(1, 10).getTime()
    const slot = base({ focusScheduleOn: true, focusUntil: monday10 + 60_000, focusSnoozeUntil: monday10 + 900_000 })
    expect(focusState(slot, monday10)).toEqual({ active: false })
    expect(focusState({ ...slot, focusSnoozeUntil: 0 }, monday10).active).toBe(true)
    expect(focusState(slot, monday10 + 900_000).active).toBe(true)
  })
})

describe('focus mode: the weekly slot', () => {
  const week = { focusDays: [1, 2, 3, 4, 5], focusFrom: 540, focusTo: 1080 }
  it('holds the times from the start (included) to the end (excluded) on the chosen days', () => {
    expect(inFocusSlot(week, at(1, 9, 0))).toBe(true)
    expect(inFocusSlot(week, at(1, 17, 59))).toBe(true)
    expect(inFocusSlot(week, at(1, 18, 0))).toBe(false)
    expect(inFocusSlot(week, at(1, 8, 59))).toBe(false)
    // Sunday and Saturday are not chosen.
    expect(inFocusSlot(week, at(0, 10))).toBe(false)
    expect(inFocusSlot(week, at(6, 10))).toBe(false)
  })

  it('runs over midnight when the end is before the start, and belongs to the day it began', () => {
    const night = { focusDays: [5], focusFrom: 22 * 60, focusTo: 6 * 60 }
    expect(inFocusSlot(night, at(5, 23))).toBe(true)
    // Saturday 05:00 is the end of Friday's slot; Saturday 23:00 is not a slot (Saturday is not chosen).
    expect(inFocusSlot(night, at(6, 5))).toBe(true)
    expect(inFocusSlot(night, at(6, 23))).toBe(false)
    expect(inFocusSlot(night, at(5, 5))).toBe(false)
  })

  it('is empty when the start equals the end', () => {
    expect(inFocusSlot({ focusDays: [1], focusFrom: 600, focusTo: 600 }, at(1, 10))).toBe(false)
  })

  it('blocks through focusState only when the slot is switched on', () => {
    const monday10 = at(1, 10).getTime()
    expect(focusState(base({ focusScheduleOn: false }), monday10)).toEqual({ active: false })
    expect(focusState(base({ focusScheduleOn: true }), monday10)).toEqual({ active: true, by: 'slot', until: null })
  })
})

describe('focus mode: patches and clock', () => {
  it('starts a timer of the asked length, switches focus on and ends a pause', () => {
    expect(startFocusPatch(25, 1_000)).toEqual({ focusMode: true, focusUntil: 1_000 + 25 * 60_000, focusSnoozeUntil: 0 })
    // A length out of bounds falls back to the default instead of writing a timer that never ends.
    expect(startFocusPatch(Number.NaN, 0).focusUntil).toBe(25 * 60_000)
    expect(startFocusPatch(10 ** 9, 0).focusUntil).toBe(25 * 60_000)
  })

  it('pauses for 15 minutes and ends the timer; stop clears both', () => {
    expect(pauseFocusPatch(1_000)).toEqual({ focusUntil: 0, focusSnoozeUntil: 1_000 + 15 * 60_000 })
    expect(stopFocusPatch()).toEqual({ focusUntil: 0, focusSnoozeUntil: 0 })
  })

  it('writes and reads HH:MM', () => {
    expect(formatClock(540)).toBe('09:00')
    expect(formatClock(1439)).toBe('23:59')
    expect(parseClock('09:05')).toBe(545)
    expect(parseClock('9:05')).toBe(545)
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('12:60')).toBeNull()
    expect(parseClock('noon')).toBeNull()
  })
})

describe('focus mode: the settings read back from a file', () => {
  it('keep hosts written one way, each once, and drop what is not a site', () => {
    expect(cleanFocusSettings(raw({ focusSites: ['News.Example.com', 'https://www.video.example/watch', 'news.example.com', 4, null, 'not a host'] })).focusSites).toEqual(['news.example.com', 'video.example'])
    expect(cleanFocusSettings(raw({ focusSites: 'example.org' })).focusSites).toEqual([])
  })

  it('are on only when the file holds exactly true', () => {
    expect(cleanFocusSettings(raw({ focusMode: true })).focusMode).toBe(true)
    for (const bad of ['true', 1, null, undefined, {}]) expect(cleanFocusSettings(raw({ focusMode: bad, focusScheduleOn: bad })), JSON.stringify(bad)).toMatchObject({ focusMode: false, focusScheduleOn: false })
  })

  it('fall back to the defaults for a value out of range', () => {
    const cleaned = cleanFocusSettings(raw({ focusDays: [1, 1, 9, -1, 'x', 3.5, 0], focusFrom: 2000, focusTo: -5, focusMinutes: 0, focusUntil: -3, focusSnoozeUntil: 'soon' }))
    expect(cleaned).toMatchObject({ focusDays: [0, 1], focusFrom: 540, focusTo: 1080, focusMinutes: 25, focusUntil: 0, focusSnoozeUntil: 0 })
    expect(cleanFocusSettings(raw({ focusDays: 'monday' })).focusDays).toEqual([1, 2, 3, 4, 5])
  })
})
