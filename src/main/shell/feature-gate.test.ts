import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings, type SidebarState } from '@shared/model'
import { FeatureGates, runningGates, type GateStore } from './feature-gate'

/** A store of its own: settings only, with the same subscribe contract as the real one (every change calls every listener). */
function fakeStore(patch: Partial<Settings> = {}) {
  let state = { settings: { ...defaultSettings(), ...patch } } as unknown as SidebarState
  const listeners = new Set<(state: SidebarState) => void>()
  const store: GateStore = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    store,
    listeners: () => listeners.size,
    set(next: Partial<Settings>) {
      state = { ...state, settings: { ...state.settings, ...next } } as SidebarState
      for (const listener of [...listeners]) listener(state)
    },
    /** A change of something else than the settings: tabs come and go all the time. */
    touch() {
      state = { ...state } as SidebarState
      for (const listener of [...listeners]) listener(state)
    }
  }
}

/** A feature that counts what it does, to see that it is started and stopped once each time and nothing is left behind. */
function counting() {
  const log = { starts: 0, stops: 0 }
  return {
    log,
    feature: {
      start() {
        log.starts++
        return () => {
          log.stops++
        }
      }
    }
  }
}

/** Every gates object a test makes is disposed after it: `runningGates()` counts across the whole run. */
const made: FeatureGates[] = []
const make = (store: GateStore, report?: (message: string, error: unknown) => void): FeatureGates => {
  const gates = new FeatureGates(store, report)
  made.push(gates)
  return gates
}
afterEach(() => {
  for (const gates of made.splice(0)) gates.disposeAll()
})

