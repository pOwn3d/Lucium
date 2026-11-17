import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from './model'
import { setLanguage } from './i18n'
import { ALL_DAYS, dayBounds, dayKey, dayLabel, entriesOfDay, historyDays, isHistoryDay, shownDay, visitTime } from './history-days'

afterEach(() => setLanguage('fr'))

const at = (day: number, hour = 12): number => new Date(2026, 9, day, hour, 0).getTime()
const page = (url: string, time: number): HistoryEntry => ({ url, title: url, visitCount: 1, lastVisitAt: time })
// Wednesday 28 October 2026.
const now = at(28, 16)

describe('the days of the history', () => {
  it('keys a visit by its calendar day in local time: 23:59 and 00:01 are two days', () => {
    expect(dayKey(new Date(2026, 9, 28, 23, 59).getTime())).toBe('2026-10-28')
    expect(dayKey(new Date(2026, 9, 29, 0, 1).getTime())).toBe('2026-10-29')
  })

  it('names the days the way a person says them, in the language of the interface', () => {
    expect(dayLabel(at(28, 8), now)).toBe('Aujourd’hui')
    expect(dayLabel(at(27, 23), now)).toBe('Hier')
    expect(dayLabel(at(26), now)).toBe('Lundi')
    expect(dayLabel(at(10), now)).toBe('10 oct.')
    expect(dayLabel(new Date(2025, 11, 31, 12).getTime(), now)).toBe('31 déc. 2025')
    setLanguage('en')
    expect(dayLabel(at(28), now)).toBe('Today')
    expect(dayLabel(at(26), now)).toBe('Monday')
  })

  it('lists the days that hold a page, the newest first, with their count; the order of a day is the order of the search', () => {
    const found = [page('a', at(26)), page('b', at(28, 9)), page('c', at(28, 15)), page('d', at(27))]
    expect(historyDays(found, now).map((day) => [day.key, day.label, day.count])).toEqual([
      ['2026-10-28', 'Aujourd’hui', 2],
      ['2026-10-27', 'Hier', 1],
      ['2026-10-26', 'Lundi', 1]
    ])
    expect(entriesOfDay(found, '2026-10-28').map((entry) => entry.url)).toEqual(['b', 'c'])
    expect(entriesOfDay(found, ALL_DAYS)).toHaveLength(4)
    expect(entriesOfDay(found, '2026-09-01')).toEqual([])
  })
})

describe('the bounds of a day (« Oublier ce jour » forgets between them, over the whole history)', () => {
  it('go from the midnight of the day to the next one, in local time, and hold every moment keyed to that day and no other', () => {
    const bounds = dayBounds('2026-10-28')!
    expect(bounds.from).toBe(new Date(2026, 9, 28).getTime())
    expect(bounds.to).toBe(new Date(2026, 9, 29).getTime())
    expect(dayKey(bounds.from)).toBe('2026-10-28')
    expect(dayKey(bounds.to - 1)).toBe('2026-10-28')
    expect(dayKey(bounds.to)).toBe('2026-10-29')
    expect(dayKey(bounds.from - 1)).toBe('2026-10-27')
  })

  it('are those of no day for what is not the key of a day: the column of every day, a date that does not exist', () => {
    for (const key of [ALL_DAYS, '', '2026-10', '2026-02-30', '2026-13-01', '2026-10-28T00:00', ' 2026-10-28']) expect(dayBounds(key), key).toBeNull()
  })

  it('are accepted by the main process as one day, the day the clocks go back included (25 hours), and nothing wider', () => {
    const { from, to } = dayBounds('2026-10-28')!
    expect(isHistoryDay(from, to)).toBe(true)
    expect(isHistoryDay(from, from + 25 * 3_600_000)).toBe(true)
    expect(isHistoryDay(from, from + 25 * 3_600_000 + 1)).toBe(false)
    // A year, everything, an empty or reversed span, what is not a moment.
    expect(isHistoryDay(from, from + 365 * 86_400_000)).toBe(false)
    expect(isHistoryDay(0, Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(isHistoryDay(from, from)).toBe(false)
    expect(isHistoryDay(to, from)).toBe(false)
    expect(isHistoryDay(-1, 10)).toBe(false)
    expect(isHistoryDay(Number.NaN, to)).toBe(false)
    expect(isHistoryDay(from, Number.POSITIVE_INFINITY)).toBe(false)
    expect(isHistoryDay(String(from), to)).toBe(false)
    expect(isHistoryDay(from, undefined)).toBe(false)
  })
})

describe('the day that is shown', () => {
  const days = historyDays([page('a', at(28)), page('b', at(27))], now)

  it('is the newest day until the person picks one, and the pick stays while it holds a page', () => {
    expect(shownDay(days, null, false)).toBe('2026-10-28')
    expect(shownDay(days, '2026-10-27', false)).toBe('2026-10-27')
    expect(shownDay(days, ALL_DAYS, false)).toBe(ALL_DAYS)
  })

  it('goes back to the newest day when the chosen one has no page left (everything on it was forgotten)', () => {
    expect(shownDay(days, '2026-10-20', false)).toBe('2026-10-28')
  })

  it('lists every page while a search is under way, so that no result hides behind an empty day', () => {
    expect(shownDay(days, null, true)).toBe(ALL_DAYS)
    expect(shownDay([], null, false)).toBe(ALL_DAYS)
  })
})

describe('the time of a visit', () => {
  it('is the hour of the day in a day column, and the date and the hour in the column of every day', () => {
    expect(visitTime(at(28, 15), false)).toBe('15:00')
    expect(visitTime(at(28, 15), true)).toBe('28 oct. 15:00')
  })
})
