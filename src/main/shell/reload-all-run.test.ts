// "Actualiser tous les onglets" as the shell runs it (browser-sleep.ts), on stand-ins of the class Browser (browser-fake.test-support.ts) with pages
// that load when the test says so: the notice comes at the click and tells how far the run is, a second click says the run is under way, « Arrêter »
// and the bound of the whole run end it, a woken tab that never comes back gives its place, and the tabs whose site no longer answers are offered.
// « Dégeler l'onglet » is here too: the page runs again, and the sweep leaves it alone for the delays. The pure rules: shared/reload-all.test.ts,
// shared/dead-tabs.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { defaultSettings, type Settings, type SidebarState, type TabItem } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { LoadFailure } from '@shared/dead-tabs'
import { RELOAD_ALL_ASK_MAX, RELOAD_ALL_AWAKE_MAX, RELOAD_ALL_DONE_MARK_MS, RELOAD_ALL_PROGRESS_MS, RELOAD_ALL_TOTAL_LIMIT_MS, deadTabsNotice, deadTabsOfferLabel, reloadAllNotice, reloadBusyNotice, reloadDetailWithDead, reloadEndNotice, reloadPhaseDetail, reloadProgressNotice } from '@shared/reload-all'
import { DEAD_TABS_FIRST_LOOK_MS, DEAD_TABS_LAUNCH_SETTLE_MS, LAUNCH_WAKE_BATCH, LAUNCH_WAKE_GAP_MS, RELOAD_ALL_TAB_LIMIT_MS } from './browser-base'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { frenchSpaces } from '@shared/french-typography'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
const pressure = vi.hoisted(() => ({ level: 'normal' as 'normal' | 'warning' | 'critical' }))
vi.mock('./sleep-pressure', () => ({ memoryPressure: () => Promise.resolve(pressure.level) }))
vi.mock('./battery-saver', () => ({ batterySaver: () => ({ active: () => false }) }))

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)
const RUN_METHODS = ['reloadAllTabs', 'reloadSleepingTabs', 'runReload', 'enterSleepingPhase', 'startTurn', 'stepReload', 'publishMarks', 'keepLastMarks', 'reloadOfSnapshot', 'withReloadMarks', 'tellReloadProgress', 'runNotice', 'showStopNotice', 'tellReloadBusy', 'stopReload', 'scopedNotice', 'spaceNameOf', 'lookAtReloaded', 'deadEntriesOf', 'tellDeadTabs', 'offerFound', 'offerDeadTabs', 'offerDead', 'wakeAndReload', 'untilLoaded', 'showDeadTabs', 'wakeAtLaunch', 'wakeInBackground'] as const

/** A promise the test settles when it says so. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

interface FakePage {
  reloads: number
  failure: LoadFailure | null
  reload(): void
  loadFailure(): LoadFailure | null
  thaw(): Promise<void>
}

interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void; second?: { label: string; run: () => void } }
  detail?: string
  progress?: { done: number; total: number }
  second?: { label: string; run: () => void }
}

const tabItem = (id: string, over: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 'espace', url: `https://${id}.example.org/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 1, ...over })

/**
 * A window with these awake tabs (a page each) and these sleeping ones (no page, or a frozen page when in `frozen`). A page that is created or
 * reloaded loads for `loadMs` (`0`: it ends at once), then ends with the failure of `failures`. The checks of the fields (`edit`) answer false at once
 * unless the test hands its own. Every notice and every change of its words is recorded.
 */
