// What the window group does for the resource panel of the sidebar (Browser.resourceTabs, sleepHiddenTabs, closeTabAnywhere, showTabAnywhere),
// run on stand-ins of its windows (browser-fake.test-support.ts), and how the shell wires its watch (`Browser.start`, run on a stand-in too).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings, type TabItem } from '@shared/model'
import type { RawProcess } from '@shared/processes'
import { setLanguage } from '@shared/i18n'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
// `Browser.start` runs on a stand-in (browser-start.test.ts): the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('../blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
const { Browser } = await import('./browser')
const { SLEEP_SWEEP_MS } = await import('./browser-base')
const shell = methodsOf(Browser.prototype)

afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
})

const tab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({ id, url: `https://${id}.example/`, title: id.toUpperCase(), spaceId: 's1', pinned: false, createdAt: 1, lastActiveAt: 1, ...extra })
const MB = 1024

interface WindowSpec {
  tabs?: TabItem[]
  /** Tab id → the pid of its page (0: a page with no process). */
  pages?: Record<string, number>
  frozen?: string[]
  shown?: string[]
  locked?: string[]
  name?: string
  activeSpaceId?: string
  settings?: Partial<Settings>
  own?: Record<string, unknown>
}

/** The real methods the stand-ins need to call one another (a stand-in answers `undefined` for anything it was not given). */
const REAL = ['autoVerdict', 'freezePage', 'sleepFacts', 'sleepRules', 'isShown', 'resourceOwner', 'ownerOf', 'releasePage'] as const

/** A window of the group, as the methods under test see it. */
function windowOf(spec: WindowSpec, all: WindowSpec[]) {
  const tabs = spec.tabs ?? []
  const state = {
    tabs: all.flatMap((w) => w.tabs ?? []).filter((t) => tabs.includes(t) || !spec.own?.['independent']),
    spaces: [{ id: 's1', name: 'Perso' }, { id: 's2', name: 'Travail' }],
    activeSpaceId: spec.activeSpaceId ?? 's1',
    settings: { ...defaultSettings(), ...spec.settings }
  }
  const pages = new Map(
    Object.entries(spec.pages ?? {}).map(([id, pid]) => [
      id,
      {
        processId: () => pid,
        probeForSleep: vi.fn(async () => ({ pictureInPicture: false, unsentInput: id.includes('typed') })),
        freeze: vi.fn(async () => true),
        thaw: vi.fn(async () => undefined)
      }
    ])
  )
  const fields: Record<string, unknown> = {
    win: { isDestroyed: () => false, isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() },
    store: { get: () => state },
    pages,
    frozen: new Set(spec.frozen ?? []),
    visible: new Set(spec.shown ?? []),
    shownTabId: spec.shown?.[0],
    windowNames: spec.name ? { own: () => spec.name, others: () => [] } : null,
    runtime: { tabs: Object.fromEntries(tabs.map((t) => [t.id, { loading: false, audible: t.id.includes('sound'), muted: false, awake: true }])) },
    idleSince: new Map(),
    isTabLocked: (t: TabItem) => (spec.locked ?? []).includes(t.id),
    ownsPage: (id: string) => pages.has(id),
    destroyPage: vi.fn((id: string) => void pages.delete(id)),
    dispatch: vi.fn(),
    publish: vi.fn(),
    setAwake: vi.fn(),
    autoReloader: null,
    ...Object.fromEntries(REAL.map((name) => [name, shell[name]])),
    ...spec.own
  }
  return { self: fakeBrowser(fields).self, fields, pages }
}

/** The group of these windows, the first one being the main one (the leader). */
function group(...specs: WindowSpec[]) {
  const windows = specs.map((spec) => windowOf(spec, specs))
  const members = new Set(windows.map((w) => w.self))
  for (const w of windows) Object.assign(w.fields, { group: members, leader: windows[0]!.self })
  // The main window keeps the downloads of the group: one runs, started by the tab `tab-downloading`.
  windows[0]!.fields['downloadSources'] = new Map([['d1', 'tab-downloading']])
  return windows
}

