import { describe, expect, it } from 'vitest'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { FeatureGates } from './feature-gate'
import { gateWebHardware } from './hardware-gate'

let n = 0
const ctx = () => ({ now: Date.now(), newId: () => `id${++n}` })

function liveStore(settings: Partial<Settings> = {}) {
  let state: SidebarState = createInitialState(ctx())
  state = { ...state, settings: { ...state.settings, ...settings } }
  const listeners = new Set<(state: SidebarState) => void>()
  return {
    get: () => state,
    subscribe: (listener: (state: SidebarState) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    set(patch: Partial<Settings>) {
      state = reduce(state, { type: 'settings/update', patch }, ctx())
      for (const listener of [...listeners]) listener(state)
    }
  }
}

function setup(settings: Partial<Settings>, holders = 0) {
  const store = liveStore(settings)
  const calls: boolean[] = []
  const toasts: string[] = []
  const gates = new FeatureGates(store)
  gateWebHardware(gates, { setWebHardware: (enabled) => (calls.push(enabled), enabled ? 0 : holders) }, () => store.get().settings, (message) => void toasts.push(message))
  return { store, calls, toasts, gates }
}

describe('the web hardware APIs, through their gate', () => {
  it('is off by default: the engine is never told to install anything', () => {
    const t = setup({})
    expect(t.calls).toEqual([])
    expect(t.gates.running()).toEqual([])
    t.gates.disposeAll()
    expect(t.calls).toEqual([])
  })

  it('switches the engine on with the setting and off again with it, and says that open connections stay when grants were taken back', () => {
    const t = setup({}, 2)
    t.store.set({ webHardware: true })
    expect(t.calls).toEqual([true])
    expect(t.gates.running()).toEqual(['web-hardware'])
    t.store.set({ webHardware: false })
    expect(t.calls).toEqual([true, false])
    expect(t.toasts).toHaveLength(1)
    expect(t.toasts[0]).toContain('reste active jusqu’au rechargement')
    expect(t.gates.running()).toEqual([])
  })

  it('says nothing when no tab held a grant', () => {
    const t = setup({ webHardware: true }, 0)
    t.store.set({ webHardware: false })
    expect(t.calls).toEqual([true, false])
    expect(t.toasts).toEqual([])
  })

  it('switches the engine off at the end without a notice, the setting being still on', () => {
    const t = setup({ webHardware: true }, 3)
    t.gates.disposeAll()
    expect(t.calls).toEqual([true, false])
    expect(t.toasts).toEqual([])
  })
})
