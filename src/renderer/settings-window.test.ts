// The window of the Settings, rendered to markup (no window): the sidebar of its pages (« Pour commencer », the 8 categories, the two pages apart, « Réglages
// modifiés » at its foot), the title ("Réglages"), the name and the blurb of the page shown, the explanation of the costs, its fold « Plus de réglages »,
// "Rétablir" under it, and what the search draws. What needs a pointer or a key (the arrows, ⌘F, "/", Escape, the jump to a result) is not here.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES } from '@shared/features'
import { setLanguage } from '@shared/i18n'
import { SETTINGS_PAGES, type UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { SEARCH_IDS, SETTINGS_SYNONYMS } from '@shared/settings-synonyms'
import { settingsHash } from '@shared/settings-target'
import { SITE_DATA_SETTINGS_REQUEST } from '@shared/site-data-sheet'
import { SettingsView } from './SettingsWindow'
import settingsCss from './settings.css?raw'
import { frenchSpaces } from '@shared/french-typography'

const ctx = { now: 1, newId: () => 'id' }
const snapshotWith = (patch: Partial<Settings> = {}): UiSnapshot => {
  const state = createInitialState(ctx)
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [] } as unknown as UiSnapshot
}

/** The window drawn at an address (`#protection/permissions`), with a search or a card already open. */
function draw(hash: string, patch: Partial<Settings> = {}, options: { query?: string; open?: string } = {}): string {
  vi.stubGlobal('location', { hash })
  return renderToStaticMarkup(createElement(SettingsView, { snapshot: snapshotWith(patch), initialQuery: options.query ?? '', initialOpen: (options.open as never) ?? null }))
}