function windowWith(options: { awake?: string[]; asleep?: string[]; frozen?: string[]; failures?: Record<string, LoadFailure>; tabs?: TabItem[]; settings?: Partial<Settings>; loadMs?: number; startMs?: number; edit?: (id: string) => Promise<boolean>; /** Tabs whose page lives in another window of the group. */ elsewhere?: string[] } = {}) {
  const awake = options.awake ?? []
  const asleep = options.asleep ?? []
  const frozenIds = options.frozen ?? []
  const base = createInitialState({ now: 0, newId: () => 'x' })
  const elsewhere = options.elsewhere ?? []
  const state: SidebarState = { ...base, tabs: options.tabs ?? [...awake, ...asleep, ...frozenIds, ...elsewhere].map((id) => tabItem(id)), settings: { ...defaultSettings(), ...options.settings } }
  const pages = new Map<string, FakePage>()
  const runtime = { tabs: {} as Record<string, { loading: boolean; awake: boolean; audible: boolean; muted: boolean }>, canGoBack: false, canGoForward: false }
  const loadEnds = new Map<string, () => void>()
  const toasts: Toast[] = []
  const revisions: string[] = []
  const details: string[] = []
  const overlays: unknown[] = []
  const slept: string[] = []
  const asked: string[] = []
  const thawed: string[] = []
  let counter = 0
  const loadMs = options.loadMs ?? 0
  /** A load starts `startMs` after it was asked (the engine says so a moment later), lasts `loadMs`, and ends with the failure of the tab, if any. */
  const load = (id: string, made: FakePage): void => {
    const start = (): void => {
      runtime.tabs[id] = { loading: true, awake: true, audible: false, muted: false }
      setTimeout(() => {
        runtime.tabs[id] = { loading: false, awake: true, audible: false, muted: false }
        made.failure = options.failures?.[id] ?? null
        loadEnds.get(id)?.()
      }, loadMs)
    }
    if (options.startMs) setTimeout(start, options.startMs)
    else start()
  }
  const page = (id: string): FakePage => {
    const made: FakePage = {
      reloads: 0,
      // Until its next load ends, a page shows what it showed: it had loaded.
      failure: null,
      reload: () => {
        made.reloads++
        load(id, made)
      },
      loadFailure: () => made.failure,
      thaw: () => Promise.resolve()
    }
    return made
  }
  for (const id of [...awake, ...frozenIds]) {
    pages.set(id, page(id))
    runtime.tabs[id] = { loading: false, awake: !frozenIds.includes(id), audible: false, muted: false }
  }
  const frozen = new Set(frozenIds)
  // Another window of the group: it holds the pages of these tabs, as the window that shows them does.
  const otherPages = new Map<string, FakePage>(elsewhere.map((id) => [id, page(id)]))
  const other = { pages: otherPages, frozen: new Set<string>(), visible: new Set<string>(), runtime: { tabs: Object.fromEntries(elsewhere.map((id) => [id, { loading: false, awake: true, audible: false, muted: false }])) } }
  const own: Record<string, unknown> = {
    store: { get: () => state },
    win: { isDestroyed: () => false },
    pages,
    frozen,
    runtime,
    loadEnds,
    idleSince: new Map<string, number>(),
    reloadRun: null,
    reloadEnded: null,
    deadFound: [],
    toast: null,
    overlayRequest: null,
    quietPages: false,
    visible: new Set<string>(),
    networkOnline: () => true,
    isPrivate: () => false,
    isTabLocked: () => false,
    ownerOf: (id: string) => (pages.has(id) ? own['self'] : otherPages.has(id) ? other : undefined),
    sleepingTabIds: () => [...asleep, ...frozenIds].filter((id) => !pages.has(id) || frozen.has(id)),
    pageIsBeingEdited: (target: FakePage) => {
      const id = [...pages].find(([, p]) => p === target)?.[0] ?? '?'
      asked.push(id)
      return options.edit ? options.edit(id) : Promise.resolve(false)
    },
    ensurePage: (tab: TabItem) => {
      const made = page(tab.id)
      pages.set(tab.id, made)
      load(tab.id, made)
      return made
    },
    thawPage: (id: string) => {
      thawed.push(id)
      frozen.delete(id)
      return pages.get(id)?.thaw() ?? Promise.resolve()
    },
    sleepAgain: async (id: string) => {
      slept.push(id)
      pages.delete(id)
    },
    showToast: (message: string, action?: Toast['action'], _durationMs?: number, more: { detail?: string; progress?: Toast['progress'] } = {}) => {
      const toast: Toast = { id: ++counter, message, ...(action ? { action } : {}), ...(action?.second ? { second: action.second } : {}), ...more }
      toasts.push(toast)
      own['toast'] = toast
    },
    reviseToast: (id: number, message: string, more: { detail?: string; progress?: Toast['progress']; second?: Toast['second'] } = {}) => {
      const toast = own['toast'] as Toast | null
      if (toast?.id !== id) return false
      if (toast.message !== message) revisions.push(message)
      toast.message = message
      Object.assign(toast, more)
      details.push(more.detail ?? '')
      return true
    },
    openOverlay: (request: unknown) => void overlays.push(request)
  }
  for (const name of RUN_METHODS) own[name] = shell[name]
  const fake = fakeBrowser(own)
  own['self'] = fake.self
  // The other window is in the group only when a test gives it pages: the launch code reads more of a window than this one needs.
  own['group'] = new Set(elsewhere.length > 0 ? [fake.self, other] : [fake.self])
  const call = <T>(name: string, ...args: unknown[]): T => shell[name]!.call(fake.self, ...args) as T
  return {
    self: fake.self,
    calls: fake.calls,
    state,
    pages,
    otherPages,
    frozen,
    toasts,
    revisions,
    details,
    overlays,
    slept,
    asked,
    thawed,
    messages: () => toasts.map((toast) => toast.message),
    last: () => toasts.at(-1)!,
    reload: (wake = false, onlySpace = false) => call<Promise<{ reloaded: number; kept: number; woken: number }>>('reloadAllTabs', 0, wake, onlySpace),
    run: () => own['reloadRun'],
    call,
    /** What the snapshot says of the run (its view, the sites found) and the marks of the rows. */
    told: () => call<{ reloadRun?: { done: number; total: number; phase: string; spaceId?: string; stopping?: true }; deadTabs?: unknown[] }>('reloadOfSnapshot'),
    marks: () => call<{ reloadMarks?: Record<string, string> }>('withReloadMarks', { tabs: {}, canGoBack: false, canGoForward: false }).reloadMarks
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  setLanguage('fr')
  pressure.level = 'normal'
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the pages of the other windows of the group', () => {
  // Reload All Tabs counted a page of another window as awake (it has an owner) and then reloaded none of them: only the tabs of the window that was
  // clicked were reloaded, and the notice said so (« 4 onglets actualisés ») while dozens of other pages stood still.
  it('are reloaded where they live, like the pages of the window that was clicked', async () => {
    const w = windowWith({ awake: ['a', 'b'], elsewhere: ['x', 'y', 'z'] })
    const done = w.reload(true)
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ reloaded: 5, kept: 0, woken: 0 })
    expect([...w.pages.values()].map((page) => page.reloads)).toEqual([1, 1])
    expect([...w.otherPages.values()].map((page) => page.reloads)).toEqual([1, 1, 1])
    expect(w.last().message).toBe(reloadAllNotice(5, 0, 0))
  })
})

