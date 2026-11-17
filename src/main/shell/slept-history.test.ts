// The Back / Forward list of a sleeping tab: what is kept when its page goes, what its next page gets, and when the list is forgotten. Then the
// real methods of the class Browser on a stand-in: the page that goes for a sleep hands its list over, and the page made at the waking replays it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce } from '@shared/sidebar'
import { SLEPT_HISTORY_MAX, SleptHistory } from './slept-history'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => void vi.restoreAllMocks())

const page = (n: number) => ({ url: `https://a.example/${n}`, title: `Page ${n}` })
const three = { entries: [page(1), page(2), page(3)], index: 2 }
const tab = { id: 't', url: 'https://a.example/3' }

describe('the list of a sleeping tab', () => {
  it('is given once to the next page of the tab, as it was', () => {
    const slept = new SleptHistory()
    slept.keep(tab, 'profile:default', () => three)
    expect(slept.take(tab, 'profile:default')).toEqual(three)
    expect(slept.take(tab, 'profile:default')).toBeUndefined()
  })

  it('keeps the place in the list when the user had gone back', () => {
    const slept = new SleptHistory()
    slept.keep({ id: 't', url: page(2).url }, 'profile:default', () => ({ ...three, index: 1 }))
    expect(slept.take({ id: 't', url: page(2).url }, 'profile:default')?.index).toBe(1)
  })

  it('keeps only web pages, and nothing for a tab with a single page', () => {
    const slept = new SleptHistory()
    slept.keep(tab, 'profile:default', () => ({ entries: [{ url: 'file:///etc/hosts', title: '' }, page(3)], index: 1 }))
    expect(slept.size).toBe(0)
    slept.keep(tab, 'profile:default', () => ({ entries: [{ url: 'file:///etc/hosts', title: '' }, page(2), page(3)], index: 2 }))
    expect(slept.take(tab, 'profile:default')).toEqual({ entries: [page(2), page(3)], index: 1 })
  })

  it('is not given to a tab that changed address or session while it slept', () => {
    const slept = new SleptHistory()
    slept.keep(tab, 'profile:default', () => three)
    expect(slept.take({ id: 't', url: 'https://b.example/' }, 'profile:default')).toBeUndefined()
    slept.keep(tab, 'profile:default', () => three)
    expect(slept.take(tab, 'container:work')).toBeUndefined()
    // Refused once, it is not kept for later.
    expect(slept.size).toBe(0)
  })

  it('logs a page that cannot answer, and keeps nothing of an earlier sleep', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const slept = new SleptHistory()
    slept.keep(tab, 'profile:default', () => three)
    slept.keep(tab, 'profile:default', () => {
      throw new Error('Object has been destroyed')
    })
    expect(slept.size).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the pages of tab t could not be read'), 'Object has been destroyed')
  })

  it('goes with its tab', () => {
    const slept = new SleptHistory()
    slept.keep(tab, 'profile:default', () => three)
    slept.keep({ ...tab, id: 'u' }, 'profile:default', () => three)
    slept.forget(new Set(['u']))
    expect(slept.take(tab, 'profile:default')).toBeUndefined()
    expect(slept.take({ ...tab, id: 'u' }, 'profile:default')).toEqual(three)
  })

  it('is forgotten with the history of its profile, and only of its profile', () => {
    const slept = new SleptHistory()
    slept.keep(tab, 'profile:default', () => three)
    slept.keep({ ...tab, id: 'w' }, 'profile:work', () => three)
    slept.keep({ ...tab, id: 'p' }, 'private', () => three)
    slept.forgetPages({ profileId: 'default' })
    expect(slept.take(tab, 'profile:default')).toBeUndefined()
    expect(slept.take({ ...tab, id: 'w' }, 'profile:work')).toEqual(three)
    expect(slept.take({ ...tab, id: 'p' }, 'private')).toEqual(three)
  })

  it('loses the pages of a forgotten site, and everything when the tab is on that site', () => {
    const slept = new SleptHistory()
    const mixed = { entries: [{ url: 'https://b.example/x', title: 'B' }, page(2), page(3)], index: 2 }
    slept.keep(tab, 'profile:default', () => mixed)
    slept.forgetPages({ profileId: 'default', site: { host: 'b.example', subdomains: false } })
    expect(slept.take(tab, 'profile:default')).toEqual({ entries: [page(2), page(3)], index: 1 })
    slept.keep(tab, 'profile:default', () => mixed)
    slept.forgetPages({ profileId: 'default', site: { host: 'a.example', subdomains: false } })
    expect(slept.size).toBe(0)
  })

  it('has a ceiling: the tabs that fell asleep first lose their list', () => {
    const slept = new SleptHistory()
    for (let n = 0; n <= SLEPT_HISTORY_MAX; n++) slept.keep({ ...tab, id: `t${n}` }, 'profile:default', () => three)
    expect(slept.size).toBe(SLEPT_HISTORY_MAX)
    expect(slept.take({ ...tab, id: 't0' }, 'profile:default')).toBeUndefined()
    expect(slept.take({ ...tab, id: `t${SLEPT_HISTORY_MAX}` }, 'profile:default')).toEqual(three)
  })
})

