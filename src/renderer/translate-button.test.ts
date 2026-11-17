// The toolbar button « Traduction de la page » and its popover (Toolbar.tsx `TranslateButton`, TranslatePopover.tsx), and the lists of Réglages › Traduction
// locale (TranslateSettings.tsx `AutoTranslateLists`): the states the button shows (offered, under way, translated), what the popover offers and asks the
// main process, where nothing is written (a private window or tab), and how an entry of a list is removed. Drawn without a window.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import type { Settings, SidebarState, TabRuntime } from '@shared/model'
import type { TranslateOffer } from '@shared/translate-quick'
import { elementsOf, type Element } from './render.test-support'

const calls = vi.hoisted(() => ({ translate: [] as unknown[], overlay: [] as unknown[], answer: null as unknown, snapshot: null as unknown }))
vi.mock('./api', () => ({
  api: () => ({
    translate: (request: unknown) => (calls.translate.push(request), calls.answer instanceof Error ? Promise.reject(calls.answer) : Promise.resolve(calls.answer)),
    openOverlay: (request: unknown) => void calls.overlay.push(request)
  }),
  useSnapshot: () => calls.snapshot
}))

const { Toolbar, TranslateButton } = await import('./Toolbar')
const { TranslatePopover, popoverModel } = await import('./TranslatePopover')
const { AutoTranslateLists } = await import('./TranslateSettings')

beforeEach(() => {
  setLanguage('fr')
  calls.translate = []
  calls.overlay = []
  calls.answer = { state: 'translated', message: '' }
})
afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
})

const ENTRY: TabRuntime = { loading: false, audible: false, muted: false, awake: true }

/** The snapshot of a window whose tab on screen is at `url`, with this runtime and these settings. */
function snapshotWith(over: { url?: string; runtime?: Partial<TabRuntime>; settings?: Partial<Settings>; privateWindow?: boolean; privateTab?: boolean } = {}): UiSnapshot {
  const base = createInitialState({ now: 1, newId: ((n) => () => `id${++n}`)(0) })
  const space = base.spaces[0]!.id
  const tab = { id: 't1', spaceId: space, url: over.url ?? 'https://www.news.example/story', title: 'Story', pinned: false, createdAt: 1, lastActiveAt: 1, ...(over.privateTab ? { private: true } : {}) }
  const state: SidebarState = { ...base, tabs: [tab], activeTabBySpace: { [space]: tab.id }, settings: { ...base.settings, translateLocal: true, ...over.settings } }
  return { state, runtime: { tabs: { t1: { ...ENTRY, pageLanguage: 'en', ...over.runtime } }, canGoBack: false, canGoForward: false }, ...(over.privateWindow ? { private: true } : {}) } as unknown as UiSnapshot
}

const OFFERED: TranslateOffer = { state: 'offered', from: 'en', to: 'fr' }
const markup = (element: ReactElement): string => renderToStaticMarkup(element)

