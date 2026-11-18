// The synchronisation window (docs/synchronisation.md §6.1, [Q5]): the only time the Mac listens, ten minutes at most.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_MAX_MS } from './limits'
import { SyncWindow, type Door, type WindowCloseReason, type WindowState } from './sync-window'

function setup(over: Partial<Door> = {}): { window: SyncWindow; door: { starts: number; stops: number }; advance: (ms: number) => Promise<void>; changes: Array<[WindowState, WindowCloseReason | undefined]> } {
  let elapsed = 0
  const door = { starts: 0, stops: 0 }
  const changes: Array<[WindowState, WindowCloseReason | undefined]> = []
  const window = new SyncWindow({
    door: {
      start: async () => void door.starts++,
      stop: async () => void door.stops++,
      ...over
    },
    elapsed: () => elapsed,
    onChange: (state, reason) => void changes.push([state, reason])
  })
  const advance = async (ms: number): Promise<void> => {
    elapsed += ms
    await vi.advanceTimersByTimeAsync(ms)
  }
  return { window, door, advance, changes }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('SyncWindow', () => {
  it('is closed until the person opens it: nothing listens', () => {
    const { window, door } = setup()
    expect(window.state()).toEqual({ open: false, remainingMs: 0 })
    expect(door.starts).toBe(0)
  })

  it('opens the door once and counts ten minutes down', async () => {
    const { window, door, advance } = setup()
    await window.open()
    expect(door.starts).toBe(1)
    expect(window.state()).toEqual({ open: true, remainingMs: WINDOW_MAX_MS })
    await advance(100_000)
    expect(window.state().remainingMs).toBe(WINDOW_MAX_MS - 100_000)
  })

  it('closes by itself at ten minutes, and stops the door', async () => {
    const { window, door, advance, changes } = setup()
    await window.open()
    await advance(WINDOW_MAX_MS - 1000)
    expect(window.state().open).toBe(true)
    expect(door.stops).toBe(0)
    await advance(1000)
    expect(window.state()).toEqual({ open: false, remainingMs: 0 })
    expect(door.stops).toBe(1)
    expect(changes.at(-1)?.[1]).toBe('timeout')
  })

  it('closes at ten minutes even when a time handed in by the clock jumped past the deadline without the timers running', async () => {
    let elapsed = 0
    const window = new SyncWindow({ door: { start: async () => undefined, stop: async () => undefined }, elapsed: () => elapsed })
    await window.open()
    elapsed = WINDOW_MAX_MS + 5000
    await vi.advanceTimersByTimeAsync(1100)
    expect(window.state().open).toBe(false)
  })

  it('prolongs for ten minutes again from now, and does not open a closed window', async () => {
    const { window, door, advance, changes } = setup()
    window.prolong()
    expect(window.state().open).toBe(false)
    expect(changes).toEqual([])
    await window.open()
    await advance(500_000)
    window.prolong()
    expect(window.state().remainingMs).toBe(WINDOW_MAX_MS)
    await advance(WINDOW_MAX_MS - 1000)
    expect(window.state().open).toBe(true)
    await advance(1000)
    expect(window.state().open).toBe(false)
    expect(door.starts).toBe(1)
    window.prolong()
    expect(window.state().open).toBe(false)
  })

  it('opening an open window prolongs it, it does not start a second door', async () => {
    const { window, door, advance } = setup()
    await window.open()
    await advance(300_000)
    await window.open()
    expect(door.starts).toBe(1)
    expect(window.state().remainingMs).toBe(WINDOW_MAX_MS)
  })

  it.each(['manual', 'page-closed', 'switch-off', 'locked'] as const)('closes at once for %s, and says why', async (reason) => {
    const { window, door, changes } = setup()
    await window.open()
    await window.close(reason)
    expect(window.state().open).toBe(false)
    expect(door.stops).toBe(1)
    expect(changes.at(-1)).toEqual([{ open: false, remainingMs: 0 }, reason])
  })

  it('closing a closed window does nothing', async () => {
    const { window, door } = setup()
    await window.close('manual')
    expect(door.stops).toBe(0)
  })

  it('stays closed, and rejects, when the door cannot open', async () => {
    const { window } = setup({ start: () => Promise.reject(new Error('the port is taken')) })
    await expect(window.open()).rejects.toThrow('the port is taken')
    expect(window.state().open).toBe(false)
    await expect(window.open()).rejects.toThrow('the port is taken')
  })

  it('opens the door once for two calls at once', async () => {
    const { window, door } = setup()
    await Promise.all([window.open(), window.open()])
    expect(door.starts).toBe(1)
    expect(window.state().open).toBe(true)
  })

  it('does not come up after a close that arrived while the door was opening', async () => {
    let release: () => void = () => undefined
    let started = 0
    const { window, door } = setup({
      start: () => {
        started++
        return new Promise<void>((resolve) => void (release = resolve))
      }
    })
    const opening = window.open()
    const closing = window.close('switch-off')
    release()
    await opening
    await closing
    expect(window.state().open).toBe(false)
    // The door that came up is stopped: no port stays open behind a window the person cut.
    expect(started).toBe(1)
    expect(door.stops).toBe(1)
  })

  it('answers a close while the door fails to open without throwing: the opener has the error', async () => {
    let fail: (error: Error) => void = () => undefined
    const { window } = setup({ start: () => new Promise<void>((_, reject) => void (fail = reject)) })
    const opening = window.open()
    const closing = window.close('manual')
    fail(new Error('refused'))
    await expect(opening).rejects.toThrow('refused')
    await expect(closing).resolves.toBeUndefined()
  })

  it('can be opened again after it closed', async () => {
    const { window, door } = setup()
    await window.open()
    await window.close('manual')
    await window.open()
    expect(door.starts).toBe(2)
    expect(window.state().open).toBe(true)
  })
})
