import { describe, expect, it } from 'vitest'
import { cleanKeepDays, historyRangeBounds, HISTORY_RANGES, isHistoryRange, purgeCutoff } from './history-range'

// Wednesday 28 October 2026, 16:30 local time.
const now = new Date(2026, 9, 28, 16, 30).getTime()

describe('the spans of the history', () => {
  it('names five spans and nothing else', () => {
    expect([...HISTORY_RANGES]).toEqual(['hour', 'today', 'week', 'month', 'all'])
    for (const bad of ['', 'year', 'ALL', 1, null, undefined, { from: 0 }]) expect(isHistoryRange(bad), String(bad)).toBe(false)
    expect(HISTORY_RANGES.every(isHistoryRange)).toBe(true)
  })

  it('counts the last hour back from now, the visit of this very instant included', () => {
    expect(historyRangeBounds('hour', now)).toEqual({ from: now - 3_600_000, to: now + 1 })
  })

  it('starts today at the local midnight', () => {
    expect(historyRangeBounds('today', now)).toEqual({ from: new Date(2026, 9, 28).getTime(), to: now + 1 })
  })

  it('counts 7 days and 4 weeks (28 days) back from now', () => {
    expect(historyRangeBounds('week', now).from).toBe(now - 7 * 86_400_000)
    expect(historyRangeBounds('month', now).from).toBe(now - 28 * 86_400_000)
  })

  it('reaches back to the first visit for « tout »', () => {
    expect(historyRangeBounds('all', now)).toEqual({ from: 0, to: now + 1 })
  })
})

describe('the purge delay', () => {
  it('keeps a whole number of days from 1 to 3650; anything else is « no purge »', () => {
    expect([7, 30, 365, 3650, 1].map(cleanKeepDays)).toEqual([7, 30, 365, 3650, 1])
    for (const bad of [0, -1, 2.5, 3651, Number.NaN, Infinity, '30', null, undefined]) expect(cleanKeepDays(bad), String(bad)).toBe(0)
  })

  it('has no cutoff while it is off, and one at now minus the days otherwise', () => {
    expect(purgeCutoff(0, now)).toBeNull()
    expect(purgeCutoff(-5, now)).toBeNull()
    expect(purgeCutoff(30, now)).toBe(now - 30 * 86_400_000)
  })
})
