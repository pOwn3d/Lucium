// What the window group does for the resource panel of the sidebar (Browser.resourceTabs, sleepHiddenTabs, closeTabAnywhere, showTabAnywhere),
// run on stand-ins of its windows (browser-fake.test-support.ts), and how the shell wires its watch (`Browser.start`, run on a stand-in too).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings, type TabItem } from '@shared/model'
import type { RawProcess } from '@shared/processes'
import { setLanguage } from '@shared/i18n'
import { RELEASE_PARALLEL, RELEASE_TAB_MS } from '@shared/resources'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
// `Browser.start` runs on a stand-in (browser-start.test.ts): the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('../blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
vi.mock('./sleep-pressure', () => ({ memoryPressure: () => Promise.resolve('normal') }))
const { Browser } = await import('./browser')
const { SLEEP_SWEEP_MS } = await import('./browser-base')
const { RELEASE_ANSWER_MS, SLEEP_PROBE_TIMEOUT_MS } = await import('../engine/electron-page-scripts')
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
const REAL = ['autoVerdict', 'freezePage', 'sleepFacts', 'sleepRules', 'isShown', 'resourceOwner', 'ownerOf', 'releasePage', 'sweepEntries', 'releaseOnce', 'releaseAsk', 'releaseClose', 'releaseLevels'] as const

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
    autoFrozen: new Set<string>(),
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
  // What the leader keeps for the whole group.
  Object.assign(windows[0]!.fields, { sleepKept: new Map(), releaseBatch: [], releasing: null })
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
    const { tabs } = shell['resourceTabs']!.call(main!.self, raw([10, 584, 7.44], [11, 278], [12, 900], [13, 400], [20, 205])) as { tabs: Array<Record<string, unknown>> }
    expect(tabs).toEqual([
      { tabId: 'a', name: 'A', url: 'https://a.example/', memoryMb: 584, cpu: 7.4 },
      // Another space of this window: its name.
      { tabId: 'b', name: 'B', url: 'https://b.example/', memoryMb: 278, cpu: 0, where: 'Travail' },
      // Another window: its name, or « Fenêtre n » after its place in the group.
      { tabId: 'c', name: 'C', url: 'https://c.example/', faviconUrl: 'https://c.example/icon.png', pinned: true, memoryMb: 205, cpu: 0, where: 'Fenêtre 2' }
    ])
    // A frozen page is asleep, a page with no process has no figure, a locked space names nothing.
    expect(tabs.map((t) => t['tabId'])).not.toContain('frozen')
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

describe('the preview of « Libérer maintenant » (Browser.resourceTabs)', () => {
  it('counts, for each strength, the tabs it would take and the memory of the processes that would go (a process another tab keeps is not counted)', () => {
    const [main] = group({
      tabs: [tab('shown'), tab('plain'), tab('pair-a'), tab('pair-b'), tab('sound'), tab('pin', { pinned: true })],
      pages: { shown: 1, plain: 2, 'pair-a': 3, 'pair-b': 3, sound: 4, pin: 5 },
      shown: ['shown'],
      settings: { sleepSkipPinned: true },
      own: { idleSince: new Map([['plain', Date.now() - 20 * 60_000]]) }
    })
    const { levels } = shell['resourceTabs']!.call(main!.self, raw([1, 900, 40], [2, 300, 2.26], [3, 200, 1], [4, 500], [5, 150, 0.5])) as { levels: Array<Record<string, unknown>> }
    expect(levels).toEqual([
      { level: 'low', count: 1, memoryMb: 300, cpu: 2.3, siteTabs: 0 },
      { level: 'medium', count: 3, memoryMb: 500, cpu: 3.3, siteTabs: 0 },
      { level: 'high', count: 4, memoryMb: 650, cpu: 3.8, siteTabs: 0 }
    ])
  })

  it('names the tabs of a kept site that only the strongest strength takes', () => {
    const [main] = group({ tabs: [tab('chat', { url: 'https://chat.example/' })], pages: { chat: 1 }, settings: { sleepExcludedHosts: ['chat.example'] } })
    const { levels } = shell['resourceTabs']!.call(main!.self, raw([1, 400])) as { levels: Array<{ count: number; siteTabs: number }> }
    expect(levels.map((l) => [l.count, l.siteTabs])).toEqual([[0, 0], [0, 0], [1, 1]])
  })
})

