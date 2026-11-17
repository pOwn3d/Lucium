import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type DownloadInfo, type Settings, type SidebarState } from '@shared/model'
import type { DownloadResumeOptions } from '../engine/types'
import { FeatureGates, runningGates, type GateStore } from './feature-gate'
import { gateDownloadResume, type ResumeEngine } from './download-resume-gate'

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
    set(next: Partial<Settings>) {
      state = { ...state, settings: { ...state.settings, ...next } } as SidebarState
      for (const listener of [...listeners]) listener(state)
    }
  }
}

const row: DownloadInfo = { id: 'rs-000000000001', filename: 'a.zip', url: 'https://x.test/a.zip', path: '/d/a.zip', state: 'interrupted', receivedBytes: 1, totalBytes: 2, startedAt: 0, resumable: true, recorded: true }

function setup(patch: Partial<Settings>, say?: (options: DownloadResumeOptions) => void) {
  const fake = fakeStore(patch)
  const calls: string[] = []
  const toasts: string[] = []
  const engine: ResumeEngine = {
    startDownloadResume: (options) => (calls.push('start'), say?.(options), [row]),
    stopDownloadResume: (purge) => void calls.push(`stop:${purge}`)
  }
  const adopted: DownloadInfo[][] = []
  const gates = new FeatureGates(fake.store)
  gateDownloadResume(gates, { engine, store: fake.store, options: { profileLive: () => true, notify: (message) => void toasts.push(message) }, adopt: (rows) => void adopted.push([...rows]), drop: () => void calls.push('drop') })
  return { ...fake, calls, adopted, toasts, gates }
}

const made: FeatureGates[] = []
afterEach(() => {
  for (const gates of made.splice(0)) gates.disposeAll()
})

describe('the gate of the resumption of downloads', () => {
  it('runs nothing, reads nothing and owns nothing while the setting is off', () => {
    const t = setup({ downloadResume: false })
    made.push(t.gates)
    expect(t.calls).toEqual([])
    expect(t.adopted).toEqual([])
    expect(t.gates.running()).toEqual([])
    expect(runningGates()).not.toContain('download-resume')
  })

  it('starts the engine when the setting is on at launch, and lists the rows it gives back', () => {
    const t = setup({ downloadResume: true })
    made.push(t.gates)
    expect(t.calls).toEqual(['start'])
    expect(t.adopted).toEqual([[row]])
    expect(runningGates()).toContain('download-resume')
  })

  it('starts when the setting goes on, and purges when it goes off', () => {
    const t = setup({ downloadResume: false })
    made.push(t.gates)
    t.set({ downloadResume: true })
    expect(t.calls).toEqual(['start'])
    t.set({ downloadResume: false })
    expect(t.calls).toEqual(['start', 'stop:true', 'drop'])
    expect(runningGates()).not.toContain('download-resume')
  })

  it('keeps the records when the window closes with the setting still on', () => {
    const t = setup({ downloadResume: true })
    t.gates.disposeAll()
    expect(t.calls).toEqual(['start', 'stop:false', 'drop'])
  })

  it('does not start twice for a change of something else', () => {
    const t = setup({ downloadResume: true })
    made.push(t.gates)
    t.set({ sidebarWidth: 300 })
    t.set({ downloadPause: true })
    expect(t.calls).toEqual(['start'])
  })
})

describe('the notices of the gate', () => {
  it('holds back a notice made while the application starts, and gives later ones at once', () => {
    vi.useFakeTimers()
    try {
      let later: (message: string) => void = () => undefined
      const t = setup({ downloadResume: true }, (options) => {
        options.notify('au démarrage')
        later = options.notify
      })
      made.push(t.gates)
      expect(t.toasts).toEqual([])
      vi.advanceTimersByTime(2000)
      expect(t.toasts).toEqual(['au démarrage'])
      later('plus tard')
      expect(t.toasts).toEqual(['au démarrage', 'plus tard'])
    } finally {
      vi.useRealTimers()
    }
  })
})
