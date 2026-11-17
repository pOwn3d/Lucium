// `chrome://history` and the other internal addresses people type lead to the page of Lucium that stands for them, or say there is none.

import { describe, expect, it } from 'vitest'
import { chromePageOf, extensionTabPage, parseChromeAddress, type ChromePageContext } from './chrome-pages'
import { normalizeWindowUrl } from './chrome-compat'
import { rankCandidates, type Candidate } from './command-bar'
import { isPageOpenUrl } from './external-links'
import { SETTINGS_ANCHORS, SETTINGS_PANES, type OverlayRequest } from './ipc'
import { createInitialState } from './sidebar'
import { isNavigableUrl, isTypedAddress, resolveInput } from './url'
import { frenchSpaces } from './french-typography'

const ON: ChromePageContext = { private: false, settings: { bookmarkManager: true, passwordManager: true, cookieManager: true } }
const OFF: ChromePageContext = { private: false, settings: { bookmarkManager: false, passwordManager: false, cookieManager: false } }
const PRIVATE: ChromePageContext = { ...ON, private: true }

const settings = (pane: string, anchor?: string): OverlayRequest => ({ panel: 'settings', pane, ...(anchor ? { anchor } : {}) }) as OverlayRequest

describe('parseChromeAddress', () => {
  it('reads chrome:// and arc:// addresses, in any case, with a path, a query or a fragment', () => {
    expect(parseChromeAddress('chrome://settings')).toMatchObject({ scheme: 'chrome', host: 'settings', path: [] })
    expect(parseChromeAddress('  ARC://Settings/Privacy/  ')).toMatchObject({ scheme: 'arc', host: 'settings', path: ['privacy'] })
    expect(parseChromeAddress('chrome://settings/content/cookies?search=a#top')).toMatchObject({ host: 'settings', path: ['content', 'cookies'] })
    expect(parseChromeAddress('chrome://net-internals/#dns')).toMatchObject({ host: 'net-internals', path: [] })
  })

  it('leaves everything else alone: words, web addresses, other schemes that start with the same letters, text around it', () => {
    for (const text of ['', 'chrome', 'chrome://', 'chrome:settings', 'chrome settings', 'chrome://settings and more', 'https://chrome.example/settings', 'javascript:chrome://settings', 'view-source:chrome://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'chrome-untrusted://x', 'chrome-search://x', 'devtools://devtools/bundled/devtools_app.html', 'file:///chrome://settings']) {
      expect(parseChromeAddress(text), text).toBeNull()
    }
  })

  it('cuts what the messages quote, so a very long address does not fill the screen', () => {
    const address = parseChromeAddress(`chrome://${'a'.repeat(300)}`)
    expect(address!.text.length).toBe(80)
    expect(address!.text.endsWith('…')).toBe(true)
  })
})

describe('the table of addresses', () => {
  const leads = (text: string, ctx = ON) => chromePageOf(text, ctx)?.request

  it('leads chrome://settings and arc://settings to Settings, and the sub-pages people know to the place that holds the same thing', () => {
    expect(leads('chrome://settings')).toEqual(settings('home'))
    expect(leads('arc://settings')).toEqual(settings('home'))
    expect(leads('chrome://settings/privacy')).toEqual(settings('protection'))
    expect(leads('chrome://settings/security')).toEqual(settings('protection'))
    expect(leads('chrome://settings/clearBrowserData')).toEqual(settings('protection'))
    expect(leads('chrome://settings/content/notifications')).toEqual(settings('protection', 'permissions'))
    expect(leads('chrome://settings/content')).toEqual(settings('protection', 'permissions'))
    expect(leads('chrome://settings/searchEngines')).toEqual(settings('navigation', 'engine'))
    expect(leads('chrome://settings/people')).toEqual(settings('profiles'))
    expect(leads('chrome://settings/downloads')).toEqual(settings('files', 'downloads'))
    expect(leads('chrome://settings/help')).toEqual(settings('about', 'about'))
    expect(leads('chrome://settings/languages')).toEqual(settings('home'))
    // The accessibility settings are in Apparence.
    expect(leads('chrome://settings/accessibility')).toEqual(settings('appearance'))
    expect(leads('chrome://settings/onStartup')).toEqual(settings('tabs'))
    expect(leads('chrome://settings/appearance')).toEqual(settings('appearance'))
    expect(leads('chrome://settings/cookies')).toEqual({ panel: 'cookies' })
    expect(leads('chrome://settings/content/cookies')).toEqual({ panel: 'cookies' })
    expect(leads('chrome://settings/content/all')).toEqual({ panel: 'cookies' })
    expect(leads('chrome://settings/passwords')).toEqual({ panel: 'passwords' })
    expect(leads('chrome://settings/autofill')).toEqual({ panel: 'passwords' })
    expect(leads('chrome://settings/extensions')).toEqual({ panel: 'extensions' })
  })

  it('opens Settings itself for a sub-page it has no name for, instead of nothing', () => {
    expect(leads('chrome://settings/payments')).toEqual(settings('home'))
    expect(leads('chrome://settings/zzz/qqq')).toEqual(settings('home'))
  })

  it('leads the history, downloads and bookmarks addresses to the panels of Lucium', () => {
    expect(leads('chrome://history')).toEqual({ panel: 'history' })
    expect(leads('chrome://history/?q=term')).toEqual({ panel: 'history' })
    expect(leads('arc://history')).toEqual({ panel: 'history' })
    expect(leads('chrome://downloads')).toEqual({ panel: 'downloads' })
    expect(leads('chrome://bookmarks')).toEqual({ panel: 'bookmarks' })
    expect(leads('chrome://bookmarks/?id=3')).toEqual({ panel: 'bookmarks' })
    expect(leads('chrome://password-manager/passwords')).toEqual({ panel: 'passwords' })
    expect(leads('chrome://newtab')).toEqual({ panel: 'commandbar', mode: 'new', initial: '' })
  })

  it('leads chrome://version, about, help and credits to the About group', () => {
    for (const text of ['chrome://version', 'chrome://about', 'chrome://help', 'chrome://chrome-urls', 'chrome://credits', 'arc://version']) expect(leads(text), text).toEqual(settings('about', 'about'))
  })

  it('says what Lucium does instead of flags: its features to add are in « Fonctions en option », which it opens', () => {
    const page = chromePageOf('chrome://flags/#enable-x', ON)!
    expect(page.request).toEqual(settings('features'))
    expect(page.label).toBe('Réglages › Fonctions en option')
    expect(page.detail).toBe(frenchSpaces('Pas de drapeaux : les fonctions à ajouter sont dans « Fonctions en option », les autres réglages dans leur page'))
    expect(page.notice).toBe(frenchSpaces('chrome://flags/#enable-x : Pas de drapeaux : les fonctions à ajouter sont dans « Fonctions en option », les autres réglages dans leur page'))
  })

  it('answers the diagnostic pages with what does the same work, and opens none of them', () => {
    const detail = (text: string) => chromePageOf(text, ON)!.detail
    expect(detail('chrome://net-internals')).toBe('Panneau Network des outils de développement')
    expect(detail('chrome://serviceworker-internals')).toBe('Panneau Application des outils de développement')
    expect(detail('chrome://indexeddb-internals')).toBe('Panneau Application des outils de développement')
    expect(detail('chrome://media-internals')).toBe('Panneau Media des outils de développement')
    expect(detail('chrome://tracing')).toBe('Panneau Performance des outils de développement')
    expect(detail('chrome://accessibility')).toBe('Panneau Elements › Accessibility des outils de développement')
    expect(detail('chrome://inspect')).toBe('Menu Affichage › Développeur › Outils de développement')
    expect(detail('chrome://gpu')).toBe('Diagnostic du moteur, sans équivalent')
    expect(detail('chrome://webrtc-internals')).toBe('Diagnostic du moteur, sans équivalent')
    expect(detail('chrome://ukm')).toBe('Aucune statistique collectée ni envoyée')
    expect(detail('chrome://sync-internals')).toBe('Ni compte ni synchronisation dans Lucium')
    for (const text of ['chrome://gpu', 'chrome://net-internals', 'chrome://inspect', 'chrome://tracing', 'chrome://ukm', 'chrome://webrtc-internals']) {
      const page = chromePageOf(text, ON)!
      expect(page.request, text).toBeUndefined()
      expect(page.label, text).toBe(text)
      expect(page.notice, text).toContain(text)
    }
  })

  it('says there is no such page for an address it does not know, in the same way: never nothing, never a web search', () => {
    for (const text of ['chrome://nothing-like-this', 'chrome://apps', 'chrome://policy', 'arc://whatever/else', 'chrome://crash']) {
      const page = chromePageOf(text, ON)!
      expect(page, text).not.toBeNull()
      expect(page.request, text).toBeUndefined()
      expect(page.label, text).toBe(text)
      expect(page.detail, text).toBe('Pas de page de ce nom, voir Réglages')
      expect(page.notice, text).toBe(frenchSpaces(`Cette adresse mène à une page interne d’un autre navigateur ; Lucium n’en a pas. ${text} : Pas de page de ce nom, voir Réglages`))
    }
  })

  it('has a request that Settings and the overlay accept for every address it opens', () => {
    const typed = ['chrome://settings', 'chrome://settings/privacy', 'chrome://settings/content/notifications', 'chrome://settings/searchEngines', 'chrome://settings/downloads', 'chrome://settings/help', 'chrome://settings/languages', 'chrome://settings/syncSetup', 'chrome://flags', 'chrome://version']
    for (const text of typed) {
      const request = chromePageOf(text, ON)!.request!
      expect(request.panel, text).toBe('settings')
      if (request.panel !== 'settings') continue
      expect(SETTINGS_PANES as readonly string[], text).toContain(request.pane)
      if (request.anchor !== undefined) expect(SETTINGS_ANCHORS as readonly string[], text).toContain(request.anchor)
    }
  })
})

describe('what a switch or a private window takes away', () => {
  it('sends chrome://bookmarks to the page that holds its switch, « Fonctions en option », and the passwords to theirs, while their function is off, and says so', () => {
    for (const [text, pane, anchor, label] of [['chrome://bookmarks', 'features', undefined, 'Réglages › Fonctions en option'], ['chrome://password-manager', 'protection', 'lock', 'Réglages › Verrouillage'], ['chrome://settings/passwords', 'protection', 'lock', 'Réglages › Verrouillage']] as const) {
      const page = chromePageOf(text, OFF)!
      expect(page.request, text).toEqual(settings(pane, anchor))
      expect(page.label, text).toBe(label)
      expect(page.notice, text).not.toBeNull()
    }
    expect(chromePageOf('chrome://bookmarks', OFF)!.detail).toBe('Les signets sont désactivés')
    expect(chromePageOf('chrome://password-manager', OFF)!.detail).toBe('Le gestionnaire de mots de passe est désactivé')
  })

  it('sends `chrome://settings/cookies` to « Fonctions en option », where the switch of the cookie view is, when that view is off', () => {
    expect(chromePageOf('chrome://settings/cookies', OFF)!.request).toEqual(settings('features'))
    expect(chromePageOf('chrome://settings/content/cookies', OFF)!.label).toBe('Réglages › Fonctions en option')
  })

  it('opens nothing for what a private window does not keep, and says why', () => {
    for (const [text, detail] of [['chrome://history', 'Pas d’historique en fenêtre privée'], ['chrome://bookmarks', 'Pas de signets en fenêtre privée'], ['chrome://password-manager', 'Pas de mots de passe en fenêtre privée']] as const) {
      const page = chromePageOf(text, PRIVATE)!
      expect(page.request, text).toBeUndefined()
      expect(page.detail, text).toBe(detail)
      expect(page.notice, text).toBe(frenchSpaces(`Cette adresse mène à une page interne d’un autre navigateur ; Lucium n’en a pas. ${text} : ${detail}`))
    }
    expect(chromePageOf('chrome://settings/cookies', PRIVATE)!.request).toEqual(settings('protection'))
    // What a private window does have is still there.
    expect(chromePageOf('chrome://downloads', PRIVATE)!.request).toEqual({ panel: 'downloads' })
    expect(chromePageOf('chrome://settings', PRIVATE)!.request).toEqual(settings('home'))
  })
})

describe('chrome://extensions and the other pages, for an extension', () => {
  it('opens the Extensions page for chrome://extensions, with a path, a query or arc://, and the other pages as the table says', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    expect(extensionTabPage('chrome://extensions', ON)?.request).toEqual({ panel: 'extensions', target: { view: 'list' } })
    expect(extensionTabPage('arc://extensions', ON)?.request).toEqual({ panel: 'extensions', target: { view: 'list' } })
    expect(extensionTabPage('chrome://extensions/shortcuts', ON)?.request).toEqual({ panel: 'extensions', target: { view: 'shortcuts' } })
    expect(extensionTabPage(`chrome://extensions/?id=${id}`, ON)?.request).toEqual({ panel: 'extensions', target: { view: 'detail', extensionId: id } })
    expect(extensionTabPage('chrome://settings/privacy', ON)?.request).toEqual(settings('protection'))
    expect(extensionTabPage('chrome://history', ON)?.request).toEqual({ panel: 'history' })
    expect(extensionTabPage('chrome://flags', ON)?.request).toEqual(settings('features'))
    expect(extensionTabPage('chrome://gpu', ON)?.notice).toBe(frenchSpaces('Cette adresse mène à une page interne d’un autre navigateur ; Lucium n’en a pas. chrome://gpu : Diagnostic du moteur, sans équivalent'))
    // An arc:// address is named for what it is.
    expect(extensionTabPage('arc://gpu', ON)?.notice).toBe(frenchSpaces('Cette adresse mène à une page interne d’un autre navigateur ; Lucium n’en a pas. arc://gpu : Diagnostic du moteur, sans équivalent'))
  })

  it('leaves chrome://newtab to the blank tab an agent opens its working tabs with, and every other address to the library', () => {
    for (const url of ['chrome://newtab', 'chrome://newtab/', ' chrome://newtab ', 'https://example.com/', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'panel.html', 'file:///etc/passwd', 'javascript:alert(1)', 42, undefined, null, {}]) {
      expect(extensionTabPage(url, ON), String(url)).toBeNull()
    }
  })
})

