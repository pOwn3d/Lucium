// The notices that offer an action: how long they stay, and the clock that waits while the pointer or the focus is on one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_NOTICE_MS, NoticeHolds, NoticeTimer, TOAST_PLAIN_MS, ToastClock, toastDurationMs } from './toast'

describe('how long a notice stays', () => {
  it('is 5 s for a plain message and 8 s when it offers an action, unless the caller asks for another time', () => {
    expect(toastDurationMs(false)).toBe(TOAST_PLAIN_MS)
    expect(toastDurationMs(true)).toBe(ACTION_NOTICE_MS)
    expect(toastDurationMs(true, 12_000)).toBe(12_000)
    expect(toastDurationMs(false, 3000)).toBe(3000)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(toastDurationMs(true, bad), String(bad)).toBe(ACTION_NOTICE_MS)
  })

  it('is never under 8 s for a notice with an action, whatever the caller asks', () => {
    expect(ACTION_NOTICE_MS).toBe(8000)
    expect(toastDurationMs(true, 3000)).toBe(ACTION_NOTICE_MS)
    expect(toastDurationMs(true, ACTION_NOTICE_MS - 1)).toBe(ACTION_NOTICE_MS)
  })
})

describe('the clock of a notice', () => {
  it('goes on with what it had left after a hold', () => {
    const clock = new ToastClock()
    clock.start(8000, 1000)
    expect(clock.hold(4000)).toBe(true)
    // A second hold (the focus enters while the pointer is in) changes nothing.
    expect(clock.hold(6000)).toBe(false)
    expect(clock.release(20_000)).toBe(5000)
    expect(clock.release(21_000)).toBeNull()
  })

  it('never has less than nothing left, and a new notice starts afresh', () => {
    const clock = new ToastClock()
    clock.start(1000, 0)
    clock.hold(5000)
    expect(clock.release(6000)).toBe(0)
    clock.start(8000, 6000)
    clock.hold(7000)
    expect(clock.release(9000)).toBe(7000)
  })
})

describe('what holds a notice', () => {
  it('is the pointer or the focus, each kept apart: the pointer leaving a notice that has the focus lets nothing go', () => {
    const holds = new NoticeHolds()
    expect(holds.held).toBe(false)
    expect(holds.set('pointer', true)).toBe(true)
    // The focus enters while the pointer is in: still held, nothing changes.
    expect(holds.set('focus', true)).toBeNull()
    expect(holds.set('pointer', false)).toBeNull()
    expect(holds.held).toBe(true)
    expect(holds.set('focus', false)).toBe(false)
    expect(holds.set('focus', false)).toBeNull()
  })
})

describe('the timer of a notice', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once, when its time is up', () => {
    const expire = vi.fn()
    new NoticeTimer(ACTION_NOTICE_MS, expire).start()
    vi.advanceTimersByTime(ACTION_NOTICE_MS - 1)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(ACTION_NOTICE_MS * 3)
    expect(expire).toHaveBeenCalledTimes(1)
  })

  it('stops while it is held and goes on with what it had left', () => {
    const expire = vi.fn()
    const timer = new NoticeTimer(ACTION_NOTICE_MS, expire).start()
    vi.advanceTimersByTime(6000)
    timer.hold()
    // A second hold (the focus comes in with the pointer) does not lose the time already kept.
    timer.hold()
    vi.advanceTimersByTime(ACTION_NOTICE_MS * 10)
    expect(expire).not.toHaveBeenCalled()
    timer.release()
    vi.advanceTimersByTime(ACTION_NOTICE_MS - 6000 - 1)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledTimes(1)
  })

  it('runs nothing once cancelled, held or not, and ignores a hold after its end', () => {
    const [cancelled, held, over] = [vi.fn(), vi.fn(), vi.fn()]
    new NoticeTimer(1000, cancelled).start().cancel()
    const kept = new NoticeTimer(1000, held).start()
    kept.hold()
    kept.cancel()
    kept.release()
    const done = new NoticeTimer(1000, over).start()
    vi.advanceTimersByTime(1000)
    done.hold()
    done.release()
    vi.advanceTimersByTime(60_000)
    expect([cancelled, held, over].map((run) => run.mock.calls.length)).toEqual([0, 0, 1])
  })

  it('reads the clock it is given, not the one of the machine', () => {
    let now = 0
    const waits: number[] = []
    const timers = { set: (_run: () => void, ms: number) => (waits.push(ms), waits.length as unknown as ReturnType<typeof setTimeout>), clear: () => undefined, now: () => now }
    const timer = new NoticeTimer(8000, () => undefined, timers).start()
    now = 5000
    timer.hold()
    now = 500_000
    timer.release()
    // 3 s were left when it stopped, however long it waited.
    expect(waits).toEqual([8000, 3000])
  })
})