const raw = (...pages: Array<[pid: number, memoryMb: number, cpu?: number]>): RawProcess[] => [
  { pid: 1, type: 'Browser', cpu: 1, memoryKb: 200 * MB },
  ...pages.map(([pid, memoryMb, cpu = 0]) => ({ pid, type: 'Tab', cpu, memoryKb: memoryMb * MB }))
]

describe('the tabs of the panel (Browser.resourceTabs)', () => {
  it('are the awake tabs of every window with the figures of their page, said from the window that asks', () => {
    const [main, second] = group(
      { tabs: [tab('a'), tab('b', { spaceId: 's2' }), tab('frozen'), tab('gone'), tab('locked')], pages: { a: 10, b: 11, frozen: 12, gone: 0, locked: 13 }, frozen: ['frozen'], locked: ['locked'], shown: ['a'] },
      { tabs: [tab('c', { faviconUrl: 'https://c.example/icon.png', pinned: true })], pages: { c: 20 } }
    )
    const { tabs, hidden } = shell['resourceTabs']!.call(main!.self, raw([10, 584, 7.44], [11, 278], [12, 900], [13, 400], [20, 205])) as { tabs: Array<Record<string, unknown>>; hidden: number }
    expect(tabs).toEqual([
      { tabId: 'a', name: 'A', url: 'https://a.example/', memoryMb: 584, cpu: 7.4 },
      // Another space of this window: its name.
      { tabId: 'b', name: 'B', url: 'https://b.example/', memoryMb: 278, cpu: 0, where: 'Travail' },
      // Another window: its name, or « Fenêtre n » after its place in the group.
      { tabId: 'c', name: 'C', url: 'https://c.example/', faviconUrl: 'https://c.example/icon.png', pinned: true, memoryMb: 205, cpu: 0, where: 'Fenêtre 2' }
    ])
    // A frozen page is asleep, a page with no process has no figure, a locked space names nothing.
    expect(tabs.map((t) => t['tabId'])).not.toContain('frozen')
    expect(hidden).toBe(2)
    // From the second window, the first is the main one.
    const seen = shell['resourceTabs']!.call(second!.self, raw([10, 584], [11, 278], [20, 205])) as { tabs: Array<Record<string, unknown>> }
    expect(seen.tabs.find((t) => t['tabId'] === 'a')?.['where']).toBe('Fenêtre principale')
    expect(seen.tabs.find((t) => t['tabId'] === 'c')?.['where']).toBeUndefined()
  })

  it('names another window by the name the user gave it, while windows can be named', () => {
    const [main] = group({ tabs: [], settings: { nameWindows: true } }, { tabs: [tab('c')], pages: { c: 20 }, name: 'Travail du soir', settings: { nameWindows: true } })
    const { tabs } = shell['resourceTabs']!.call(main!.self, raw([20, 100])) as { tabs: Array<Record<string, unknown>> }
    expect(tabs[0]!['where']).toBe('Travail du soir')
  })

  it('marks the tabs whose page shares its process with another tab', () => {
    const [main] = group({ tabs: [tab('a'), tab('b'), tab('c')], pages: { a: 10, b: 10, c: 11 } })
    const { tabs } = shell['resourceTabs']!.call(main!.self, raw([10, 300], [11, 100])) as { tabs: Array<Record<string, unknown>> }
    expect(tabs.map((t) => [t['tabId'], t['shared'] === true])).toEqual([['a', true], ['b', true], ['c', false]])
  })
})