describe('the command bar', () => {
  const base = createInitialState({ now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() })
  const state = { ...base, settings: { ...base.settings, bookmarkManager: true, passwordManager: true } }
  const rows = (text: string, options: { private?: boolean } = {}) => rankCandidates(text, state, [], [], [], options)

  it('offers the page that stands for the address alone, with the sentence of its detail, and no web search for that text', () => {
    expect(rows('chrome://settings')).toEqual([{ kind: 'internal', id: 'internal', label: 'Réglages › Pour commencer', detail: 'Équivalent de chrome://settings', request: settings('home') }])
    expect(rows('chrome://history')).toEqual([{ kind: 'internal', id: 'internal', label: 'Historique', detail: 'Équivalent de chrome://history', request: { panel: 'history' } }])
    expect(rows('chrome://settings/privacy')[0]).toMatchObject({ label: 'Réglages › Vie privée et sécurité', request: settings('protection') })
    for (const text of ['chrome://settings', 'chrome://gpu', 'chrome://unknown-page', 'arc://flags']) {
      const found = rows(text)
      expect(found, text).toHaveLength(1)
      expect(found[0]!.kind, text).toBe('internal')
    }
  })

  it('shows a row with nothing to open for an address that leads nowhere', () => {
    const [row] = rows('chrome://gpu') as Array<Candidate & { kind: 'internal' }>
    expect(row).toEqual({ kind: 'internal', id: 'internal', label: 'chrome://gpu', detail: 'Diagnostic du moteur, sans équivalent' })
    expect('request' in row!).toBe(false)
  })

  it('follows the state: the bookmark library off, and a private window', () => {
    const off = { ...state, settings: { ...state.settings, bookmarkManager: false } }
    expect(rankCandidates('chrome://bookmarks', off)[0]).toMatchObject({ kind: 'internal', label: 'Réglages › Fonctions en option', detail: 'Les signets sont désactivés', request: settings('features') })
    expect(rows('chrome://history', { private: true })[0]).toEqual({ kind: 'internal', id: 'internal', label: 'chrome://history', detail: 'Pas d’historique en fenêtre privée' })
  })

  it('does not touch chrome://extensions (its own row), an address with words around it, or a web address', () => {
    expect(rows('chrome://extensions')[0]).toMatchObject({ kind: 'extpage', id: 'extpage' })
    expect(rows('chrome://settings and more').some((c) => c.kind === 'internal')).toBe(false)
    expect(rows('https://chrome.example/history').some((c) => c.kind === 'internal')).toBe(false)
    expect(rows('example.com')[0]).toMatchObject({ kind: 'open', url: 'https://example.com' })
  })
})

describe('what a web page can do with these addresses', () => {
  // The pages of Lucium they lead to are for the person who typed the address: no address of a page, no link and no window.open reaches them.
  const addresses = ['chrome://settings', 'chrome://extensions', 'chrome://history', 'chrome://flags', 'chrome://gpu', 'arc://settings', 'arc://extensions']

  it('opens in no tab and in no window: they are not web addresses', () => {
    for (const url of addresses) {
      expect(isNavigableUrl(url), url).toBe(false)
      expect(isPageOpenUrl(url), url).toBe(false)
      expect(() => normalizeWindowUrl(url), url).toThrow('Invalid URL')
    }
  })

  it('is an address for the suggestions of the search engine: what is typed is never sent to it', () => {
    for (const url of addresses) expect(isTypedAddress(url), url).toBe(true)
  })

  it('is read as a web search, not as an address to load, by the part that turns text into a page', () => {
    for (const url of addresses) expect(resolveInput(url, 'https://search.example/?q=%s')?.kind, url).toBe('search')
  })
})
