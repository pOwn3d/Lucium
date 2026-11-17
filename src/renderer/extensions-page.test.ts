// The Extensions page (chrome://extensions), rendered to markup with the real components and a snapshot of three
// extensions (no window, as space-panels.test.ts does): what a person would find on screen. Measured here: the words and places
// (☰, search, "Mode développeur", the developer's bar, the grid of cards, the rows of "Détails"), the tools of the developer behind the switch and the
// actions of every day not, the journal of a card that opens by itself on an error, and every button has a name.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPER_MODE_KEY, describeManifest, extensionState, extensionsPath, internalPageUrl, parseExtensionsLocation, type ExtensionDetail, type ExtensionRow, type ExtensionsTarget } from '@shared/extension-page'
import type { JournalEntry } from '@shared/extension-journal'
import { setLanguage } from '@shared/i18n'
import type { ExtensionInfo } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import stylesheet from './extensions-page.css?raw'
import pageSource from './ExtensionsPage.tsx?raw'
import entrySource from './extensions.tsx?raw'
import rootSource from './root.tsx?raw'
import logSource from './ui-error-log.ts?raw'
import surfaceSource from './surface.ts?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))

import { DetailRows, ExtensionCard, ExtensionsPage } from './ExtensionsPage'
import { frenchSpaces } from '@shared/french-typography'

const PROBE = 'a'.repeat(32)
const FEED = 'b'.repeat(32)
const WORDS = 'c'.repeat(32)
const extension = (over: Partial<ExtensionInfo>): ExtensionInfo => ({ id: PROBE, name: 'Sonde API', version: '1.4.2', profileId: 'default', source: 'store', enabled: true, ...over })
const infos: ExtensionInfo[] = [
  extension({ commands: [{ name: 'open', description: 'Ouvrir la fenêtre', accelerator: 'Alt+Shift+A', label: '⌥⇧A' }] }),
  extension({ id: FEED, name: 'Lecteur de flux', version: '0.9.0', source: 'unpacked' }),
  extension({ id: WORDS, name: 'Dictionnaire', version: '3.1.0', enabled: false })
]
const initialState = () => createInitialState({ now: 1, newId: () => 'id' })

/** `at`: where the address of the tab leads ("shortcuts", or the query of an extension: `id=<id>&profile=<id>`); empty, the list. */
function show(extensions: ExtensionInfo[], { at = '', dev, webStore = true }: { at?: string; dev?: 'on' | 'off'; webStore?: boolean } = {}): string {
  vi.stubGlobal('location', { pathname: at === 'shortcuts' ? '/shortcuts' : '/', search: at === '' || at === 'shortcuts' ? '' : `?${at}` })
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === DEVELOPER_MODE_KEY ? (dev ?? null) : null), setItem: () => undefined })
  const state = initialState()
  holder.snapshot = { state: { ...state, settings: { ...state.settings, webStoreInstall: webStore } }, extensions }
  return renderToStaticMarkup(createElement(ExtensionsPage))
}

/** Every button of a markup has a name: its text, or an aria-label. */
function unnamedButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs!) && inner!.replace(/<[^>]*>/g, '').trim() === '').map(([whole]) => whole.slice(0, 90))
}

beforeEach(() => setLanguage('fr'))
afterEach(() => vi.unstubAllGlobals())

