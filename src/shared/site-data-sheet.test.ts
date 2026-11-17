// The rules of the sheet « Effacer les données du site » (site-data-sheet.ts): what it opens with, what the keys of the field do, what keeps a run from
// starting and how it is said, the run it asks for, what it remembers, and the summary of the answer. The choices are the extension's.

import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage, t } from './i18n'
import { DEFAULT_SITE_DATA_TYPES, SITE_DATA_HOSTS_MAX, SITE_DATA_TYPES, type SiteDataSiteResult } from './site-data'
import {
  licencesNoteKey,
  offeredSiteDataTypes,
  rememberedChoices,
  resultChip,
  resultErrors,
  resultsSummary,
  sheetHosts,
  sheetKeyAction,
  sheetProblem,
  sheetProblemText,
  sheetRequest,
  sheetStart,
  type SheetSettings
} from './site-data-sheet'
import { frenchSpaces } from './french-typography'

const settings = (over: Partial<SheetSettings> = {}): SheetSettings => ({ siteDataTypes: [...DEFAULT_SITE_DATA_TYPES], siteDataSubdomains: false, siteDataReload: true, siteDataAutoClose: true, siteDataHttp: false, ...over })

afterEach(() => setLanguage('fr'))

describe('what the sheet opens with', () => {
  it('names the site of the tab as the first tag, its port included, localhost and IP addresses as they are', () => {
    expect(sheetStart('https://www.example.com/a/b?c#d', settings(), { private: false }).tags).toEqual(['www.example.com'])
    expect(sheetStart('http://localhost:3000/admin', settings(), { private: false }).tags).toEqual(['localhost:3000'])
    expect(sheetStart('http://192.168.1.20:8080/', settings(), { private: false }).tags).toEqual(['192.168.1.20:8080'])
    expect(sheetStart('https://Example.COM:443/', settings(), { private: false }).tags).toEqual(['example.com'])
  })

  it('names no site for a tab that is not on a web page', () => {
    for (const url of ['about:blank', 'lucium://settings', 'file:///Users/moi/a.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', '', null, undefined]) {
      expect(sheetStart(url, settings(), { private: false }).tags, String(url)).toEqual([])
    }
  })

  it('has the extension’s defaults: every type but the history, subdomains off, the reload and the auto-close on', () => {
    const start = sheetStart('https://example.com/', settings(), { private: false })
    expect(start.types).toEqual(SITE_DATA_TYPES.filter((type) => type !== 'history'))
    expect([start.http, start.subdomains, start.reload, start.autoClose]).toEqual([false, false, true, true])
  })

  it('ticks « Inclure HTTP » for a page served over http, or when it was ticked by hand before', () => {
    expect(sheetStart('http://localhost:3000/', settings(), { private: false }).http).toBe(true)
    expect(sheetStart('https://example.com/', settings(), { private: false }).http).toBe(false)
    expect(sheetStart('https://example.com/', settings({ siteDataHttp: true }), { private: false }).http).toBe(true)
    expect(sheetStart(null, settings(), { private: false }).http).toBe(false)
  })

  it('starts from the choices remembered, and offers no history in a private window', () => {
    const remembered = settings({ siteDataTypes: ['cookies', 'history'], siteDataSubdomains: true, siteDataReload: false, siteDataAutoClose: false })
    expect(sheetStart('https://example.com/', remembered, { private: false })).toMatchObject({ types: ['cookies', 'history'], subdomains: true, reload: false, autoClose: false })
    expect(sheetStart('https://example.com/', remembered, { private: true }).types).toEqual(['cookies'])
    expect(offeredSiteDataTypes(true)).toEqual(SITE_DATA_TYPES.filter((type) => type !== 'history'))
    expect(offeredSiteDataTypes(false)).toEqual([...SITE_DATA_TYPES])
  })
})

describe('the sites of a run', () => {
  it('are the tags, then what is still typed (a whole address gives its host), each once', () => {
    expect(sheetHosts(['a.example'], '')).toEqual({ hosts: ['a.example'], draftInvalid: false })
    expect(sheetHosts(['a.example'], 'b.example, a.example https://c.example/x')).toEqual({ hosts: ['a.example', 'b.example', 'c.example'], draftInvalid: false })
  })

  it('say when what is typed is not a site', () => {
    expect(sheetHosts(['a.example'], 'pas/un/hote')).toEqual({ hosts: ['a.example'], draftInvalid: true })
  })
})

