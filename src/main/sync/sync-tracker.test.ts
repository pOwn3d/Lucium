// The marks follow the state while the switch is on (docs/synchronisation.md §9.2).
import { describe, expect, it, vi } from 'vitest'
import { MarkBook } from './marks'
import { stateOf } from './session-rig.test-support'
import { MarkTracker, TRACK_DELAY_MS } from './sync-tracker'

function rig() {
  const listeners: Array<() => void> = []
  const timers: Array<{ run: () => void; ms: number }> = []
  const book = new MarkBook('mac')
  let state = stateOf({ spaces: [{ id: 's1', name: 'A' }] })
  const save = vi.fn()
  const tracker = new MarkTracker({
    state: () => state,
    subscribe: (listener) => (listeners.push(listener), () => void listeners.splice(listeners.indexOf(listener), 1)),
    marks: book,
    save,
    now: () => 1_790_000_000_000,
    setTimer: (run, ms) => (timers.push({ run, ms }), { unref: () => undefined } as unknown as NodeJS.Timeout)
  })
  return { tracker, listeners, timers, book, save, change: (next: typeof state) => ((state = next), listeners.forEach((l) => l())) }
}

describe('MarkTracker', () => {
  it('looks at the state once when it starts, writes the marks, and subscribes', () => {
    const r = rig()
    expect(r.tracker.running()).toBe(false)
    r.tracker.start()
    expect(r.tracker.running()).toBe(true)
    expect(Object.keys(r.book.stampsOf('space', 's1'))).toContain('name')
    expect(r.save).toHaveBeenCalledTimes(1)
    expect(r.listeners).toHaveLength(1)
  })

  it('starts once: a second start subscribes nothing more', () => {
    const r = rig()
    r.tracker.start()
    r.tracker.start()
    expect(r.listeners).toHaveLength(1)
  })

  it('waits for a quiet moment after a change, and looks once for any number of changes in it', () => {
    const r = rig()
    r.tracker.start()
    r.save.mockClear()
    const next = stateOf({ spaces: [{ id: 's1', name: 'B' }] })
    r.change(next)
    r.change(next)
    r.change(next)
    expect(r.timers).toHaveLength(1)
    expect(r.timers[0]?.ms).toBe(TRACK_DELAY_MS)
    expect(r.save).not.toHaveBeenCalled()
    r.timers[0]?.run()
    expect(r.save).toHaveBeenCalledTimes(1)
    r.change(next)
    expect(r.timers).toHaveLength(2)
  })

  it('marks the field the change touched', () => {
    const r = rig()
    r.tracker.start()
    const before = r.book.stampsOf('space', 's1')['name']
    r.change(stateOf({ spaces: [{ id: 's1', name: 'B' }] }))
    r.timers[0]?.run()
    expect(r.book.stampsOf('space', 's1')['name']).not.toBe(before)
  })

  it('lets go when halted: nothing is subscribed, and a look that was waiting does not happen', () => {
    const r = rig()
    r.tracker.start()
    r.save.mockClear()
    r.change(stateOf({ spaces: [{ id: 's1', name: 'B' }] }))
    r.tracker.halt()
    expect(r.tracker.running()).toBe(false)
    expect(r.listeners).toHaveLength(0)
    expect(r.save).not.toHaveBeenCalled()
  })

  it('does not look after it was halted, even if a look was waiting (the timer is cleared)', () => {
    vi.useFakeTimers()
    const listeners: Array<() => void> = []
    const save = vi.fn()
    let state = stateOf({ spaces: [{ id: 's1', name: 'A' }] })
    const tracker = new MarkTracker({ state: () => state, subscribe: (l) => (listeners.push(l), () => void listeners.splice(0, 1)), marks: new MarkBook('mac'), save, now: () => 1_790_000_000_000 })
    tracker.start()
    save.mockClear()
    state = stateOf({ spaces: [{ id: 's1', name: 'B' }] })
    listeners.forEach((l) => l())
    tracker.halt()
    vi.advanceTimersByTime(TRACK_DELAY_MS * 3)
    expect(save).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('says it in the log, and goes on, when the marks cannot be written', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = rig()
    r.save.mockImplementation(() => {
      throw new Error('the disk is full')
    })
    expect(() => r.tracker.start()).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('marks could not be written'), expect.anything())
    expect(Object.keys(r.book.stampsOf('space', 's1'))).toContain('name')
    log.mockRestore()
  })
})