describe('the toolbar button « Traduction de la page »', () => {
  it('shows a page in another language as offered, named, with what it is in its description', () => {
    const html = markup(createElement(TranslateButton, { offer: OFFERED }))
    expect(html).toContain('data-state="offered"')
    expect(html).toContain('aria-label="Traduction de la page"')
    expect(html).toContain('aria-description="Page en anglais"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('aria-busy')
    // The colour is a fill of the card of the A; the strokes keep the ink of the bar.
    expect(html).toContain('class="tb-tint-lang"')
  })

  it('says a translation under way (busy) and a translated page (its own state, the active look of the bar)', () => {
    const working = markup(createElement(TranslateButton, { offer: { state: 'working', from: 'en', to: 'fr' } }))
    expect(working).toContain('aria-busy="true"')
    expect(working).toContain('aria-description="Traduction de l’anglais vers le français…"')
    const translated = markup(createElement(TranslateButton, { offer: { state: 'translated', from: 'en', to: 'fr' } }))
    expect(translated).toContain('data-state="translated"')
    expect(translated).toContain('aria-description="Traduit de l’anglais vers le français"')
    setLanguage('en')
    expect(markup(createElement(TranslateButton, { offer: OFFERED }))).toContain('aria-label="Page translation"')
  })

  it('opens its popover hung from itself, never the full panel', () => {
    const element = TranslateButton({ offer: OFFERED }) as Element
    const onClick = element.props['onClick'] as (event: unknown) => void
    onClick({ currentTarget: { getBoundingClientRect: () => ({ x: 900, y: 8, width: 32, height: 24 }) } })
    expect(calls.overlay).toEqual([{ panel: 'translatepop', anchor: { x: 900, y: 8, width: 32, height: 24 } }])
  })

  it('is drawn by the bar only when there is something to offer (the window computes it: shared/translate-quick.ts `translateOffer`)', () => {
    const bar = (translate?: TranslateOffer) =>
      markup(
        createElement(Toolbar, {
          space: { id: 's', name: 'Travail', emoji: '💼', profileId: 'default' } as never,
          current: { id: 't1', spaceId: 's', url: 'https://www.news.example/story', title: 'Story', pinned: false, createdAt: 1, lastActiveAt: 2 },
          runtime: { tabs: {}, canGoBack: false, canGoForward: false },
          sidebarVisible: true,
          fullUrl: false,
          draggable: false,
          canSplit: false,
          ...(translate ? { translate } : {})
        })
      )
    expect(bar(OFFERED)).toContain('tb-translate')
    expect(bar()).not.toContain('tb-translate')
  })
})

describe('what the popover offers', () => {
  it('for a page in another language: « Page en anglais », « Traduire », the two switches as the settings say, the other languages', () => {
    const model = popoverModel(snapshotWith({ settings: { translateAlways: ['en'], translateNeverSites: [] } }))
    expect(model.sentence).toBe('Page en anglais')
    expect(model.primary).toEqual({ label: 'Traduire', request: { action: 'quick' } })
    expect(model.always).toEqual({ label: 'Toujours traduire l’anglais', checked: true })
    expect(model.never).toEqual({ checked: false, host: 'news.example' })
    expect(model.others).not.toContain('en')
    expect(model.others).toContain('fr')
    expect(popoverModel(snapshotWith({ settings: { translateNeverSites: ['news.example'] } })).never?.checked).toBe(true)
  })

  it('for a translated page: « Traduit de l’anglais vers le français », « Afficher l’original », and other languages than those two', () => {
    const model = popoverModel(snapshotWith({ runtime: { translation: { state: 'translated', from: 'en', to: 'fr' } } }))
    expect(model.sentence).toBe('Traduit de l’anglais vers le français')
    expect(model.primary).toEqual({ label: 'Afficher l’original', request: { action: 'restore' } })
    expect(model.others).not.toContain('en')
    expect(model.others).not.toContain('fr')
    expect(popoverModel(snapshotWith({ runtime: { translation: { state: 'working', from: 'en', to: 'fr' } } })).primary).toEqual({ label: 'Arrêter', request: { action: 'restore' } })
  })

  it('has no switch in a private window, nor on a private tab: nothing of them is written down', () => {
    for (const where of [{ privateWindow: true }, { privateTab: true }]) {
      const model = popoverModel(snapshotWith(where))
      expect(model.primary?.label, JSON.stringify(where)).toBe('Traduire')
      expect(model.always, JSON.stringify(where)).toBeUndefined()
      expect(model.never, JSON.stringify(where)).toBeUndefined()
    }
  })

  it('offers nothing for a page in the target language, a PDF, or with the function off', () => {
    for (const over of [{ runtime: { pageLanguage: 'fr' } }, { url: 'https://www.news.example/report.pdf' }, { settings: { translateLocal: false } }]) {
      expect(popoverModel(snapshotWith(over)), JSON.stringify(over)).toMatchObject({ offer: null, primary: null, others: [] })
    }
  })
})

describe('the popover’s actions', () => {
  const ANCHOR = { x: 900, y: 8, width: 32, height: 24 }
  const drawn = (snapshot: UiSnapshot): Element[] => {
    calls.snapshot = snapshot
    return elementsOf(createElement(TranslatePopover, { anchor: ANCHOR }))
  }
  const byClass = (elements: Element[], name: string) => elements.find((element) => String(element.props['className'] ?? '').split(' ').includes(name))!

  it('is a dialog named by its sentence, its main button first to take the focus', () => {
    const html = (() => {
      calls.snapshot = snapshotWith()
      return markup(createElement(TranslatePopover, { anchor: ANCHOR }))
    })()
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1">Page en anglais<\/h2>/)
    expect(html).toMatch(/class="tk-btn primary tp-main" data-autofocus="true"/)
    expect(html).toContain('Plus d’options…')
  })

  it('asks the main process: one click, the original, the two switches, another language; and opens the full panel', async () => {
    const elements = drawn(snapshotWith())
    ;(byClass(elements, 'tp-main').props['onClick'] as () => void)()
    const switches = elements.filter((element) => element.props['role'] === 'switch')
    ;(switches[0]!.props['onChange'] as (event: unknown) => void)({ target: { checked: true } })
    ;(switches[1]!.props['onChange'] as (event: unknown) => void)({ target: { checked: true } })
    const select = byClass(elements, 'tp-other')
    ;(select.props['onChange'] as (event: unknown) => void)({ target: { value: '' } })
    ;(select.props['onChange'] as (event: unknown) => void)({ target: { value: 'de' } })
    ;(byClass(elements, 'tp-more').props['onClick'] as () => void)()
    expect(calls.translate).toEqual([{ action: 'quick' }, { action: 'always', language: 'en', on: true }, { action: 'never-site', on: true }, { action: 'quick', to: 'de' }])
    expect(calls.overlay).toEqual([{ panel: 'translate' }])
    const translated = drawn(snapshotWith({ runtime: { translation: { state: 'translated', from: 'en', to: 'fr' } } }))
    ;(byClass(translated, 'tp-main').props['onClick'] as () => void)()
    expect(calls.translate.at(-1)).toEqual({ action: 'restore' })
  })

  it('says a request that failed, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    calls.answer = new Error('channel closed')
    const elements = drawn(snapshotWith())
    ;(byClass(elements, 'tp-main').props['onClick'] as () => void)()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[translate] a request of the popover failed:', 'channel closed'))
  })
})

