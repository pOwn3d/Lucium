// The forced end of loading (20 s) announces nothing once its page is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORCED_LOADING_END_MS, LoadingTimer } from './loading-timer'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the forced end of loading', () => {
  it('announces the end once the delay has run out, and not before', () => {
    const timer = new LoadingTimer()
    const announce = vi.fn()
    timer.start(() => false, announce)
    vi.advanceTimersByTime(FORCED_LOADING_END_MS - 1)
    expect(announce).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(announce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FORCED_LOADING_END_MS * 3)
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it('checks that the page is still there before it announces anything', () => {
    const timer = new LoadingTimer()
    const announce = vi.fn()
    let gone = false
    timer.start(() => gone, announce)
    // The page is closed or destroyed while the count runs.
    gone = true
    vi.advanceTimersByTime(FORCED_LOADING_END_MS)
    expect(announce).not.toHaveBeenCalled()
  })

  it('announces nothing when the load ended by itself', () => {
    const timer = new LoadingTimer()
    const announce = vi.fn()
    timer.start(() => false, announce)
    timer.cancel()
    vi.advanceTimersByTime(FORCED_LOADING_END_MS * 2)
    expect(announce).not.toHaveBeenCalled()
  })

  it('counts from the last load that started: an earlier count does not announce for it', () => {
    const timer = new LoadingTimer()
    const first = vi.fn()
    const second = vi.fn()
    timer.start(() => false, first)
    vi.advanceTimersByTime(FORCED_LOADING_END_MS - 1000)
    timer.start(() => false, second)
    vi.advanceTimersByTime(1000)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FORCED_LOADING_END_MS - 1000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('can count again after it announced', () => {
    const timer = new LoadingTimer()
    const announce = vi.fn()
    timer.start(() => false, announce)
    vi.advanceTimersByTime(FORCED_LOADING_END_MS)
    timer.start(() => false, announce)
    vi.advanceTimersByTime(FORCED_LOADING_END_MS)
    expect(announce).toHaveBeenCalledTimes(2)
  })
})