describe('the keys of the field', () => {
  it('Enter adds what is typed as a tag, and starts the run when the field is empty', () => {
    expect(sheetKeyAction('Enter', 'b.example', 1)).toBe('take')
    expect(sheetKeyAction('Enter', '', 1)).toBe('clear')
    expect(sheetKeyAction('Enter', '   ', 1)).toBe('clear')
    // With no tag, the run's own check says « Entrez un domaine ».
    expect(sheetKeyAction('Enter', '', 0)).toBe('clear')
  })

  it('Backspace in an empty field takes the last tag away, and is typing otherwise', () => {
    expect(sheetKeyAction('Backspace', '', 2)).toBe('remove-last')
    expect(sheetKeyAction('Backspace', 'b', 2)).toBeNull()
    expect(sheetKeyAction('Backspace', '', 0)).toBeNull()
    expect(sheetKeyAction('a', '', 2)).toBeNull()
  })
})

describe('what keeps a run from starting', () => {
  it('is no site, then no type, in the extension’s words', () => {
    expect(sheetProblem({ hosts: [], draftInvalid: false, types: ['cookies'] })).toBe('no-site')
    expect(sheetProblem({ hosts: [], draftInvalid: false, types: [] })).toBe('no-site')
    expect(sheetProblem({ hosts: ['a.example'], draftInvalid: false, types: [] })).toBe('no-type')
    expect(sheetProblemText('no-site')).toBe('Entrez un domaine')
    expect(sheetProblemText('no-type')).toBe('Sélectionnez au moins un type')
    setLanguage('en')
    expect([sheetProblemText('no-site'), sheetProblemText('no-type')]).toEqual(['Enter a domain', 'Select at least one data type'])
  })

  it('is a typed site that is not one, or more sites than a run takes', () => {
    expect(sheetProblem({ hosts: ['a.example'], draftInvalid: true, types: ['cookies'] })).toBe('invalid')
    const many = Array.from({ length: SITE_DATA_HOSTS_MAX + 1 }, (_, i) => `s${i}.example`)
    expect(sheetProblem({ hosts: many, draftInvalid: false, types: ['cookies'] })).toBe('too-many')
    expect(sheetProblem({ hosts: many.slice(1), draftInvalid: false, types: ['cookies'] })).toBeNull()
  })

  it('is nothing when there is a site and a type', () => {
    expect(sheetProblem({ hosts: ['a.example'], draftInvalid: false, types: ['cookies'] })).toBeNull()
  })
})

describe('the run the button asks for', () => {
  const choices = { types: ['history', 'cookies'] as const, http: true, subdomains: true, reload: false, autoClose: true }

  it('carries the scopes, the reload and the auto-close, with the types in the panel’s order', () => {
    expect(sheetRequest(['a.example', 'localhost:3000'], { ...choices, types: [...choices.types] })).toEqual({ hosts: ['a.example', 'localhost:3000'], types: ['cookies', 'history'], subdomains: true, http: true, reload: false, detached: true })
    expect(sheetRequest(['a.example'], { ...choices, types: ['cookies'], http: false, subdomains: false, autoClose: false })).toMatchObject({ http: false, subdomains: false, detached: false })
  })

  it('remembers « Inclure HTTP » only when the user flipped it: ticked by itself for an http page, it must not stay for the https sites after', () => {
    const run = { ...choices, types: [...choices.types] }
    expect(rememberedChoices(run, { httpChosen: false, settings: settings() }).siteDataHttp).toBe(false)
    expect(rememberedChoices(run, { httpChosen: true, settings: settings() }).siteDataHttp).toBe(true)
    expect(rememberedChoices({ ...run, http: false }, { httpChosen: true, settings: settings({ siteDataHttp: true }) }).siteDataHttp).toBe(false)
    expect(rememberedChoices(run, { httpChosen: false, settings: settings() })).toEqual({ siteDataTypes: ['cookies', 'history'], siteDataSubdomains: true, siteDataReload: false, siteDataAutoClose: true, siteDataHttp: false })
  })
})

