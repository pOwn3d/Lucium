// The rules of the translation in one click (translate-quick.ts): what the two lists may hold once read back, which pages the toolbar button is for, which
// page is translated by itself as it loads (« Ne jamais traduire ce site » wins over « Toujours traduire »), what a page publishes of its language (nothing
// for a page in the target language), and the names of the languages in the sentences.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { defaultSettings, type Settings } from './model'
import { clampSettings } from './sidebar-state'
import {
  TRANSLATE_LANGUAGES_MAX,
  cleanQuickTranslateSettings,
  cleanTranslateLanguages,
  foreignLanguageOf,
  languageName,
  languagePhrase,
  neverTranslated,
  translateEntryLabel,
  translateOffer,
  translateSentence,
  translateSiteOf,
  translatesByItself,
  withAlwaysLanguage,
  withNeverSite
} from './translate-quick'

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

const quick = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), translateLocal: true, ...over })

describe('the lists, read back from the file of settings', () => {
  it('keep language codes only, each once, in order, and no more than the bound', () => {
    expect(cleanTranslateLanguages(['en', 'de', 'en', 'EN', 'und', 'zxx', 'english', 'en-US', 'x', 5, null, { code: 'it' }, 'it'])).toEqual(['en', 'de', 'it'])
    expect(cleanTranslateLanguages('en')).toEqual([])
    expect(cleanTranslateLanguages(undefined)).toEqual([])
    const many = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)))
    expect(cleanTranslateLanguages(many)).toHaveLength(TRANSLATE_LANGUAGES_MAX)
  })

  it('keep sites as the other lists of sites do (host, lower case, no www.), and the memory of the notice only for true', () => {
    const cleaned = cleanQuickTranslateSettings({ translateAlways: ['en'], translateNeverSites: ['https://www.News.Example/page?x=1', 'news.example', 'javascript:alert(1)', 'not a host', 42 as never], translateSystemNoticeSeen: 'yes' as never })
    expect(cleaned).toEqual({ translateAlways: ['en'], translateNeverSites: ['news.example'], translateSystemNoticeSeen: false })
    expect(cleanQuickTranslateSettings({ translateAlways: [], translateNeverSites: [], translateSystemNoticeSeen: true }).translateSystemNoticeSeen).toBe(true)
  })

  it('are cleaned whenever the settings are loaded', () => {
    const loaded = clampSettings({ ...defaultSettings(), translateAlways: ['en', 'EN', '../x'], translateNeverSites: ['WWW.example.org', 'file:///etc'], translateSystemNoticeSeen: 1 as never } as Settings)
    expect(loaded.translateAlways).toEqual(['en'])
    expect(loaded.translateNeverSites).toEqual(['example.org'])
    expect(loaded.translateSystemNoticeSeen).toBe(false)
    expect(defaultSettings()).toMatchObject({ translateAlways: [], translateNeverSites: [], translateSystemNoticeSeen: false })
  })

  it('take a language in or out; a code that is not one changes nothing', () => {
    expect(withAlwaysLanguage(['de'], 'en', true)).toEqual(['de', 'en'])
    expect(withAlwaysLanguage(['de', 'en'], 'en', true)).toEqual(['de', 'en'])
    expect(withAlwaysLanguage(['de', 'en'], 'en', false)).toEqual(['de'])
    expect(withAlwaysLanguage(['de'], 'English', true)).toEqual(['de'])
    expect(withAlwaysLanguage(['de'], 'en-US', true)).toEqual(['de'])
  })

  it('take the site of a page in or out (out takes a parent domain that covered it too); a page off the web changes nothing', () => {
    expect(withNeverSite([], 'https://www.news.example/a', true)).toEqual(['news.example'])
    expect(withNeverSite(['news.example'], 'https://sport.news.example/b', true)).toEqual(['news.example'])
    expect(withNeverSite(['news.example', 'other.example'], 'https://sport.news.example/b', false)).toEqual(['other.example'])
    expect(withNeverSite(['other.example'], 'file:///Users/moi/page.html', true)).toEqual(['other.example'])
    expect(translateSiteOf('about:blank')).toBeNull()
    // An address without its scheme is not a page: no site is read from it.
    expect(translateSiteOf('news.example/a')).toBeNull()
    expect(withNeverSite([], 'news.example/a', true)).toEqual([])
    expect(translateSiteOf(undefined)).toBeNull()
    expect(neverTranslated(['news.example'], 'https://sport.news.example/b')).toBe(true)
    expect(neverTranslated(['news.example'], 'https://othernews.example/')).toBe(false)
  })
})

describe('what a page publishes of its language', () => {
  it('is its primary language when it is another one than the target, and nothing for a page in the target language or in none', () => {
    expect(foreignLanguageOf('en-US', 'fr')).toBe('en')
    expect(foreignLanguageOf('EN', 'fr')).toBe('en')
    expect(foreignLanguageOf('fr-CA', 'fr')).toBe('')
    expect(foreignLanguageOf('fr', 'fr')).toBe('')
    expect(foreignLanguageOf('', 'fr')).toBe('')
    expect(foreignLanguageOf('und', 'fr')).toBe('')
    expect(foreignLanguageOf('de', 'de')).toBe('')
  })
})