describe('the notice of a run', () => {
  it('comes at the click, before any page is reloaded, with the number of tabs the run covers, and the end replaces it', async () => {
    const w = windowWith({ awake: ['a', 'b'], asleep: ['s1', 's2', 's3'] })
    const done = w.reload(true)
    expect(w.messages()).toEqual([reloadProgressNotice(0, 5)])
    expect(w.toasts[0]!.action?.label).toBe(t('reload-all.arreter'))
    expect([...w.pages.values()].every((page) => page.reloads === 0)).toBe(true)
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ reloaded: 2, kept: 0, woken: 3 })
    expect(w.last().message).toBe(reloadAllNotice(2, 0, 3))
    expect(w.run()).toBeNull()
  })

  it('says how far the run is as it goes, every two seconds at most, in the notice it showed (not a new one each time)', async () => {
    // 18 sleeping tabs that load for 3 s each, 8 at a time: three rounds, nine seconds.
    const asleep = Array.from({ length: 18 }, (_, i) => `s${i}`)
    const w = windowWith({ asleep, loadMs: 3000 })
    const done = w.reload(true)
    await vi.advanceTimersByTimeAsync(2999)
    expect(w.revisions).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    // Eight tabs came back in the same moment: the notice changed once, not eight times.
    expect(w.revisions).toEqual([reloadProgressNotice(1, 18)])
    await vi.advanceTimersByTimeAsync(3000)
    expect(w.revisions).toEqual([reloadProgressNotice(1, 18), reloadProgressNotice(1 + RELOAD_ALL_AWAKE_MAX, 18)])
    await vi.runAllTimersAsync()
    await done
    // One notice at the click, one at the end: the progress changed the words of the first, it never brought a new one in.
    expect(w.toasts).toHaveLength(2)
    expect(w.revisions).toHaveLength(3)
    expect(RELOAD_ALL_PROGRESS_MS).toBe(2000)
  })

  it('is not brought back for a progress once the person closed it (or another notice took its place)', async () => {
    const w = windowWith({ asleep: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], loadMs: 3000 })
    const done = w.reload(true)
    ;(w.self as Record<string, unknown>)['toast'] = null
    await vi.runAllTimersAsync()
    await done
    expect(w.revisions).toEqual([])
    expect(w.messages()).toEqual([reloadProgressNotice(0, 7), reloadAllNotice(0, 0, 7)])
  })
})

describe('a second request while a run goes on', () => {
  it('starts nothing, and says that the run is under way and how far it is, with « Arrêter »', async () => {
    const answers = new Map<string, ReturnType<typeof deferred<boolean>>>()
    const w = windowWith({ awake: ['a', 'b'], edit: (id) => (answers.set(id, deferred<boolean>()), answers.get(id)!.promise) })
    const first = w.reload()
    await vi.advanceTimersByTimeAsync(0)
    answers.get('a')!.resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(await w.reload()).toEqual({ reloaded: 0, kept: 0, woken: 0 })
    expect(w.last().message).toBe(reloadBusyNotice(1, 2))
    expect(w.last().action?.label).toBe(t('reload-all.arreter'))
    // The second request asked no page anything: only the two of the first run were asked.
    expect(w.asked).toEqual(['a', 'b'])
    answers.get('b')!.resolve(false)
    await vi.runAllTimersAsync()
    expect(await first).toEqual({ reloaded: 2, kept: 0, woken: 0 })
    expect(w.last().message).toBe(reloadAllNotice(2, 0, 0))
  })
})

describe('« Arrêter »', () => {
  it('starts no tab after it: the ones under way end their turn, and the end says how many were left', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const answers = new Map<string, ReturnType<typeof deferred<boolean>>>()
    const w = windowWith({ awake: ids, edit: (id) => (answers.set(id, deferred<boolean>()), answers.get(id)!.promise) })
    const done = w.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.asked).toHaveLength(RELOAD_ALL_ASK_MAX)
    w.toasts[0]!.action!.run()
    expect(w.last().message).toBe(t('reload-all.arret-en-cours'))
    for (const answer of answers.values()) answer.resolve(false)
    await vi.runAllTimersAsync()
    const counts = await done
    expect(w.asked).toHaveLength(RELOAD_ALL_ASK_MAX)
    expect(counts.reloaded).toBe(RELOAD_ALL_ASK_MAX)
    expect(w.last().message).toBe(reloadEndNotice(reloadAllNotice(RELOAD_ALL_ASK_MAX, 0, 0), 'stopped', ids.length - RELOAD_ALL_ASK_MAX))
    expect(w.run()).toBeNull()
  })
})