beforeAll(() => {
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterEach(() => setLanguage('fr'))
afterAll(() => vi.unstubAllGlobals())

/** The pages of the sidebar, in the order drawn: their id, their name, and whether the one marked as current. */
function sidebar(markup: string): Array<{ id: string; name: string; current: boolean }> {
  return [...markup.matchAll(/<button type="button" class="settings-cat" data-cat="([a-z]+)"([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    id: match[1]!,
    name: /<span class="settings-cat-name">([^<]*)<\/span>/.exec(match[3]!)![1]!,
    current: match[2]!.includes('aria-current="page"')
  }))
}

describe('the sidebar', () => {
  it('lists « Pour commencer », the 8 categories named by what one wants to do, then the two pages apart, and marks the one that is shown', () => {
    const markup = draw('#protection')
    const cats = sidebar(markup)
    expect(cats.map((c) => c.id)).toEqual([...SETTINGS_PAGES])
    expect(cats.map((c) => c.name)).toEqual(['Pour commencer', 'Apparence', 'Onglets et fenêtres', 'Navigation', 'Vie privée', 'Téléchargements', 'Extensions et outils', 'Clavier et souris', 'Profils', 'Fonctions en option', 'À propos'])
    expect(cats.filter((c) => c.current).map((c) => c.id)).toEqual(['protection'])
    // A rule after « Pour commencer », and one before the two pages apart.
    const nav = /<div class="settings-cats">([\s\S]*?)<\/div><div class="settings-nav-foot">/.exec(markup)![1]!
    expect([...nav.matchAll(/<hr class="settings-cats-sep" aria-hidden="true"\/>|data-cat="([a-z]+)"/g)].map((match) => match[1] ?? '—')).toEqual(['home', '—', 'appearance', 'tabs', 'navigation', 'protection', 'files', 'tools', 'keyboard', 'profiles', '—', 'features', 'about'])
  })

  it('reads in English when the interface does', () => {
    setLanguage('en')
    expect(sidebar(draw('#protection')).map((c) => c.name)).toEqual(['Start here', 'Appearance', 'Tabs and windows', 'Navigation', 'Privacy', 'Downloads', 'Extensions and tools', 'Keyboard and mouse', 'Profiles', 'Optional features', 'About'])
  })

  it('has « Réglages modifiés » at its foot, after the pages', () => {
    const markup = draw('#tabs', { sleepMode: 'freeze' })
    expect(markup).toMatch(/<div class="settings-nav-foot"><button type="button" class="settings-changed-link"><span>Réglages modifiés<\/span>/)
    expect(markup.indexOf('settings-nav-foot')).toBeGreaterThan(markup.lastIndexOf('data-cat='))
  })

  it('has one stop of the Tab key (the page shown), the arrows do the rest', () => {
    const stops = [...draw('#tabs').matchAll(/data-cat="([a-z]+)"[^>]*tabindex="(-?\d)"/g)].filter((match) => match[2] === '0').map((match) => match[1])
    expect(stops).toEqual(['tabs'])
  })

  it('opens on « Pour commencer » for an address it does not know, and leads an old one to the page that took its place', () => {
    const current = (hash: string) => sidebar(draw(hash)).find((c) => c.current)?.id
    expect(current('')).toBe('home')
    expect(current('#nowhere')).toBe('home')
    expect(current('#general')).toBe('home')
    expect(current('#general/guide')).toBe('home')
    expect(current('#general/about')).toBe('about')
    expect(current('#general/icon')).toBe('about')
    expect(current('#advanced/extensions')).toBe('tools')
    expect(current('#advanced/permissions')).toBe('protection')
    expect(current('#advanced/about')).toBe('about')
    expect(current('#features')).toBe('features')
    expect(current('#profiles')).toBe('profiles')
    expect(current('#keyboard')).toBe('keyboard')
    // The 16 categories of an earlier cut, and the 14 of the next one: each address leads to the category that holds the same things now.
    expect(current('#windows')).toBe('tabs')
    expect(current('#sleep')).toBe('tabs')
    expect(current('#search')).toBe('navigation')
    expect(current('#commandbar')).toBe('navigation')
    expect(current('#links')).toBe('navigation')
    expect(current('#shortcuts')).toBe('keyboard')
    expect(current('#history')).toBe('protection')
    expect(current('#network')).toBe('protection')
    expect(current('#lock')).toBe('protection')
    expect(current('#security')).toBe('protection')
    expect(current('#privacy')).toBe('protection')
    expect(current('#privacy/permissions')).toBe('protection')
    expect(current('#navigation')).toBe('navigation')
    expect(current('#navigation/shortcuts')).toBe('keyboard')
    expect(current('#navigation/links')).toBe('navigation')
    expect(current('#spaces')).toBe('appearance')
    expect(current('#extensions')).toBe('tools')
    expect(current('#icon')).toBe('about')
    expect(current('#about')).toBe('about')
  })

  it('writes the size of the interface as the language writes a percentage', () => {
    expect(draw('#appearance', { uiScale: 120 })).toContain(`<span class="ui-scale-value" aria-live="polite">${frenchSpaces('120 %')}</span>`)
    setLanguage('en')
    expect(draw('#appearance', { uiScale: 120 })).toContain('<span class="ui-scale-value" aria-live="polite">120%</span>')
  })

  it('puts a dot on a category that holds a setting not at its default, and tells a screen reader how many', () => {
    const markup = draw('#home', { sleepMode: 'freeze', uiScale: 120 })
    expect(markup.match(/class="pref-changed settings-cat-changed"/g)).toHaveLength(2)
    expect(markup).toContain('<span class="sr-only">1 réglage modifié</span>')
    expect(draw('#home')).not.toContain('settings-cat-changed')
  })

  it('has a search field above them, named for a screen reader with its two keys', () => {
    expect(draw('#home')).toMatch(/<input[^>]*type="search"[^>]*placeholder="Rechercher"[^>]*aria-label="Rechercher un réglage \(⌘F ou \/\)"/)
  })
})

describe('the category shown', () => {
  it('has the name of the window ("Réglages") in the bar, the name of the category once above its rows with its blurb, in the words of the language of the interface', () => {
    const markup = draw('#tabs')
    expect(markup).toContain('<h1 class="settings-title" id="pane-title">Réglages</h1>')
    expect(markup).toContain('<h2 class="settings-pane-title" id="pane-heading">Onglets et fenêtres</h2>')
    // Once in the page (the sidebar says it too, as the name of the entry).
    expect(markup.split('<main')[1]!.split('>Onglets et fenêtres<').length - 1).toBe(1)
    expect(markup).toContain('Veille, archivage, organisation, vue scindée, fenêtres.')
    setLanguage('en')
    const english = draw('#tabs')
    expect(english).toContain('<h1 class="settings-title" id="pane-title">Settings</h1>')
    expect(english).toContain('<h2 class="settings-pane-title" id="pane-heading">Tabs and windows</h2>')
    expect(english).toContain('Sleep, archiving, organization, split view, windows.')
    expect(english).toContain('<span class="settings-cat-name">Privacy</span>')
  })

  it('has no level to choose: the head holds the name and the blurb of the category, nothing at its right', () => {
    for (const pane of SETTINGS_PAGES) {
      const markup = draw(`#${pane}`)
      expect(markup, pane).not.toContain('settings-level')
      expect(markup, pane).not.toContain('Tous les réglages')
      expect(markup, pane).toMatch(/<div class="settings-pane-head"><div><h2 class="settings-pane-title" id="pane-heading">[^<]*<\/h2><p class="settings-blurb">/)
    }
  })

  it('draws the rows at the top of the category, then « Plus de réglages » closed with the others in it, then "Rétablir": no row is lost', () => {
    const markup = draw('#protection')
    const top = markup.split('<div class="more-settings"')[0]!
    const fold = /<div [^>]*class="more-settings-body" hidden="">([\s\S]*?)<\/div><\/div><div class="reset-bar">/.exec(markup)?.[1] ?? ''
    expect(markup).toMatch(/<button type="button" class="more-settings-toggle" aria-expanded="false" aria-controls="[^"]+"><span class="more-settings-title">Plus de réglages<\/span>/)
    expect(markup.indexOf('class="more-settings"')).toBeLessThan(markup.indexOf('class="reset-bar"'))
    // At the top, the level of protection and the switch of the ads under it; the network is on its subpage, whose row is at the top too.
    expect(top).toContain('data-search="protectionLevel"')
    expect(top).toContain('data-setting="blockAds"')
    expect(top.indexOf('data-search="protectionLevel"')).toBeLessThan(top.indexOf('data-setting="blockAds"'))
    expect(top).toMatch(/data-setting="dohCustom dohMode dohProvider dohCustomUrl proxyEnabled proxy" data-placement="page" data-subpage-entry="network"/)
    expect(fold).not.toContain('proxyEnabled')
    expect(draw('#protection/network')).toContain('data-setting="proxyEnabled"')
    const keys = (html: string) => new Set([...html.matchAll(/data-setting="([^"]*)"/g)].flatMap((match) => match[1]!.split(' ')))
    expect([...keys(draw('#home', {}, { query: 'a' }).split('data-category-label="Vie privée et sécurité"')[1]!.split('data-category-label=')[0]!)].filter((key) => !keys(markup).has(key))).toEqual([])
  })

  it('has one fold, at the foot of every category, and none in a group', () => {
    for (const pane of SETTINGS_PAGES) {
      const markup = draw(`#${pane}`)
      expect(markup.split('class="more-settings"').length - 1, pane).toBe(1)
      expect(markup, pane).not.toContain('pref-fold')
    }
  })

  it('draws the rows each profile keeps on its own in the category of what they do, for the profile on screen, and again in Profils for the one picked', () => {
    expect(draw('#navigation')).toMatch(/data-setting="searchUrlTemplate"[^>]*>[\s\S]*?<span class="pref-profile" title="[^"]+">profil «\u00a0Profil par défaut\u00a0»<\/span>/)
    expect(draw('#tabs')).toContain('data-setting="autoArchiveHours"')
    expect(draw('#files')).toContain('data-search="downloadFolder"')
    expect(draw('#protection')).toContain('data-search="clearProfileData"')
    const profiles = draw('#profiles')
    expect(profiles).toMatch(/data-setting="searchUrlTemplate" data-placement="page" data-mirror=""/)
    expect(profiles).not.toContain('class="pref-profile"')
  })

  it('says no cost under the blurb of a page: the cost of a feature is said on its line of « Fonctions en option » only', () => {
    for (const pane of ['about', 'protection', 'tabs', 'features']) {
      expect(draw(`#${pane}`), pane).not.toContain('legend-cost')
      expect(draw(`#${pane}`), pane).not.toContain('<details')
    }
  })

  it('offers « Rétablir » for « Fonctions en option » too, which counts the features and their options that left their default', () => {
    const quiet = draw('#features')
    expect(quiet).toContain('Rien n’a été modifié dans cette catégorie.')
    expect(draw('#features', { tabTree: true, notesListButton: false })).toContain('2 réglages modifiés dans cette catégorie.')
  })

  it('has "Rétablir" under its rows: asleep while nothing moved, awake with the count when something did, with the lists it leaves alone told in its tooltip', () => {
    const quiet = draw('#tabs')
    expect(quiet).toContain('Rien n’a été modifié dans cette catégorie.')
    expect(quiet).toMatch(/<button class="button" type="button" disabled=""[^>]*>Rétablir les valeurs par défaut<\/button>/)
    const moved = draw('#tabs', { sleepMode: 'freeze', sleepNotify: true })
    expect(moved).toContain('2 réglages modifiés dans cette catégorie.')
    expect(moved).not.toMatch(/disabled=""[^>]*>Rétablir/)
    expect(moved).toContain(frenchSpaces('title="Ne sont pas touchés : les listes de sites, les règles, les raccourcis, ce que vous avez saisi, le verrouillage, les conteneurs et ce que chaque profil règle à part."'))
    expect(draw('#tabs', { sleepMode: 'freeze' })).toContain('1 réglage modifié dans cette catégorie.')
  })

  it('counts only what the category holds: a setting of another category is not its to put back', () => {
    expect(draw('#profiles', { sleepMode: 'freeze' })).toContain('Rien n’a été modifié dans cette catégorie.')
  })

  // Profiles and the editor of the shortcuts are translated, and no longer marked French in English.
  it('says in a screen reader\'s language that Profiles and the editor of the shortcuts are in the language of the interface', () => {
    setLanguage('en')
    expect(draw('#profiles')).toMatch(/<main[^>]*lang="en"/)
    expect(draw('#tabs')).toMatch(/<main[^>]*lang="en"/)
    const keyboard = draw('#keyboard/shortcuts')
    expect(keyboard).toMatch(/<main[^>]*lang="en"/)
    expect(keyboard).toContain('<div id="shortcuts" class="shortcuts-area">')
    expect(draw('#profiles')).not.toMatch(/Comment voulez-vous|Comme le défaut|Nettoyer/)
  })

  it('opens the card of the row it is told to, under it (one at a time)', () => {
    const markup = draw('#features', {}, { open: 'tabTree' })
    expect([...markup.matchAll(/data-illu="([^"]+)"/g)].map((match) => match[1])).toEqual(['tabTree'])
    expect(markup).toContain(frenchSpaces(`aria-label="Effet de « ${FEATURES.find((f) => f.id === 'tab-tree')!.label} »"`))
  })
})

describe('a search', () => {
  it('replaces the category by every category, each under its name, and the bar keeps the name of the window', () => {
    const markup = draw('#tabs', {}, { query: 'veille' })
    expect(markup).toContain('<h1 class="settings-title" id="pane-title">Réglages</h1>')
    expect(markup).toContain('class="settings-shell settings-searching"')
    expect(markup).not.toContain('class="more-settings"')
    const wrappers = [...markup.matchAll(/class="results-cat" data-category-label="([^"]+)"/g)].map((match) => match[1])
    // Every page, « Fonctions en option » with its lines, which no category draws again.
    expect(wrappers).toEqual(['Pour commencer', 'Apparence', 'Onglets et fenêtres', 'Navigation', 'Vie privée et sécurité', 'Téléchargements et fichiers', 'Extensions et outils', 'Clavier et souris', 'Profils', 'Fonctions en option', 'À propos et mises à jour'])
    // No category is current while the results show, and nothing is offered to put back.
    expect(sidebar(markup).filter((c) => c.current)).toEqual([])
    expect(markup).not.toContain('class="reset-bar"')
    expect(markup).not.toContain('settings-pane-title')
  })

  it('draws the rows the search reads: the sleep delay and the groups it hangs under are in the markup the filter goes through', () => {
    const markup = draw('#home', {}, { query: 'veille' })
    expect(markup).toContain('Mettre en veille les onglets inactifs')
    expect(markup).toContain('Sites gardés éveillés, un onglet chacun')
    expect(markup).toContain('data-setting="sleepAfterMinutes"')
  })

  it('carries every search id a synonym names on a row of the window: a word that finds a row that is not a setting lands on it, and no row claims an id nothing names', () => {
    // A search draws every category at once: the rows the filter goes through are all here.
    const markup = draw('#home', {}, { query: 'veille' })
    const carried = new Set([...markup.matchAll(/data-search="([^"]+)"/g)].map((match) => match[1]))
    // The callout "Lucium n'est pas votre navigateur par défaut" is drawn only once the system has said so, after the first draw (GeneralSettings.tsx).
    expect(SEARCH_IDS.filter((id) => id !== 'defaultBrowser' && !carried.has(id))).toEqual([])
    expect([...carried].filter((id) => !(SEARCH_IDS as readonly string[]).includes(id!))).toEqual([])
    // « exporter » and « sauvegarde » lead to the buttons of the export of everything, which sit in Fichiers et données.
    for (const word of ['exporter', 'sauvegarde']) expect(SETTINGS_SYNONYMS[word]).toContain('exportData')
    expect(draw('#files')).toMatch(/<div class="pref-buttons" data-search="exportData"><button class="button"[^>]*>Exporter les données<\/button><\/div>/)
  })

  it('draws, where the settings button of the sheet « Effacer les données du site » leads, the group it scrolls to with the three settings of the sheet', () => {
    const { pane, anchor } = SITE_DATA_SETTINGS_REQUEST
    const hash = settingsHash(pane, anchor)
    expect(hash).toBe('protection/sitedata')
    // The category named is the one shown, and the group carries the id the anchor names (the window scrolls to `getElementById`).
    const markup = draw(`#${hash}`)
    expect(markup).toContain('data-cat="protection" aria-current="page"')
    const group = /<section[^>]*id="sitedata"[^>]*>[\s\S]*?<\/section>/.exec(markup)?.[0] ?? ''
    expect(group).toContain('data-setting="siteDataConfirm siteDataNotify siteDataAnimation"')
    expect(group).toContain('Effacement des données du site')
    for (const label of ['Demander confirmation', 'Notifier au raccourci', 'Animation sur la page']) expect(group, label).toContain(label)
    // The group waits in « Plus de réglages », closed: the window opens the fold when the link lands (settings-more.test.ts).
    expect(markup.split('class="more-settings-body"')[1]).toContain('id="sitedata"')
  })

  it('titles the list of sites by what it keeps awake: one tab of each site, or all of them once the switch under it is on', () => {
    expect(draw('#tabs/awake')).toContain('Sites gardés éveillés, un onglet chacun')
    const all = draw('#tabs/awake', { sleepExcludedKeepAll: true })
    expect(all).toContain('Sites gardés éveillés, tous leurs onglets')
    expect(all).not.toContain('un onglet chacun')
  })

  it('reads every row: no fold while the results show, the rows of « Plus de réglages » among them', () => {
    const markup = draw('#home', {}, { query: 'veille' })
    expect(markup).not.toContain('more-settings')
    expect(markup).toContain('data-setting="sleepMode" data-placement="more"')
  })

  it('gives each row the way to where it lives: "Ouvrir dans <catégorie> › <groupe>"', () => {
    const markup = draw('#home', {}, { query: 'veille' })
    expect(markup).toMatch(/data-setting="sleepMode"[\s\S]*?<button type="button" class="pref-open">Ouvrir dans Onglets et fenêtres › Mise en veille<\/button>/)
    // A row of a group with no title says the category alone; a row of a subpage names it; outside a search, no such button.
    expect(markup).toContain('>Ouvrir dans Extensions et outils</button>')
    expect(markup).toContain('>Ouvrir dans Clavier et souris › Raccourcis clavier</button>')
    expect(markup).toContain('>Ouvrir dans Vie privée et sécurité › DNS chiffré et proxy › Proxy</button>')
    expect(draw('#tabs')).not.toContain('class="pref-open"')
  })

  it('draws the pane of the Profiles under the language of the interface, like the others', () => {
    setLanguage('en')
    const markup = draw('#home', {}, { query: 'proxy' })
    expect(markup).toMatch(/data-category-label="Profiles"[^>]*lang="en"/)
    expect(markup).toMatch(/data-category-label="Privacy and security"[^>]*lang="en"/)
  })
})

// No horizontal scroll bar under the list of categories (`overflow-y: auto` alone makes the other axis scroll too).
describe('the list of categories', () => {
  it('scrolls up and down when the window is short, never sideways', () => {
    const rule = /\.settings-nav\s*\{([^}]*)\}/.exec(settingsCss)?.[1] ?? ''
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('overflow-x: hidden')
  })
})

// The scale of the sheet: the title 22 px, the groups 17 px with a rule and a count, the hints 12 px; tokens only, so that the dark scheme follows.
describe('the sheet', () => {
  const rule = (selector: string): string => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(settingsCss)?.[1] ?? ''

  it('sets the name of a category at 22 px, the title of a group at 17 px with a rule, the hints at 12 px, from the tokens', () => {
    expect(rule('.settings-pane-title')).toContain('font-size: var(--t-2xl)')
    expect(rule('.pref-section > h3')).toContain('font-size: var(--t-xl)')
    expect(rule('.pref-section > h3')).toContain('border-bottom: 1px solid var(--line)')
    expect(rule('.pref-hint')).toContain('font-size: var(--t-s)')
  })

  it('draws « Plus de réglages » as a line 48 px tall at least, with a visible focus and a chevron that does not move when motion is reduced', () => {
    expect(rule('.more-settings-toggle')).toContain('min-height: 48px')
    expect(rule('.more-settings-toggle:focus-visible')).toContain('outline: var(--focus-width) solid var(--focus)')
    expect(settingsCss).toContain('@media (prefers-reduced-motion: reduce) { .more-settings-toggle::after { transition: none; } }')
  })

  it('puts the sidebar at the left, 204 px wide, the page in the rest; the page shown as a soft accent with the accent as text', () => {
    expect(rule('.settings-body')).toContain('grid-template-columns: 204px minmax(0, 1fr)')
    expect(rule('.settings-nav')).toContain('border-right: 1px solid var(--line)')
    expect(rule('.settings-cats')).toContain('flex-direction: column')
    expect(rule(".settings-cat[aria-current='page']")).toContain('background: var(--accent-soft)')
    expect(rule(".settings-cat[aria-current='page']")).toContain('color: var(--accent-text)')
    expect(rule('.settings-cat:focus-visible')).toContain('outline: var(--focus-width) solid var(--focus)')
    // A name that does not fit wraps when the text is larger: it is never cut.
    expect(rule('.settings-cat-name')).toContain('overflow-wrap: anywhere')
    expect(rule('.settings-cat-name')).not.toContain('nowrap')
  })

  it('paints the words found with the Custom Highlight API, from the accent, and lights a row a result led to', () => {
    expect(settingsCss).toContain('::highlight(settings-hit) { background: color-mix(in srgb, var(--accent) 22%, transparent)')
    expect(rule('.pref-flash')).toContain('animation: pref-flash')
    expect(settingsCss).toContain('@media (prefers-reduced-motion: reduce) { .pref-flash { animation: none;')
  })

  it('names no colour by its value in what it adds: only tokens', () => {
    for (const block of ['.more-settings', '.settings-cats', '.pref-profile', '.pref-open', '.settings-cat-count']) {
      const text = settingsCss.split(block)[1]?.split('\n')[0] ?? ''
      expect(text, block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })
})

// The Settings can be set dark or light: the appearance was only in the menu bar (Affichage › Apparence). It is in Apparence now.
describe('the appearances, in Apparence', () => {
  const select = (markup: string, label: string) => new RegExp(`<select[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)<\\/select>`).exec(markup)?.[1] ?? ''
  const options = (markup: string, label: string) => [...select(markup, label).matchAll(/<option value="([a-z]+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`)

  it('are two rows with a name of their own, each with automatic, light and dark: Lucium’s, and the one asked of the websites', () => {
    const markup = draw('#appearance')
    expect(markup).toContain('data-setting="interfaceAppearance"')
    expect(markup).toContain('data-setting="websiteAppearance"')
    expect(options(markup, 'Apparence de Lucium')).toEqual(['auto:Automatique', 'light:Clair', 'dark:Sombre'])
    expect(options(markup, 'Apparence demandée aux sites')).toEqual(['auto:Automatique', 'light:Clair', 'dark:Sombre'])
  })

  it('show the choice that is made, each for its own setting', () => {
    for (const [value, label] of [['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']] as const) {
      expect(select(draw('#appearance', { interfaceAppearance: value }), 'Apparence de Lucium')).toMatch(new RegExp(`<option value="${value}" selected=""[^>]*>${label}<`))
      expect(select(draw('#appearance', { websiteAppearance: value }), 'Apparence demandée aux sites')).toMatch(new RegExp(`<option value="${value}" selected=""[^>]*>${label}<`))
    }
    // One row does not show the other's value.
    const markup = draw('#appearance', { interfaceAppearance: 'auto', websiteAppearance: 'dark' })
    expect(select(markup, 'Apparence de Lucium')).toMatch(/<option value="auto" selected=""/)
    expect(select(markup, 'Apparence demandée aux sites')).toMatch(/<option value="dark" selected=""/)
  })
})

// A small drawing of a window, in colour, on top of the pane of the links added nothing: it is gone.
describe('the pane of the links', () => {
  it('has no decorative picture on top: it starts with the text', () => {
    expect(draw('#links')).not.toContain('links-hero')
    expect(settingsCss).not.toContain('.links-hero')
  })
})

describe('the title bar', () => {
  it('has no close button of its own: the red button and ⌘W close the window, as in macOS settings', () => {
    const markup = draw('#general')
    const bar = /<header class="settings-titlebar"[\s\S]*?<\/header>/.exec(markup)![0]
    expect(bar).not.toContain('settings-close')
    expect(markup).not.toContain('settings-close')
  })
})

// An emptied list of site searches had no way back but one by one. « Rétablir les recherches par défaut » sits under the list.
describe('the searches of a site, in Navigation', () => {
  /** The button that brings the default searches back, as drawn: its markup up to its text. */
  const restoreButton = (markup: string): string => /<button class="button"[^>]*>Rétablir les recherches par défaut<\/button>/.exec(markup)?.[0] ?? ''

  it('offers to bring back the default searches of an emptied list, and says how many are missing', () => {
    const markup = draw('#navigation/sitesearches', { siteSearches: [] })
    expect(restoreButton(markup)).not.toBe('')
    expect(restoreButton(markup)).not.toContain('disabled')
    expect(markup).toMatch(/\d+ recherches par défaut ne sont pas dans la liste\./)
  })

  it('greys the button when every default search is in the list', () => {
    const markup = draw('#navigation/sitesearches')
    expect(restoreButton(markup)).toContain('disabled')
    expect(markup).toContain('Toutes les recherches par défaut sont dans la liste.')
  })
})
