// The figures of the resource gauge and of its panel (resource-watch.ts): zero cost while no panel is open, one 2 s refresh for every open panel
// whatever their window, stopped with the last one; the pressure of macOS read at the sweep and at an opening, never at each refresh.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawProcess } from '@shared/processes'
import { RESOURCE_REFRESH_MS, type MemoryGauge } from '@shared/resources'
import { ResourceWatch, type ResourceViewer } from './resource-watch'

const MB = 1024

function setup(options: { memoryMb?: number; level?: number | null; paused?: boolean } = {}) {
  const state = { memoryMb: options.memoryMb ?? 4000, level: options.level ?? 1, paused: options.paused ?? false, failMeasure: false }
  const measure = vi.fn((): RawProcess[] => {
    if (state.failMeasure) throw new Error('no metrics')
    return [{ pid: 1, type: 'Browser', cpu: 1, memoryKb: state.memoryMb * MB }]
  })
  const pressure = vi.fn(() => Promise.resolve(state.level))
  const gauges: Array<MemoryGauge | null> = []
  const watch = new ResourceWatch({ measure, totalMb: 16_000, pressure, onGauge: (gauge) => gauges.push(gauge), paused: () => state.paused })
  return { watch, measure, pressure, gauges, state }
}

/** A panel that records what it was shown; `gone` makes it say its window is gone. */
function viewer() {
  const shown: MemoryGauge[] = []
  let gone = false
  const self: ResourceViewer & { shown: MemoryGauge[]; leave(): void } = {
    shown,
    leave: () => void (gone = true),
    show: (_raw, gauge) => {
      if (gone) return false
      shown.push(gauge)
      return true
    }
  }
  return self
}

/** The pressure read once already (a sweep came by): an opening that reads the same level draws nothing more. */
async function knownPressure(t: ReturnType<typeof setup>): Promise<void> {
  t.watch.sweep()
  await vi.advanceTimersByTimeAsync(0)
  t.measure.mockClear()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('while no panel is open', () => {
  it('owns no timer: the ring is read once when the function starts, and again only at the sweep of the sleep', async () => {
    const t = setup()
    t.watch.prime()
    expect(t.measure).toHaveBeenCalledTimes(1)
    expect(t.gauges.map((g) => g?.percent)).toEqual([25])
    // Starting runs no program: the pressure waits for the first sweep.
    expect(t.pressure).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.measure).toHaveBeenCalledTimes(1)
    t.watch.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.pressure).toHaveBeenCalledTimes(1)
    expect(t.measure).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tells the windows only when the ring shows something else', async () => {
    const t = setup({ memoryMb: 4000, level: 1 })
    t.watch.prime()
    t.state.memoryMb = 4030
    t.watch.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.gauges).toHaveLength(1)
    t.state.level = 2
    t.watch.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.gauges).toHaveLength(2)
    expect(t.gauges[1]).toMatchObject({ pressure: true, warn: true })
  })
})

describe('the refresh of the panels', () => {
  it('starts with the first panel, measures every 2 s, and stops with the last one, whatever their window', async () => {
    const t = setup()
    await knownPressure(t)
    const first = viewer()
    const second = viewer()
    t.watch.open(101, first)
    expect(first.shown).toHaveLength(1)
    expect(t.watch.running()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    // A panel of another window: the same refresh, shown the last figures at once without a new measure.
    t.watch.open(202, second)
    expect(vi.getTimerCount()).toBe(1)
    expect(second.shown).toHaveLength(1)
    expect(t.measure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS)
    expect(t.measure).toHaveBeenCalledTimes(2)
    expect(first.shown).toHaveLength(2)
    expect(second.shown).toHaveLength(2)
    t.watch.close(101)
    expect(t.watch.running()).toBe(true)
    await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS)
    expect(first.shown).toHaveLength(2)
    expect(second.shown).toHaveLength(3)
    t.watch.close(202)
    expect(t.watch.running()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * RESOURCE_REFRESH_MS)
    expect(t.measure).toHaveBeenCalledTimes(3)
  })

  it('reads the pressure when a first panel opens, never at each refresh', async () => {
    const t = setup()
    t.watch.open(1, viewer())
    await vi.advanceTimersByTimeAsync(5 * RESOURCE_REFRESH_MS)
    expect(t.pressure).toHaveBeenCalledTimes(1)
    t.watch.open(2, viewer())
    expect(t.pressure).toHaveBeenCalledTimes(1)
  })

  it('draws at once a pressure that changed since the last sweep', async () => {
    const t = setup({ level: 1 })
    await knownPressure(t)
    t.state.level = 4
    const panel = viewer()
    t.watch.open(1, panel)
    expect(panel.shown.map((g) => g.pressure)).toEqual([false])
    await vi.advanceTimersByTimeAsync(0)
    expect(panel.shown.map((g) => g.pressure)).toEqual([false, true])
  })

  it('forgets a panel whose window is gone, and stops when it was the last', async () => {
    const t = setup()
    const panel = viewer()
    t.watch.open(1, panel)
    panel.leave()
    await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS)
    expect(t.watch.openCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes a panel that cannot be drawn, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const t = setup()
    t.watch.open(1, { show: () => { throw new Error('gone') } })
    expect(t.watch.openCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be drawn'), 'gone')
  })

  it('keeps the panels open through a measure that fails, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const t = setup()
    await knownPressure(t)
    const panel = viewer()
    t.watch.open(1, panel)
    t.state.failMeasure = true
    await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS)
    expect(panel.shown).toHaveLength(1)
    expect(t.watch.openCount()).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be measured'), 'no metrics')
  })

  it('draws the panels again from the last measure after an action, without measuring', () => {
    const t = setup()
    const panel = viewer()
    t.watch.open(1, panel)
    t.watch.refresh()
    expect(panel.shown).toHaveLength(2)
    expect(t.measure).toHaveBeenCalledTimes(1)
  })

  it('opens nothing and lets the open panels go while the application is locked', async () => {
    const t = setup({ paused: true })
    t.watch.open(1, viewer())
    expect(vi.getTimerCount()).toBe(0)
    expect(t.measure).not.toHaveBeenCalled()
    t.state.paused = false
    await knownPressure(t)
    const panel = viewer()
    t.watch.open(2, panel)
    t.state.paused = true
    await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS)
    expect(t.watch.openCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(panel.shown).toHaveLength(1)
  })

  it('stops everything when the function is switched off', async () => {
    const t = setup()
    t.watch.prime()
    t.watch.open(1, viewer())
    t.watch.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(t.watch.gauge()).toBeNull()
    t.watch.open(2, viewer())
    t.watch.sweep()
    await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(t.measure).toHaveBeenCalledTimes(2)
    expect(t.watch.gauge()).toBeNull()
  })

  it('keeps the last level when the pressure cannot be read, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const t = setup({ level: 2 })
    t.watch.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.watch.gauge()?.pressure).toBe(true)
    t.pressure.mockImplementationOnce(() => Promise.reject(new Error('busy')))
    t.watch.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.watch.gauge()?.pressure).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pressure could not be read'), 'busy')
  })
})