describe('the bound of a run', () => {
  it('ends a run that waits for ever, says so, and the next request starts afresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let hang = true
    const w = windowWith({ awake: ['a', 'b'], edit: () => (hang ? new Promise<boolean>(() => undefined) : Promise.resolve(false)) })
    const done = w.reload()
    await vi.advanceTimersByTimeAsync(RELOAD_ALL_TOTAL_LIMIT_MS - 1)
    expect(w.run()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toEqual({ reloaded: 0, kept: 0, woken: 0 })
    expect(w.run()).toBeNull()
    expect(w.last().message).toBe(reloadEndNotice(reloadAllNotice(0, 0, 0), 'timeout', 2, false))
    expect(w.last().message).toBe(frenchSpaces('Actualisation interrompue au bout de 10 min : 2 onglets non traités'))
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[reload-all] the run did not end within 10 min'))).toBe(true)
    hang = false
    const again = w.reload()
    expect(w.last().message).toBe(reloadProgressNotice(0, 2))
    await vi.runAllTimersAsync()
    expect(await again).toEqual({ reloaded: 2, kept: 0, woken: 0 })
  })

  it('lets the button answer again after a run that failed', async () => {
    const w = windowWith({ asleep: ['s1'] })
    ;(w.self as Record<string, unknown>)['wakeAndReload'] = () => Promise.reject(new Error('engine gone'))
    await expect(w.reload(true)).rejects.toThrow('engine gone')
    expect(w.run()).toBeNull()
    ;(w.self as Record<string, unknown>)['wakeAndReload'] = shell['wakeAndReload']
    const again = w.reload(true)
    await vi.runAllTimersAsync()
    expect(await again).toEqual({ reloaded: 0, kept: 0, woken: 1 })
  })

  it('gives the place of a woken tab that never comes back to the next one, and the log names it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const frozen = Array.from({ length: RELOAD_ALL_AWAKE_MAX + 1 }, (_, i) => `f${i}`)
    const w = windowWith({ frozen })
    // The protocol never answers the thaw of these pages.
    for (const page of w.pages.values()) page.thaw = () => new Promise<void>(() => undefined)
    const done = w.reload(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.thawed).toHaveLength(RELOAD_ALL_AWAKE_MAX)
    await vi.advanceTimersByTimeAsync(RELOAD_ALL_TAB_LIMIT_MS)
    expect(w.thawed).toEqual(frozen)
    await vi.advanceTimersByTimeAsync(RELOAD_ALL_TAB_LIMIT_MS)
    expect(await done).toMatchObject({ woken: frozen.length })
    expect(warn.mock.calls.some((call) => String(call[0]) === `[reload-all] tab f0 did not come back within ${RELOAD_ALL_TAB_LIMIT_MS / 1000} s: its place goes to the next one`)).toBe(true)
  })

  it('writes in the log the tab whose reload failed, and goes on with the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const w = windowWith({ awake: ['a', 'b'] })
    w.pages.get('a')!.reload = () => {
      throw new Error('page gone')
    }
    const done = w.reload()
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ reloaded: 1, kept: 0, woken: 0 })
    expect(warn).toHaveBeenCalledWith('[reload-all] tab a could not be reloaded:', 'page gone')
    expect(w.last().message).toBe(reloadAllNotice(1, 0, 0))
  })
})

