// The count of a page just forgotten in the command bar waits in memory for « Annuler », per profile, for as long as the history keeps the page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORGOTTEN_KEPT_MAX, FORGOTTEN_KEPT_MS } from '../history'
import { ForgottenRanking } from './forgotten-ranking'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('ForgottenRanking', () => {
  it('gives the count back once, to the profile and the page it was kept for', () => {
    const kept = new ForgottenRanking()
    kept.keep('default', 'https://a.example/', 4)
    expect(kept.take('work', 'https://a.example/')).toBe(0)
    expect(kept.take('default', 'https://b.example/')).toBe(0)
    expect(kept.take('default', 'https://a.example/')).toBe(4)
    expect(kept.take('default', 'https://a.example/')).toBe(0)
    expect(kept.size()).toBe(0)
  })

  it('gives nothing back once the time is up, by the clock of the caller and by its own', () => {
    const kept = new ForgottenRanking()
    kept.keep('default', 'https://a.example/', 4, 1_000)
    expect(kept.take('default', 'https://a.example/', 1_000 + FORGOTTEN_KEPT_MS + 1)).toBe(0)
    kept.keep('default', 'https://a.example/', 4)
    vi.advanceTimersByTime(FORGOTTEN_KEPT_MS)
    expect(kept.size()).toBe(0)
    expect(kept.take('default', 'https://a.example/')).toBe(0)
  })

  it('keeps nothing for a count that is not one, and drops what a page forgotten for good had', () => {
    const kept = new ForgottenRanking()
    kept.keep('default', 'https://a.example/', 4)
    kept.keep('default', 'https://a.example/', 0)
    expect(kept.size()).toBe(0)
    expect(kept.take('default', 'https://a.example/')).toBe(0)
    kept.keep('default', 'https://a.example/', 1.5)
    expect(kept.size()).toBe(0)
    kept.keep('default', 'https://b.example/', 2)
    kept.drop('default', 'https://b.example/')
    expect(kept.take('default', 'https://b.example/')).toBe(0)
  })

  it('never holds more pages than the history keeps aside: the oldest goes first', () => {
    const kept = new ForgottenRanking()
    for (let i = 0; i <= FORGOTTEN_KEPT_MAX; i++) kept.keep('default', `https://p${i}.example/`, i + 1)
    expect(kept.size()).toBe(FORGOTTEN_KEPT_MAX)
    expect(kept.take('default', 'https://p0.example/')).toBe(0)
    expect(kept.take('default', 'https://p1.example/')).toBe(2)
  })
})