describe('the lists of Réglages › Traduction locale', () => {
  it('say when they are empty', () => {
    const html = markup(createElement(AutoTranslateLists, { settings: { translateAlways: [], translateNeverSites: [] }, update: () => undefined }))
    expect(html).toContain('Aucune langue n’est traduite d’office et aucun site n’est exclu.')
  })

  it('list each language and each site with « Retirer », which takes that one out', () => {
    const patches: unknown[] = []
    const elements = elementsOf(createElement(AutoTranslateLists, { settings: { translateAlways: ['en', 'de'], translateNeverSites: ['news.example', 'other.example'] }, update: (patch) => void patches.push(patch) }))
    const removers = elements.filter((element) => element.props['className'] === 'link-button')
    expect(removers.map((element) => element.props['aria-label'])).toEqual(['Retirer Toujours traduire l’anglais', 'Retirer Toujours traduire l’allemand', 'Retirer news.example', 'Retirer other.example'])
    ;(removers[0]!.props['onClick'] as () => void)()
    ;(removers[3]!.props['onClick'] as () => void)()
    expect(patches).toEqual([{ translateAlways: ['de'] }, { translateNeverSites: ['news.example'] }])
    const html = markup(createElement(AutoTranslateLists, { settings: { translateAlways: ['en'], translateNeverSites: ['news.example'] }, update: () => undefined }))
    expect(html).toContain('Toujours traduire l’anglais')
    expect(html).toContain('Ne jamais traduire news.example')
  })
})
