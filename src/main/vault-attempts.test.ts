import { describe, expect, it } from 'vitest'
import { FREE_TRIES, RETRY_MAX_MS, retryDelayMs } from '@shared/lock'
import { NO_ATTEMPTS, afterWrongPhrase, attemptsText, parseAttempts, waitMs, type Attempts } from './vault-attempts'

const NOW = 1_700_000_000_000

describe('the schedule of the wait after wrong phrases', () => {
  it('tolerates the first two wrong phrases, waits a second after the third and doubles up to half a minute, as the lock of the application does', () => {
    let attempts: Attempts = NO_ATTEMPTS
    const waits: number[] = []
    for (let n = 1; n <= 10; n++) {
      attempts = afterWrongPhrase(attempts, NOW)
      waits.push(waitMs(attempts, NOW))
    }
    expect(waits).toEqual([0, 0, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
    expect(FREE_TRIES).toBe(3)
    // The same numbers as the lock of the application: one schedule for both.
    expect(waits).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(retryDelayMs))
  })

  it('counts from the moment of the failure, and the wait runs out with time', () => {
    const third = afterWrongPhrase(afterWrongPhrase(afterWrongPhrase(NO_ATTEMPTS, NOW), NOW), NOW + 500)
    expect(third).toEqual({ failures: 3, until: NOW + 500 + 1000 })
    expect(waitMs(third, NOW + 500)).toBe(1000)
    expect(waitMs(third, NOW + 1000)).toBe(500)
    expect(waitMs(third, NOW + 1500)).toBe(0)
    expect(waitMs(third, NOW + 9_999_999)).toBe(0)
  })

  it('never goes past the cap, however many wrong phrases there were', () => {
    let attempts: Attempts = NO_ATTEMPTS
    for (let n = 0; n < 5000; n++) attempts = afterWrongPhrase(attempts, NOW)
    expect(attempts.failures).toBeLessThanOrEqual(1000)
    expect(waitMs(attempts, NOW)).toBe(RETRY_MAX_MS)
  })
})

describe('a wait the file claims is not trusted beyond the schedule', () => {
  it('cannot be longer than the schedule gives for the count: a clock set far ahead, or a hand-edited file, locks nothing for good', () => {
    const tenYears = NOW + 10 * 365 * 24 * 3600 * 1000
    expect(waitMs({ failures: 3, until: tenYears }, NOW)).toBe(1000)
    expect(waitMs({ failures: 6, until: tenYears }, NOW)).toBe(8000)
    expect(waitMs({ failures: 40, until: tenYears }, NOW)).toBe(RETRY_MAX_MS)
  })

  it('is none when the count is within the free tries, whatever the end of the wait says', () => {
    expect(waitMs({ failures: 2, until: NOW + 60_000 }, NOW)).toBe(0)
    expect(waitMs(NO_ATTEMPTS, NOW)).toBe(0)
  })
})

describe('reading the file', () => {
  it('gives back what attemptsText wrote', () => {
    const attempts = { failures: 5, until: NOW + 4000 }
    expect(parseAttempts(attemptsText(attempts))).toEqual(attempts)
    expect(JSON.parse(attemptsText(attempts))).toEqual({ v: 1, failures: 5, until: NOW + 4000 })
  })

  it('takes anything that is not exactly that for no failure at all: the owner is never shut out by a damaged file', () => {
    const bad = [
      '',
      'not json',
      '[]',
      'null',
      '42',
      '{}',
      '{"v":2,"failures":5,"until":1}',
      '{"v":1,"failures":"5","until":1}',
      '{"v":1,"failures":5.5,"until":1}',
      '{"v":1,"failures":-3,"until":1}',
      '{"v":1,"failures":0,"until":1}',
      '{"v":1,"failures":1001,"until":1}',
      '{"v":1,"failures":5}',
      '{"v":1,"failures":5,"until":"soon"}',
      '{"v":1,"failures":5,"until":-1}',
      '{"v":1,"failures":5,"until":null}'
    ]
    for (const text of bad) expect(parseAttempts(text), text).toEqual(NO_ATTEMPTS)
  })
})