describe('« Tout mettre en veille sauf l’onglet affiché » (Browser.sleepHiddenTabs)', () => {
  const windows = (settings: Partial<Settings> = {}) =>
    group(
      {
        tabs: [tab('shown'), tab('plain'), tab('sound'), tab('kept', { keepAwake: true }), tab('tab-downloading'), tab('reloads', { autoReload: { seconds: 30 } })],
        pages: { shown: 1, plain: 2, sound: 3, kept: 4, 'tab-downloading': 5, reloads: 6 },
        shown: ['shown'],
        settings
      },
      { tabs: [tab('typed'), tab('other'), tab('frozen'), tab('never', { url: 'https://chat.example/' })], pages: { typed: 7, other: 8, frozen: 9, never: 10 }, frozen: ['frozen'], settings: { sleepExcludedHosts: ['chat.example'], ...settings } }
    )

  it('puts to sleep the hidden tabs of every window, whatever the delay, and keeps the shown and the protected ones', async () => {
    // The delay is « Jamais »: the button does not wait for it.
    const [main, second] = windows({ sleepAfterMinutes: 0 })
    const slept = (await shell['sleepHiddenTabs']!.call(main!.self)) as string[]
    expect(slept.sort()).toEqual(['other', 'plain'])
    // `true`: a sleep, so each page hands its Back / Forward list over (slept-history.ts).
    expect(main!.fields['destroyPage']).toHaveBeenCalledWith('plain', true)
    expect(second!.fields['destroyPage']).toHaveBeenCalledWith('other', true)
    // Sound, a download, « Ne jamais mettre en veille », a tab that reloads itself, a site never put to sleep, text not sent, the tab on screen: awake.
    for (const id of ['shown', 'sound', 'kept', 'tab-downloading', 'reloads']) expect(main!.pages.has(id), id).toBe(true)
    for (const id of ['typed', 'never', 'frozen']) expect(second!.pages.has(id), id).toBe(true)
    expect(main!.fields['publish']).toHaveBeenCalled()
  })

  it('freezes instead when the settings say so', async () => {
    const [main, second] = windows({ sleepMode: 'freeze' })
    const slept = (await shell['sleepHiddenTabs']!.call(main!.self)) as string[]
    expect(slept.sort()).toEqual(['other', 'plain'])
    expect(main!.fields['destroyPage']).not.toHaveBeenCalled()
    expect((main!.pages.get('plain')!.freeze as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    expect((second!.pages.get('other')!.freeze as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
  })

  it('publishes nothing when nothing could sleep', async () => {
    const [main] = group({ tabs: [tab('shown'), tab('sound')], pages: { shown: 1, sound: 2 }, shown: ['shown'] })
    expect(await shell['sleepHiddenTabs']!.call(main!.self)).toEqual([])
    expect(main!.fields['publish']).not.toHaveBeenCalled()
  })
})

describe('the buttons of a row', () => {
  it('✕ follows the rule of the sidebar’s cross: a Today tab is archived, an awake pinned tab is put back on its anchor', () => {
    const [main] = group({ tabs: [tab('today'), tab('pin', { pinned: true })], pages: { today: 1, pin: 2 } })
    expect(shell['closeTabAnywhere']!.call(main!.self, 'today')).toBe(true)
    expect(shell['closeTabAnywhere']!.call(main!.self, 'pin')).toBe(true)
    expect((main!.fields['dispatch'] as ReturnType<typeof vi.fn>).mock.calls).toEqual([[{ type: 'tab/archive', id: 'today' }], [{ type: 'tab/close', id: 'pin' }]])
  })

  it('✕ goes through the window that holds the tab when this one does not list it (windows of their own), and the notice comes there', () => {
    const [main, second] = group({ tabs: [], own: { independent: true } }, { tabs: [tab('far')], pages: { far: 3 }, own: { independent: true } })
    expect(shell['closeTabAnywhere']!.call(main!.self, 'far')).toBe(true)
    expect(main!.fields['dispatch']).not.toHaveBeenCalled()
    expect(second!.fields['dispatch']).toHaveBeenCalledWith({ type: 'tab/archive', id: 'far' })
  })

  it('a click shows the tab in its window, which comes to the front', () => {
    const [main, second] = group({ tabs: [tab('here')], pages: { here: 1 } }, { tabs: [tab('far')], pages: { far: 3 } })
    expect(shell['showTabAnywhere']!.call(main!.self, 'far')).toBe(true)
    const win = second!.fields['win'] as Record<string, ReturnType<typeof vi.fn>>
    expect(win['restore']).toHaveBeenCalled()
    expect(win['focus']).toHaveBeenCalled()
    expect(second!.fields['dispatch']).toHaveBeenCalledWith({ type: 'tab/select', id: 'far' })
    shell['showTabAnywhere']!.call(main!.self, 'here')
    expect(main!.fields['dispatch']).toHaveBeenCalledWith({ type: 'tab/select', id: 'here' })
    expect((main!.fields['win'] as Record<string, ReturnType<typeof vi.fn>>)['focus']).not.toHaveBeenCalled()
  })

  it('do nothing for a tab hidden by the lock, or that has no live page any more', async () => {
    const [main] = group({ tabs: [tab('locked'), tab('asleep')], pages: { locked: 1 }, locked: ['locked'] })
    for (const id of ['locked', 'asleep', 'unknown']) {
      expect(shell['closeTabAnywhere']!.call(main!.self, id), id).toBe(false)
      expect(shell['showTabAnywhere']!.call(main!.self, id), id).toBe(false)
      expect(await shell['sleepTabAnywhere']!.call(main!.self, id), id).toBe(false)
    }
    expect(main!.fields['dispatch']).not.toHaveBeenCalled()
  })
})

describe('the watch of the group', () => {
  it('is the main window’s, for every window, and none in a private window', () => {
    const watch = { gauge: () => ({ memoryMb: 8300, totalMb: 16384, percent: 51, pressure: false, warn: true }) }
    const leader = { resourceWatch: watch }
    const normal = fakeBrowser({ leader, isPrivate: () => false }).self
    // Whatever its group holds, a private window shows no ring (its tabs are its own).
    const secret = fakeBrowser({ leader, isPrivate: () => true }).self
    expect(shell['resources']!.call(normal)).toBe(watch)
    expect(shell['resources']!.call(secret)).toBeNull()
    const snapshotOf = (self: object, locked: boolean) => shell['memoryGaugeOfSnapshot']!.call(Object.assign(self, { resources: () => shell['resources']!.call(self) }), locked)
    expect(snapshotOf(normal, false)).toEqual({ memoryGauge: watch.gauge() })
    // The lock screen is told nothing of it.
    expect(snapshotOf(normal, true)).toEqual({})
    expect(snapshotOf(secret, false)).toEqual({})
  })

  /** `Browser.start` for a window of this kind: the gates it makes, by name, over the watch (a recorder of the sweep) the group holds. */
  function started(kind: 'main' | 'private' | 'secondary', sweep = vi.fn()) {
    const gates = new Map<string, { start(): unknown }>()
    const fake = fakeBrowser({
      isPrivate: () => kind === 'private',
      isSecondary: () => kind === 'secondary',
      gates: { gate: (id: string, gate: { start(): unknown }) => void gates.set(id, gate) },
      store: { get: () => ({ settings: defaultSettings() }), subscribe: () => () => {} },
      group: new Set(),
      resourceWatch: { sweep },
      sleepSweep: async () => undefined
    })
    shell['start']!.call(fake.self)
    return { gates, sweep }
  }

  it('is made by the gate of its function in the main window only, and read at the beat of the sleep sweep', () => {
    expect([...started('main').gates.keys()]).toContain('resource-gauge')
    expect([...started('private').gates.keys()]).not.toContain('resource-gauge')
    expect([...started('secondary').gates.keys()]).not.toContain('resource-gauge')
    // The beat of the sleep sweep reads it, and the gate of the sleep stops the beat.
    vi.useFakeTimers()
    try {
      const { gates, sweep } = started('main')
      const stop = gates.get('sleep')!.start() as () => void
      vi.advanceTimersByTime(SLEEP_SWEEP_MS)
      expect(sweep).toHaveBeenCalledTimes(1)
      stop()
      vi.advanceTimersByTime(SLEEP_SWEEP_MS * 3)
      expect(sweep).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('has no timer of its own: its function arms none besides the refresh of an open panel (resource-watch.ts)', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const stop = shell['startResourceWatch']!.call(fakeBrowser({ resourceWatch: null, publish: vi.fn(), win: { isDestroyed: () => true } }).self) as () => void
      expect(vi.getTimerCount()).toBe(0)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is dropped with its function, and the windows lose the ring, unless the window is closing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const closing of [false, true]) {
      const fields: Record<string, unknown> = { resourceWatch: null, publish: vi.fn(), win: { isDestroyed: () => closing } }
      const stop = shell['startResourceWatch']!.call(fakeBrowser(fields).self) as () => void
      expect(fields['resourceWatch'], `closing: ${closing}`).not.toBeNull()
      stop()
      expect(fields['resourceWatch']).toBeNull()
      expect(fields['publish'], `closing: ${closing}`).toHaveBeenCalledTimes(closing ? 0 : 1)
    }
  })
})
