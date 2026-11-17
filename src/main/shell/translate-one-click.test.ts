// The translation in one click, in the window (browser-commands.ts, browser-pages.ts, browser-publish.ts, web-tools-menu.ts): « Traduire en <langue> » of the
// page's menu and of File translates at once and opens the panel only when it cannot; a page that tells another language is translated by itself only when
// « Toujours traduire » asks for it (nothing is made otherwise); the runtime of a tab carries its language and its translation for the toolbar button, and a
// new document drops both. The real methods of the Browser run on stand-ins for the window; the menu is the real one, Electron's `Menu` handing it back.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { defaultSettings, type Settings, type SidebarState, type TabRuntime, type TabTranslation } from '@shared/model'
import type { MenuFacts } from '@shared/menu-state'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const { buildMenu } = await import('./menu')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

afterEach(() => setLanguage('fr'))

const ENTRY: TabRuntime = { loading: false, audible: false, muted: false, awake: true }

/** A translation of the window that answers as told, and the calls it received. */
function translator(answer: { state: string } = { state: 'translated' }, translation: TabTranslation | null = null) {
  const calls: string[] = []
  return {
    calls,
    controller: {
      translationOf: () => translation,
      quickTab: async (id: string) => (calls.push(`quick:${id}`), answer),
      restoreTab: async (id: string) => (calls.push(`restore:${id}`), answer),
      autoTranslate: async (id: string) => void calls.push(`auto:${id}`),
      forgetTab: (id: string) => void calls.push(`forget:${id}`)
    }
  }
}

