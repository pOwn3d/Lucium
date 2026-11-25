// The guard of the video behind a space (shell/video-load-guard.ts, the function `video-load-pause`): what it reads at each beat, what it tells the window,
// and that it owns nothing while its setting is off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SidebarState } from '@shared/model'
import type { RawProcess } from '@shared/processes'
import { createInitialState, reduce } from '@shared/sidebar'
import { LOAD_PAUSE_READINGS, LOAD_READING_MS, LOAD_RESUME_CPU, type VideoPauseReason } from '@shared/video-load-pause'
import { FeatureGates } from './feature-gate'
import { VideoLoadGuard, gateVideoLoad, type VideoLoadGuardDeps } from './video-load-guard'

const proc = (cpu: number): RawProcess[] => [{ pid: 1, type: 'Browser', cpu, memoryKb: 1 }]
const ctx = { now: 0, newId: () => 'x' }

/** The facts the guard reads, changed from the test. */
function facts(over: Partial<{ cpu: number; capturing: boolean; pressure: boolean; locked: boolean }> = {}) {
  const state = { cpu: 10, capturing: false, pressure: false, locked: false, ...over }
  const changes: Array<VideoPauseReason | null> = []
  const deps: VideoLoadGuardDeps = {
    measure: vi.fn(() => proc(state.cpu)),
    capturing: () => state.capturing,
    pressure: () => Promise.resolve(state.pressure),
    onChange: (reason) => void changes.push(reason),
    paused: () => state.locked
  }
  return { state, changes, deps }
}

afterEach(() => vi.restoreAllMocks())

describe('the guard', () => {
  it('says nothing while nothing happens, and tells the window the moment a call starts and the moment it ends', async () => {
    const { state, changes, deps } = facts()
    const guard = new VideoLoadGuard(deps)
    await guard.tick()
    await guard.tick()
    expect(changes).toEqual([])
    state.capturing = true
    await guard.tick()
    expect([guard.reason(), changes]).toEqual(['capture', ['capture']])
    // Still on a call: not told again.
    await guard.tick()
    expect(changes).toEqual(['capture'])
    state.capturing = false
    await guard.tick()
    expect([guard.reason(), changes]).toEqual([null, ['capture', null]])
  })

  it('stops the video for a load only after the readings in a row, the first reading of the meter being left out', async () => {
    const { state, changes, deps } = facts({ cpu: 250 })
    const guard = new VideoLoadGuard(deps)
    // The first reading only starts the meter (no interval to average the processor over): it counts for nothing.
    await guard.tick()
    for (let i = 0; i < LOAD_PAUSE_READINGS - 1; i++) await guard.tick()
    expect(guard.reason()).toBeNull()
    await guard.tick()
    expect([guard.reason(), changes]).toEqual(['load', ['load']])
    // Held while the load stays above the lower mark; let go under it.
    state.cpu = LOAD_RESUME_CPU
    await guard.tick()
    expect(guard.reason()).toBe('load')
    state.cpu = LOAD_RESUME_CPU - 1
    await guard.tick()
    expect([guard.reason(), changes]).toEqual([null, ['load', null]])
  })

  it('counts the memory pressure of macOS as a load', async () => {
    const { changes, deps } = facts({ pressure: true })
    const guard = new VideoLoadGuard(deps)
    for (let i = 0; i < LOAD_PAUSE_READINGS; i++) await guard.tick()
    expect(changes).toEqual(['load'])
  })

  it('reads nothing while the application is locked, nor once stopped', async () => {
    const { state, deps } = facts({ capturing: true })
    state.locked = true
    const guard = new VideoLoadGuard(deps)
    await guard.tick()
    expect(deps.measure).not.toHaveBeenCalled()
    state.locked = false
    guard.stop()
    await guard.tick()
    expect(deps.measure).not.toHaveBeenCalled()
  })

  it('says in the log that a reading failed and keeps the video as it was (a failing meter, a failing pressure reader)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { state, changes, deps } = facts({ capturing: true })
    const guard = new VideoLoadGuard(deps)
    await guard.tick()
    expect(guard.reason()).toBe('capture')
    deps.measure = () => {
      throw new Error('no metrics')
    }
    state.capturing = false
    await guard.tick()
    expect(warn).toHaveBeenCalledWith('[video] the load could not be read, the video stays as it is:', 'no metrics')
    deps.measure = () => proc(1)
    deps.pressure = () => Promise.reject(new Error('sysctl failed'))
    await guard.tick()
    expect(warn).toHaveBeenLastCalledWith('[video] the load could not be read, the video stays as it is:', 'sysctl failed')
    expect([guard.reason(), changes]).toEqual(['capture', ['capture']])
  })
})

describe('its gate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A store over the real reducer, as the gates see one. */
  function store(settings: Partial<Settings>) {
    let state: SidebarState = createInitialState(ctx)
    state = { ...state, settings: { ...state.settings, ...settings } }
    const listeners = new Set<(state: SidebarState) => void>()
    return {
      get: () => state,
      subscribe: (listener: (state: SidebarState) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
      set(patch: Partial<Settings>) {
        state = reduce(state, { type: 'settings/update', patch }, ctx)
        for (const listener of [...listeners]) listener(state)
      }
    }
  }

  it('owns no timer and reads nothing while its setting is off, and reads every 15 s while it is on', async () => {
    const s = store({ pauseVideoOnLoad: false })
    const { deps } = facts()
    const gates = new FeatureGates(s)
    gateVideoLoad(gates, deps)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * LOAD_READING_MS)
    expect(deps.measure).not.toHaveBeenCalled()
    s.set({ pauseVideoOnLoad: true })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.measure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LOAD_READING_MS)
    expect(deps.measure).toHaveBeenCalledTimes(2)
    gates.disposeAll()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets the video play again when the setting is switched off while it is held', async () => {
    const s = store({ pauseVideoOnLoad: true })
    const { changes, deps } = facts({ capturing: true })
    const gates = new FeatureGates(s)
    gateVideoLoad(gates, deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual(['capture'])
    s.set({ pauseVideoOnLoad: false })
    expect(changes).toEqual(['capture', null])
    expect(vi.getTimerCount()).toBe(0)
    gates.disposeAll()
  })

  it('is on by default', () => {
    expect(createInitialState(ctx).settings.pauseVideoOnLoad).toBe(true)
  })
})