describe('the tabs whose site no longer answers, after a run', () => {
  const NOT_FOUND: LoadFailure = { kind: 'network', name: 'ERR_NAME_NOT_RESOLVED' }

  it('are offered once the run has ended, a woken one as well as an awake one, even though the woken one went back to sleep', async () => {
    const w = windowWith({ awake: ['a', 'b'], asleep: ['s1', 's2'], failures: { b: NOT_FOUND, s2: { kind: 'network', name: 'ERR_CONNECTION_REFUSED' } } })
    const done = w.reload(true)
    await vi.runAllTimersAsync()
    await done
    expect(w.slept).toEqual(['s1', 's2'])
    expect(w.last().message).toBe(deadTabsNotice(2))
    expect(w.last().action?.label).toBe(deadTabsOfferLabel(2))
    w.last().action!.run()
    expect(w.overlays).toEqual([{ panel: 'deadtabs', entries: [{ id: 'b', reason: 'not-found' }, { id: 's2', reason: 'refused' }] }])
  })

  it('looks at the pages just reloaded only once their load has had the time to start: before, they still show what they showed', async () => {
    // The engine says that a load started a moment after the reload was asked.
    const w = windowWith({ awake: ['a', 'b'], failures: { b: NOT_FOUND }, loadMs: 5000, startMs: 300 })
    const done = w.reload()
    await vi.advanceTimersByTimeAsync(0)
    await done
    await vi.advanceTimersByTimeAsync(DEAD_TABS_FIRST_LOOK_MS)
    expect(w.last().message).toBe(reloadAllNotice(2, 0, 0))
    await vi.runAllTimersAsync()
    expect(w.last().message).toBe(deadTabsNotice(1))
  })

  it('are not offered while the network is down, nor while the list is open, nor in a private window', async () => {
    for (const blocked of [{ networkOnline: () => false }, { overlayRequest: { panel: 'deadtabs', entries: [] } }, { isPrivate: () => true }]) {
      const w = windowWith({ awake: ['a', 'b'], failures: { b: NOT_FOUND } })
      Object.assign(w.self, blocked)
      const done = w.reload()
      await vi.runAllTimersAsync()
      await done
      expect(w.last().message, JSON.stringify(Object.keys(blocked))).toBe(reloadAllNotice(2, 0, 0))
    }
  })

  it('opens the list with the tabs still open at the click of the notice, pinned since or not, but not one that became the page of a favourite', async () => {
    const w = windowWith({ awake: ['a', 'b', 'c', 'd', 'ok'], failures: { a: NOT_FOUND, b: NOT_FOUND, c: NOT_FOUND, d: NOT_FOUND } })
    const done = w.reload()
    await vi.runAllTimersAsync()
    await done
    w.state.tabs = w.state.tabs.filter((tab) => tab.id !== 'a').map((tab) => (tab.id === 'b' ? { ...tab, pinned: true } : tab.id === 'd' ? { ...tab, favoriteId: 'fav' } : tab))
    w.last().action!.run()
    expect(w.overlays).toEqual([{ panel: 'deadtabs', entries: [{ id: 'b', reason: 'not-found' }, { id: 'c', reason: 'not-found' }] }])
  })

  it('are offered after the load of every tab at launch too, once they had the time to settle', async () => {
    const w = windowWith({ asleep: ['s1', 's2'], failures: { s1: NOT_FOUND }, settings: { loadAllTabsAtLaunch: true }, loadMs: 20_000 })
    expect(shell['wakeAtLaunch']!.call(w.self)).toEqual(['s1', 's2'])
    await vi.advanceTimersByTimeAsync(DEAD_TABS_FIRST_LOOK_MS + 15_000)
    expect(w.toasts).toEqual([])
    await vi.advanceTimersByTimeAsync(DEAD_TABS_LAUNCH_SETTLE_MS)
    expect(w.last().message).toBe(deadTabsNotice(1))
  })

  // Dozens of pages made in the same instant came on screen as black rectangles until they were reloaded: the tabs that wake with the application are made
  // by small batches, a few seconds apart.
  it('wakes the tabs of the launch by batches a few seconds apart, not all at once', async () => {
    const ids = Array.from({ length: LAUNCH_WAKE_BATCH * 2 + 2 }, (_, i) => `t${i}`)
    const w = windowWith({ asleep: ids, settings: { loadAllTabsAtLaunch: true } })
    shell['wakeAtLaunch']!.call(w.self)
    expect(w.pages.size).toBe(LAUNCH_WAKE_BATCH)
    await vi.advanceTimersByTimeAsync(LAUNCH_WAKE_GAP_MS)
    expect(w.pages.size).toBe(LAUNCH_WAKE_BATCH * 2)
    await vi.advanceTimersByTimeAsync(LAUNCH_WAKE_GAP_MS)
    expect(w.pages.size).toBe(ids.length)
  })

  it('are not looked for at launch without « Charger tous les onglets au lancement »', async () => {
    const w = windowWith({ asleep: ['s1'], tabs: [tabItem('s1', { keepAwake: true })], failures: { s1: NOT_FOUND } })
    expect(shell['wakeAtLaunch']!.call(w.self)).toEqual(['s1'])
    await vi.runAllTimersAsync()
    expect(w.toasts).toEqual([])
  })
})

describe('the two phases of a run', () => {
  it('reloads the awake tabs first, then says at once that it turns to the sleeping ones, with the count and the bar', async () => {
    const asleep = Array.from({ length: 4 }, (_, i) => `s${i}`)
    const w = windowWith({ awake: ['a', 'b'], asleep, loadMs: 3000 })
    const done = w.reload(true)
    // At the click: the count of every tab, the phase of the awake ones, an empty bar.
    expect(w.toasts[0]).toMatchObject({ message: reloadProgressNotice(0, 6), detail: reloadPhaseDetail('awake'), progress: { done: 0, total: 6 } })
    expect(w.told().reloadRun).toEqual({ done: 0, total: 6, phase: 'awake' })
    await vi.advanceTimersByTimeAsync(0)
    // The awake ones were asked before any sleeping tab was woken.
    expect(w.asked.slice(0, 2)).toEqual(['a', 'b'])
    expect(w.told().reloadRun).toMatchObject({ done: 2, phase: 'sleeping' })
    // The turn of the phase did not wait for the two seconds between two progresses.
    expect(w.last()).toMatchObject({ detail: reloadPhaseDetail('sleeping', { afterAwake: true }), progress: { done: 2, total: 6 } })
    expect(w.last().detail).toBe(frenchSpaces('Onglets éveillés actualisés. Onglets en veille : réveil et rechargement'))
    await vi.runAllTimersAsync()
    await done
    expect(w.told().reloadRun).toBeUndefined()
  })

  it('tells the time left of the sleeping tabs once eight of them took ten seconds, and not before', async () => {
    // 40 sleeping tabs that load in 3 s, 8 at a time: 8 more every 3 s.
    const w = windowWith({ asleep: Array.from({ length: 40 }, (_, i) => `s${i}`), loadMs: 3000 })
    const done = w.reload(true)
    await vi.advanceTimersByTimeAsync(9000)
    expect(w.last().detail).toBe(reloadPhaseDetail('sleeping'))
    await vi.advanceTimersByTimeAsync(3000)
    // 32 done in 12 s: 8 left, 3 s.
    expect(w.last().detail).toBe(frenchSpaces('Onglets en veille : réveil et rechargement, moins d’une minute restante'))
    await vi.runAllTimersAsync()
    await done
  })
})