/** A window: its tabs (the first on screen), its settings, its runtime, and what it opened and published. */
function windowWith(over: { settings?: Partial<Settings>; url?: string; translator?: ReturnType<typeof translator> | null; runtime?: Partial<TabRuntime> } = {}) {
  const base = createInitialState({ now: 1, newId: ((n) => () => `id${++n}`)(0) })
  const space = base.spaces[0]!.id
  const tab = { id: 't1', spaceId: space, url: over.url ?? 'https://www.news.example/story', title: 'Story', pinned: false, createdAt: 1, lastActiveAt: 1 }
  const state: SidebarState = { ...base, tabs: [tab, { ...tab, id: 't2', url: 'https://other.example/' }], activeTabBySpace: { [space]: tab.id }, settings: { ...defaultSettings(), ...over.settings } }
  const opened: unknown[] = []
  const made: string[] = []
  const published: number[] = []
  const access = over.translator === null ? null : (over.translator ?? translator())
  const self: Record<string, unknown> = {
    store: { get: () => state },
    runtime: { tabs: { t1: { ...ENTRY, ...over.runtime }, t2: ENTRY }, canGoBack: false, canGoForward: false },
    translatorAccess: {
      get: () => (made.push('get'), state.settings.translateLocal ? (access?.controller ?? null) : null),
      made: () => (made.push('made'), access?.controller ?? null)
    },
    openOverlay: (request: unknown) => void opened.push(request),
    openTranslatePage: () => void opened.push('openTranslatePage'),
    publish: () => void published.push(1),
    isPrivate: () => false
  }
  for (const name of ['translateTabNow', 'translateIfAlways', 'forgetTranslation', 'showTabTranslation', 'handlePageUpdate', 'translateFact']) self[name] = methods[name]
  return { self, opened, made, published, calls: access?.calls ?? [], state }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('« Traduire en <langue> » of the page’s menu and of File, for a tab', () => {
  it('translates at once, and opens no panel when it went through', async () => {
    const w = windowWith({ settings: { translateLocal: true } })
    methods['translateTabNow']!.call(w.self, 't1')
    await settle()
    expect(w.calls).toEqual(['quick:t1'])
    expect(w.opened).toEqual([])
  })

  it('opens the full panel when the translation cannot be done that way, for the tab still on screen only', async () => {
    const shown = windowWith({ settings: { translateLocal: true }, translator: translator({ state: 'error' }) })
    methods['translateTabNow']!.call(shown.self, 't1')
    await settle()
    expect(shown.opened).toEqual([{ panel: 'translate' }])
    const elsewhere = windowWith({ settings: { translateLocal: true }, translator: translator({ state: 'error' }) })
    methods['translateTabNow']!.call(elsewhere.self, 't2')
    await settle()
    expect(elsewhere.opened).toEqual([])
  })

  it('is « Afficher l’original » for a tab translated or being translated', async () => {
    const w = windowWith({ settings: { translateLocal: true }, translator: translator({ state: 'idle' }, { state: 'translated', from: 'en', to: 'fr' }) })
    methods['translateTabNow']!.call(w.self, 't1')
    await settle()
    expect(w.calls).toEqual(['restore:t1'])
  })

  it('with the function off, opens the settings where it is switched on, as before', () => {
    const w = windowWith({ settings: { translateLocal: false } })
    methods['translateTabNow']!.call(w.self, 't1')
    expect(w.opened).toEqual(['openTranslatePage'])
    expect(w.calls).toEqual([])
  })
})

describe('a page that tells another language than the target', () => {
  const told = (over: Parameters<typeof windowWith>[0], language = 'en') => {
    const w = windowWith(over)
    methods['translateIfAlways']!.call(w.self, 't1', language)
    return w
  }

  it('is translated by itself when its language is one of « Toujours traduire »', () => {
    expect(told({ settings: { translateLocal: true, translateAlways: ['en'] } }).calls).toEqual(['auto:t1'])
  })

  it('makes nothing at all otherwise: no list, another language, a site never translated, a PDF, the function off', () => {
    for (const over of [
      { settings: { translateLocal: true } },
      { settings: { translateLocal: true, translateAlways: ['de'] } },
      { settings: { translateLocal: true, translateAlways: ['en'], translateNeverSites: ['news.example'] } },
      { settings: { translateLocal: true, translateAlways: ['en'] }, url: 'https://www.news.example/report.pdf' },
      { settings: { translateLocal: false, translateAlways: ['en'] } }
    ]) {
      const w = told(over)
      expect(w.calls, JSON.stringify(over)).toEqual([])
      // The translation of the window is not even made for it.
      expect(w.made, JSON.stringify(over)).toEqual([])
    }
  })
})

describe('the runtime of a tab', () => {
  it('carries the language a page tells, for the toolbar button, and asks for « Toujours traduire »', () => {
    const w = windowWith({ settings: { translateLocal: true, translateAlways: ['en'] } })
    methods['handlePageUpdate']!.call(w.self, 't1', { pageLanguage: 'en' })
    expect((w.self['runtime'] as { tabs: Record<string, TabRuntime> }).tabs['t1']!.pageLanguage).toBe('en')
    expect(w.published).toHaveLength(1)
    expect(w.calls).toEqual(['auto:t1'])
    // '' takes it out (the page is in the target language now).
    methods['handlePageUpdate']!.call(w.self, 't1', { pageLanguage: '' })
    expect((w.self['runtime'] as { tabs: Record<string, TabRuntime> }).tabs['t1']!.pageLanguage).toBeUndefined()
  })

  it('drops the language and the translation of the document before when a new one comes, and ends that translation', () => {
    const w = windowWith({ settings: { translateLocal: true }, runtime: { pageLanguage: 'en', translation: { state: 'translated', from: 'en', to: 'fr' } } })
    methods['handlePageUpdate']!.call(w.self, 't1', { newDocument: true })
    const entry = (w.self['runtime'] as { tabs: Record<string, TabRuntime> }).tabs['t1']!
    expect(entry.pageLanguage).toBeUndefined()
    expect(entry.translation).toBeUndefined()
    expect(w.calls).toEqual(['forget:t1'])
    // Only a translation that exists is told: none is made for it.
    expect(w.made).toEqual(['made'])
  })

  it('keeps the translation of a page that tells its language again (a navigation within the page)', () => {
    const translation: TabTranslation = { state: 'translated', from: 'en', to: 'fr' }
    const w = windowWith({ settings: { translateLocal: true }, runtime: { pageLanguage: 'en', translation } })
    methods['handlePageUpdate']!.call(w.self, 't1', { pageLanguage: '' })
    expect((w.self['runtime'] as { tabs: Record<string, TabRuntime> }).tabs['t1']!.translation).toEqual(translation)
  })

  it('shows the translation the controller tells, and publishes only a change', () => {
    const w = windowWith({ settings: { translateLocal: true } })
    const translation: TabTranslation = { state: 'working', from: 'en', to: 'fr' }
    methods['showTabTranslation']!.call(w.self, 't1', translation)
    methods['showTabTranslation']!.call(w.self, 't1', { ...translation })
    expect((w.self['runtime'] as { tabs: Record<string, TabRuntime> }).tabs['t1']!.translation).toEqual(translation)
    methods['showTabTranslation']!.call(w.self, 't1', null)
    expect((w.self['runtime'] as { tabs: Record<string, TabRuntime> }).tabs['t1']!.translation).toBeUndefined()
    methods['showTabTranslation']!.call(w.self, 'gone', translation)
    expect(w.published).toHaveLength(2)
  })
})

describe('the entry of the File menu', () => {
  /** The leaves of the menu built for a window whose facts say this of the page on screen. */
  function fileEntries(facts: Partial<MenuFacts>, translateLocal = true) {
    const base = createInitialState({ now: 1, newId: ((n) => () => `id${++n}`)(0) })
    const space = base.spaces[0]!.id
    const tab = { id: 'tab', spaceId: space, url: 'https://www.news.example/story', title: 'Story', pinned: false, createdAt: 1, lastActiveAt: 1 }
    const state: SidebarState = { ...base, tabs: [tab], activeTabBySpace: { [space]: tab.id }, settings: { ...base.settings, translateLocal } }
    const asked: unknown[] = []
    const browser = new Proxy(
      {
        menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, sound: 'silent', ...facts }),
        translateTabNow: (id: string) => void asked.push(`now:${id}`),
        openOverlay: (request: unknown) => void asked.push(request)
      } as Record<string, unknown>,
      { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
    )
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    type Item = { label?: string; click?: () => void; submenu?: Item[] }
    const leaves = (items: Item[]): Item[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))
    return { items: leaves(buildMenu(browser as never, { get: () => state } as never, actions as never, {}) as unknown as Item[]), asked }
  }
  const translation = (items: Array<{ label?: string }>) => items.filter((item) => /^(Traduire|Afficher l’original)/.test(item.label ?? '')).map((item) => item.label)

  it('is « Traduire en français », done at once, for a page in another language', () => {
    const menu = fileEntries({ translate: { state: 'offered', to: 'fr' } })
    expect(translation(menu.items)).toEqual(['Traduire en français'])
    menu.items.find((item) => item.label === 'Traduire en français')!.click!()
    expect(menu.asked).toEqual(['now:tab'])
  })

  it('is « Afficher l’original » for a page translated or being translated', () => {
    expect(translation(fileEntries({ translate: { state: 'translated', to: 'fr' } }).items)).toEqual(['Afficher l’original'])
    expect(translation(fileEntries({ translate: { state: 'working', to: 'fr' } }).items)).toEqual(['Afficher l’original'])
  })

  it('stays « Traduire cette page… », the full panel, for every other page; and is gone with the function', () => {
    const menu = fileEntries({})
    expect(translation(menu.items)).toEqual([t('menu.traduire-cette-page')])
    menu.items.find((item) => item.label === t('menu.traduire-cette-page'))!.click!()
    expect(menu.asked).toEqual([{ panel: 'translate' }])
    expect(translation(fileEntries({ translate: { state: 'offered', to: 'fr' } }, false).items)).toEqual([])
  })

  it('is told by the facts only for a page in another language or translated (the key of a page in the target language is unchanged)', () => {
    const fact = (over: Parameters<typeof windowWith>[0]) => {
      const w = windowWith(over)
      return methods['translateFact']!.call(w.self, w.state.tabs[0])
    }
    expect(fact({ settings: { translateLocal: true }, runtime: { pageLanguage: 'en' } })).toEqual({ translate: { state: 'offered', to: 'fr' } })
    expect(fact({ settings: { translateLocal: true }, runtime: { translation: { state: 'translated', from: 'en', to: 'de' } } })).toEqual({ translate: { state: 'translated', to: 'de' } })
    expect(fact({ settings: { translateLocal: true } })).toEqual({})
    expect(fact({ settings: { translateLocal: false }, runtime: { pageLanguage: 'en' } })).toEqual({})
  })
})
