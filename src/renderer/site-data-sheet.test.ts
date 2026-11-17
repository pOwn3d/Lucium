// The sheet « Effacer les données du site » (SiteData.tsx) and its group of Réglages, drawn with the real components and no window: the layout of the
// extension « Clear Domain Data » (domains as tags, the two scopes, the recent domains, the grid of types with its count, the switches, the button with
// its keys), what the button and the field ask of the main process, the answer and the confirmation. What a button asks is read the way
// site-panel.test.ts reads it: the component is called as a function, and the handler it hands to a button is called.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import type { SiteDataBatchRequest, SiteDataSiteResult } from '@shared/site-data'

type El = ReactElement<Record<string, unknown>>

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<{ call: string; request?: unknown }> }))
vi.mock('./api', () => ({
  api: () => ({
    openOverlay: (request: unknown) => holder.asked.push({ call: 'openOverlay', request }),
    closeOverlay: () => holder.asked.push({ call: 'closeOverlay' }),
    dispatch: (action: unknown) => (holder.asked.push({ call: 'dispatch', request: action }), Promise.resolve()),
    clearSites: (request: SiteDataBatchRequest) => (holder.asked.push({ call: 'clearSites', request }), Promise.resolve([])),
    siteCookieCount: () => Promise.resolve(0)
  }),
  useSnapshot: () => holder.snapshot
}))

import { SiteData, type SiteDataInitial } from './SiteData'
import { frenchSpaces } from '@shared/french-typography'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }

/** A window with one tab on `url` (none when null), these settings, private or not. */
function snapshotWith(url: string | null, settings: Partial<Settings> = {}, options: { private?: boolean } = {}): void {
  let state: SidebarState = createInitialState(ctx)
  if (url !== null) state = reduce(state, { type: 'tab/open', url, spaceId: state.spaces[0]!.id }, ctx)
  state = reduce(state, { type: 'settings/update', patch: settings }, ctx)
  holder.snapshot = { state, extensions: [], runtime: { tabs: {} }, platform: 'darwin', private: options.private === true }
}

function sheet(url: string | null, settings: Partial<Settings> = {}, initial: SiteDataInitial = {}, options: { private?: boolean } = {}): string {
  snapshotWith(url, settings, options)
  return renderToStaticMarkup(createElement(SiteData, { initial }))
}

/** Every element of a tree, the function components called too. */
function expanded(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(expanded)
  if (!isValidElement(node)) return []
  const element = node as El
  if (typeof element.type === 'function') return [element, ...expanded((element.type as (props: unknown) => ReactNode)(element.props))]
  return [element, ...expanded(element.props['children'] as ReactNode)]
}