describe('the answer', () => {
  const site = (host: string, ...results: SiteDataSiteResult['results']): SiteDataSiteResult => ({ host, results })

  it('says everything was cleared, with the number of operations', () => {
    expect(resultsSummary([site('a', { type: 'cookies', ok: true }, { type: 'cache', ok: true }), site('b', { type: 'cookies', ok: true })], { reload: true })).toEqual({ ok: true, title: 'Données effacées', detail: '3 opérations réussies' })
  })

  it('counts the failures, says the tab was not reloaded when it was asked to be, and counts a site with no answer as a failure', () => {
    const results = [site('a', { type: 'cookies', ok: true }, { type: 'cache', ok: false, error: 'disk' }), site('b')]
    expect(resultsSummary(results, { reload: true })).toEqual({ ok: false, title: 'Terminé avec 2 erreurs', detail: frenchSpaces('Réussies : 1 · Échecs : 2 · onglet non rechargé') })
    expect(resultsSummary(results, { reload: false }).detail).toBe(frenchSpaces('Réussies : 1 · Échecs : 2'))
  })

  it('gives each type a chip with its count when there was something, and each failure its words', () => {
    expect(resultChip({ type: 'cookies', ok: true, count: 3 })).toEqual({ type: 'cookies', ok: true, label: 'Cookies', count: 3, title: '3 cookies' })
    expect(resultChip({ type: 'history', ok: true, count: 0 })).toMatchObject({ count: null, title: 'Rien à effacer' })
    expect(resultChip({ type: 'cache', ok: false, error: 'disk full' })).toMatchObject({ ok: false, count: null, title: frenchSpaces('Échec : disk full') })
    expect(resultErrors([{ type: 'cache', ok: false, error: 'disk full' }, { type: 'cookies', ok: true }, { type: 'indexedDB', ok: false }])).toEqual(['Cache du réseau — disk full', 'Bases IndexedDB — Échec'])
  })

  it('names the line of the licences of protected video, in its chip and in its failure', () => {
    expect(resultChip({ type: 'mediaLicenses', ok: true })).toEqual({ type: 'mediaLicenses', ok: true, label: 'Licences de vidéo protégée', count: null, title: 'Effacé' })
    expect(resultErrors([{ type: 'mediaLicenses', ok: false, error: 'storage busy' }])).toEqual(['Licences de vidéo protégée — storage busy'])
  })

  it('says what the search for the subdomains that hold data gave: how many, none, a list that is not whole, or no list at all', () => {
    expect(resultChip({ type: 'subdomains', ok: true, count: 2 })).toEqual({ type: 'subdomains', ok: true, label: 'Sous-domaines', count: 2, title: '2 sous-domaines avec des données' })
    expect(resultChip({ type: 'subdomains', ok: true, count: 1 })).toMatchObject({ title: '1 sous-domaine avec des données' })
    expect(resultChip({ type: 'subdomains', ok: true, count: 0 })).toMatchObject({ count: null, title: 'Rien à effacer' })
    expect(resultErrors([{ type: 'subdomains', ok: false, error: 'unread' }])).toEqual(['Sous-domaines — unread'])
    // A private window: the chip itself says the list was not whole, and its tooltip says why instead of « Effacé ».
    const seen = resultChip({ type: 'subdomains', ok: true, seenOnly: true })
    expect(seen).toEqual({ type: 'subdomains', ok: true, label: 'Sous-domaines vus seulement', count: null, title: t('site-data.une-fenetre-privee-ne-garde-pas-la-liste-des-sites') })
  })

  it('says the licences go only when every type their erasure takes is ticked, and that they stay otherwise', () => {
    expect(licencesNoteKey([...SITE_DATA_TYPES])).toBe('site-data.note-licences-effacees')
    expect(licencesNoteKey(['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'])).toBe('site-data.note-licences-effacees')
    for (const kept of ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] as const) {
      expect(licencesNoteKey(SITE_DATA_TYPES.filter((type) => type !== kept)), kept).toBe('site-data.note-licences-gardees')
    }
    expect(licencesNoteKey(['cookies'])).toBe('site-data.note-licences-gardees')
    // Nothing is said to someone who erases none of that storage.
    expect(licencesNoteKey(['cache', 'sessionStorage', 'history'])).toBeNull()
    expect(licencesNoteKey([])).toBeNull()
  })
})
