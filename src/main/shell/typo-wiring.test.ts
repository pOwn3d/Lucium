// The lookalike guard (shared/typo-guard.ts) on the real methods of the class Browser, on a stand-in: an address typed in the command bar (every mode)
// or in the tab editor is announced to the gate with the history of the profile, and a link or a search is not; the request filter holds the first load
// of an announced host, and only while the setting is on. The page that says it: engine/error-pages-typo.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { createInitialState, reduce } from '@shared/sidebar'
import { typoGate } from '../engine/typo-gate'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => typoGate.forgetAll())

/** `quiet`: the blocker is off too, so that the filter has nothing else to say (and reads no list). */
function window(typoGuard = true, quiet = true, search?: string) {
  const ctx = { now: 1, newId: () => 'tab-1' }
  let state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
  state = reduce(state, { type: 'settings/update', patch: { typoGuard, ...(search ? { searchUrlTemplate: search } : {}), ...(quiet ? { blockAds: false, blockTrackers: false, blockCookieBanners: false } : {}) } }, ctx)
  const page = { loadURL: vi.fn(), focus: vi.fn() }
  const profiles: string[] = []
  const history = { of: (profileId: string) => (profiles.push(profileId), { hosts: () => ['google.com'] }) }
  const fake = fakeBrowser({
    store: { get: () => state },
    pages: new Map([['tab-1', page]]),
    activePage: () => page,
    littleOpener: vi.fn(),
    dispatch: vi.fn(),
    isPrivate: () => false,
    showToast: vi.fn(),
    history,
    searchTemplateFor: shell['searchTemplateFor'],
    expectTypoWarning: shell['expectTypoWarning'],
    submitUrl: shell['submitUrl'],
    setTabAddress: shell['setTabAddress'],
    requestFilter: shell['requestFilter']
  })
  return { call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args), profiles, state }
}

describe('a typed address that looks like a site of the person', () => {
  it('is announced in every mode of the command bar, and the first load of its host is then held', () => {
    for (const mode of ['current', 'new', 'little', 'split'] as const) {
      typoGate.forgetAll()
      const w = window()
      w.call('submitUrl', 'gogle.com', mode)
      expect(typoGate.holds('https://gogle.com/'), mode).toBe(true)
    }
  })

  it('is announced in the tab editor, with the history of the profile of the tab', () => {
    const w = window()
    w.call('setTabAddress', 'tab-1', 'https://gogle.com/')
    expect(w.profiles.length).toBeGreaterThan(0)
    expect(typoGate.holds('https://gogle.com/')).toBe(true)
  })

  it('is not announced when the guard is off', () => {
    window(false).call('submitUrl', 'gogle.com', 'current')
    expect(typoGate.holds('https://gogle.com/')).toBe(false)
  })

  it('is not announced for words that are searched, even when the search engine itself looks like a known site', () => {
    const w = window(true, true, 'https://googel.com/search?q=%s')
    w.call('submitUrl', 'recipes', 'current')
    expect(typoGate.holds('https://googel.com/search?q=recipes')).toBe(false)
  })

  it('is not announced for words that are searched, nor for a site the person uses', () => {
    const w = window()
    w.call('submitUrl', 'gogle recipes', 'current')
    w.call('submitUrl', 'google.com', 'current')
    expect(typoGate.holds('https://gogle.com/')).toBe(false)
    expect(typoGate.holds('https://google.com/')).toBe(false)
  })
})

describe('the request filter', () => {
  const request = (url: string, resourceType = 'mainFrame') => ({ url, resourceType, pageId: 'tab-1', pageUrl: 'https://a.example/' })

  it('holds the first main-frame load of an announced host while the guard is on, once', () => {
    const w = window()
    const filter = w.call('requestFilter') as (r: ReturnType<typeof request>) => boolean
    typoGate.expect('gogle.com', 'google.com')
    expect(filter(request('https://gogle.com/img.png', 'image'))).toBe(false)
    expect(filter(request('https://gogle.com/'))).toBe(true)
    expect(filter(request('https://gogle.com/'))).toBe(false)
  })

  it('does not exist while the guard is off (and the blocker, the pings and the focus mode are off too)', () => {
    const w = window(false)
    expect(w.state.settings.typoGuard).toBe(false)
    expect(w.call('requestFilter')).toBeNull()
  })
})