/** The sheet as the elements it returns (it keeps state, so it is called while a render is going on). */
function elements(url: string | null, settings: Partial<Settings> = {}, initial: SiteDataInitial = {}, options: { private?: boolean } = {}): El[] {
  snapshotWith(url, settings, options)
  let tree: El[] = []
  const Probe = () => {
    tree = expanded(createElement(SiteData, { initial }))
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return tree
}

const byClass = (tree: El[], className: string) => tree.find((element) => String(element.props['className'] ?? '').split(' ').includes(className))
const click = (element: El | undefined) => (element!.props['onClick'] as () => void)()
const key = (element: El | undefined, name: string) => (element!.props['onKeyDown'] as (e: unknown) => void)({ key: name, preventDefault: () => undefined, nativeEvent: { isComposing: false } })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const runs = () => holder.asked.filter((ask) => ask.call === 'clearSites').map((ask) => ask.request as SiteDataBatchRequest)

beforeEach(() => {
  holder.asked = []
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), lucium: {} })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the sheet as it opens', () => {
  it('draws nothing until the first snapshot has come', () => {
    holder.snapshot = null
    expect(renderToStaticMarkup(createElement(SiteData))).toBe('')
  })

  it('names the site of the tab as a tag, in monospace, with its ×, and the field to add one', () => {
    const markup = sheet('http://localhost:3000/admin')
    expect(markup).toContain('<span class="sd-tag-label" title="localhost:3000">localhost:3000</span>')
    expect(markup).toContain('aria-label="Retirer localhost:3000"')
    expect(markup).toContain('placeholder="Ajouter un domaine…"')
    expect(markup).toContain('>1 domaine</span>')
  })

  it('has the extension’s defaults: every type but the history, HTTP for an http page, subdomains off, the reload and the auto-close on', () => {
    const markup = sheet('http://localhost:3000/')
    const ticked = [...markup.matchAll(/<input type="checkbox" class="sd-check"(?: aria-description="[^"]*")?( checked="")?[^>]*\/><strong class="sd-tile-label">([^<]+)</g)].map(([, on, label]) => `${on ? '✓' : '·'} ${label}`)
    expect(ticked).toEqual(['✓ Cache du réseau', '✓ Cookies', '✓ Stockage local', '✓ Bases IndexedDB', '✓ Service workers', '✓ Cache Storage', '✓ sessionStorage', '· Historique du site'])
    expect(markup).toContain('<span class="sd-count">7/8</span>')
    const pill = (label: string) => markup.split(`<span>${label}</span>`)[0]!.split('<label class="sd-scope"').at(-1)!
    expect(pill('Inclure HTTP')).toContain('checked=""')
    expect(pill('Sous-domaines')).not.toContain('checked=""')
    const toggle = (label: string) => markup.split(`<span>${label}</span>`)[0]!.split('<label class="sd-switch"').at(-1)!
    expect(toggle('Recharger l’onglet')).toContain('checked=""')
    expect(toggle('Fermeture auto')).toContain('checked=""')
    expect(sheet('https://example.com/').split('<span>Inclure HTTP</span>')[0]!.split('<label class="sd-scope"').at(-1)).not.toContain('checked=""')
  })

  it('ends with the red button, its trash glyph, « Effacer les données » and the keys of the shortcut that clears without the sheet', () => {
    const markup = sheet('https://example.com/')
    const cta = markup.split('<button type="button" class="sd-cta"')[1]!.split('</button>')[0]!
    expect(cta).toContain('<span class="sd-cta-label">Effacer les données</span>')
    expect([...cta.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map(([, k]) => k)).toEqual(['⌥', '⇧', '⌘', 'X'])
    expect(cta).toContain(frenchSpaces('title="Sans la feuille, pour le site de l’onglet : ⌥⇧⌘X"'))
    // A shortcut taken away in Réglages is not shown.
    expect(sheet('https://example.com/', { keyBindings: { clearSiteDataNow: '' } }).split('class="sd-cta"')[1]!.split('</button>')[0]).not.toContain('<kbd>')
  })

  it('keeps the HTTP sign-in exception as a short note while the cookies are ticked', () => {
    expect(sheet('https://example.com/')).toContain('<p class="sd-note">Effacer les cookies oublie aussi les identifiants HTTP (boîte de connexion) de tout le profil.</p>')
    expect(sheet('https://example.com/', { siteDataTypes: ['cache'] })).not.toContain('sd-note')
  })

  it('says whether the licences of protected video go with what is ticked, or stay and why', () => {
    const gone = '<p class="sd-note">Les licences de vidéo protégée (DRM) du site sont effacées aussi.</p>'
    const kept = 'Les licences de vidéo protégée (DRM) du site restent'
    expect(sheet('https://example.com/')).toContain(gone)
    expect(sheet('https://example.com/')).not.toContain(kept)
    const withoutCookies = sheet('https://example.com/', { siteDataTypes: ['localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] })
    expect(withoutCookies).toContain(kept)
    expect(withoutCookies).not.toContain(gone)
  })

  it('offers the domains erased before, one click each, and a button to forget them', () => {
    const markup = sheet('https://example.com/', { siteDataRecents: ['example.com', 'localhost:3000', 'a.example'] })
    expect([...markup.matchAll(/<button type="button" class="sd-recent"[^>]*>([^<]+)</g)].map(([, host]) => host)).toEqual(['localhost:3000', 'a.example'])
    expect(markup).toContain('title="Effacer la liste des domaines récents">Effacer</button>')
  })

  it('in a private window: no history to forget, no recent domain', () => {
    const markup = sheet('https://example.com/', { siteDataRecents: ['a.example'] }, {}, { private: true })
    expect(markup).not.toContain('Historique du site')
    expect(markup).not.toContain('sd-recent')
    expect(markup).toContain('<span class="sd-count">7/7</span>')
  })

  it('shows the cookie count on its tile', () => {
    expect(sheet('https://example.com/', {}, { cookies: 12 })).toContain('<span class="sd-badge" title="12 cookies trouvés">12</span>')
    expect(sheet('https://example.com/', {}, { cookies: 0 })).not.toContain('sd-badge')
  })

  it('says what keeps a run from starting, in the extension’s words', () => {
    expect(sheet(null, {}, { problem: 'no-site' })).toContain('<p class="sd-error" role="alert">Entrez un domaine</p>')
    expect(sheet('https://example.com/', {}, { problem: 'no-type' })).toContain('<p class="sd-error" role="alert">Sélectionnez au moins un type</p>')
    // What is typed and is not a site is said at once, and marks the field.
    const typed = sheet('https://example.com/', {}, { draft: 'pas/un/hote' })
    expect(typed).toContain('role="alert">Adresse non valide')
    expect(typed).toContain('class="sd-field is-invalid"')
  })

  it('leads its settings button to its group of Réglages', () => {
    const tree = elements('https://example.com/')
    click(tree.find((element) => element.props['aria-label'] === 'Réglages de l’effacement'))
    expect(holder.asked).toEqual([{ call: 'openOverlay', request: { panel: 'settings', pane: 'protection', anchor: 'sitedata' } }])
  })
})

describe('what the sheet asks of the main process', () => {
  it('runs the sites with the scopes, the types, the reload and the auto-close, and remembers the choices', async () => {
    click(byClass(elements('http://localhost:3000/', { siteDataSubdomains: true, siteDataReload: false }), 'sd-cta'))
    await settle()
    expect(runs()).toEqual([{ hosts: ['localhost:3000'], types: ['cache', 'cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage', 'sessionStorage'], subdomains: true, http: true, reload: false, detached: true }])
    expect(holder.asked[0]).toEqual({ call: 'dispatch', request: { type: 'settings/update', patch: { siteDataTypes: ['cache', 'cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage', 'sessionStorage'], siteDataSubdomains: true, siteDataReload: false, siteDataAutoClose: true, siteDataHttp: false } } })
    // « Fermeture auto »: the sheet closes as soon as the run is handed over.
    expect(holder.asked.at(-1)).toEqual({ call: 'closeOverlay' })
  })

  it('asks for the https origins only on an https page, and counts what is still typed as a site', async () => {
    const tree = elements('https://example.com/', { siteDataAutoClose: false }, { draft: 'b.example' })
    click(byClass(tree, 'sd-cta'))
    await settle()
    expect(runs()).toEqual([expect.objectContaining({ hosts: ['example.com', 'b.example'], http: false, detached: false })])
    expect(holder.asked.some((ask) => ask.call === 'closeOverlay')).toBe(false)
  })

  it('starts the run with Enter in the empty field, and not while something is typed', async () => {
    key(byClass(elements('https://example.com/'), 'sd-input'), 'Enter')
    await settle()
    expect(runs()).toHaveLength(1)
    holder.asked = []
    key(byClass(elements('https://example.com/', {}, { draft: 'b.example' }), 'sd-input'), 'Enter')
    await settle()
    expect(runs()).toEqual([])
  })

  it('runs nothing without a site or without a type', async () => {
    click(byClass(elements(null), 'sd-cta'))
    // A private window offers no history: with only that ticked there is no type to run.
    click(byClass(elements('https://example.com/', { siteDataTypes: ['history'] }, {}, { private: true }), 'sd-cta'))
    await settle()
    expect(runs()).toEqual([])
  })

  it('asks first when Réglages says so, and runs from the confirmation only', async () => {
    click(byClass(elements('https://example.com/', { siteDataConfirm: true }), 'sd-cta'))
    await settle()
    expect(runs()).toEqual([])
    click(byClass(elements('https://example.com/', { siteDataConfirm: true }, { confirming: true }), 'sd-yes'))
    await settle()
    expect(runs()).toHaveLength(1)
  })
})

describe('the confirmation', () => {
  it('is a dialog over the sheet: the warning glyph, « Effacer les données ? », the domains as chips, Annuler first and Effacer in red', () => {
    const markup = sheet('https://example.com/', { siteDataConfirm: true }, { confirming: true, draft: 'b.example' })
    const dialog = markup.split('<div class="sd-dialog" role="alertdialog" aria-modal="true"')[1]!
    expect(dialog).toContain('<h3 id="sd-confirm-title">Effacer les données\u202f?</h3>')
    expect(dialog).toContain(frenchSpaces('Suppression définitive de 7 types de données pour :'))
    expect([...dialog.matchAll(/<li class="sd-chip" title="[^"]+">([^<]+)<\/li>/g)].map(([, host]) => host)).toEqual(['example.com', 'b.example'])
    expect(dialog.indexOf('class="sd-no"')).toBeLessThan(dialog.indexOf('class="sd-yes"'))
    expect(dialog).toMatch(/<button type="button" class="sd-no" autofocus="">Annuler<\/button>/)
    expect(dialog).toContain('<button type="button" class="sd-yes">Effacer</button>')
  })

  it('goes away with Escape, and the sheet stays', () => {
    const tree = elements('https://example.com/', { siteDataConfirm: true }, { confirming: true })
    let stopped = false
    ;(byClass(tree, 'sd-modal')!.props['onKeyDown'] as (e: unknown) => void)({ key: 'Escape', stopPropagation: () => (stopped = true) })
    expect(stopped).toBe(true)
    expect(holder.asked).toEqual([])
  })
})

describe('the answer', () => {
  const answer: SiteDataSiteResult[] = [
    { host: 'example.com', results: [{ type: 'cookies', ok: true, count: 4 }, { type: 'cache', ok: true }] },
    { host: 'localhost:3000', results: [{ type: 'cookies', ok: true, count: 0 }, { type: 'cache', ok: false, error: 'disk full' }] }
  ]

  it('is a banner, then one card per domain with its score and a chip per type, the failures in words, and « Retour »', () => {
    const markup = sheet('https://example.com/', { siteDataAutoClose: false }, { results: answer })
    expect(markup).toContain('<div class="sd-banner is-error" role="status">')
    expect(markup).toContain(frenchSpaces('<strong>Terminé avec 1 erreur</strong><span>Réussies : 3 · Échecs : 1 · onglet non rechargé</span>'))
    const cards = markup.split('<article').slice(1)
    expect(cards.map((card) => card.match(/class="sd-card-host" title="[^"]+">([^<]+)</)![1])).toEqual(['example.com', 'localhost:3000'])
    expect(cards.map((card) => card.match(/class="sd-score">(\d+)\/(\d+)</)!.slice(1).join('/'))).toEqual(['2/2', '1/2'])
    expect(cards[1]).toContain('class="sd-card has-error"')
    expect([...cards[0]!.matchAll(/<li class="sd-result (is-ok|is-err)" title="([^"]+)">/g)].map(([, state, title]) => `${state} ${title}`)).toEqual(['is-ok 4 cookies', 'is-ok Effacé'])
    expect(cards[0]).toContain('<span class="sd-result-count">4</span>')
    expect(cards[1]).toContain('<p class="sd-result-error">Cache du réseau — disk full</p>')
    expect(markup).toMatch(/<button type="button" class="sd-secondary" autofocus="">Retour<\/button>/)
    // The form is not drawn under the answer.
    expect(markup).not.toContain('sd-cta')
  })

  it('says everything was cleared when it was', () => {
    const markup = sheet('https://example.com/', { siteDataAutoClose: false }, { results: [answer[0]!] })
    expect(markup).toContain('<div class="sd-banner is-ok" role="status">')
    expect(markup).toContain('<strong>Données effacées</strong><span>2 opérations réussies</span>')
    expect(markup).not.toContain('has-error')
  })
})

describe('its group of Réglages', () => {
  async function protection(settings: Partial<Settings>, options: { private?: boolean } = {}) {
    const updates: Array<Partial<Settings>> = []
    const { SiteDataSettings } = await import('./SitePrivacySettings')
    const { FoldPassContext } = await import('./settings-context')
    const initial = createInitialState({ now: 1, newId: () => 'id' })
    const snapshot = { state: { ...initial, settings: { ...initial.settings, ...settings } }, extensions: [], downloads: [], private: options.private === true } as unknown as UiSnapshot
    const node = createElement(SiteDataSettings, { snapshot, update: (patch: Partial<Settings>) => void updates.push(patch) })
    let tree: El[] = []
    const Probe = (): null => {
      tree = expanded(node)
      return null
    }
    const wrap = (child: ReactElement) => createElement(FoldPassContext.Provider, { value: 'all' as const }, child)
    renderToStaticMarkup(wrap(createElement(Probe)))
    return { markup: renderToStaticMarkup(wrap(node)), tree, updates }
  }

  it('is the group the anchor leads to, with « Demander confirmation », « Notifier au raccourci » and the eight choices of the animation', async () => {
    const { markup } = await protection({ siteDataAnimation: 'matrix' })
    expect(markup).toContain('id="sitedata"')
    expect(markup).toContain('Effacement des données du site')
    expect(markup).toContain('data-setting="siteDataConfirm"')
    expect(markup).toContain('Demander confirmation')
    expect(markup).toContain('data-setting="siteDataNotify"')
    expect(markup).toContain('Notifier au raccourci')
    expect(markup).toContain('data-setting="siteDataAnimation"')
    const choices = [...markup.matchAll(/<button type="button" role="radio" aria-checked="(true|false)" class="sitedata-anim"[^>]*>.*?<span>([^<]+)<\/span><\/button>/g)].map(([, on, name]) => `${on === 'true' ? '●' : '○'} ${name}`)
    expect(choices).toEqual(['○ Aucune', '○ Spinner', '○ Pac-Man', '○ Balai', '● Matrix', '○ Nuke', '○ Feu', '○ Rebond'])
  })

  it('writes the choice of the animation, the confirmation and the notice', async () => {
    const { tree, updates } = await protection({})
    const fire = tree.find((element) => element.props['role'] === 'radio' && expanded(element.props['children'] as ReactNode).some((child) => child.props['children'] === 'Feu'))
    click(fire)
    const confirm = tree.find((element) => element.type === 'input' && element.props['aria-label'] === 'Demander confirmation')
    ;(confirm!.props['onChange'] as (e: unknown) => void)({ target: { checked: true } })
    expect(updates).toEqual([{ siteDataAnimation: 'fire' }, { siteDataConfirm: true }])
  })

  it('shows the main window’s settings in a private window without letting them change', async () => {
    const { markup } = await protection({}, { private: true })
    expect(markup).toContain('Ces réglages sont ceux de la fenêtre principale.')
    expect([...markup.matchAll(/class="sitedata-anim" disabled=""/g)]).toHaveLength(8)
  })
})