describe('« Libérer maintenant » (Browser.releaseLevel)', () => {
  const OLD = Date.now() - 20 * 60_000
  const windows = (settings: Partial<Settings> = {}, idle: Record<string, number> = {}) => {
    const common: Partial<Settings> = { sleepAfterMinutes: 0, sleepExcludedHosts: ['chat.example'], sleepSkipPinned: true, ...settings }
    return group(
      {
        tabs: [tab('shown'), tab('plain'), tab('sound'), tab('kept', { keepAwake: true }), tab('tab-downloading'), tab('reloads', { autoReload: { seconds: 30 } }), tab('pin', { pinned: true })],
        pages: { shown: 1, plain: 2, sound: 3, kept: 4, 'tab-downloading': 5, reloads: 6, pin: 11 },
        shown: ['shown'],
        settings: common,
        own: { idleSince: new Map(Object.entries(idle)) }
      },
      { tabs: [tab('typed'), tab('other'), tab('frozen'), tab('never', { url: 'https://chat.example/' })], pages: { typed: 7, other: 8, frozen: 9, never: 10 }, frozen: ['frozen'], settings: common, own: { idleSince: new Map(Object.entries(idle)) } }
    )
  }
  const release = (self: object, level: string) => shell['releaseLevel']!.call(self, level) as Promise<{ level: string; slept: number; refused: Record<string, number>; busy?: true }>

  it('medium puts to sleep every hidden tab of every window, whatever the delay, and keeps what is protected', async () => {
    // The delay is « Jamais »: the action does not wait for it.
    const [main, second] = windows()
    const outcome = await release(main!.self, 'medium')
    // The text typed and not sent is counted as such, never named.
    expect(outcome).toEqual({ level: 'medium', slept: 2, refused: { unsent: 1, confirm: 0, other: 0, slow: 0 } })
    // `true`: a sleep, so each page hands its Back / Forward list over (slept-history.ts).
    expect(main!.fields['destroyPage']).toHaveBeenCalledWith('plain', true)
    expect(second!.fields['destroyPage']).toHaveBeenCalledWith('other', true)
    // Sound, a download, « Ne jamais mettre en veille », a tab that reloads itself, a pinned tab and a site kept awake (the settings), text not sent, the tab on screen: awake.
    for (const id of ['shown', 'sound', 'kept', 'tab-downloading', 'reloads', 'pin']) expect(main!.pages.has(id), id).toBe(true)
    for (const id of ['typed', 'never', 'frozen']) expect(second!.pages.has(id), id).toBe(true)
    expect(main!.fields['publish']).toHaveBeenCalled()
    expect(main!.fields['releaseBatch']).toEqual([{ id: 'plain', window: main!.self }, { id: 'other', window: second!.self }])
  })

  it('low takes only the tabs left for ten minutes or more', async () => {
    const [main, second] = windows({}, { other: OLD })
    expect(await release(main!.self, 'low')).toMatchObject({ slept: 1 })
    expect(second!.pages.has('other')).toBe(false)
    expect(main!.pages.has('plain')).toBe(true)
  })

  it('high also takes the pinned tabs and the tabs of the sites kept awake, and still keeps the protected ones', async () => {
    const [main, second] = windows()
    const outcome = await release(main!.self, 'high')
    expect(outcome.slept).toBe(4)
    expect(main!.pages.has('pin')).toBe(false)
    expect(second!.pages.has('never')).toBe(false)
    for (const id of ['shown', 'sound', 'kept', 'tab-downloading', 'reloads']) expect(main!.pages.has(id), id).toBe(true)
    expect(second!.pages.has('typed')).toBe(true)
  })

  it('frees the page even when the settings say to freeze: the point is the memory, and « Annuler » reloads it', async () => {
    const [main, second] = windows({ sleepMode: 'freeze' })
    await release(main!.self, 'medium')
    expect(main!.fields['destroyPage']).toHaveBeenCalledWith('plain', true)
    expect(main!.pages.get('plain')).toBeUndefined()
    expect(second!.pages.get('other')).toBeUndefined()
  })

  it('counts a page that asks to confirm leaving, and keeps it awake', async () => {
    const [main] = windows()
    const plain = main!.pages.get('plain') as Record<string, unknown>
    plain['release'] = vi.fn(async () => false)
    expect(await release(main!.self, 'medium')).toMatchObject({ slept: 1, refused: { unsent: 1, confirm: 1, other: 0, slow: 0 } })
    expect(main!.pages.has('plain')).toBe(true)
  })

  it('marks the tabs that hold something (text not sent, Picture in Picture, a confirmation on leaving) so that the sweep leaves them out of the cap a while', async () => {
    const [main, second] = windows()
    ;(second!.pages.get('other') as Record<string, unknown>)['probeForSleep'] = vi.fn(async () => ({ pictureInPicture: true, unsentInput: false }))
    // A page that asks to confirm leaving is marked by `releasePage`, as the sweep does.
    ;(main!.pages.get('plain') as Record<string, unknown>)['release'] = vi.fn(async () => false)
    const before = Date.now()
    expect(await release(main!.self, 'medium')).toMatchObject({ slept: 0, refused: { unsent: 1, confirm: 1, other: 1, slow: 0 } })
    const kept = main!.fields['sleepKept'] as Map<string, number>
    expect([...kept.keys()].sort()).toEqual(['other', 'plain', 'typed'])
    for (const at of kept.values()) expect(at).toBeGreaterThanOrEqual(before)
  })

  it('answers « busy » to a request made while a run goes on, without starting a second one', async () => {
    const [main] = windows()
    let answer: (probe: { pictureInPicture: boolean; unsentInput: boolean }) => void = () => undefined
    ;(main!.pages.get('plain') as Record<string, unknown>)['probeForSleep'] = () => new Promise((resolve) => (answer = resolve as typeof answer))
    const first = release(main!.self, 'medium')
    expect(await release(main!.self, 'high')).toEqual({ level: 'high', slept: 0, refused: { unsent: 0, confirm: 0, other: 0, slow: 0 }, busy: true })
    answer({ pictureInPicture: false, unsentInput: false })
    expect((await first).slept).toBe(2)
    // The run is over: the next request is taken.
    expect((await release(main!.self, 'medium')).busy).toBeUndefined()
  })

  it('publishes nothing and keeps the last batch when nothing could sleep', async () => {
    const [main] = group({ tabs: [tab('shown'), tab('sound')], pages: { shown: 1, sound: 2 }, shown: ['shown'] })
    const batch = [{ id: 'older', window: main!.self }]
    main!.fields['releaseBatch'] = batch
    expect(await release(main!.self, 'medium')).toEqual({ level: 'medium', slept: 0, refused: { unsent: 0, confirm: 0, other: 0, slow: 0 } })
    expect(main!.fields['publish']).not.toHaveBeenCalled()
    expect(main!.fields['releaseBatch']).toBe(batch)
  })
})