describe('what the interface is told of a run', () => {
  it('marks every row of the run to come at the click, under way during its turn, « Actualisé » a moment after, and nothing then', async () => {
    const w = windowWith({ awake: ['a'], asleep: ['s1', 's2'], loadMs: 3000 })
    const done = w.reload(true)
    // The awake page is asked at once whether a field is being edited: its turn has begun.
    expect(w.marks()).toEqual({ a: 'running', s1: 'pending', s2: 'pending' })
    await vi.advanceTimersByTimeAsync(0)
    // The awake page was asked to reload (its row shows its own loading ring); the sleeping ones were woken and load.
    expect(w.marks()).toEqual({ a: 'reloaded', s1: 'running', s2: 'running' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(w.slept).toEqual(['s1', 's2'])
    expect(w.marks()).toEqual({ a: 'reloaded', s1: 'reloaded', s2: 'reloaded' })
    await done
    expect(w.run()).toBeNull()
    // The run has ended: its last rows keep their mark a moment, then the window is told once more.
    expect(w.marks()).toEqual({ a: 'reloaded', s1: 'reloaded', s2: 'reloaded' })
    const published = w.calls.filter((c) => c.name === 'publish').length
    await vi.advanceTimersByTimeAsync(RELOAD_ALL_DONE_MARK_MS)
    expect(w.marks()).toBeUndefined()
    expect(w.calls.filter((c) => c.name === 'publish').length).toBeGreaterThan(published)
  })

  it('gives no mark « Actualisé » to a tab left alone because a field is being edited in it', async () => {
    const w = windowWith({ awake: ['typing', 'b'], edit: (id) => Promise.resolve(id === 'typing') })
    const done = w.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.marks()).toEqual({ b: 'reloaded' })
    await vi.runAllTimersAsync()
    await done
  })

  it('names the space of the button of one space, and says once « Arrêter » is pressed that the run is stopping', async () => {
    const w = windowWith({ asleep: ['s1', 's2', 's3'], loadMs: 3000 })
    const done = w.reload(true, true)
    expect(w.told().reloadRun).toMatchObject({ spaceId: w.state.activeSpaceId })
    await vi.runAllTimersAsync()
    await done
    const all = windowWith({ asleep: ['s1', 's2', 's3'], loadMs: 3000 })
    const running = all.reload(true)
    await vi.advanceTimersByTimeAsync(0)
    all.toasts[0]!.action!.run()
    expect(all.told().reloadRun).toMatchObject({ stopping: true })
    await vi.runAllTimersAsync()
    await running
  })
})

describe('a click on the button while its run goes on', () => {
  it('brings its notice back with « Arrêter », the phase and the bar, and starts nothing', async () => {
    const w = windowWith({ awake: ['a'], asleep: ['s1', 's2'], loadMs: 3000 })
    const first = w.reload(true)
    await vi.advanceTimersByTimeAsync(0)
    // The person closed the notice; the button still turns (the run is in the snapshot), and a click on it answers.
    ;(w.self as Record<string, unknown>)['toast'] = null
    expect(w.told().reloadRun).toMatchObject({ done: 1, total: 3 })
    expect(await w.reload(true)).toEqual({ reloaded: 0, kept: 0, woken: 0 })
    expect(w.last()).toMatchObject({ message: reloadBusyNotice(1, 3), detail: reloadPhaseDetail('sleeping', { afterAwake: true }), progress: { done: 1, total: 3 } })
    expect(w.last().action?.label).toBe(t('reload-all.arreter'))
    expect(w.pages.get('a')!.reloads).toBe(1)
    w.last().action!.run()
    await vi.runAllTimersAsync()
    await first
  })
})

describe('the sleeping tabs a run wakes', () => {
  it('are fewer at once when macOS says the memory is short', async () => {
    for (const [level, most] of [['normal', RELOAD_ALL_AWAKE_MAX], ['warning', 3], ['critical', 1]] as const) {
      pressure.level = level
      const w = windowWith({ asleep: Array.from({ length: 12 }, (_, i) => `s${i}`), loadMs: 3000 })
      const done = w.reload(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(w.pages.size, level).toBe(most)
      await vi.runAllTimersAsync()
      await done
      expect(w.slept, level).toHaveLength(12)
    }
  })

  it('leave out a locked space: its tabs are not counted, and no page of them is made', async () => {
    const w = windowWith({ tabs: [tabItem('free'), tabItem('secret', { spaceId: 'locked' })] })
    const self = w.self as Record<string, unknown>
    self['sleepingTabIds'] = shell['sleepingTabIds']
    self['isTabLocked'] = (tab: TabItem) => tab.spaceId === 'locked'
    const done = w.reload(true)
    // The notice at the click counts the tabs of the run: the locked one is not among them.
    expect(w.messages()).toEqual([reloadProgressNotice(0, 1)])
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ reloaded: 0, kept: 0, woken: 1 })
    expect([...w.pages.keys()]).not.toContain('secret')
    expect(w.slept).toEqual(['free'])
  })

  it('leave alone a tab whose space is locked while the run goes on', async () => {
    // The list was made before the lock: the turn of the tab comes after it.
    const w = windowWith({ asleep: ['free', 'secret'] })
    ;(w.self as Record<string, unknown>)['isTabLocked'] = (tab: TabItem) => tab.id === 'secret'
    const done = w.reload(true)
    await vi.runAllTimersAsync()
    expect(await done).toMatchObject({ woken: 1 })
    expect(w.slept).toEqual(['free'])
  })

  it('ask a page frozen by hand whether a field holds text before reloading it, and freeze it again as it was when it does', async () => {
    const frozenAgain: string[] = []
    const w = windowWith({ frozen: ['draft', 'idle'], edit: (id) => Promise.resolve(id === 'draft') })
    ;(w.self as Record<string, unknown>)['freezePage'] = async (id: string) => (frozenAgain.push(id), true)
    const done = w.reload(true)
    await vi.runAllTimersAsync()
    expect(await done).toEqual({ reloaded: 0, kept: 1, woken: 2 })
    expect(w.asked).toEqual(['draft', 'idle'])
    expect(w.pages.get('draft')!.reloads).toBe(0)
    expect(frozenAgain).toEqual(['draft'])
    expect(w.thawed).toEqual(['draft', 'idle'])
  })
})