describe('the toolbar button', () => {
  const entry = (pageLanguage?: string) => ({ ...(pageLanguage !== undefined ? { pageLanguage } : {}) })

  it('offers the translation of a web page in another language than the target', () => {
    expect(translateOffer(true, 'https://news.example/a', entry('en'), 'fr')).toEqual({ state: 'offered', from: 'en', to: 'fr' })
  })

  it('is not drawn for a page in the target language, one whose language is not told, a PDF, a page off the web, or with the function off', () => {
    expect(translateOffer(true, 'https://news.example/a', entry('fr'), 'fr')).toBeNull()
    expect(translateOffer(true, 'https://news.example/a', entry(), 'fr')).toBeNull()
    expect(translateOffer(true, 'https://news.example/report.PDF', entry('en'), 'fr')).toBeNull()
    expect(translateOffer(true, 'file:///Users/moi/page.html', entry('en'), 'fr')).toBeNull()
    expect(translateOffer(true, 'lucium://settings', entry('en'), 'fr')).toBeNull()
    expect(translateOffer(false, 'https://news.example/a', entry('en'), 'fr')).toBeNull()
    expect(translateOffer(true, undefined, entry('en'), 'fr')).toBeNull()
    expect(translateOffer(true, 'https://news.example/a', undefined, 'fr')).toBeNull()
  })

  it('stays for a page being translated and a translated one, whatever its text reads like now', () => {
    expect(translateOffer(true, 'https://news.example/a', { translation: { state: 'working', from: 'en', to: 'fr' } }, 'fr')).toEqual({ state: 'working', from: 'en', to: 'fr' })
    expect(translateOffer(true, 'https://news.example/a', { pageLanguage: 'en', translation: { state: 'translated', from: 'en', to: 'de' } }, 'fr')).toEqual({ state: 'translated', from: 'en', to: 'de' })
  })
})

describe('a page translated by itself as it loads', () => {
  const url = 'https://www.news.example/a'

  it('is one in a language of « Toujours traduire », into the target', () => {
    expect(translatesByItself(quick({ translateAlways: ['en'] }), url, 'en', 'fr')).toBe(true)
  })

  it('is never one on a site of « Ne jamais traduire ce site », which wins (its subdomains too)', () => {
    expect(translatesByItself(quick({ translateAlways: ['en'], translateNeverSites: ['news.example'] }), url, 'en', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['en'], translateNeverSites: ['news.example'] }), 'https://sport.news.example/', 'en', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['en'], translateNeverSites: ['other.example'] }), url, 'en', 'fr')).toBe(true)
  })

  it('is never one in another language, in the target language, a PDF, a page off the web, or with the function off', () => {
    expect(translatesByItself(quick({ translateAlways: ['de'] }), url, 'en', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['fr'] }), url, 'fr', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['en'] }), url, '', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['en'] }), 'https://news.example/a.pdf', 'en', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['en'] }), 'file:///a.html', 'en', 'fr')).toBe(false)
    expect(translatesByItself(quick({ translateAlways: ['en'], translateLocal: false }), url, 'en', 'fr')).toBe(false)
  })
})

describe('the names of the languages', () => {
  it('take their article in French, elided before a vowel or a mute h', () => {
    expect(languagePhrase('en', 'the')).toBe('l’anglais')
    expect(languagePhrase('en', 'of')).toBe('de l’anglais')
    expect(languagePhrase('fr', 'the')).toBe('le français')
    expect(languagePhrase('ja', 'of')).toBe('du japonais')
    expect(languagePhrase('he', 'the')).toBe('l’hébreu')
    expect(languagePhrase('hu', 'of')).toBe('du hongrois')
  })

  it('are the names alone in English', () => {
    setLanguage('en')
    expect(languagePhrase('en', 'the')).toBe('English')
    expect(languagePhrase('fr', 'of')).toBe('French')
  })

  it('say what the button and its popover say, in each state', () => {
    expect(translateSentence({ state: 'offered', from: 'en', to: 'fr' })).toBe('Page en anglais')
    expect(translateSentence({ state: 'working', from: 'en', to: 'fr' })).toBe('Traduction de l’anglais vers le français…')
    expect(translateSentence({ state: 'translated', from: 'ja', to: 'fr' })).toBe('Traduit du japonais vers le français')
    setLanguage('en')
    expect(translateSentence({ state: 'translated', from: 'en', to: 'fr' })).toBe('Translated from English to French')
    expect(translateSentence({ state: 'offered', from: 'de', to: 'en' })).toBe('Page in German')
  })

  it('name the entry of the page menu: « Traduire en français » for a page in another language, « Afficher l’original » once translated, none otherwise', () => {
    expect(translateEntryLabel('en-US', 'fr', false)).toBe('Traduire en français')
    expect(translateEntryLabel('fr', 'fr', true)).toBe('Afficher l’original')
    expect(translateEntryLabel('fr-FR', 'fr', false)).toBeNull()
    expect(translateEntryLabel('', 'fr', false)).toBeNull()
    expect(translateEntryLabel('fr', 'de', false)).toBe('Traduire en allemand')
    setLanguage('en')
    expect(translateEntryLabel('fr', 'en', false)).toBe('Translate to English')
  })

  it('fall back on the code when the system has no name for it', () => {
    expect(languageName('')).toBe('')
    expect(languageName('qq')).toBe('qq')
  })
})