describe('« Libérer maintenant » with a page that does not answer (Browser.releaseLevel)', () => {
  type Probe = { pictureInPicture: boolean; unsentInput: boolean }
  const quiet: Probe = { pictureInPicture: false, unsentInput: false }
  const windows = () => group({ tabs: [tab('a'), tab('mute'), tab('c')], pages: { a: 1, mute: 2, c: 3 }, settings: { sleepAfterMinutes: 0 } })
  const release = (self: object) => shell['releaseLevel']!.call(self, 'medium') as Promise<{ slept: number; refused: Record<string, number>; busy?: true }>
  const silence = (window: ReturnType<typeof windows>[number], id: string, probe: () => Promise<Probe>): void => void ((window.pages.get(id) as Record<string, unknown>)['probeForSleep'] = vi.fn(probe))

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for one step of one tab longer than the engine itself gives a page to answer (its probe, its close): only a page that is out of reach is given up', () => {
    expect(RELEASE_TAB_MS).toBeGreaterThan(Math.max(SLEEP_PROBE_TIMEOUT_MS, RELEASE_ANSWER_MS))
    expect(RELEASE_TAB_MS).toBeLessThanOrEqual(12_000)
  })

  it('leaves the silent tab awake after the delay, counts it as too slow, and goes on with the other tabs', async () => {
    const [main] = windows()
    silence(main!, 'mute', () => new Promise<Probe>(() => undefined))
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS)
    expect(await run).toEqual({ level: 'medium', slept: 2, refused: { unsent: 0, confirm: 0, other: 0, slow: 1 } })
    expect(main!.pages.has('mute')).toBe(true)
    expect(main!.pages.has('a')).toBe(false)
    expect(main!.pages.has('c')).toBe(false)
    expect(main!.fields['releaseBatch']).toEqual([{ id: 'a', window: main!.self }, { id: 'c', window: main!.self }])
  })

  it('waits the whole delay for a tab and not a moment more', async () => {
    const [main] = windows()
    silence(main!, 'a', () => new Promise<Probe>(() => undefined))
    let done = false
    void release(main!.self).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('frees the lock of the single run: another run is taken once the silent tab is given up', async () => {
    const [main] = windows()
    silence(main!, 'a', () => new Promise<Probe>(() => undefined))
    const run = release(main!.self)
    expect((await release(main!.self)).busy).toBe(true)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS)
    await run
    expect(main!.fields['releasing']).toBeNull()
    const next = release(main!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS)
    expect((await next).busy).toBeUndefined()
  })

  it('does not put a tab to sleep when its page answers after the delay', async () => {
    const [main] = windows()
    let answer: (probe: Probe) => void = () => undefined
    silence(main!, 'mute', () => new Promise<Probe>((resolve) => (answer = resolve)))
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS)
    await run
    answer(quiet)
    await vi.advanceTimersByTimeAsync(0)
    expect(main!.pages.has('mute')).toBe(true)
    expect(main!.fields['destroyPage']).not.toHaveBeenCalledWith('mute', true)
  })

  it('lets a page that answers in time go to sleep as before', async () => {
    const [main] = windows()
    silence(main!, 'mute', () => new Promise<Probe>((resolve) => setTimeout(() => resolve(quiet), RELEASE_TAB_MS - 1)))
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS)
    expect((await run).slept).toBe(3)
  })
})

