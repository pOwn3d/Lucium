// The sleep sweep of a window (browser-sleep.ts, `sweepOnce`) run on stand-ins of the class Browser (browser-fake.test-support.ts), with pages that
// answer at once: the cap counts the pages of every window of the group, a page frozen first is freed at the delay without being asked, and the
// memory pressure read at the sweep shortens the delay and lowers the cap. The rules themselves are tested in shared/sleep.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings, type SidebarState, type TabItem } from '@shared/model'
import { t } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import type { MemoryPressure, PageProbe } from '@shared/sleep'
import { fakeBrowser, methodsOf, type Call } from './browser-fake.test-support'

const pressure = vi.hoisted(() => ({ now: 'normal' as MemoryPressure }))

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
vi.mock('./sleep-pressure', () => ({ memoryPressure: () => Promise.resolve(pressure.now) }))
vi.mock('./battery-saver', () => ({ batterySaver: () => ({ active: () => false }) }))

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)
const SLEEP_METHODS = ['sweepOnce', 'sleepFacts', 'autoVerdict', 'sleepRules', 'sweepEntries', 'sweepPlan', 'frozenMayGo', 'freezeFirst', 'freezePage', 'isShown', 'releasePage', 'showSleepToast'] as const

const MINUTE = 60_000
const CLEAN: PageProbe = { pictureInPicture: false, unsentInput: false }

interface FakePage {
  asked: number
  frozen: boolean
  probe: PageProbe
  probeForSleep(): Promise<PageProbe | null>
  freeze(): Promise<boolean>
  thaw(): Promise<void>
  usesCapture(): boolean
}

const page = (probe: PageProbe = CLEAN, capturing = false): FakePage => {
  const made: FakePage = {
    asked: 0,
    frozen: false,
    probe,
    probeForSleep: () => {
      made.asked++
      return Promise.resolve(made.frozen ? null : made.probe)
    },
    freeze: () => {
      made.frozen = true
      return Promise.resolve(true)
    },
    thaw: () => {
      made.frozen = false
      return Promise.resolve()
    },
    usesCapture: () => capturing
  }
  return made
}

const tabItem = (id: string, url = `https://${id}.example.org/`): TabItem => ({ id, spaceId: 'espace', url, title: id, pinned: false, createdAt: 1, lastActiveAt: 1 })

interface Window {
  self: Record<string, unknown>
  /** What the window called that the test did not give it (its notices, among them). */
  calls: Call[]
  pages: Map<string, FakePage>
  destroyed: string[]
}

/** A window of the group holding these pages, each left `minutes` ago. `shown` is on screen. */
function windowWith(state: SidebarState, pages: Record<string, { minutes: number; page?: FakePage }>, shown = 'none'): Window {
  const map = new Map(Object.entries(pages).map(([id, entry]) => [id, entry.page ?? page()]))
  const idleSince = new Map(Object.entries(pages).map(([id, entry]) => [id, Date.now() - entry.minutes * MINUTE]))
  const destroyed: string[] = []
  const own: Record<string, unknown> = {
    store: { get: () => state },
    pages: map,
    idleSince,
    frozen: new Set<string>(),
    autoFrozen: new Set<string>(),
    visible: new Set<string>([shown]),
    shownTabId: shown,
    runtime: { tabs: {}, canGoBack: false, canGoForward: false },
    downloadSources: new Map<string, string>(),
    sleepKept: new Map<string, number>(),
    destroyPage: (id: string) => {
      destroyed.push(id)
      map.delete(id)
    }
  }
  for (const name of SLEEP_METHODS) own[name] = shell[name]
  const fake = fakeBrowser(own)
  return { self: fake.self, calls: fake.calls, pages: map, destroyed }
}

/** Puts the windows in one group, the first one leading. */
function group(...windows: Window[]): void {
  const members = new Set(windows.map((window) => window.self))
  for (const window of windows) {
    window.self['group'] = members
    window.self['leader'] = windows[0]!.self
  }
}

function stateWith(ids: string[], settings: Partial<Settings> = {}, urls: Record<string, string> = {}): SidebarState {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  return { ...base, tabs: ids.map((id) => tabItem(id, urls[id])), settings: { ...defaultSettings(), sleepNotify: false, ...settings } }
}

