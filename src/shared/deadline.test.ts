import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIMED_OUT, mapLimit, withDeadline } from './deadline'

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

describe('mapLimit', () => {
  const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms))

  it('never has more than the limit in flight, and takes the next item the moment a slot frees', async () => {
    let inFlight = 0
    let peak = 0
    const starts: number[] = []
    const run = mapLimit([1000, 1000, 3000, 1000, 1000], 2, async (ms, index) => {
      starts[index] = Date.now()
      peak = Math.max(peak, ++inFlight)
      await later(ms, undefined)
      inFlight--
    })
    await vi.advanceTimersByTimeAsync(4000)
    await run
    expect(peak).toBe(2)
    // Item 2 (3 s) holds one slot only: items 3 and 4 go through the other one, one after the other.
    expect(starts.map((at) => at - starts[0]!)).toEqual([0, 0, 1000, 1000, 2000])
  })

  it('gives the results in the order of the items, whatever the order they finish in', async () => {
    const run = mapLimit(['a', 'b', 'c'], 3, (name, index) => later((3 - index) * 100, name.toUpperCase()))
    await vi.advanceTimersByTimeAsync(300)
    expect(await run).toEqual(['A', 'B', 'C'])
  })

  it('does not run anything for no items, and treats a limit below one as one', async () => {
    const work = vi.fn(async (n: number) => n)
    expect(await mapLimit([], 4, work)).toEqual([])
    expect(work).not.toHaveBeenCalled()
    expect(await mapLimit([1, 2], 0, work)).toEqual([1, 2])
  })

  it('does not return an empty list silently for a limit that is not a number: it runs the items one at a time', async () => {
    const work = vi.fn(async (n: number) => n)
    expect(await mapLimit([1, 2, 3], Number.NaN, work)).toEqual([1, 2, 3])
    expect(work).toHaveBeenCalledTimes(3)
  })

  it('lets the other items finish when one fails, then throws the first failure: nothing is left running behind the caller', async () => {
    let finished = 0
    const run = mapLimit([1, 2, 3, 4], 2, async (n) => {
      await later(100, undefined)
      if (n === 1) throw new Error('first')
      finished++
    })
    const caught = run.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(500)
    expect(await caught).toBe('first')
    expect(finished).toBe(3)
  })
})
