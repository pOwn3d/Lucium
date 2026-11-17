// An address typed with its scheme that cannot be read: the page of the engine refuses it by throwing (`ElectronPage.loadURL`), and the
// throw came out of the IPC listener of the command bar. The real methods of the class Browser on a stand-in: the user is told, nothing is loaded.
// The rule of what is an address: shared/url.test.ts; the mini window's own bar: little.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { createInitialState, reduce } from '@shared/sidebar'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)
const UNREADABLE = ['http://exa mple.com', 'http://[::1', 'http://x.com:99999']

function windowWithPage() {
  const ctx = { now: 1, newId: () => 'tab-1' }
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
  // What the engine does with such an address.
  const page = { loadURL: vi.fn((url: string) => void (URL.canParse(url) || (() => { throw new Error('Refusing to load a non-web URL: http:') })())), focus: vi.fn() }
  const toasts: string[] = []
  const littleOpener = vi.fn()
  const dispatch = vi.fn()
  const fake = fakeBrowser({
    store: { get: () => state },
    pages: new Map([['tab-1', page]]),
    activePage: () => page,
    littleOpener,
    dispatch,
    isPrivate: () => false,
    showToast: (message: string) => void toasts.push(message),
    searchTemplateFor: shell['searchTemplateFor'],
    submitUrl: shell['submitUrl'],
    pageEvents: shell['pageEvents'],
    setTabAddress: shell['setTabAddress']
  })
  return { call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args), page, toasts, littleOpener, dispatch, spaceId: state.activeSpaceId }
}

describe('an address that cannot be read, typed in the command bar', () => {
  it('is told, not thrown, in every mode: the tab on screen, a new tab, a mini window', () => {
    for (const mode of ['current', 'new', 'little', 'split'] as const) {
      for (const input of UNREADABLE) {
        const w = windowWithPage()
        expect(() => w.call('submitUrl', input, mode), `${mode} ${input}`).not.toThrow()
        expect(w.toasts, `${mode} ${input}`).toEqual([t('browser.adresse-invalide')])
        expect(w.page.loadURL).not.toHaveBeenCalled()
        expect(w.littleOpener).not.toHaveBeenCalled()
        expect(w.dispatch).not.toHaveBeenCalled()
      }
    }
  })

  it('leaves a readable address alone', () => {
    const w = windowWithPage()
    w.call('submitUrl', 'https://b.example/', 'current')
    expect(w.page.loadURL).toHaveBeenCalledWith('https://b.example/')
    expect(w.toasts).toEqual([])
  })
})

describe('the space a mini window is opened from', () => {
  it('is the space this window shows, for the command bar in the mode of a mini window', () => {
    const w = windowWithPage()
    w.call('submitUrl', 'https://b.example/', 'little')
    expect(w.littleOpener).toHaveBeenCalledWith('https://b.example/', { spaceId: w.spaceId })
  })

  it('is the space of the tab whose link asks for one', () => {
    const w = windowWithPage()
    const tab = { id: 'tab-9', spaceId: 'elsewhere', url: 'https://a.example/', title: 'A', pinned: false, createdAt: 1, lastActiveAt: 1 }
    const events = w.call('pageEvents', tab, () => true) as { openWindow: (url: string, disposition: string) => void }
    events.openWindow('https://other.example/', 'little')
    expect(w.littleOpener).toHaveBeenCalledWith('https://other.example/', { spaceId: 'elsewhere' })
  })
})

describe('the page of a private tab asked for in another place (⌘↩ on its line in the command bar)', () => {
  const PRIVATE = 'https://clinique.example/rendez-vous'

  function windowWithPrivateTab(alsoOrdinary = false) {
    let n = 0
    const ctx = { now: 1, newId: () => `id${++n}` }
    let state = reduce(createInitialState(ctx), { type: 'settings/update', patch: { privateTabs: true } }, ctx)
    state = reduce(state, { type: 'tab/open', url: PRIVATE, private: true }, ctx)
    if (alsoOrdinary) state = reduce(state, { type: 'tab/open', url: PRIVATE }, ctx)
    expect(state.tabs.filter((tab) => tab.private === true)).toHaveLength(1)
    const littleOpener = vi.fn()
    const dispatch = vi.fn()
    const fake = fakeBrowser({ store: { get: () => state }, activePage: () => undefined, littleOpener, dispatch, isPrivate: () => false, searchTemplateFor: shell['searchTemplateFor'], pendingSplit: null })
    return { call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args), littleOpener, dispatch }
  }

  it('opens in a private tab, never in an ordinary one nor in a mini window', () => {
    for (const mode of ['new', 'little'] as const) {
      const w = windowWithPrivateTab()
      w.call('submitUrl', PRIVATE, mode)
      expect(w.dispatch.mock.calls.map((call) => call[0]), mode).toEqual([{ type: 'tab/open', url: PRIVATE, private: true }])
      expect(w.littleOpener).not.toHaveBeenCalled()
    }
  })

  it('opens as any address does when an ordinary tab shows it too, and for an address no private tab is at', () => {
    const shared = windowWithPrivateTab(true)
    shared.call('submitUrl', PRIVATE, 'new')
    expect(shared.dispatch).toHaveBeenCalledWith({ type: 'tab/open', url: PRIVATE })
    const other = windowWithPrivateTab()
    other.call('submitUrl', 'https://b.example/', 'new')
    expect(other.dispatch).toHaveBeenCalledWith({ type: 'tab/open', url: 'https://b.example/' })
    other.call('submitUrl', 'https://b.example/', 'little')
    expect(other.littleOpener).toHaveBeenCalledTimes(1)
  })
})

describe('an address typed in the address editor of a tab that has no page in this window (asleep, or shown by another window)', () => {
  it('is not lost in silence: the person is told that the address did not change', () => {
    const w = windowWithPage()
    expect(() => w.call('setTabAddress', 'tab-asleep', 'https://b.example/')).not.toThrow()
    expect(w.toasts).toEqual([t('browser.adresse-non-changee-onglet-non-charge')])
    expect(w.page.loadURL).not.toHaveBeenCalled()
  })

  it('says nothing when the tab has its page: the address is loaded', () => {
    const w = windowWithPage()
    w.call('setTabAddress', 'tab-1', 'https://b.example/')
    expect(w.page.loadURL).toHaveBeenCalledWith('https://b.example/')
    expect(w.toasts).toEqual([])
  })
})

describe('an address that cannot be read, typed in the address editor of a tab', () => {
  it('is told, and the page loads nothing', () => {
    for (const input of UNREADABLE) {
      const w = windowWithPage()
      expect(() => w.call('setTabAddress', 'tab-1', input)).not.toThrow()
      expect(w.toasts).toEqual([t('browser.adresse-invalide')])
      expect(w.page.loadURL).not.toHaveBeenCalled()
    }
  })
})