describe('the list', () => {
  it('has ☰ with its entries (folded), the search, a grid of named cards with "Détails", "Supprimer" and a named switch', () => {
    const markup = show(infos)
    expect(markup.match(/<article/g)).toHaveLength(3)
    expect(markup).toContain('class="xp-grid"')
    expect(markup).toContain('placeholder="Rechercher dans les extensions"')
    expect(markup).toMatch(/aria-label="Menu principal" aria-expanded="false"/)
    expect(markup).toMatch(/<nav[^>]*hidden=""[^>]*>.*Mes extensions.*Raccourcis clavier.*Chrome Web Store.*Réglages des extensions…/)
    for (const name of ['Sonde API', 'Lecteur de flux', 'Dictionnaire']) expect(markup).toContain(frenchSpaces(`aria-label="Activer « ${name} »"`))
    expect(markup.match(/>Détails</g)).toHaveLength(3)
    expect(markup.match(/>Supprimer</g)).toHaveLength(3)
    expect(markup).toMatch(/xp-chip ok">Activée</)
    expect(markup).toContain('Non empaquetée')
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('has the developer’s bar and the id on the cards behind the switch only (on by default: the page showed them all)', () => {
    const on = show(infos)
    for (const text of ['Charger une extension non empaquetée', 'Empaqueter l’extension', 'Mettre à jour', 'aria-label="Recharger"', `<b>ID</b> ${PROBE}`]) expect(on, text).toContain(text)
    // "Empaqueter l'extension" lists the folders only: a Web Store extension is not packed.
    expect(on).toMatch(/xp-pack[\s\S]*>Lecteur de flux<\/button>/)
    expect(on).not.toMatch(/xp-pack[\s\S]*>Sonde API<\/button>/)
    expect(on).not.toMatch(/disabled=""[^>]*>Mettre à jour/)
    const off = show(infos, { dev: 'off' })
    for (const text of ['Charger l’extension', 'Empaqueter', 'Mettre à jour', 'Recharger', '<b>ID</b>']) expect(off, text).not.toContain(text)
    expect(off.match(/>Supprimer</g)).toHaveLength(3)
  })

  it('offers "Mettre à jour" and the Web Store only while the Web Store is allowed', () => {
    const markup = show(infos, { webStore: false })
    expect(markup).toMatch(/disabled=""[^>]*>Mettre à jour/)
    expect(markup).not.toMatch(/>Chrome Web Store</)
  })

  it('shows the menu of the profiles only when the extensions are in more than one', () => {
    expect(show(infos)).not.toContain('<select')
    const two = show([...infos, extension({ profileId: 'work' })])
    expect(two).toContain('<select')
    expect(two).toContain('3 extensions')
  })

  it('says there is nothing, and not an empty page', () => {
    const markup = show([])
    expect(markup).toContain('Aucune extension installée')
    expect(markup).not.toContain('<article')
  })

  it('answers in English when the language is English', () => {
    setLanguage('en')
    const markup = show(infos)
    expect(markup).toContain('Developer mode')
    expect(markup).not.toContain('Mode développeur')
  })
})

describe('a card', () => {
  const row = (over: Partial<ExtensionRow> = {}, detail?: ExtensionDetail): ExtensionRow => ({ info: infos[0]!, ...(detail ? { detail } : {}), state: extensionState(infos[0]!, detail), errors: 0, warnings: 0, ...over })
  const line = (id: number, level: JournalEntry['level']): JournalEntry => ({ id, at: 1_700_000_000_000 + id, level, source: 'worker', extensionId: PROBE, profileId: 'default', message: `line ${id}` })
  const card = (entries: JournalEntry[], r = row({ errors: entries.filter((e) => e.level === 'error').length }), dev = true) =>
    renderToStaticMarkup(createElement(ExtensionCard, { row: r, dev, busy: false, own: entries, act: async () => ({ ok: true }), onDetails: () => undefined, onClearJournal: () => undefined }))

  it('has "Erreurs" in developer mode, open by itself when the journal holds an error and folded when it holds only news', () => {
    const withError = card([line(1, 'info'), line(2, 'error')])
    expect(withError).toMatch(/aria-expanded="true"[^>]*>Erreurs</)
    expect(withError).toContain('line 2')
    expect(withError).toContain('1 erreur')
    const news = card([line(1, 'info')])
    expect(news).toMatch(/aria-expanded="false"[^>]*>Erreurs</)
    expect(news).not.toContain('line 1')
    expect(card([])).not.toContain('>Erreurs<')
    expect(card([line(2, 'error')], undefined, false)).not.toContain('>Erreurs<')
  })

  it('shows why an extension is not loaded in place of its description', () => {
    const detail: ExtensionDetail = { profileId: 'default', id: PROBE, path: '/x', facts: null, workerRunning: false, failure: 'manifest.json absent' }
    const failed = card([], row({ state: 'failed', info: { ...infos[0]!, enabled: false } }, detail))
    expect(failed).toContain(frenchSpaces('Non chargée : manifest.json absent'))
    expect(failed).toContain('xp-chip danger">Non chargée<')
  })
})

describe('an extension that asks to block requests from its code', () => {
  const WARNING = 'n’applique pas ce qu’elle répond'
  const detailOf = (manifest: Record<string, unknown>): ExtensionDetail => ({ profileId: 'default', id: PROBE, path: '/x', facts: describeManifest({ manifest_version: 3, description: 'Bloque.', ...manifest }), workerRunning: false })
  const card = (detail: ExtensionDetail) =>
    renderToStaticMarkup(createElement(ExtensionCard, { row: { info: infos[0]!, detail, state: 'enabled', errors: 0, warnings: 0 }, dev: false, busy: false, own: [], act: async () => ({ ok: true }), onDetails: () => undefined, onClearJournal: () => undefined }))
  const details = (detail: ExtensionDetail) =>
    renderToStaticMarkup(createElement(DetailRows, { row: { info: infos[0]!, detail, state: 'enabled', errors: 0, warnings: 0 }, copies: [infos[0]!], settings: initialState().settings, dev: false, busy: false, act: async () => ({ ok: true }), onCopy: () => undefined, onGone: () => undefined }))

  it('a Manifest V3 extension is told on its card and under "Détails" that what it answers is not applied, outside developer mode too', () => {
    for (const manifest of [{ permissions: ['webRequest', 'webRequestBlocking'] }, { permissions: ['webRequestBlocking'], host_permissions: ['<all_urls>'] }]) {
      expect(card(detailOf(manifest))).toMatch(new RegExp(`<p class="xp-note">[^<]*${WARNING}`))
      expect(details(detailOf(manifest))).toMatch(new RegExp(`<p class="xp-note">[^<]*${WARNING}`))
    }
  })

  it('says it in English when the language is English', () => {
    setLanguage('en')
    expect(card(detailOf({ permissions: ['webRequestBlocking'] }))).toContain('does not apply what it answers')
    setLanguage('fr')
  })

  it('says nothing of it for an extension that does not ask for it, for one with declarative rules (they are applied), for a Manifest V2 one (its answers are applied), nor while the manifest is not read', () => {
    expect(card(detailOf({ permissions: ['storage', 'tabs'] }))).not.toContain('xp-note')
    // A Manifest V2 extension has the warning of its old format (below) and not this one.
    expect(card(detailOf({ manifest_version: 2, permissions: ['webRequestBlocking', '<all_urls>'] }))).not.toContain(WARNING)
    expect(details(detailOf({ manifest_version: 2, permissions: ['webRequestBlocking', '<all_urls>'] }))).not.toContain(WARNING)
    expect(card(detailOf({ permissions: ['declarativeNetRequest', 'webRequest'], declarative_net_request: { rule_resources: [] } }))).not.toContain('xp-note')
    expect(details(detailOf({ permissions: ['storage', 'tabs'] }))).not.toContain('xp-note')
    expect(card({ profileId: 'default', id: PROBE, path: '/x', facts: null, workerRunning: false })).not.toContain('xp-note')
  })
})

describe('an extension in Manifest V2, the old format, loaded from a folder', () => {
  const NOTE = 'Cette extension est au format Manifest V2, un format ancien : Lucium la charge, mais certaines de ses fonctions peuvent manquer ou ne pas marcher comme prévu.'
  const detailOf = (manifest: Record<string, unknown>): ExtensionDetail => ({ profileId: 'default', id: FEED, path: '/work/old', facts: describeManifest({ manifest_version: 2, description: 'Une vieille extension.', ...manifest }), workerRunning: false })
  const rowOf = (detail: ExtensionDetail): ExtensionRow => ({ info: infos[1]!, detail, state: 'enabled', errors: 0, warnings: 0 })
  const card = (detail: ExtensionDetail, dev = false) =>
    renderToStaticMarkup(createElement(ExtensionCard, { row: rowOf(detail), dev, busy: false, own: [], act: async () => ({ ok: true }), onDetails: () => undefined, onClearJournal: () => undefined }))
  const details = (detail: ExtensionDetail) =>
    renderToStaticMarkup(createElement(DetailRows, { row: rowOf(detail), copies: [infos[1]!], settings: initialState().settings, dev: false, busy: false, act: async () => ({ ok: true }), onCopy: () => undefined, onGone: () => undefined }))

  it('is told on its card and under "Détails" that the format is old, under its description, outside developer mode too', () => {
    const old = detailOf({ permissions: ['storage'] })
    expect(card(old)).toMatch(new RegExp(`<p class="xp-desc">Une vieille extension\\.</p><p class="xp-note">${frenchSpaces(NOTE)}</p>`))
    expect(card(old, true)).toContain(frenchSpaces(NOTE))
    expect(details(old)).toMatch(new RegExp(`Une vieille extension\\.<p class="xp-note">${frenchSpaces(NOTE)}</p>`))
  })

  it('says it in English when the language is English', () => {
    setLanguage('en')
    expect(card(detailOf({}))).toContain('This extension uses Manifest V2, an old format: Lucium loads it, but some of its features may be missing')
    setLanguage('fr')
  })

  it('says nothing of it for a Manifest V3 extension, nor while the manifest is not read', () => {
    const v3: ExtensionDetail = { ...detailOf({}), facts: describeManifest({ manifest_version: 3, description: 'Récente.' }) }
    expect(card(v3)).not.toContain('xp-note')
    expect(details(v3)).not.toContain('xp-note')
    const unread: ExtensionDetail = { profileId: 'default', id: FEED, path: '/work/old', facts: null, workerRunning: false }
    expect(card(unread)).not.toContain('xp-note')
    expect(details(unread)).not.toContain('xp-note')
  })

  it('has the warning of its format and that of a Manifest V3 blocker apart: one never stands for the other', () => {
    const both = card({ ...detailOf({}), facts: { ...describeManifest({ manifest_version: 2 }), requestBlocking: true } })
    expect(both).toContain(frenchSpaces(NOTE))
    expect(both).toContain('n’applique pas ce qu’elle répond')
  })
})

describe('what an extension was granted on its request', () => {
  const facts = describeManifest({ manifest_version: 3, description: 'Sonde.', permissions: ['storage'], optional_permissions: ['history'], optional_host_permissions: ['https://*.shop.example/*'] })
  const rows = (granted: ExtensionDetail['granted'], act: (request: unknown) => Promise<{ ok: boolean }> = async () => ({ ok: true })) => {
    const detail: ExtensionDetail = { profileId: 'default', id: PROBE, path: '/x', facts, workerRunning: false, ...(granted ? { granted } : {}) }
    return renderToStaticMarkup(createElement(DetailRows, { row: { info: infos[0]!, detail, state: 'enabled', errors: 0, warnings: 0 }, copies: [infos[0]!], settings: initialState().settings, dev: false, busy: false, act, onCopy: () => undefined, onGone: () => undefined }))
  }
  const granted = { permissions: [{ id: 'history', label: 'Lire et modifier votre historique de navigation', level: 'broad' as const }], origins: ['https://pay.shop.example/*'] }

  it('is listed under "Détails" with the sentence and the level of the sheet, each with a named button that takes it back', () => {
    const markup = rows(granted)
    expect(markup).toContain('Accordées à sa demande')
    expect(markup).toMatch(/Lire et modifier votre historique de navigation <code class="xp-code">history<\/code> <span class="xp-chip danger">étendue<\/span>/)
    expect(markup).toContain('<code class="xp-code">https://pay.shop.example/*</code>')
    expect(markup).toContain('aria-label="Retirer l’autorisation history"')
    expect(markup).toContain('aria-label="Retirer l’autorisation https://pay.shop.example/*"')
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('has no row when nothing was granted, and the count of facultative permissions no longer says "never"', () => {
    const markup = rows(undefined)
    expect(markup).not.toContain('Accordées à sa demande')
    expect(markup.replaceAll('\u00a0', ' ')).toContain('2 autorisations facultatives, accordées seulement si vous l’acceptez quand l’extension les demande')
    expect(markup).not.toContain('jamais')
  })

  it('asks the main process to take back exactly what the button names, in the profile of the row', () => {
    expect(pageSource).toContain("act({ op: 'revoke-granted', profileId: info.profileId, extensionId: info.id, name: permission.id })")
    expect(pageSource).toContain("act({ op: 'revoke-granted', profileId: info.profileId, extensionId: info.id, name: origin })")
    // The details are read again when a grant comes or goes while the page is open.
    expect(pageSource).toContain('${e.grantedCount ?? 0}')
  })
})

describe('the page "Détails" and the shortcuts', () => {
  const facts = describeManifest({ manifest_version: 3, description: 'Sonde les API.', permissions: ['tabs'], host_permissions: ['https://example.org/*'], options_page: 'options.html' })
  const rows = (info: ExtensionInfo, dev = true) => {
    const detail: ExtensionDetail = { profileId: 'default', id: info.id, path: '/Users/moi/sonde', facts, workerRunning: false }
    const row: ExtensionRow = { info, detail, state: 'enabled', errors: 0, warnings: 0 }
    return renderToStaticMarkup(createElement(DetailRows, { row, copies: [info], settings: initialState().settings, dev, busy: false, act: async () => ({ ok: true }), onCopy: () => undefined, onGone: () => undefined }))
  }

  it('has the rows of "Détails" in their order, and says rather than offers what Lucium does not do', () => {
    const markup = rows(infos[0]!)
    const labels = ['Description', 'Version', 'ID', 'Inspecter les vues', 'Autorisations', 'Accès au site', 'Options de l’extension', 'Autoriser en navigation privée', 'Autoriser l’accès aux URL de fichier', 'Source', 'Supprimer l’extension']
    let at = -1
    for (const label of labels) {
      const next = markup.indexOf(`<span>${label}</span>`) >= 0 ? markup.indexOf(`<span>${label}</span>`) : markup.indexOf(`>${label}<`)
      expect(next, label).toBeGreaterThan(at)
      at = next
    }
    expect(markup).toContain('Sonde les API.')
    expect(markup).toContain('https://example.org/*')
    expect(markup.match(/>Non disponible</g)).toHaveLength(2)
    expect(markup).toContain('Chrome Web Store')
    expect(unnamedButtons(markup)).toEqual([])
    expect(rows(infos[0]!, false)).not.toContain('Inspecter les vues')
  })

  it('says where a folder was loaded from', () => {
    const markup = rows(infos[1]!)
    expect(markup).toContain('Extension non empaquetée')
    expect(markup).toContain(frenchSpaces('Chargée depuis : /Users/moi/sonde'))
    expect(markup).toContain('Empaqueter…')
  })

  it('keeps the shortcuts and the journal on the page, and the switch of the developer', () => {
    const hash = `id=${PROBE}&profile=default`
    const on = show(infos, { at: hash })
    for (const title of ['Raccourcis clavier', 'Erreurs']) expect(on, title).toContain(`<h2>${title}</h2>`)
    expect(on).toContain('<kbd class="tk-kbd">⌥⇧A</kbd>')
    expect(on).toContain('Mode développeur')
    expect(unnamedButtons(on)).toEqual([])
  })

  it('says when the extension of the address is not installed', () => {
    expect(show(infos.slice(1), { at: `id=${PROBE}` })).toContain('Cette extension n’est pas installée.')
  })

  it('says under a shortcut that a command of Lucium or another extension already holds that it does not respond, in the list and under "Détails"', () => {
    const clash = [extension({ commands: [{ name: 'tab', description: 'Nouvel onglet à moi', accelerator: 'Cmd+T', label: '⌘T' }, { name: 'open', description: 'Ouvrir la fenêtre', accelerator: 'Alt+Shift+A', label: '⌥⇧A' }] })]
    const NOTE = 'Déjà pris par un raccourci de Lucium ou d’une autre extension'
    for (const hash of ['shortcuts', `id=${PROBE}&profile=default`]) {
      const markup = show(clash, { at: hash })
      expect(markup.match(new RegExp(NOTE, 'g')), hash).toHaveLength(1)
      expect(markup, hash).toMatch(new RegExp(`Nouvel onglet à moi</span><div class="xp-hint">${NOTE}`))
    }
    expect(show(infos, { at: 'shortcuts' })).not.toContain(NOTE)
    // Switched off, the extension holds no key at all: nothing is said of it.
    expect(show([{ ...clash[0]!, enabled: false }], { at: 'shortcuts' })).not.toContain(NOTE)
  })

  it('lists the shortcuts of every extension that has one under the title "Raccourcis clavier"', () => {
    const markup = show(infos, { at: 'shortcuts' })
    expect(markup).toContain('<h1 class="xp-title">Raccourcis clavier</h1>')
    expect(markup).toContain('Ouvrir la fenêtre')
    expect(markup).toContain('⌥⇧A')
    expect(markup).not.toContain('Lecteur de flux')
  })
})

describe('"Effacer" of the journal at the foot of the list', () => {
  it('asks to forget the lines that are shown there, by their numbers: never the whole journal, which holds the other extensions and the other profiles', () => {
    expect(pageSource).toContain('<JournalBox entries={general} names={names} onClear={() => void clearShown(general)} />')
    expect(pageSource).toContain("send({ op: 'clear-journal', ids })")
    expect(pageSource).not.toContain('clearJournal({})')
  })
})

describe('the stylesheet', () => {
  it('keeps the profile menu, the developer switch and the icon buttons at 28 px or more: they take their height from --target', () => {
    expect(stylesheet).toMatch(/\.xp-profile\s*\{[^}]*min-height:\s*var\(--target\)/)
    expect(stylesheet).toMatch(/\.xp-dev\s*\{[^}]*min-height:\s*var\(--target\)/)
    expect(stylesheet).toMatch(/\.xp-icon\s*\{[^}]*width:\s*var\(--target\)/)
  })
})

describe('the page as a tab', () => {
  // A region that drags the window, in a page that is a tab of the window, would move the whole window by the bar of the page; the 84 px were the traffic lights of the window it had.
  it('has no title bar that drags the window and no room kept for the traffic lights', () => {
    expect(stylesheet).not.toMatch(/-webkit-app-region/)
    expect(stylesheet).not.toMatch(/\b84px\b/)
  })

  it('is routed by its address, never by the hash: nothing of it reads or writes location.hash', () => {
    expect(pageSource).not.toMatch(/location\.hash|hashchange/)
  })
})

// The key of the session (the files of the page are served under it: shared/internal-serve.ts) is known to the document of the page alone. What could carry it out is an
// address the page builds and sends somewhere: a link, a navigation, a request, a message to the main process, the address of its tab (which an extension with "tabs"
// reads) or a line of a log. The page builds none from what it knows of its own files, and the network and the navigations are closed to it anyway (the policy of content,
// the guards of the engine). The document is served with `Referrer-Policy: same-origin` (internal-serve.test.ts), so no link would send even the address of the page out.
describe('what the page can send out never holds the key of the session', () => {
  const KEY = '0123456789abcdef0123456789abcdef' // gitleaks:allow (invented for this test, the key of no session)
  const loadedFiles = `lucium-ui://extensions/${KEY}/assets/extensions-BxahU_Tj.js`
  /** The code of a module: its comments (which say what the code does not do) are not the code. */
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const mainSource = code(`${entrySource}\n${rootSource}\n${surfaceSource}`)
  const mainShell = import.meta.glob('../main/shell/internal-page*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const scan = (source: string): string[] =>
    [
      /import\.meta/,
      /document\.(currentScript|scripts|styleSheets|referrer|URL|documentURI|baseURI)/,
      /performance\.(getEntries|getEntriesByType|getEntriesByName)/,
      /querySelector(All)?\(\s*['"`][^'"`]*(script|link|base|meta)/,
      /window\.open|\.open\(\s*['"`]/,
      /location\.(href|assign|replace|origin|host|toString)|location\s*=/,
      /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|postMessage|importScripts/,
      /window\.name|\bname\s*=\s*window/,
      /\.stack\b/
    ]
      .filter((pattern) => pattern.test(code(source)))
      .map(String)

  it('reads nowhere the address of its own files, and opens nothing: no link, no window, no request, no read of the document’s scripts', () => {
    expect(scan(pageSource)).toEqual([])
    expect(scan(mainSource)).toEqual([])
    // The page's only reads of its location are the path and the query of its tab: what the shell and the page write in `extensionsPath`, never a file.
    const reads = [...code(pageSource).matchAll(/\blocation\b[^\n]{0,40}/g)].map((found) => found[0])
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read, read).toMatch(/location\.(pathname|search)\b/)
  })

  it('writes to the history one address only, the one `extensionsPath` makes of a view, an extension id and a profile: not of anything the document knows', () => {
    const writes = [...code(pageSource).matchAll(/history\.(pushState|replaceState)\([^\n]*\)/g)].map((found) => found[0])
    expect(writes).toEqual(["history.pushState(null, '', extensionsPath(target))"])
    const ids = ['a'.repeat(32), 'p'.repeat(32)]
    for (const target of [{ view: 'list' }, { view: 'shortcuts' }, ...ids.map((extensionId) => ({ view: 'detail', extensionId })), ...ids.map((extensionId) => ({ view: 'detail', extensionId, profileId: 'work' }))] as ExtensionsTarget[]) {
      expect(extensionsPath(target), JSON.stringify(target)).not.toContain(KEY)
      expect(internalPageUrl(target)).not.toContain(KEY)
    }
  })

  it('does not take the key it is shown in its location for a place to go: the list, and nothing written back', () => {
    for (const [path, search] of [[`/${KEY}/assets/extensions-BxahU_Tj.js`, ''], ['/', `?k=${KEY}`], ['/', `?id=${KEY}`], ['/shortcuts/', `?id=${PROBE}&k=${KEY}`]] as const) {
      const target = parseExtensionsLocation(path, search)
      expect(JSON.stringify(target), `${path}${search}`).not.toContain(KEY)
      expect(extensionsPath(target), `${path}${search}`).not.toContain(KEY)
    }
    expect(loadedFiles).toContain(KEY)
  })

  it('draws no link and no address in any of its views: nothing to click that goes out, and no file of the page named in its markup', () => {
    for (const markup of [show(infos), show(infos, { at: 'shortcuts' }), show(infos, { at: `id=${PROBE}&profile=default` }), show(infos, { at: `id=${PROBE}`, dev: 'on' }), show(infos, { dev: 'on', webStore: false }), show([])]) {
      expect(markup).not.toMatch(/<a[\s>]/)
      expect(markup).not.toMatch(/\s(href|action|formaction|ping|srcset|poster|background)=/)
      expect(markup).not.toContain('lucium-ui:')
      expect(markup).not.toContain('/assets/')
      // An image the page shows is data it was given (an icon), never an address.
      for (const src of markup.matchAll(/\ssrc="([^"]*)"/g)) expect(src[1], src[1]).toMatch(/^data:image\//)
    }
  })

  it('writes its uncaught errors to its console and nowhere else: the stack of an error names the files of the page, and the console of a tab is not relayed to the log of the application', () => {
    // The only place the page holds the address of one of its files (the stack of an error, the `filename` of an error event) is the log of its own errors.
    expect(code(logSource)).not.toMatch(/lucium|api\(|fetch\(|sendBeacon|postMessage|XMLHttpRequest/)
    expect(code(logSource)).toContain('log: (...args: unknown[]) => void = console.error')
    // The relay of those lines to the log of the application is wired for the surfaces of the interface (surface-load.ts), not for the page of a tab.
    for (const [file, source] of Object.entries(mainShell)) {
      if (!/internal-page|internal-pages/.test(file)) continue
      expect(source, file).not.toMatch(/relayUiErrors|ui-error-relay|console-message/)
    }
  })
})