describe('a woken tab going back to sleep', () => {
  /** A woken tab `a` with its page, the sleep allowing it, in this mode. */
  function wokenWindow(sleepMode: 'discard' | 'freeze') {
    const frozenNow: string[] = []
    const destroyed: string[] = []
    const page = {}
    const base = createInitialState({ now: 0, newId: () => 'x' })
    const state: SidebarState = { ...base, tabs: [tabItem('a')], settings: { ...defaultSettings(), sleepMode } }
    const own: Record<string, unknown> = {
      store: { get: () => state },
      pages: new Map([['a', page]]),
      frozen: new Set<string>(),
      idleSince: new Map<string, number>(),
      autoVerdict: async () => ({ sleep: true }),
      freezePage: async (id: string) => (frozenNow.push(id), true),
      destroyPage: (id: string) => void destroyed.push(id)
    }
    own['sleepAgain'] = shell['sleepAgain']
    const fake = fakeBrowser(own)
    return { again: (wasFrozen: boolean) => shell['sleepAgain']!.call(fake.self, 'a', page, undefined, wasFrozen) as Promise<void>, frozenNow, destroyed }
  }

  it('loses its page again when it had none, even in the mode « Garder en mémoire »: a run of every tab keeps no page for each', async () => {
    const w = wokenWindow('freeze')
    await w.again(false)
    expect(w.destroyed).toEqual(['a'])
    expect(w.frozenNow).toEqual([])
  })

  it('is frozen again when it was frozen in the mode « Garder en mémoire », and freed in the mode that frees the memory', async () => {
    const kept = wokenWindow('freeze')
    await kept.again(true)
    expect(kept.frozenNow).toEqual(['a'])
    expect(kept.destroyed).toEqual([])
    const freed = wokenWindow('discard')
    await freed.again(true)
    expect(freed.destroyed).toEqual(['a'])
  })
})

