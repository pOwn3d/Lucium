import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVER_POLL_MS } from '@shared/battery-saver'
import { BatterySaver, type PowerSource } from './battery-saver'

function fakePower(initial: { onBattery: boolean; percent: number | null }) {
  const state = { ...initial }
  const listeners = new Set<() => void>()
  let reads = 0
  const source: PowerSource = {
    onBattery: () => state.onBattery,
    percent: async () => {
      reads++
      return state.percent
    },
    watch: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    source,
    reads: () => reads,
    listeners: () => listeners.size,
    set: (next: Partial<typeof state>) => {
      Object.assign(state, next)
    },
    /** The computer goes onto battery or back onto mains power. */
    plug: (onBattery: boolean) => {
      state.onBattery = onBattery
      for (const listener of [...listeners]) listener()
    }
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('the battery saver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing while the setting is off: no listener on the power events, no timer, no process, never on', async () => {
    const power = fakePower({ onBattery: true, percent: 3 })
    const saver = new BatterySaver(power.source)
    saver.configure(false)
    saver.setAsked(true)
    await vi.advanceTimersByTimeAsync(SAVER_POLL_MS * 5)
    expect(power.listeners()).toBe(0)
    expect(power.reads()).toBe(0)
    expect(saver.polling()).toBe(false)
    expect(saver.watching()).toBe(false)
    expect(saver.active()).toBe(false)
    expect(saver.askedByHand()).toBe(false)
  })

  it('does not read the charge, nor arm a timer, on mains power', async () => {
    const power = fakePower({ onBattery: false, percent: 90 })
    const saver = new BatterySaver(power.source)
    saver.configure(true)
    await settle()
    expect(power.listeners()).toBe(1)
    expect(power.reads()).toBe(0)
    expect(saver.polling()).toBe(false)
    expect(saver.active()).toBe(false)
  })

  it('comes on by itself when the charge is low on battery, and goes off when the computer is plugged in', async () => {
    const power = fakePower({ onBattery: true, percent: 15 })
    const saver = new BatterySaver(power.source)
    const changes: boolean[] = []
    saver.subscribe(() => changes.push(saver.active()))
    saver.configure(true)
    await settle()
    expect(saver.active()).toBe(true)
    expect(saver.polling()).toBe(true)
    power.plug(false)
    expect(saver.active()).toBe(false)
    expect(saver.polling()).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('follows the charge while on battery: it reads every two minutes, and comes on when the charge falls', async () => {
    const power = fakePower({ onBattery: true, percent: 60 })
    const saver = new BatterySaver(power.source)
    saver.configure(true)
    await settle()
    expect(saver.active()).toBe(false)
    power.set({ percent: 19 })
    await vi.advanceTimersByTimeAsync(SAVER_POLL_MS)
    expect(saver.active()).toBe(true)
    expect(power.reads()).toBe(2)
  })

  it('comes on at once when asked, and the request lasts only while the setting is on', async () => {
    const power = fakePower({ onBattery: false, percent: 100 })
    const saver = new BatterySaver(power.source)
    saver.configure(true)
    saver.setAsked(true)
    expect(saver.active()).toBe(true)
    expect(saver.askedByHand()).toBe(true)
    saver.configure(false)
    expect(saver.active()).toBe(false)
    expect(saver.askedByHand()).toBe(false)
    saver.configure(true)
    expect(saver.active()).toBe(false)
  })

  it('tells its listeners when only the request changed (the menu entry is checked), and not when nothing did', async () => {
    const power = fakePower({ onBattery: true, percent: 10 })
    const saver = new BatterySaver(power.source)
    saver.configure(true)
    await settle()
    let calls = 0
    saver.subscribe(() => calls++)
    saver.setAsked(true)
    expect(calls).toBe(1)
    saver.setAsked(true)
    expect(calls).toBe(1)
    saver.setAsked(false)
    expect(calls).toBe(2)
    expect(saver.active()).toBe(true)
  })

  it('lets go of everything when the setting goes off, and ignores a reading that comes back after', async () => {
    const power = fakePower({ onBattery: true, percent: 10 })
    let release: ((value: number | null) => void) | undefined
    power.source.percent = () => new Promise((resolve) => (release = resolve))
    const saver = new BatterySaver(power.source)
    saver.configure(true)
    saver.configure(false)
    expect(power.listeners()).toBe(0)
    expect(saver.polling()).toBe(false)
    release!(5)
    await settle()
    expect(saver.active()).toBe(false)
  })

  it('does not come on by itself when the charge cannot be read', async () => {
    const saver = new BatterySaver(fakePower({ onBattery: true, percent: null }).source)
    saver.configure(true)
    await settle()
    expect(saver.active()).toBe(false)
  })

  it('reads another power source from now on, and puts the first back: a low battery of the real one does not count meanwhile', async () => {
    const real = fakePower({ onBattery: true, percent: 5 })
    const stand = fakePower({ onBattery: false, percent: 100 })
    const saver = new BatterySaver(real.source)
    saver.configure(true)
    await settle()
    expect(saver.active()).toBe(true)
    const restore = saver.useSource(stand.source)
    await settle()
    expect(saver.active()).toBe(false)
    expect(real.listeners()).toBe(0)
    expect(stand.listeners()).toBe(1)
    expect(saver.polling()).toBe(false)
    restore()
    await settle()
    expect(saver.active()).toBe(true)
    expect(stand.listeners()).toBe(0)
    expect(real.listeners()).toBe(1)
  })

  it('ignores a reading of the source it left, and listens to nothing if the setting is off', async () => {
    const real = fakePower({ onBattery: true, percent: 5 })
    let release: ((value: number | null) => void) | undefined
    real.source.percent = () => new Promise((resolve) => (release = resolve))
    // On battery too, so that only the generation tells the old reading from the new source's.
    const stand = fakePower({ onBattery: true, percent: 100 })
    const saver = new BatterySaver(real.source)
    saver.configure(true)
    saver.useSource(stand.source)
    release!(5)
    await settle()
    expect(saver.active()).toBe(false)
    const idle = new BatterySaver(real.source)
    idle.useSource(stand.source)
    expect(stand.listeners()).toBe(1)
    expect(idle.watching()).toBe(false)
  })
})