const sweep = (window: Window): Promise<string[]> => shell['sweepOnce']!.call(window.self) as Promise<string[]>

afterEach(() => {
  pressure.now = 'normal'
})

describe('the sleep sweep of a window', () => {
  it('puts to sleep, before their delay, the tabs beyond the cap that were left the longest ago, counting the pages of every window', async () => {
    const state = stateWith(['a', 'b', 'c', 'd', 'e'], { sleepAwakeMax: 3 })
    const first = windowWith(state, { a: { minutes: 9 }, b: { minutes: 1 } })
    const second = windowWith(state, { c: { minutes: 8 }, d: { minutes: 2 }, e: { minutes: 3 } })
    group(first, second)
    // Five pages for a cap of three: the two oldest (a, then c) go, each by the window that holds it.
    expect(await sweep(first)).toEqual(['a'])
    expect(await sweep(second)).toEqual(['c'])
    expect([...first.pages.keys(), ...second.pages.keys()].sort()).toEqual(['b', 'd', 'e'])
    // Within the cap, nothing more goes before its delay.
    expect(await sweep(first)).toEqual([])
    expect(await sweep(second)).toEqual([])
  })

  it('never puts to sleep the tab whose video floats in Lucium’s window, told by the main process (its page says it floats nothing)', async () => {
    const state = stateWith(['a', 'b', 'c'], { sleepAfterMinutes: 30, sleepAwakeMax: 1 })
    const floating = page()
    const window = windowWith(state, { a: { minutes: 600, page: floating }, b: { minutes: 600 }, c: { minutes: 600 } })
    group(window)
    window.self['floatingVideo'] = { floatingTab: () => 'a' }
    expect((await sweep(window)).sort()).toEqual(['b', 'c'])
    expect([...window.pages.keys()]).toEqual(['a'])
    // Never asked: what the main process knows comes first.
    expect(floating.asked).toBe(0)
  })

  it('leaves awake a page left for its delay that asks to confirm leaving it (its beforeunload), and marks it as holding something', async () => {
    const state = stateWith(['a', 'b'], { sleepAfterMinutes: 30 })
    const guarded = { ...page(), release: vi.fn(async () => false) }
    const window = windowWith(state, { a: { minutes: 60, page: guarded }, b: { minutes: 60 } })
    group(window)
    expect(await sweep(window)).toEqual(['b'])
    expect(guarded.release).toHaveBeenCalledTimes(1)
    expect([...window.pages.keys()]).toEqual(['a'])
    expect((window.self['sleepKept'] as Map<string, number>).has('a')).toBe(true)
  })

  it('does not count a page that holds text not sent, and remembers it for the next sweeps of the group', async () => {
    const state = stateWith(['a', 'b', 'c'], { sleepAwakeMax: 1 })
    const typing = page({ pictureInPicture: false, unsentInput: true })
    const window = windowWith(state, { a: { minutes: 9, page: typing }, b: { minutes: 5 }, c: { minutes: 1 } })
    group(window)
    // a is over the cap but says it holds text: it stays; b, over the cap too, goes.
    expect(await sweep(window)).toEqual(['b'])
    expect((window.self['sleepKept'] as Map<string, number>).has('a')).toBe(true)
    // Now a does not count: c alone fits the cap, and a is not asked again.
    const asked = typing.asked
    expect(await sweep(window)).toEqual([])
    expect(typing.asked).toBe(asked)
  })

  it('puts every tab nothing protects to sleep under critical pressure, and the ones left for 5 minutes under a warning', async () => {
    const state = stateWith(['a', 'b', 'c', 'shown'])
    const window = windowWith(state, { a: { minutes: 6 }, b: { minutes: 1 }, c: { minutes: 0, page: page(CLEAN, true) }, shown: { minutes: 0 } }, 'shown')
    group(window)
    expect(await sweep(window)).toEqual([])
    pressure.now = 'warning'
    expect(await sweep(window)).toEqual(['a'])
    pressure.now = 'critical'
    // c uses the camera, and the tab on screen stays.
    expect(await sweep(window)).toEqual(['b'])
    expect([...window.pages.keys()].sort()).toEqual(['c', 'shown'])
  })

  it('keeps one tab of a site never put to sleep, the one left last, and lets the others follow the delay', async () => {
    const urls = { m1: 'https://mail.example.com/a', m2: 'https://mail.example.com/b' }
    const state = stateWith(['m1', 'm2'], { sleepExcludedHosts: ['example.com'] }, urls)
    const window = windowWith(state, { m1: { minutes: 40 }, m2: { minutes: 35 } })
    group(window)
    expect(await sweep(window)).toEqual(['m1'])
    expect(await sweep(window)).toEqual([])
    // With "Garder tous les onglets de ces sites", none goes.
    const all = windowWith(stateWith(['m1', 'm2'], { sleepExcludedHosts: ['example.com'], sleepExcludedKeepAll: true }, urls), { m1: { minutes: 40 }, m2: { minutes: 35 } })
    group(all)
    expect(await sweep(all)).toEqual([])
  })

  it('freezes a tab left for the freeze delay, then frees it at the delay without asking the frozen page', async () => {
    const state = stateWith(['a', 'b'], { sleepFreezeAfterMinutes: 5 })
    const frozenFirst = page()
    const window = windowWith(state, { a: { minutes: 6, page: frozenFirst }, b: { minutes: 1 } })
    group(window)
    expect(await sweep(window)).toEqual([])
    expect([...(window.self['frozen'] as Set<string>)]).toEqual(['a'])
    expect([...(window.self['autoFrozen'] as Set<string>)]).toEqual(['a'])
    expect(frozenFirst.frozen).toBe(true)
    const asked = frozenFirst.asked
    ;(window.self['idleSince'] as Map<string, number>).set('a', Date.now() - 31 * MINUTE)
    expect(await sweep(window)).toEqual(['a'])
    expect(frozenFirst.asked).toBe(asked)
    expect(window.destroyed).toEqual(['a'])
  })

  it('tells what it did in the right words: tabs put to sleep, or (mode « Garder en mémoire ») tabs frozen, which are not asleep', async () => {
    const notice = async (settings: Partial<Settings>, minutes: Record<string, number>) => {
      const state = stateWith(Object.keys(minutes), { sleepNotify: true, sleepAfterMinutes: 30, ...settings })
      const window = windowWith(state, Object.fromEntries(Object.entries(minutes).map(([id, left]) => [id, { minutes: left }])))
      group(window)
      await sweep(window)
      const toast = window.calls.find((call) => call.name === 'showToast')
      return { message: toast?.args[0], action: (toast?.args[1] as { label: string } | undefined)?.label }
    }
    expect(await notice({ sleepMode: 'discard' }, { a: 60 })).toEqual({ message: t('sleep.onglet-mis-en-veille'), action: t('sleep.reveiller') })
    expect(await notice({ sleepMode: 'discard' }, { a: 60, b: 60 })).toEqual({ message: t('sleep.count-onglets-mis-en-veille', { count: 2 }), action: undefined })
    expect(await notice({ sleepMode: 'freeze' }, { a: 60 })).toEqual({ message: t('sleep.onglet-gele'), action: t('sleep.degeler') })
    expect(await notice({ sleepMode: 'freeze' }, { a: 60, b: 60 })).toEqual({ message: t('sleep.count-onglets-geles', { count: 2 }), action: undefined })
    expect(t('sleep.onglet-gele')).toBe('Onglet gelé')
  })

  it('never freezes a tab that uses the camera or plays sound, and leaves a page frozen by hand as it is', async () => {
    const state = stateWith(['cam', 'byHand'], { sleepFreezeAfterMinutes: 5 })
    const window = windowWith(state, { cam: { minutes: 6, page: page(CLEAN, true) }, byHand: { minutes: 90 } })
    ;(window.self['frozen'] as Set<string>).add('byHand')
    group(window)
    expect(await sweep(window)).toEqual([])
    expect([...(window.self['frozen'] as Set<string>)]).toEqual(['byHand'])
    expect(window.destroyed).toEqual([])
  })
})
