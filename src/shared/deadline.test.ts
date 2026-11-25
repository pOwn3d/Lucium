import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIMED_OUT, withDeadline } from './deadline'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withDeadline', () => {
  it('gives the result of work that answers in time, and leaves no timer behind', async () => {
    const result = withDeadline(3000, async () => 'done')
    await expect(result).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up on work that never answers once the time is up, and tells the work', async () => {
    let expired: () => boolean = () => false
    const result = withDeadline(3000, (isExpired) => {
      expired = isExpired
      return new Promise<string>(() => undefined)
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(expired()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(expired()).toBe(true)
    await expect(result).resolves.toBe(TIMED_OUT)
  })

  it('does not let a late answer change what was given', async () => {
    let answer!: (value: string) => void
    const result = withDeadline(1000, () => new Promise<string>((resolve) => (answer = resolve)))
    await vi.advanceTimersByTimeAsync(1000)
    answer('late')
    await expect(result).resolves.toBe(TIMED_OUT)
  })

  it('passes on a failure that comes in time, and only logs one that comes late', async () => {
    await expect(withDeadline(1000, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let fail!: (error: Error) => void
    const result = withDeadline(1000, () => new Promise<string>((_, reject) => (fail = reject)))
    await vi.advanceTimersByTimeAsync(1000)
    fail(new Error('late boom'))
    await expect(result).resolves.toBe(TIMED_OUT)
    expect(warn).toHaveBeenCalledWith('[deadline] the work failed after its time was up:', 'late boom')
    warn.mockRestore()
  })
})