describe('FeatureGates', () => {
  it('starts a feature that is on when it is gated, and does not start one that is off', () => {
    const on = fakeStore({ resolveFavicons: true })
    const a = counting()
    make(on.store).gate('favicons', a.feature)
    expect(a.log).toEqual({ starts: 1, stops: 0 })

    const off = fakeStore({ resolveFavicons: false })
    const b = counting()
    const gate = make(off.store).gate('favicons', b.feature)
    expect(b.log).toEqual({ starts: 0, stops: 0 })
    expect(gate.running()).toBe(false)
  })

  it('stops the feature when its setting goes off and starts it again when it comes back', () => {
    const s = fakeStore({ autoBackup: true })
    const { log, feature } = counting()
    const gate = make(s.store).gate('auto-backup', feature)
    s.set({ autoBackup: false })
    expect(log).toEqual({ starts: 1, stops: 1 })
    expect(gate.running()).toBe(false)
    s.set({ autoBackup: true })
    expect(log).toEqual({ starts: 2, stops: 1 })
    expect(gate.running()).toBe(true)
  })

  it('follows a delay setting: 0 is off, anything above is on', () => {
    const s = fakeStore({ sleepAfterMinutes: 0 })
    const { log, feature } = counting()
    make(s.store).gate('sleep', feature)
    expect(log.starts).toBe(0)
    s.set({ sleepAfterMinutes: 15 })
    expect(log).toEqual({ starts: 1, stops: 0 })
    // A change of the delay is not a change of the feature: the feature follows the delay itself.
    s.set({ sleepAfterMinutes: 60 })
    expect(log).toEqual({ starts: 1, stops: 0 })
    s.set({ sleepAfterMinutes: 0 })
    expect(log).toEqual({ starts: 1, stops: 1 })
  })

  it('is idempotent: changes of the state that leave the setting alone start and stop nothing', () => {
    const s = fakeStore({ resolveFavicons: true })
    const { log, feature } = counting()
    const gate = make(s.store).gate('favicons', feature)
    for (let i = 0; i < 20; i++) s.touch()
    for (let i = 0; i < 5; i++) gate.sync()
    s.set({ resolveFavicons: true })
    expect(log).toEqual({ starts: 1, stops: 0 })
    s.set({ resolveFavicons: false })
    s.set({ resolveFavicons: false })
    s.touch()
    expect(log).toEqual({ starts: 1, stops: 1 })
  })

  it('accepts a start that returns nothing', () => {
    const s = fakeStore({ resolveFavicons: true })
    const start = vi.fn()
    const gate = make(s.store).gate('favicons', { start })
    expect(gate.running()).toBe(true)
    s.set({ resolveFavicons: false })
    expect(gate.running()).toBe(false)
  })

  describe('a start that fails', () => {
    it('is logged with the name of the feature, leaves it off, and is not retried at every change of the state', () => {
      const s = fakeStore({ resolveFavicons: true })
      const report = vi.fn()
      let attempts = 0
      const gate = make(s.store, report).gate('favicons', {
        start() {
          attempts++
          throw new Error('no session')
        }
      })
      expect(report).toHaveBeenCalledTimes(1)
      const [message, error] = report.mock.calls[0] as [string, Error]
      expect(message).toContain('favicons')
      expect(message).toContain('Chercher l’icône des sites sans icône')
      expect(error.message).toBe('no session')
      expect(gate.running()).toBe(false)
      expect(runningGates()).not.toContain('favicons')
      for (let i = 0; i < 10; i++) s.touch()
      expect(attempts).toBe(1)
      expect(report).toHaveBeenCalledTimes(1)
    })

    it('is tried again when the setting is switched off and on', () => {
      const s = fakeStore({ resolveFavicons: true })
      let fail = true
      const report = vi.fn()
      const gate = make(s.store, report).gate('favicons', {
        start() {
          if (fail) throw new Error('first time')
        }
      })
      expect(gate.running()).toBe(false)
      fail = false
      s.set({ resolveFavicons: false })
      s.set({ resolveFavicons: true })
      expect(gate.running()).toBe(true)
      expect(report).toHaveBeenCalledTimes(1)
    })
  })

  describe('a stop that fails', () => {
    it('is logged with the name of the feature and the feature counts as stopped', () => {
      const s = fakeStore({ autoUpdate: true })
      const report = vi.fn()
      let starts = 0
      const gate = make(s.store, report).gate('auto-update', {
        start() {
          starts++
          return () => {
            throw new Error('timer already gone')
          }
        }
      })
      s.set({ autoUpdate: false })
      expect(report).toHaveBeenCalledTimes(1)
      expect((report.mock.calls[0] as [string, Error])[0]).toContain('auto-update')
      expect((report.mock.calls[0] as [string, Error])[1].message).toBe('timer already gone')
      expect(gate.running()).toBe(false)
      expect(runningGates()).not.toContain('auto-update')
      s.set({ autoUpdate: true })
      expect(starts).toBe(2)
    })
  })

  describe('dispose', () => {
    it('stops the feature, stops listening to the store, and does nothing the second time', () => {
      const s = fakeStore({ resolveFavicons: true })
      const { log, feature } = counting()
      const gate = make(s.store).gate('favicons', feature)
      expect(s.listeners()).toBe(1)
      gate.dispose()
      gate.dispose()
      expect(log).toEqual({ starts: 1, stops: 1 })
      expect(s.listeners()).toBe(0)
      s.set({ resolveFavicons: false })
      s.set({ resolveFavicons: true })
      expect(log).toEqual({ starts: 1, stops: 1 })
    })

    it('leaves nothing subscribed for a feature that never started', () => {
      const s = fakeStore({ resolveFavicons: false })
      const gates = make(s.store)
      gates.gate('favicons', counting().feature)
      gates.disposeAll()
      expect(s.listeners()).toBe(0)
    })

    it('stops every feature of the gates at once (the exit of the application)', () => {
      const s = fakeStore({ resolveFavicons: true, autoBackup: true, autoUpdate: false })
      const gates = make(s.store)
      const a = counting()
      const b = counting()
      const c = counting()
      gates.gate('favicons', a.feature)
      gates.gate('auto-backup', b.feature)
      gates.gate('auto-update', c.feature)
      expect(gates.running().sort()).toEqual(['auto-backup', 'favicons'])
      gates.disposeAll()
      expect(gates.running()).toEqual([])
      expect([a.log.stops, b.log.stops, c.log.stops]).toEqual([1, 1, 0])
      expect(s.listeners()).toBe(0)
    })

    it('still stops the others when one stop fails', () => {
      const s = fakeStore({ resolveFavicons: true, autoBackup: true })
      const report = vi.fn()
      const gates = make(s.store, report)
      gates.gate('favicons', {
        start: () => () => {
          throw new Error('boom')
        }
      })
      const b = counting()
      gates.gate('auto-backup', b.feature)
      gates.disposeAll()
      expect(b.log.stops).toBe(1)
      expect(report).toHaveBeenCalledTimes(1)
    })
  })

  describe('a start or a stop that changes the state', () => {
    it('starts once when the start itself touches the state', () => {
      const s = fakeStore({ resolveFavicons: true })
      let starts = 0
      make(s.store).gate('favicons', {
        start() {
          starts++
          s.touch()
        }
      })
      expect(starts).toBe(1)
    })

    it('ends up stopped when the setting went off while the feature was starting', () => {
      const s = fakeStore({ resolveFavicons: true })
      const { log } = counting()
      const gate = make(s.store).gate('favicons', {
        start() {
          log.starts++
          s.set({ resolveFavicons: false })
          return () => {
            log.stops++
          }
        }
      })
      expect(log).toEqual({ starts: 1, stops: 1 })
      expect(gate.running()).toBe(false)
    })
  })

  describe('registration', () => {
    it('refuses a second gate for the same feature on the same store, which would start it twice', () => {
      const gates = make(fakeStore().store)
      gates.gate('favicons', counting().feature)
      expect(() => gates.gate('favicons', counting().feature)).toThrow(/already gated/)
    })

    it('refuses a feature that is not in the registry', () => {
      const gates = make(fakeStore().store)
      expect(() => gates.gate('nothing-like-this' as never, counting().feature)).toThrow(/Unknown feature/)
    })

    it('lets two stores (two windows) gate the same feature', () => {
      const one = fakeStore({ sleepAfterMinutes: 30 })
      const two = fakeStore({ sleepAfterMinutes: 30 })
      const a = counting()
      const b = counting()
      const gates = [make(one.store), make(two.store)]
      gates[0]!.gate('sleep', a.feature)
      gates[1]!.gate('sleep', b.feature)
      one.set({ sleepAfterMinutes: 0 })
      expect([a.log.stops, b.log.stops]).toEqual([1, 0])
      for (const g of gates) g.disposeAll()
    })

    it('counts the running gates across stores, and counts none once they are all stopped', () => {
      const before = runningGates().length
      const s = fakeStore({ resolveFavicons: true })
      const gates = make(s.store)
      gates.gate('favicons', counting().feature)
      expect(runningGates()).toContain('favicons')
      s.set({ resolveFavicons: false })
      expect(runningGates().length).toBe(before)
      gates.disposeAll()
    })
  })
})
