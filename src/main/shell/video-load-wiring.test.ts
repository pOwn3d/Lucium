// How the window wires the guard of the video behind a space (Browser.startVideoLoadGate, shell/video-load-guard.ts): the gate is the main window's, what it
// reads is the pages of the whole group, what it says goes to every window through the snapshot, and a notice says it once for each pause. Run on stand-ins of
// the windows (browser-fake.test-support.ts), over a meter and a pressure reader the test drives.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { setLanguage, t } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { LOAD_PAUSE_READINGS } from '@shared/video-load-pause'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const meter = { cpu: 10 }
const pressure = { level: 'normal' as 'normal' | 'warning' | 'critical' }
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ status: () => 'off', subscribe: () => () => {} }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
vi.mock('./process-meter', () => ({ processMeter: () => () => [{ pid: 1, type: 'Browser', cpu: meter.cpu, memoryKb: 1 }] }))
vi.mock('./sleep-pressure', () => ({ memoryPressure: () => Promise.resolve(pressure.level) }))
vi.mock('../lock-service', () => ({ getLockService: () => null }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => {
  setLanguage('fr')
  meter.cpu = 10
  pressure.level = 'normal'
  vi.restoreAllMocks()
})

/** A window of a group of two whose pages may hold the camera: `capturing` says which tab. */
function aGroup(capturing: { current: string | null }) {
  const pageOf = (id: string) => ({ usesCapture: () => capturing.current === id })
  const win = (id: string) => ({ pages: new Map([[id, pageOf(id)]]), win: { isDestroyed: () => false } })
  const main = fakeBrowser({ ...win('a'), publish: vi.fn(), showToast: vi.fn(), videoPause: null })
  const other = fakeBrowser({ ...win('b'), publish: vi.fn(), showToast: vi.fn() })
  const group = new Set([main.self, other.self])
  for (const w of [main, other]) Object.assign(w.self, { group, leader: main.self })
  return { main, other }
}

/** The gate the main window made, started as the settings would. */
function started(window: ReturnType<typeof fakeBrowser>) {
  const gates = new Map<string, { start(): unknown }>()
  Object.assign(window.self, { gates: { gate: (id: string, gate: { start(): unknown }) => void gates.set(id, gate) } })
  shell['startVideoLoadGate']!.call(window.self)
  return gates.get('video-load-pause')!
}

describe('the gate', () => {
  it('is made by the main window only, in the gates of its function', () => {
    const made = (kind: 'main' | 'private' | 'secondary') => {
      const gates = new Map<string, unknown>()
      const fake = fakeBrowser({
        isPrivate: () => kind === 'private',
        isSecondary: () => kind === 'secondary',
        gates: { gate: (id: string, gate: unknown) => void gates.set(id, gate) },
        store: { get: () => ({ settings: defaultSettings() }), subscribe: () => () => {} },
        group: new Set(),
        resourceWatch: null,
        startVideoLoadGate: shell['startVideoLoadGate'],
        sleepSweep: async () => undefined
      })
      shell['start']!.call(fake.self)
      return [...gates.keys()]
    }
    expect(made('main')).toContain('video-load-pause')
    expect(made('private')).not.toContain('video-load-pause')
    expect(made('secondary')).not.toContain('video-load-pause')
  })
})

describe('what it does', () => {
  it('holds the video when a page of ANY window of the group holds the camera, says so once, and lets it go when the call ends', async () => {
    vi.useFakeTimers()
    try {
      const capturing = { current: null as string | null }
      const { main, other } = aGroup(capturing)
      const gate = started(main)
      const stop = gate.start() as () => void
      await vi.advanceTimersByTimeAsync(0)
      expect(main.self['videoPause']).toBeNull()
      // The call is in the second window: the group's video stops, and the main window says so.
      capturing.current = 'b'
      await vi.advanceTimersByTimeAsync(15_000)
      expect(main.self['videoPause']).toBe('capture')
      expect(main.self['showToast']).toHaveBeenCalledTimes(1)
      expect(main.self['showToast']).toHaveBeenCalledWith(t('video-load-pause.appel'))
      expect(main.self['publish']).toHaveBeenCalledTimes(1)
      // Still on the call: no second notice.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(main.self['showToast']).toHaveBeenCalledTimes(1)
      // The call ends: it plays again, silently, and the windows are told.
      capturing.current = null
      await vi.advanceTimersByTimeAsync(15_000)
      expect(main.self['videoPause']).toBeNull()
      expect(main.self['showToast']).toHaveBeenCalledTimes(1)
      expect(main.self['publish']).toHaveBeenCalledTimes(2)
      void other
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds it under a load that lasts, with its own notice', async () => {
    vi.useFakeTimers()
    try {
      const { main } = aGroup({ current: null })
      const stop = started(main).start() as () => void
      meter.cpu = 300
      // The first reading starts the meter; then the readings in a row.
      await vi.advanceTimersByTimeAsync(15_000 * (LOAD_PAUSE_READINGS - 1))
      expect(main.self['videoPause']).toBeNull()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(main.self['videoPause']).toBe('load')
      expect(main.self['showToast']).toHaveBeenCalledWith(t('video-load-pause.charge'))
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the guard is dropped while it holds, but the windows are told and the video plays again', async () => {
    vi.useFakeTimers()
    try {
      const { main } = aGroup({ current: 'a' })
      const stop = started(main).start() as () => void
      await vi.advanceTimersByTimeAsync(0)
      expect(main.self['videoPause']).toBe('capture')
      ;(main.self['showToast'] as ReturnType<typeof vi.fn>).mockClear()
      stop()
      expect(main.self['videoPause']).toBeNull()
      expect(main.self['showToast']).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what the snapshot says', () => {
  const snapshotOf = (leader: Record<string, unknown>) => shell['videoPauseOfSnapshot']!.call(fakeBrowser({ leader }).self)

  it('is the reason the video is held, from the main window, and nothing while it plays', () => {
    expect(snapshotOf({ videoPause: 'capture' })).toEqual({ videoLoadPause: 'capture' })
    expect(snapshotOf({ videoPause: 'load' })).toEqual({ videoLoadPause: 'load' })
    expect(snapshotOf({ videoPause: null })).toEqual({})
  })

  it('is in the snapshot of the window', () => {
    const state = createInitialState({ now: 0, newId: () => 'x' })
    const fake = fakeBrowser({ store: { get: () => state }, mediaPlayers: [], peek: null, sidePanel: null, webPanel: null, toast: null, floatVisible: false, overlayRequest: null, find: null, leader: { videoPause: 'load' } })
    fake.self['videoPauseOfSnapshot'] = () => shell['videoPauseOfSnapshot']!.call(fake.self)
    expect(shell['snapshot']!.call(fake.self)).toMatchObject({ videoLoadPause: 'load' })
  })
})
