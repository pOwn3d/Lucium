// The language of the pages and the translation switched off: docs/fonctions.md promises that nothing runs for the
// translation while it is off. The page reads its language only when the shell says the translation is on, and the page menu offers
// « Traduire en <langue> » only then. The real methods of the Browser run on a stand-in for the window; the real page of the engine runs over a fake web contents.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings, type TabTranslation } from '@shared/model'
import type { PageEvents, PageMenuOptions } from '../engine/types'
import { TRANSLATE_WORLD } from '@shared/translate-page-script'
import { makePage, settle } from '../engine/electron-page.test-support'

vi.mock('electron', async () => (await import('../engine/electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

function windowWith(translateLocal: boolean, over: { translateTarget?: string; translation?: TabTranslation } = {}) {
  const settings: Settings = { ...defaultSettings(), translateLocal, ...(over.translateTarget !== undefined ? { translateTarget: over.translateTarget } : {}) }
  const entry = { loading: false, audible: false, muted: false, awake: true, ...(over.translation ? { translation: over.translation } : {}) }
  return { store: { get: () => ({ settings, tabs: [{ id: 't1', url: 'https://journal.example/' }] }) }, isPrivate: () => false, runtime: { tabs: { t1: entry } } }
}

afterEach(() => setLanguage('fr'))

describe('the translation switched off', () => {
  it('takes the entry « Traduire en <langue> » out of the page menu', () => {
    const offered = (on: boolean) => (methods['menuOptionsFor']!.call(windowWith(on), 't1') as PageMenuOptions).translate
    expect(offered(false)).toBe(false)
    expect(offered(true)).toBe(true)
  })

  it('tells the page not to read its language', () => {
    // The events of a tab are made by a method of the window: their `readsLanguage` follows the setting of the moment.
    const readsLanguage = (on: boolean) => (methods['pageEvents']!.call(windowWith(on), { id: 't1', spaceId: 's', url: 'https://journal.example/' }) as PageEvents).readsLanguage?.()
    expect(readsLanguage(false)).toBe(false)
    expect(readsLanguage(true)).toBe(true)
  })

  it('is what the page asks before it reads the language, in the isolated world of the translation', async () => {
    const reads = async (on: boolean) => {
      const { wc } = await makePage({ events: { readsLanguage: () => on } })
      wc.emit('did-stop-loading')
      await settle()
      return wc
    }
    const off = await reads(false)
    expect(off.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(off.executeJavaScript).not.toHaveBeenCalled()
    const on = await reads(true)
    expect(on.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(TRANSLATE_WORLD, [{ code: "document.documentElement.lang || ''" }])
    // Never in the world of the page itself, which could answer for it.
    expect(on.executeJavaScript).not.toHaveBeenCalled()
  })
})

describe('the entry of the page menu, switched on', () => {
  it('names the language pages are translated into: the one chosen in the settings, else the interface’s', () => {
    const target = (over: { translateTarget?: string } = {}) => (methods['menuOptionsFor']!.call(windowWith(true, over), 't1') as PageMenuOptions).translateTarget
    expect(target()).toBe('fr')
    expect(target({ translateTarget: 'de' })).toBe('de')
    setLanguage('en')
    expect(target()).toBe('en')
  })

  it('says when the page is translated or being translated, so that the entry is « Afficher l’original »', () => {
    const translated = (translation?: TabTranslation) => (methods['menuOptionsFor']!.call(windowWith(true, translation ? { translation } : {}), 't1') as PageMenuOptions).translated
    expect(translated()).toBe(false)
    expect(translated({ state: 'translated', from: 'en', to: 'fr' })).toBe(true)
    expect(translated({ state: 'working', from: 'en', to: 'fr' })).toBe(true)
  })

  it('compares the page’s language with that target, which the page asks for before it publishes anything', () => {
    const events = methods['pageEvents']!.call(windowWith(true, { translateTarget: 'de' }), { id: 't1', spaceId: 's', url: 'https://journal.example/' }) as PageEvents
    expect(events.translateTarget?.()).toBe('de')
  })

  describe('the page of the engine', () => {
    const published = (update: ReturnType<typeof vi.fn>): unknown[] => update.mock.calls.map(([patch]) => (patch as { pageLanguage?: string }).pageLanguage).filter((language) => language !== undefined)
    const pageIn = async (language: string, target: string) => {
      const update = vi.fn()
      const { wc } = await makePage({ events: { readsLanguage: () => true, translateTarget: () => target, update } })
      wc.url = 'https://journal.example/'
      wc.executeJavaScriptInIsolatedWorld.mockResolvedValue(language as never)
      const read = async (): Promise<void> => {
        wc.emit('did-stop-loading')
        await settle()
      }
      return { wc, update, read }
    }

    it('publishes nothing for a page in the target language (the one of the settings, not the interface\'s), and the language of another one', async () => {
      const same = await pageIn('de', 'de')
      await same.read()
      expect(published(same.update)).toEqual([])
      const other = await pageIn('fr', 'de')
      await other.read()
      expect(published(other.update)).toEqual(['fr'])
    })

    it('does not send the same language twice for a document, and starts a new document without the language of the one before', async () => {
      const { wc, update, read } = await pageIn('en', 'fr')
      await read()
      // The page navigates within itself: the language is read again, and it is the one already published.
      wc.emit('did-navigate-in-page', {}, 'https://journal.example/#suite', true)
      await read()
      expect(published(update)).toEqual(['en'])
      // A new document: the language published for the one before goes with it, so its own is published.
      wc.emit('did-navigate', {}, 'https://journal.example/autre')
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ newDocument: true }))
      await read()
      expect(published(update)).toEqual(['en', 'en'])
    })  })
})
