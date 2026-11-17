import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_READY_MAX_MS, profileReady } from './profile-ready'

describe('profileReady', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is nothing at all for a profile with no extension to load: its first page is not made to wait', () => {
    expect(profileReady([], PROFILE_READY_MAX_MS, 'profile x')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stays pending while an extension is loading, and settles once every load has ended, the failed one included', async () => {
    let finish!: () => void
    const slow = new Promise<void>((resolve) => (finish = resolve))
    const failed = Promise.reject(new Error('cannot load'))
    let settled = false
    void profileReady([slow, failed], PROFILE_READY_MAX_MS, 'profile x')!.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    // The timer is taken away once the loads are over.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not hold a page for ever: a load that never ends is given up after the delay, and the log says which profile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let settled = false
    void profileReady([new Promise(() => undefined)], 500, 'profile work')!.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('profile work'))
  })
})
