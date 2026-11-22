import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { FeatureGates, type GateStore } from './feature-gate'
import { gateHistoryPurge, HISTORY_PURGE_MS } from './history-purge'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function store(keepDays: number): { store: GateStore; set(days: number): void } {
  let state: SidebarState = createInitialState({ now: 0, newId: () => 'id' })
  let listener: ((s: SidebarState) => void) | null = null
  const apply = (days: number) => (state = { ...state, settings: { ...state.settings, historyKeepDays: days } })
  apply(keepDays)
  return {
    store: { get: () => state, subscribe: (l) => ((listener = l), () => (listener = null)) },
    set: (days) => listener?.(apply(days))
  }
}

describe('the purge of the history follows its setting', () => {
  it('owns no timer and makes no pass while the delay is 0 (the default)', () => {
    const { store: s } = store(0)
    const purge = vi.fn()
    gateHistoryPurge(new FeatureGates(s), purge)
    vi.advanceTimersByTime(3 * HISTORY_PURGE_MS)
    expect(purge).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes one pass at once when a delay is set, then one an hour', () => {
    const { store: s } = store(30)
    const purge = vi.fn()
    gateHistoryPurge(new FeatureGates(s), purge)
    expect(purge).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2 * HISTORY_PURGE_MS)
    expect(purge).toHaveBeenCalledTimes(3)
  })

  it('starts when the delay is set later and stops, timer cleared, when it goes back to 0', () => {
    const { store: s, set } = store(0)
    const purge = vi.fn()
    gateHistoryPurge(new FeatureGates(s), purge)
    set(7)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    set(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2 * HISTORY_PURGE_MS)
    expect(purge).toHaveBeenCalledTimes(1)
  })
})