describe('the sites found not to answer before a long run ends', () => {
  const NOT_FOUND: LoadFailure = { kind: 'network', name: 'ERR_NAME_NOT_RESOLVED' }

  it('are told in the notice of the run once the awake tabs have settled, with a button that shows them, while the sleeping ones are still woken', async () => {
    const asleep = Array.from({ length: 24 }, (_, i) => `s${i}`)
    const w = windowWith({ awake: ['a', 'dead'], asleep, failures: { dead: NOT_FOUND }, loadMs: 5000 })
    const done = w.reload(true)
    // The awake pages end their load at 5 s and are looked at a moment later; the woken ones come back at 5 s and 10 s, so the notice changed at 5 s and
    // waits for nothing else than its two seconds to say what was found: before 7.5 s, not at the next round of the sleeping ones.
    await vi.advanceTimersByTimeAsync(7500)
    expect(w.run()).not.toBeNull()
    expect(w.last().detail).toBe(reloadDetailWithDead(reloadPhaseDetail('sleeping', { afterAwake: true }), 1))
    expect(w.last().second?.label).toBe(deadTabsOfferLabel(1))
    expect(w.told().deadTabs).toEqual([{ id: 'dead', reason: 'not-found' }])
    w.last().second!.run()
    expect(w.overlays).toEqual([{ panel: 'deadtabs', entries: [{ id: 'dead', reason: 'not-found' }] }])
    await vi.runAllTimersAsync()
    await done
  })

  it('grow as the woken tabs come back, so that a list open meanwhile adds them', async () => {
    const asleep = ['ok1', 'gone', ...Array.from({ length: 20 }, (_, i) => `s${i}`)]
    const w = windowWith({ asleep, failures: { gone: NOT_FOUND }, loadMs: 3000 })
    const done = w.reload(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(w.run()).not.toBeNull()
    expect(w.told().deadTabs).toEqual([{ id: 'gone', reason: 'not-found' }])
    await vi.runAllTimersAsync()
    await done
    // At the end, the notice offers them as before.
    expect(w.last().message).toBe(deadTabsNotice(1))
  })

  it('include the pinned tabs whose site no longer resolves (the test servers of the maintainer), and not the page of a favourite', async () => {
    const tabs = [tabItem('ppd', { pinned: true }), tabItem('fav', { pinned: true, favoriteId: 'f1' }), tabItem('ok')]
    const w = windowWith({ asleep: ['ppd', 'fav', 'ok'], tabs, failures: { ppd: NOT_FOUND, fav: NOT_FOUND } })
    const done = w.reload(true)
    await vi.runAllTimersAsync()
    await done
    expect(w.last().message).toBe(deadTabsNotice(1))
    w.last().action!.run()
    expect(w.overlays).toEqual([{ panel: 'deadtabs', entries: [{ id: 'ppd', reason: 'not-found' }] }])
  })
})

describe('« Dégeler l’onglet »', () => {
  const SLEEP_METHODS = ['thawTab', 'sweepOnce', 'sleepFacts', 'autoVerdict', 'sleepRules', 'sweepEntries', 'sweepPlan', 'frozenMayGo', 'freezeFirst', 'freezePage', 'isShown', 'thawPage', 'setAwake', 'releasePage'] as const
  const MINUTE = 60_000

  /** A window whose tab `a` was frozen by the sweep an hour ago (left an hour ago), with the delays of the settings. */
  function frozenWindow(settings: Partial<Settings> = { sleepFreezeAfterMinutes: 5, sleepAfterMinutes: 30, sleepMode: 'discard', sleepNotify: false }, locked = false) {
    const thaws: string[] = []
    const freezes: string[] = []
    const destroyed: string[] = []
    const page = {
      probeForSleep: async () => ({ pictureInPicture: false, unsentInput: false }),
      freeze: async () => (freezes.push('a'), true),
      thaw: async () => void thaws.push('a'),
      usesCapture: () => false
    }
    const pages = new Map([['a', page]])
    const base = createInitialState({ now: 0, newId: () => 'x' })
    const state: SidebarState = { ...base, tabs: [tabItem('a')], settings: { ...defaultSettings(), ...settings } }
    const own: Record<string, unknown> = {
      store: { get: () => state },
      pages,
      idleSince: new Map([['a', Date.now() - 60 * MINUTE]]),
      frozen: new Set(['a']),
      autoFrozen: new Set(['a']),
      visible: new Set<string>(),
      shownTabId: 'none',
      runtime: { tabs: { a: { loading: false, awake: false, frozen: true, audible: false, muted: false } }, canGoBack: false, canGoForward: false },
      downloadSources: new Map<string, string>(),
      sleepKept: new Map<string, number>(),
      isTabLocked: () => locked,
      destroyPage: (id: string) => {
        destroyed.push(id)
        pages.delete(id)
      }
    }
    for (const name of SLEEP_METHODS) own[name] = shell[name]
    const fake = fakeBrowser(own)
    own['group'] = new Set([fake.self])
    own['leader'] = fake.self
    own['ownerOf'] = (id: string) => (pages.has(id) ? fake.self : undefined)
    return { self: fake.self, own, thaws, freezes, destroyed, calls: fake.calls }
  }

  it('lets the frozen page run again where it is, shows the tab awake and tells the interface, without showing or reloading it', async () => {
    const w = frozenWindow()
    expect(await shell['thawTab']!.call(w.self, 'a')).toBe(true)
    expect(w.thaws).toEqual(['a'])
    expect((w.own['frozen'] as Set<string>).has('a')).toBe(false)
    expect((w.own['runtime'] as { tabs: Record<string, unknown> }).tabs['a']).toMatchObject({ awake: true })
    expect((w.own['runtime'] as { tabs: Record<string, { frozen?: boolean }> }).tabs['a']!.frozen).toBeUndefined()
    const names = w.calls.map((call) => call.name)
    expect(names).toContain('publish')
    expect(names.filter((name) => /dispatch|reload|activatePage|layout/.test(name))).toEqual([])
  })

  it('starts the delays again from now: the next sweep neither freezes it again nor frees it', async () => {
    const w = frozenWindow()
    await shell['thawTab']!.call(w.self, 'a')
    expect(await shell['sweepOnce']!.call(w.self)).toEqual([])
    expect(w.freezes).toEqual([])
    expect(w.destroyed).toEqual([])
    // Without the delays started again, the same sweep frees the page left an hour ago.
    const control = frozenWindow()
    await shell['thawTab']!.call(control.self, 'a')
    ;(control.own['idleSince'] as Map<string, number>).set('a', Date.now() - 60 * MINUTE)
    expect(await shell['sweepOnce']!.call(control.self)).toEqual(['a'])
  })

  it('does nothing for a tab that is not frozen, that is gone, or of a locked space', async () => {
    const awake = frozenWindow()
    ;(awake.own['frozen'] as Set<string>).clear()
    expect(await shell['thawTab']!.call(awake.self, 'a')).toBe(false)
    expect(await shell['thawTab']!.call(frozenWindow().self, 'gone')).toBe(false)
    const locked = frozenWindow(undefined, true)
    expect(await shell['thawTab']!.call(locked.self, 'a')).toBe(false)
    expect(locked.thaws).toEqual([])
  })

  it('thaws the page in the window of the group that holds it', async () => {
    const holder = frozenWindow()
    const other = frozenWindow()
    ;(other.own['pages'] as Map<string, unknown>).clear()
    other.own['ownerOf'] = () => holder.self
    expect(await shell['thawTab']!.call(other.self, 'a')).toBe(true)
    expect(holder.thaws).toEqual(['a'])
  })
})