describe('« Libérer maintenant » on a machine that is busy: slow answers, a few tabs at a time (Browser.releaseLevel)', () => {
  type Probe = { pictureInPicture: boolean; unsentInput: boolean }
  const quiet: Probe = { pictureInPicture: false, unsentInput: false }
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`)
  const many = (n: number, own: Record<string, unknown> = {}) => group({ tabs: ids(n).map((id) => tab(id)), pages: Object.fromEntries(ids(n).map((id, i) => [id, i + 1])), settings: { sleepAfterMinutes: 0 }, own })
  const release = (self: object) => shell['releaseLevel']!.call(self, 'medium') as Promise<{ slept: number; refused: Record<string, number>; busy?: true }>
  type Page = Record<string, unknown>
  const pageOf = (window: ReturnType<typeof many>[number], id: string): Page => window.pages.get(id) as Page
  const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms))

  /** Every page answers its probe after `probeMs` and its close after `closeMs`; says how many answers were waited for at the same time, and in what order things happened. */
  function slowPages(window: ReturnType<typeof many>[number], probeMs: number, closeMs: number) {
    const seen = { inFlight: 0, peak: 0, events: [] as string[] }
    const wait = async <T>(label: string, ms: number, value: T): Promise<T> => {
      seen.peak = Math.max(seen.peak, ++seen.inFlight)
      try {
        return await later(ms, value)
      } finally {
        seen.inFlight--
        seen.events.push(label)
      }
    }
    for (const id of window.pages.keys()) {
      const page = pageOf(window, id)
      page['probeForSleep'] = vi.fn(() => wait(`probed:${id}`, probeMs, quiet))
      page['release'] = vi.fn(() => {
        seen.events.push(`closing:${id}`)
        return wait(`closed:${id}`, closeMs, true)
      })
    }
    return seen
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // The case of the machine at 217 % of a core: 2 s to answer the page, 2 s to close it. Asked one tab after the other with 3 s for both, none could go.
  it('puts every tab to sleep although each one takes four seconds to be asked and closed (more than the old three seconds for both)', async () => {
    const [main] = many(8)
    slowPages(main!, 2000, 2000)
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(2000 * 2 * 2)
    expect(await run).toEqual({ level: 'medium', slept: 8, refused: { unsent: 0, confirm: 0, other: 0, slow: 0 } })
    expect(main!.pages.size).toBe(0)
    expect((main!.fields['releaseBatch'] as unknown[]).length).toBe(8)
  })

  it(`asks and closes ${RELEASE_PARALLEL} tabs at a time, no more and not one by one: twelve tabs of two seconds take three rounds a pass, not twelve`, async () => {
    const [main] = many(12)
    const seen = slowPages(main!, 2000, 2000)
    let ended = false
    void release(main!.self).then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(11_999)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(true)
    expect(seen.peak).toBe(RELEASE_PARALLEL)
  })

  it('looks at every protection before it closes anything: no page is closed until every page has been asked', async () => {
    const [main] = many(6)
    const seen = slowPages(main!, 1000, 1000)
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(10_000)
    await run
    const firstClose = seen.events.findIndex((event) => event.startsWith('closing:'))
    const lastProbe = seen.events.map((event) => event.startsWith('probed:')).lastIndexOf(true)
    expect(firstClose).toBeGreaterThan(-1)
    expect(lastProbe).toBeLessThan(firstClose)
  })

  it('never closes a tab whose page said it holds something, whatever the others do', async () => {
    const [main] = many(6)
    slowPages(main!, 1000, 1000)
    pageOf(main!, 't2')['probeForSleep'] = vi.fn(() => later(1500, { pictureInPicture: false, unsentInput: true }))
    pageOf(main!, 't4')['probeForSleep'] = vi.fn(() => later(500, { pictureInPicture: true, unsentInput: false }))
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await run).toEqual({ level: 'medium', slept: 4, refused: { unsent: 1, confirm: 0, other: 1, slow: 0 } })
    expect([...main!.pages.keys()].sort()).toEqual(['t2', 't4'])
    expect(pageOf(main!, 't2')['release']).not.toHaveBeenCalled()
    expect(pageOf(main!, 't4')['release']).not.toHaveBeenCalled()
  })

  it('does not close a tab that was shown, or began to play, between the two passes', async () => {
    const [main] = many(5)
    slowPages(main!, 1000, 1000)
    // The last page to answer is the one whose answer comes while the others wait: by then `t0` is on screen and `t1` plays a sound.
    pageOf(main!, 't4')['probeForSleep'] = vi.fn(async () => {
      await later(3000, undefined)
      ;(main!.fields['visible'] as Set<string>).add('t0')
      ;((main!.fields['runtime'] as { tabs: Record<string, { audible: boolean }> }).tabs['t1'] as { audible: boolean }).audible = true
      return quiet
    })
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await run).toEqual({ level: 'medium', slept: 3, refused: { unsent: 0, confirm: 0, other: 2, slow: 0 } })
    expect([...main!.pages.keys()].sort()).toEqual(['t0', 't1'])
  })

  it('counts a page that answers its close too late as too slow, and still lets « Annuler » wake it when it does go', async () => {
    const [main] = many(3)
    slowPages(main!, 100, 100)
    pageOf(main!, 't1')['release'] = vi.fn(() => later(RELEASE_TAB_MS + 3000, true))
    const run = release(main!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS + 200)
    // The run gave up on t1 and ended: two went, one is « too slow », and the batch of « Annuler » holds the two that went.
    expect(await run).toEqual({ level: 'medium', slept: 2, refused: { unsent: 0, confirm: 0, other: 0, slow: 1 } })
    expect((main!.fields['releaseBatch'] as Array<{ id: string }>).map((one) => one.id)).toEqual(['t0', 't2'])
    expect(main!.pages.has('t1')).toBe(true)
    // Its close ends later: the page is gone, and it joins the batch.
    await vi.advanceTimersByTimeAsync(3000)
    expect(main!.pages.has('t1')).toBe(false)
    expect((main!.fields['releaseBatch'] as Array<{ id: string }>).map((one) => one.id).sort()).toEqual(['t0', 't1', 't2'])
    expect(main!.fields['publish']).toHaveBeenCalled()
  })

  it('puts the late tab in the batch of a run that slept nothing else, and not in the batch of a newer run', async () => {
    const [first] = many(1)
    slowPages(first!, 100, 100)
    pageOf(first!, 't0')['release'] = vi.fn(() => later(RELEASE_TAB_MS + 2000, true))
    const run = release(first!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS + 200)
    expect((await run).refused.slow).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect((first!.fields['releaseBatch'] as Array<{ id: string }>).map((one) => one.id)).toEqual(['t0'])

    const [second] = many(1)
    slowPages(second!, 100, 100)
    pageOf(second!, 't0')['release'] = vi.fn(() => later(RELEASE_TAB_MS + 2000, true))
    const newer = [{ id: 'elsewhere', window: second!.self }]
    const other = release(second!.self)
    await vi.advanceTimersByTimeAsync(RELEASE_TAB_MS + 200)
    await other
    // A newer run took the batch meanwhile: what « Annuler » wakes is that one.
    second!.fields['releaseBatch'] = newer
    await vi.advanceTimersByTimeAsync(2000)
    expect(second!.fields['releaseBatch']).toBe(newer)
    expect(newer).toEqual([{ id: 'elsewhere', window: second!.self }])
  })

  it('goes on to the end when a close fails: the others are not left running, the lock is freed, and the failure is the caller’s', async () => {
    const [main] = many(5)
    slowPages(main!, 10, 10)
    pageOf(main!, 't1')['release'] = vi.fn(async () => {
      throw new Error('the engine refused')
    })
    const run = release(main!.self)
    const caught = run.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await caught).toBe('the engine refused')
    expect(main!.pages.has('t1')).toBe(true)
    expect(main!.fields['releasing']).toBeNull()
  })
})

describe('« Annuler » (Browser.undoRelease)', () => {
  const asleep = (id: string) => tab(id)
  it('gives a page again to the tabs of the last run that are still asleep, in the window that held them, and forgets the batch', async () => {
    vi.useFakeTimers()
    try {
      const wake = vi.fn((_tabs: TabItem[]) => ['x'])
      const [main, second] = group({ tabs: [asleep('a'), asleep('b')], own: { wakeInBackground: wake } }, { tabs: [asleep('c')], own: { wakeInBackground: wake } })
      main!.fields['releaseBatch'] = [{ id: 'a', window: main!.self }, { id: 'c', window: second!.self }, { id: 'b', window: main!.self }]
      expect(await shell['undoRelease']!.call(main!.self)).toBe(3)
      expect(wake.mock.calls.map(([tabs]) => (tabs as TabItem[]).map((t) => t.id))).toEqual([['a'], ['c'], ['b']])
      expect(main!.fields['releaseBatch']).toEqual([])
      // A second click has nothing left.
      expect(await shell['undoRelease']!.call(main!.self)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves alone a tab shown or woken meanwhile (it has a page again), and a window that left the group', async () => {
    const wake = vi.fn((_tabs: TabItem[]) => ['x'])
    const [main] = group({ tabs: [asleep('a'), asleep('b')], pages: { b: 2 }, own: { wakeInBackground: wake } })
    const gone = { store: { get: () => ({ tabs: [asleep('z')] }) }, win: { isDestroyed: () => false } }
    main!.fields['releaseBatch'] = [{ id: 'a', window: main!.self }, { id: 'b', window: main!.self }, { id: 'z', window: gone }]
    expect(await shell['undoRelease']!.call(main!.self)).toBe(1)
    expect(wake.mock.calls.map(([tabs]) => (tabs as TabItem[]).map((t) => t.id))).toEqual([['a']])
  })

  it('wakes them a few at a time, a gap apart, so that dozens of pages are not made in the same instant', async () => {
    vi.useFakeTimers()
    try {
      const wake = vi.fn((_tabs: TabItem[]) => ['x'])
      const ids = Array.from({ length: 20 }, (_, i) => `t${i}`)
      const [main] = group({ tabs: ids.map(asleep), own: { wakeInBackground: wake } })
      main!.fields['releaseBatch'] = ids.map((id) => ({ id, window: main!.self }))
      expect(await shell['undoRelease']!.call(main!.self)).toBe(20)
      expect(wake).toHaveBeenCalledTimes(8)
      await vi.advanceTimersByTimeAsync(2000)
      expect(wake).toHaveBeenCalledTimes(16)
      await vi.advanceTimersByTimeAsync(4000)
      expect(wake).toHaveBeenCalledTimes(20)
    } finally {
      vi.useRealTimers()
    }
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
