import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { within } from './within'

describe('within', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gives the answer when it comes in time, and does not call onLate', async () => {
    const late = vi.fn()
    const answer = within(new Promise<number>((resolve) => setTimeout(() => resolve(7), 100)), 1000, -1, late)
    await vi.advanceTimersByTimeAsync(100)
    await expect(answer).resolves.toBe(7)
    await vi.advanceTimersByTimeAsync(5000)
    expect(late).not.toHaveBeenCalled()
  })

  it('gives the fallback when nothing comes, once, and drops the answer that comes after', async () => {
    const late = vi.fn()
    let finish: (value: number) => void = () => {}
    const answer = within(new Promise<number>((resolve) => (finish = resolve)), 1000, -1, late)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(answer).resolves.toBe(-1)
    finish(9)
    await vi.advanceTimersByTimeAsync(10)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('passes a rejection on, and stops waiting', async () => {
    const late = vi.fn()
    const answer = within(Promise.reject(new Error('gone')), 1000, -1, late)
    await expect(answer).rejects.toThrow('gone')
    await vi.advanceTimersByTimeAsync(5000)
    expect(late).not.toHaveBeenCalled()
  })
})
