import { describe, expect, it } from 'vitest'
import { FAILURES_PER_MINUTE_BEFORE_REFUSAL, MAX_TRACKED_ADDRESSES, REFUSAL_MS } from './limits'
import { AddressLimiter } from './rate-limit'

function limiter(): { now: number; limiter: AddressLimiter } {
  const state = { now: 0, limiter: null as unknown as AddressLimiter }
  state.limiter = new AddressLimiter(() => state.now)
  return state
}

describe('AddressLimiter (docs/synchronisation.md §6.1)', () => {
  it('refuses an address after ten failures in a minute, for a minute', () => {
    const s = limiter()
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL - 1; n++) {
      s.limiter.recordFailure('192.168.1.5')
      s.now += 1000
    }
    expect(s.limiter.isRefused('192.168.1.5')).toBe(false)
    s.limiter.recordFailure('192.168.1.5')
    expect(s.limiter.isRefused('192.168.1.5')).toBe(true)
    s.now += REFUSAL_MS - 1
    expect(s.limiter.isRefused('192.168.1.5')).toBe(true)
    s.now += 1
    expect(s.limiter.isRefused('192.168.1.5')).toBe(false)
  })

  it('does not count failures that are more than a minute apart', () => {
    const s = limiter()
    for (let n = 0; n < 30; n++) {
      s.limiter.recordFailure('10.0.0.2')
      expect(s.limiter.isRefused('10.0.0.2')).toBe(false)
      s.now += 61_000
    }
  })

  it('keeps one address from costing another: each is counted alone', () => {
    const s = limiter()
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL; n++) s.limiter.recordFailure('10.0.0.2')
    expect(s.limiter.isRefused('10.0.0.2')).toBe(true)
    expect(s.limiter.isRefused('10.0.0.3')).toBe(false)
  })

  it(`holds at most ${MAX_TRACKED_ADDRESSES} addresses, the oldest going first`, () => {
    const s = limiter()
    for (let n = 0; n < MAX_TRACKED_ADDRESSES + 100; n++) s.limiter.recordFailure(`10.1.${n >> 8}.${n & 255}`)
    expect(s.limiter.size()).toBe(MAX_TRACKED_ADDRESSES)
  })

  it('keeps an address that is used again, and forgets the one that was not: the oldest by last use goes first', () => {
    const s = limiter()
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL - 1; n++) s.limiter.recordFailure('10.9.9.9')
    for (let n = 0; n < MAX_TRACKED_ADDRESSES - 1; n++) s.limiter.recordFailure(`10.2.${n >> 8}.${n & 255}`)
    // Used again: the tenth failure refuses it, and it is now the newest entry of a full table.
    s.limiter.recordFailure('10.9.9.9')
    for (let n = 0; n < 5; n++) s.limiter.recordFailure(`10.3.0.${n}`)
    expect(s.limiter.size()).toBe(MAX_TRACKED_ADDRESSES)
    expect(s.limiter.isRefused('10.9.9.9')).toBe(true)
  })
})
