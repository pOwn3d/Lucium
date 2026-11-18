import { describe, expect, it } from 'vitest'
import { SafeClock } from './safe-clock'

/** Two sources a test moves by hand. */
function sources(): { monotonic: number; wall: number; api: { monotonic: () => number; wall: () => number } } {
  const state = { monotonic: 1000, wall: 1_790_000_000_000, api: { monotonic: () => state.monotonic, wall: () => state.wall } }
  return state
}

describe('SafeClock: the time that measures a window', () => {
  it('starts at zero and follows both clocks when they agree', () => {
    const s = sources()
    const clock = new SafeClock(s.api)
    expect(clock.elapsed()).toBe(0)
    s.monotonic += 5000
    s.wall += 5000
    expect(clock.elapsed()).toBe(5000)
  })

  it('is not stretched by a wall clock put back: the monotonic clock goes on', () => {
    const s = sources()
    const clock = new SafeClock(s.api)
    s.monotonic += 60_000
    s.wall -= 3_600_000
    expect(clock.elapsed()).toBe(60_000)
  })

  it('closes early when the wall clock jumps forward, or when the Mac slept (the monotonic clock stood still)', () => {
    const s = sources()
    const clock = new SafeClock(s.api)
    s.monotonic += 1000
    s.wall += 600_000
    expect(clock.elapsed()).toBe(600_000)
  })

  it('never goes backwards, whatever the sources do afterwards', () => {
    const s = sources()
    const clock = new SafeClock(s.api)
    s.wall += 90_000
    expect(clock.elapsed()).toBe(90_000)
    s.wall -= 80_000
    expect(clock.elapsed()).toBe(90_000)
    s.monotonic += 95_000
    expect(clock.elapsed()).toBe(95_000)
  })
})
