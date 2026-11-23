import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import { BackupFiles } from '../backup-store'

// The auto-updater imports Electron for its real network and dialogs only: a test gives its own.
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0', isPackaged: false }, autoUpdater: {}, BrowserWindow: {}, dialog: {}, net: {}, shell: {} }))

const { SessionBackups, gateBackups } = await import('./backups')
const { AutoUpdater, gateAutoUpdate } = await import('./auto-update')
const { SessionWriter, gateWindowMemory } = await import('./session')
const { FeatureGates } = await import('./feature-gate')
const { gateAutoArchive, ARCHIVE_SWEEP_MS } = await import('./auto-archive')
const { AutoReloader } = await import('./auto-reload')
const { LittleShortcut, gateLittleShortcut } = await import('./little-shortcut')
const { gateThumbnails } = await import('./thumbnails')
const { backgroundFeed } = await import('./update-source')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
let n = 0
const ctx = () => ({ now: Date.now(), newId: () => `id${++n}` })

/** A store over the real reducer, as the gates and the services under test see one. */
function liveStore(settings: Partial<Settings> = {}) {
  let state: SidebarState = createInitialState(ctx())
  state = { ...state, settings: { ...state.settings, ...settings } }
  const listeners = new Set<(state: SidebarState) => void>()
  return {
    get: () => state,
    subscribe: (listener: (state: SidebarState) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    listeners: () => listeners.size,
    set(patch: Partial<Settings>) {
      state = reduce(state, { type: 'settings/update', patch }, ctx())
      for (const listener of [...listeners]) listener(state)
    },
    open(url: string) {
      state = reduce(state, { type: 'tab/open', url, background: true }, ctx())
      for (const listener of [...listeners]) listener(state)
    }
  }
}

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-wiring-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 24, 10, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the automatic copies, through their gate', () => {
  function setup(settings: Partial<Settings>) {
    const store = liveStore(settings)
    const files = new BackupFiles(join(tmp(), 'copies'))
    const backups = new SessionBackups({ files, state: store.get, subscribe: (l) => store.subscribe(() => l()), apply: () => undefined, toast: () => undefined })
    const gates = new FeatureGates(store)
    gateBackups(gates, backups)
    return { store, files, backups, gates }
  }

  it('owns no timer and no subscription while the copies are off', () => {
    const t = setup({ autoBackup: false })
    t.store.open('https://a.example/')
    // The gate's own subscription is all there is.
    expect(t.store.listeners()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(48 * HOUR)
    expect(t.files.ids()).toEqual([])
    t.gates.disposeAll()
  })

  it('runs a timer and a subscription of its own while the copies are on, and makes a copy after the delay', () => {
    const t = setup({ autoBackup: true })
    t.store.open('https://a.example/')
    expect(t.store.listeners()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    // A copy is not made at launch: it waits for the delay (30 minutes).
    expect(t.files.ids()).toEqual([])
    vi.advanceTimersByTime(30 * MINUTE)
    expect(t.files.ids()).toHaveLength(1)
    t.gates.disposeAll()
  })

  it('frees the timer and the subscription when the copies are switched off, and takes them back when switched on', () => {
    const t = setup({ autoBackup: true })
    t.store.open('https://a.example/')
    t.store.set({ autoBackup: false })
    expect(t.store.listeners()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(48 * HOUR)
    expect(t.files.ids()).toEqual([])
    t.store.set({ autoBackup: true })
    expect(t.store.listeners()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    t.gates.disposeAll()
    expect(t.store.listeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes the first copy at once when the copies are switched on during the session, as before the gates', () => {
    const t = setup({ autoBackup: false })
    t.store.open('https://a.example/')
    expect(t.files.ids()).toEqual([])
    t.store.set({ autoBackup: true })
    expect(t.files.ids()).toHaveLength(1)
    // Off and on again: the same.
    t.store.set({ autoBackup: false })
    t.store.open('https://b.example/')
    t.store.set({ autoBackup: true })
    expect(t.files.ids()).toHaveLength(2)
    t.gates.disposeAll()
  })
})

describe('the automatic update look, through its gate', () => {
  function setup(settings: Partial<Settings>) {
    const store = liveStore(settings)
    const fetchFeed = vi.fn(async () => ({ ok: false as const, reason: 'test feed' }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const updater = new AutoUpdater({
      settings: () => store.get().settings,
      version: '1.0.0',
      // The system of this test is macOS, whatever runs it: the switch read is `autoUpdate`, not the CI runner's.
      platform: 'darwin',
      feed: (settings) => (settings.autoUpdate ? 'https://feed.example/latest' : null),
      fetchFeed,
      notify: () => true,
      remember: () => undefined
    })
    const gates = new FeatureGates(store)
    gateAutoUpdate(gates, updater, 'darwin')
    return { store, fetchFeed, gates }
  }

  it('owns no timer and asks nothing while the setting is off', async () => {
    const t = setup({ autoUpdate: false })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(72 * HOUR)
    expect(t.fetchFeed).not.toHaveBeenCalled()
    t.gates.disposeAll()
  })

  it('looks 20 seconds after launch, then once a day, while the setting is on', async () => {
    const t = setup({ autoUpdate: true })
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(19_000)
    expect(t.fetchFeed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.fetchFeed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(t.fetchFeed).toHaveBeenCalledTimes(2)
    t.gates.disposeAll()
  })

  it('frees both timers when the setting goes off, asks nothing afterwards, and starts over when it is back on', async () => {
    const t = setup({ autoUpdate: true })
    await vi.advanceTimersByTimeAsync(21_000)
    expect(t.fetchFeed).toHaveBeenCalledTimes(1)
    t.store.set({ autoUpdate: false })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(72 * HOUR)
    expect(t.fetchFeed).toHaveBeenCalledTimes(1)
    t.store.set({ autoUpdate: true })
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(t.fetchFeed).toHaveBeenCalledTimes(2)
    t.gates.disposeAll()
    expect(vi.getTimerCount()).toBe(0)
  })
})

// The look in the background follows ONE switch per system: `autoUpdate` on macOS, `windowsAutoUpdate` on Windows and on Linux, which is off by default for everyone
// (shared/platform.ts, `autoUpdateOn`). The feed of these tests is the real `backgroundFeed` of a built application with a built-in address, so that the switch
// of the system is what decides, from the gate to the request.
describe('the automatic update look, on each system, through the gate of its own switch', () => {
  const WINDOWS_FEED = 'https://lucium.app/updates/win32-x64/feed.json'
  const LINUX_FEED = 'https://lucium.app/updates/linux-x64/feed.json'
  const feedOf = (platform: NodeJS.Platform): string => (platform === 'linux' ? 'https://lucium.app/updates/linux-x64/appimage/feed.json' : WINDOWS_FEED)
  function setup(platform: NodeJS.Platform, settings: Partial<Settings>) {
    const store = liveStore(settings)
    const fetchFeed = vi.fn(async () => ({ ok: false as const, reason: 'test feed' }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const updater = new AutoUpdater({
      settings: () => store.get().settings,
      version: '1.0.0',
      platform,
      feed: (current) =>
        backgroundFeed({ builtIn: platform === 'linux' ? LINUX_FEED : WINDOWS_FEED, builtInTest: '', channel: 'stable', builtApp: true, platform, packaging: platform === 'linux' ? 'appimage' : null, env: undefined, setting: '' }, current),
      fetchFeed,
      notify: () => true,
      remember: () => undefined
    })
    const gates = new FeatureGates(store)
    gateAutoUpdate(gates, updater, platform)
    return { store, fetchFeed, gates }
  }

  it.each(['win32', 'linux'] as const)('on %s, a profile that only has the old autoUpdate on (the 1.1.5 default) owns no timer and asks nothing: the own switch is off by default', async (platform) => {
    const t = setup(platform, {})
    expect(t.store.get().settings).toMatchObject({ autoUpdate: true, windowsAutoUpdate: false })
    expect(t.gates.running()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(72 * HOUR)
    expect(t.fetchFeed).not.toHaveBeenCalled()
    t.gates.disposeAll()
  })

  it.each(['win32', 'linux'] as const)('on %s, looks 20 seconds after launch, then once a day, while its own switch is on, whatever the old one says', async (platform) => {
    const t = setup(platform, { autoUpdate: false, windowsAutoUpdate: true })
    expect(t.gates.running()).toEqual(['auto-update-windows'])
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(19_000)
    expect(t.fetchFeed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.fetchFeed).toHaveBeenCalledTimes(1)
    expect(t.fetchFeed).toHaveBeenLastCalledWith(feedOf(platform))
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(t.fetchFeed).toHaveBeenCalledTimes(2)
    t.gates.disposeAll()
  })

  it.each(['win32', 'linux'] as const)('on %s, frees both timers when its switch goes off, and the old switch turns nothing on afterwards', async (platform) => {
    const t = setup(platform, { windowsAutoUpdate: true })
    await vi.advanceTimersByTimeAsync(21_000)
    expect(t.fetchFeed).toHaveBeenCalledTimes(1)
    t.store.set({ windowsAutoUpdate: false })
    expect(vi.getTimerCount()).toBe(0)
    t.store.set({ autoUpdate: false })
    t.store.set({ autoUpdate: true })
    expect(vi.getTimerCount()).toBe(0)
    expect(t.gates.running()).toEqual([])
    await vi.advanceTimersByTimeAsync(72 * HOUR)
    expect(t.fetchFeed).toHaveBeenCalledTimes(1)
    t.gates.disposeAll()
  })

  it('on macOS, the switch of Windows and Linux turns nothing on, and the switch it always had still does', async () => {
    const t = setup('darwin', { autoUpdate: false, windowsAutoUpdate: true })
    expect(t.gates.running()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(72 * HOUR)
    expect(t.fetchFeed).not.toHaveBeenCalled()
    t.store.set({ autoUpdate: true })
    expect(t.gates.running()).toEqual(['auto-update'])
    expect(vi.getTimerCount()).toBe(2)
    t.gates.disposeAll()
  })
})

describe('the memory of the windows, through its gate', () => {
  function setup(settings: Partial<Settings>) {
    const store = liveStore(settings)
    const path = join(tmp(), 'windows.json')
    const win = new EventEmitter()
    const app = new EventEmitter()
    const changes = new Set<() => void>()
    const windows = {
      onChange: (listener: () => void) => (changes.add(listener), () => void changes.delete(listener)),
      sessionSnapshot: () => ({ main: { x: 0, y: 0, width: 800, height: 600 }, windows: [] }),
      isQuitting: () => false
    }
    const writer = new SessionWriter(path, windows as never)
    const gates = new FeatureGates(store)
    gateWindowMemory(gates, { win: win as never, app: app as never, windows: windows as never, writer })
    const listening = () => win.listenerCount('resize') + win.listenerCount('move') + win.listenerCount('close') + app.listenerCount('before-quit') + changes.size
    return { store, path, win, app, changes, gates, listening }
  }

  it('listens to nothing and writes nothing while the setting is off', () => {
    const t = setup({ restoreWindows: false })
    expect(t.listening()).toBe(0)
    t.win.emit('resize')
    t.win.emit('move')
    t.app.emit('before-quit')
    vi.advanceTimersByTime(10_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(existsSync(t.path)).toBe(false)
    t.gates.disposeAll()
  })

  it('listens to the window, saves after a move, and does not save at launch while the setting is on', () => {
    const t = setup({ restoreWindows: true })
    expect(t.listening()).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
    t.win.emit('move')
    vi.advanceTimersByTime(600)
    expect(existsSync(t.path)).toBe(true)
    t.gates.disposeAll()
  })

  it('lets go of every listener and of a save that was waiting when the setting goes off', () => {
    const t = setup({ restoreWindows: true })
    t.win.emit('resize')
    expect(vi.getTimerCount()).toBe(1)
    t.store.set({ restoreWindows: false })
    expect(t.listening()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(existsSync(t.path)).toBe(false)
    t.gates.disposeAll()
  })

  it('saves the windows as they are as soon as the setting is switched on during the session', () => {
    const t = setup({ restoreWindows: false })
    t.store.set({ restoreWindows: true })
    expect(t.listening()).toBe(5)
    vi.advanceTimersByTime(600)
    expect(existsSync(t.path)).toBe(true)
    t.gates.disposeAll()
    expect(t.listening()).toBe(0)
  })
})

describe('the archive sweep, through its gate', () => {
  function setup(settings: Partial<Settings>) {
    const store = liveStore(settings)
    const sweep = vi.fn()
    const gates = new FeatureGates(store)
    gateAutoArchive(gates, sweep)
    return { store, sweep, gates }
  }
  const profile = (hours: number) => ({ work: { autoArchiveHours: hours } })

  it('owns no timer and sweeps nothing while archiving is "Jamais" everywhere, at launch and afterwards', () => {
    const t = setup({ autoArchiveHours: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(t.sweep).not.toHaveBeenCalled()
    vi.advanceTimersByTime(48 * HOUR)
    expect(t.sweep).not.toHaveBeenCalled()
    t.gates.disposeAll()
  })

  it('sweeps once as it starts, then every 10 minutes, while the general delay is above 0 (the default)', () => {
    const t = setup({})
    expect(vi.getTimerCount()).toBe(1)
    expect(t.sweep).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(ARCHIVE_SWEEP_MS)
    expect(t.sweep).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3 * ARCHIVE_SWEEP_MS)
    expect(t.sweep).toHaveBeenCalledTimes(5)
    t.gates.disposeAll()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps sweeping when the general delay is "Jamais" but a profile has a delay of its own', () => {
    const t = setup({ autoArchiveHours: 0, profiles: profile(6) })
    expect(vi.getTimerCount()).toBe(1)
    expect(t.sweep).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(ARCHIVE_SWEEP_MS)
    expect(t.sweep).toHaveBeenCalledTimes(2)
    t.gates.disposeAll()
  })

  it('frees the timer when the last delay goes to 0, wherever it was set, and takes it back when one is set again', () => {
    const t = setup({ autoArchiveHours: 12, profiles: profile(6) })
    // The general delay goes, a profile's stays: still running.
    t.store.set({ autoArchiveHours: 0 })
    expect(vi.getTimerCount()).toBe(1)
    // The profile's delay goes too: nothing is left.
    t.store.set({ profiles: profile(0) })
    expect(vi.getTimerCount()).toBe(0)
    const swept = t.sweep.mock.calls.length
    vi.advanceTimersByTime(24 * HOUR)
    expect(t.sweep).toHaveBeenCalledTimes(swept)
    // A delay again, on the general setting: back, with a pass at once.
    t.store.set({ autoArchiveHours: 24 })
    expect(vi.getTimerCount()).toBe(1)
    expect(t.sweep).toHaveBeenCalledTimes(swept + 1)
    // …and from a profile alone.
    t.store.set({ autoArchiveHours: 0 })
    expect(vi.getTimerCount()).toBe(0)
    t.store.set({ profiles: profile(3) })
    expect(vi.getTimerCount()).toBe(1)
    t.gates.disposeAll()
    expect(vi.getTimerCount()).toBe(0)
    expect(t.store.listeners()).toBe(0)
  })
})

describe('the automatic reload, which costs nothing until a tab is armed', () => {
  const tab = (autoReload?: { seconds: number }) => ({ id: 'a', spaceId: 's', url: 'https://a.example/', title: 'a', pinned: false, createdAt: 0, lastActiveAt: 0, ...(autoReload ? { autoReload } : {}) })
  function setup(armed: { seconds: number } | undefined) {
    let current = armed
    const reloads = vi.fn()
    const reloader = new AutoReloader({
      targets: () => (current ? [{ tab: tab(current), page: {}, loading: false, reload: reloads, isEditing: async () => false }] : [])
    })
    return {
      reloader,
      reloads,
      arm: (seconds: number | undefined) => {
        current = seconds === undefined ? undefined : { seconds }
        reloader.refresh()
      }
    }
  }

  it('owns no timer when no tab is armed, however it is asked to look', () => {
    const t = setup(undefined)
    t.reloader.refresh()
    t.reloader.loaded('a')
    t.reloader.forget('a')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(48 * HOUR)
    expect(t.reloads).not.toHaveBeenCalled()
  })

  it('arms one timer for an armed tab and releases it as soon as the last one is disarmed', () => {
    const t = setup(undefined)
    t.arm(30)
    expect(vi.getTimerCount()).toBe(1)
    t.arm(5)
    expect(vi.getTimerCount()).toBe(1)
    t.arm(undefined)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(48 * HOUR)
    expect(t.reloads).not.toHaveBeenCalled()
  })

  it('leaves no timer once stopped', () => {
    const t = setup({ seconds: 30 })
    t.reloader.refresh()
    expect(vi.getTimerCount()).toBe(1)
    t.reloader.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the system-wide mini window shortcut, through its gate', () => {
  function setup(settings: Partial<Settings>) {
    const store = liveStore(settings)
    const held = new Map<string, () => void>()
    const host = { register: vi.fn((accelerator: string, callback: () => void) => (held.set(accelerator, callback), true)), unregister: vi.fn((accelerator: string) => void held.delete(accelerator)) }
    const shortcut = new LittleShortcut(() => undefined, host)
    const gates = new FeatureGates(store)
    gateLittleShortcut(gates, shortcut, store, () => store.get().settings.keyBindings['newLittleArc'] ?? 'CmdOrCtrl+Alt+N')
    return { store, held, host, gates }
  }

  it('holds nothing and follows nothing while the setting is off: the gate\'s own subscription is all there is', () => {
    const t = setup({ littleArcShortcut: false })
    expect(t.host.register).not.toHaveBeenCalled()
    expect(t.store.listeners()).toBe(1)
    t.store.open('https://a.example/')
    expect(t.host.register).not.toHaveBeenCalled()
    t.gates.disposeAll()
  })

  it('holds the shortcut and follows a change of the command\'s keys while the setting is on', () => {
    const t = setup({ littleArcShortcut: true })
    expect([...t.held.keys()]).toEqual(['CmdOrCtrl+Alt+N'])
    expect(t.store.listeners()).toBe(2)
    t.store.set({ keyBindings: { newLittleArc: 'CmdOrCtrl+Alt+L' } })
    expect([...t.held.keys()]).toEqual(['CmdOrCtrl+Alt+L'])
    t.gates.disposeAll()
  })

  it('lets go of the shortcut and of its subscription when the setting goes off, and takes them back when it is on again', () => {
    const t = setup({ littleArcShortcut: true })
    t.store.set({ littleArcShortcut: false })
    expect(t.held.size).toBe(0)
    expect(t.store.listeners()).toBe(1)
    t.store.set({ littleArcShortcut: true })
    expect([...t.held.keys()]).toEqual(['CmdOrCtrl+Alt+N'])
    expect(t.store.listeners()).toBe(2)
    t.gates.disposeAll()
    expect(t.held.size).toBe(0)
    expect(t.store.listeners()).toBe(0)
  })
})

describe('the pictures of the hover cards, through their gate (hover-cards)', () => {
  function setup(settings: Partial<Settings>) {
    const store = liveStore(settings)
    const made: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
    const gates = new FeatureGates(store)
    const pictures = gateThumbnails(gates, () => {
      const one = { dispose: vi.fn() }
      made.push(one)
      return one
    })
    return { store, made, pictures, gates }
  }

  it('makes nothing while the cards are off', () => {
    const t = setup({ hoverCards: false })
    expect(t.made).toHaveLength(0)
    expect(t.pictures.current()).toBeNull()
    t.gates.disposeAll()
  })

  it('makes the pictures when the cards come on, and drops them when they go off', () => {
    const t = setup({ hoverCards: false })
    t.store.set({ hoverCards: true })
    expect(t.made).toHaveLength(1)
    expect(t.pictures.current()).toBe(t.made[0])
    t.store.set({ hoverCards: false })
    expect(t.made[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(t.pictures.current()).toBeNull()
    t.store.set({ hoverCards: true })
    expect(t.made).toHaveLength(2)
    expect(t.pictures.current()).toBe(t.made[1])
    t.gates.disposeAll()
    expect(t.made[1]!.dispose).toHaveBeenCalledTimes(1)
  })
})