describe('the page of a tab, around a sleep', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `t${++n}` })() }
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: page(3).url }, ctx)
  const live = state.tabs.find((t) => t.url === page(3).url)!

  function windowWith(livePage: Record<string, unknown>) {
    const slept = new SleptHistory()
    const made: Array<Record<string, unknown>> = []
    const newPage = () => {
      const fresh = { loadURL: vi.fn(), restoreHistory: vi.fn(() => false), restoreClosedHistory: vi.fn(() => Promise.resolve()), watchKeys: vi.fn(), navigationEntries: () => ({ entries: [], index: -1 }) }
      made.push(fresh)
      return fresh
    }
    const fake = fakeBrowser({
      slept,
      pages: new Map([[live.id, livePage]]),
      pageSession: new Map([[live.id, 'profile:default']]),
      privatePages: new Set(),
      pageContainer: new Map(),
      pageAutoplay: new Map(),
      carriedHistory: new Map(),
      creating: new Set(),
      idleSince: new Map(),
      frozen: new Set(),
      fullscreenTab: null,
      runtime: { tabs: {} },
      cycleWatching: false,
      store: { get: () => state },
      options: {},
      engine: { createPage: newPage },
      reopened: { take: () => undefined },
      isPrivate: () => false,
      containerKeyOf: () => '',
      pageEvents: () => ({}),
      destroyPage: shell['destroyPage'],
      dropPageState: shell['dropPageState'],
      sessionKeyOf: shell['sessionKeyOf'],
      restoreHistory: shell['restoreHistory']
    })
    fake.self['leader'] = fake.self
    const call = (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args)
    return { slept, made, call }
  }

  it('let go for a sleep, hands its list over; the page made at the waking goes back through it instead of loading the address alone', async () => {
    const { slept, made, call } = windowWith({ destroy: vi.fn(), navigationEntries: () => three, release: () => Promise.resolve(true) })
    expect(await call('releasePage', live.id)).toBe(true)
    expect(slept.size).toBe(1)
    call('ensurePage', live)
    expect(made[0]!['restoreClosedHistory']).toHaveBeenCalledWith(three.entries, three.index)
    expect(made[0]!['loadURL']).not.toHaveBeenCalled()
    expect(slept.size).toBe(0)
  })

  it('destroyed for another reason (the tab closed, another session), keeps nothing: the next page loads the address', () => {
    const { slept, made, call } = windowWith({ destroy: vi.fn(), navigationEntries: () => three })
    call('destroyPage', live.id)
    expect(slept.size).toBe(0)
    call('ensurePage', live)
    expect(made[0]!['loadURL']).toHaveBeenCalledWith(live.url)
  })

  it('of a window put away, hands its list over too', () => {
    const { slept, call } = windowWith({ destroy: vi.fn(), navigationEntries: () => three })
    call('putAway', true)
    expect(slept.size).toBe(1)
  })
})
