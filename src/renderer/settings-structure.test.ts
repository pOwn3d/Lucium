// "No setting disappears" (8 categories): the Settings window is made of the categories of SETTINGS_PAGES, and this test renders every one of them (no window, as
// settings-r11.test.ts does) and compares what it draws with the map of shared/settings-catalog.ts, and the map with the code that defines the settings.
//   - every key of `defaultSettings()` (it returns a `Settings`: the compiler makes it hold every required key of the interface, and the optional ones are
//     listed below, where a new one fails to compile) is drawn in one category, or listed with the reason it never had a row;
//   - every optional feature (shared/features.ts) has its switch: the 29 features to add in « Fonctions en option », one line each with its cost said in
//     a sentence, and nowhere else; the other features in the category of their setting or, for those with no row of their own, in the category the map
//     gives them, with no mark of their cost;
//   - the rows a category draws are the keys it declares, no more, no less; Profils draws again, marked as mirrors, the few rows each profile keeps on its
//     own (PER_PROFILE_KEYS), for the profile picked in its list;
//   - a page is drawn in two parts, its top and its one fold « Plus de réglages » (shared/settings-placement.ts), and its lists and editors on its
//     subpages (shared/settings-subpages.ts): every row is in one of them, once, and a subpage is said on its page by the row that opens it.
// A row marks itself with `data-setting` (settings-parts.tsx); `Group` does for the lists it holds.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { costSentence, featureById, featureDefault, featureLine, FEATURES } from '@shared/features'
import { setLanguage, t, type MessageKey } from '@shared/i18n'
import { SETTINGS_ANCHORS, SETTINGS_PAGES, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { adsBlockingPatch } from '@shared/privacy-dashboard'
import { createInitialState } from '@shared/sidebar'
import { CATALOGUE_FEATURES, FEATURE_ONLY_SWITCHES, FEATURE_THEMES, FLOW_ANCHORS, HOME_MIRROR_KEYS, NO_CONTROL_KEYS, PER_PROFILE_KEYS, SETTINGS_CATEGORIES, SETTINGS_KEYS, categoryOfKey } from '@shared/settings-catalog'
import { ILLUSTRATIONS } from '@shared/settings-illustrations'
import { PAGE_KEYS, placementOf } from '@shared/settings-placement'
import { SUBPAGES } from '@shared/settings-subpages'
import { CategoryContent } from './SettingsCategories'
import { FoldPassContext, IllustrationContext, SettingsStateContext, type FoldPass } from './settings-context'
import illustrationsCss from './settings-illustrations.css?raw'
import { frenchSpaces } from '@shared/french-typography'

const ctx = { now: 1, newId: () => 'id' }

/** The text of a key of the catalogues, in the language the tests draw in (French). */
const setLanguageText = (key: string): string => t(key as MessageKey)
const noop = () => undefined

// Every test of this file draws whole categories of the Settings, most of them all the categories in several variants: up to half a second of processor
// each, which a machine with every core taken stretches past the 5 s a test has by default.
vi.setConfig({ testTimeout: 30_000 })

/** The keys `Settings` declares optional: the compiler does not make `defaultSettings()` hold them, so they are listed here (a new one fails to compile). */
type OptionalSettingsKey = { [K in keyof Settings]-?: object extends Pick<Settings, K> ? K : never }[keyof Settings]
const OPTIONAL_SETTINGS_KEYS: Record<OptionalSettingsKey, true> = { blockTrackers: true }

/** Every element a tree draws, the function components called (inside the render of a probe, where their hooks are allowed) and what they return walked too. */
function expandedElements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(expandedElements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  const type = element.type as unknown
  // A memo component is its function under `type`.
  const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
  if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expandedElements((component as (props: unknown) => ReactNode)(element.props))]
  }
  return [element, ...expandedElements(element.props['children'] as ReactNode)]
}

/** The elements of a category, every component in it called: their handlers are the ones the real rows get. */
function elementsOfCategory(pane: SettingsPage, snapshot: UiSnapshot, update: (patch: Partial<Settings>) => void): ReactElement<Record<string, unknown>>[] {
  let found: ReactElement<Record<string, unknown>>[] = []
  const Probe = (): null => {
    found = expandedElements(createElement(CategoryContent, { pane, snapshot, update, goTo: noop }))
    return null
  }
  renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: 'all' }, createElement(Probe)))
  return found
}

/** A snapshot holding what the panes read; `patch` changes the settings. */
function snapshotWith(patch: Partial<Settings> = {}, extra: Partial<UiSnapshot> = {}): UiSnapshot {
  const state = createInitialState(ctx)
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [], ...extra } as unknown as UiSnapshot
}

/** Every switch on: the rows that wait for one (the list of the pages watched, the proxy, the encrypted DNS) are drawn. */
function allOn(): Partial<Settings> {
  const on: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaultSettings())) if (value === false) on[key] = true
  return on as Partial<Settings>
}

const variants = (): UiSnapshot[] => [
  snapshotWith(),
  snapshotWith(allOn(), {
    lock: { active: true, appLocked: false, lockedSpaces: [], guardedSpaces: [], touchId: true, retryInMs: 0 },
    // A build that carries a test update channel: the row « Recevoir les versions de test » is drawn.
    updateTestChannel: true
  } as Partial<UiSnapshot>),
  // A container exists, the encrypted DNS is a server of one's own, an application is remembered for a type of file: the rows that wait for them are drawn.
  snapshotWith({ tabContainers: true, containers: [{ id: 'c1', name: 'Travail', color: 'blue' }], dohCustom: true, dohProvider: 'custom', openWithMemory: true, openWithApps: { pdf: '/Applications/Preview.app' } } as unknown as Partial<Settings>)
]

/** The category drawn whole (the test of the map wants every row), or one of its parts: its top, its fold « Plus de réglages », or one of its subpages. */
const markup = (pane: SettingsPage, snapshot: UiSnapshot, pass: FoldPass = 'all'): string =>
  renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: pass }, createElement(CategoryContent, { pane, snapshot, update: noop, goTo: noop })))

const keysIn = (html: string): Set<string> => {
  const keys = new Set<string>()
  for (const attribute of html.matchAll(/data-setting="([^"]*)"/g)) for (const key of attribute[1]!.split(' ')) keys.add(key)
  return keys
}

/**
 * A part of a page without the rows that open a subpage (each is one element: a row holding one button), and without a group left with no row then
 * (« Réseau et listes de filtres », made of two of them, is drawn on its page only), its note and its « En savoir plus » with it.
 */
const withoutEntries = (html: string): string =>
  html
    .replace(/<div class="pref-row subpage-entry"[^>]*><button[\s\S]*?<\/button><\/div>/g, '')
    .replace(/<section class="pref-section"[^>]*>(?:<h3>(?:(?!<\/h3>)[\s\S])*<\/h3>)?<div class="pref-group[^"]*"><\/div>(?:<p class="pref-note">(?:(?!<\/p>)[\s\S])*<\/p>)?(?:<div class="pref-note pref-note-more">(?:(?!<\/section>)[\s\S])*)?<\/section>/g, '')

/** The keys of the rows marked as mirrors of a row of another category (`data-mirror`). */
const mirrorsIn = (html: string): Set<string> => new Set([...html.matchAll(/data-setting="([^"]*)"[^>]*data-mirror=""/g)].map((match) => match[1]!))

/** The keys a category draws as its own, over the states of `variants`, and the ones it draws as mirrors. */
function drawn(pane: SettingsPage): { own: Set<string>; mirrors: Set<string> } {
  const own = new Set<string>()
  const mirrors = new Set<string>()
  for (const snapshot of variants()) {
    const html = markup(pane, snapshot)
    for (const key of mirrorsIn(html)) mirrors.add(key)
    for (const key of keysIn(html)) own.add(key)
  }
  for (const key of mirrors) own.delete(key)
  return { own, mirrors }
}

beforeAll(() => {
  // A few panes ask for the bridge while they draw (they do not call it): it exists, and holds nothing.
  vi.stubGlobal('window', { lucium: {} })
  setLanguage('fr')
})
afterAll(() => vi.unstubAllGlobals())

describe('the map of the settings (shared/settings-catalog.ts)', () => {
  it('places every key of the interface Settings and of its defaults in one category, or says why it has no row', () => {
    const keys = Object.keys(defaultSettings())
    expect(keys.length).toBeGreaterThan(150)
    // The optional keys of the interface are in the defaults too, so that the map below sees them.
    for (const key of Object.keys(OPTIONAL_SETTINGS_KEYS)) expect(keys, key).toContain(key)
    const placed = new Map<string, SettingsPage[]>()
    for (const pane of SETTINGS_PAGES) for (const key of SETTINGS_KEYS[pane]) placed.set(key, [...(placed.get(key) ?? []), pane])
    const missing = keys.filter((key) => !placed.has(key) && !(key in NO_CONTROL_KEYS))
    expect(missing, `Réglages sans rangée ni raison : ${missing.join(', ')}`).toEqual([])
    const twice = [...placed].filter(([key, panes]) => panes.length > 1 || key in NO_CONTROL_KEYS).map(([key]) => key)
    expect(twice, 'une clé est dans deux catégories, ou à la fois placée et sans rangée').toEqual([])
    const unknown = [...placed.keys(), ...Object.keys(NO_CONTROL_KEYS)].filter((key) => !keys.includes(key))
    expect(unknown, 'la carte nomme une clé qui n’existe pas').toEqual([])
  })

  it('has a reason for every key that never had a row (nothing is dropped without being said)', () => {
    for (const [key, reason] of Object.entries(NO_CONTROL_KEYS)) expect(reason.length, key).toBeGreaterThan(10)
  })

  it('gives every optional feature a row: « Fonctions en option » for the features to add, the category of its setting for the others, and for those with no row of their own, the one they are listed under', () => {
    const listed = new Set<string>(CATALOGUE_FEATURES)
    for (const feature of FEATURES) {
      const pane = categoryOfKey(feature.key)
      expect(pane, `${feature.id} (${feature.key})`).not.toBeNull()
      expect(pane === 'features', feature.id).toBe(listed.has(feature.id))
      const only = (FEATURE_ONLY_SWITCHES as Record<string, SettingsPage>)[feature.id]
      if (only !== undefined) expect(pane, feature.id).toBe(only)
    }
    // The preferences with no row of their own: the compact mode, the media player, the favourite names, the gauge, the states of the tabs, the status of the downloads, the news after an update.
    expect(Object.keys(FEATURE_ONLY_SWITCHES).sort()).toEqual(['compact-mode', 'download-status-chip', 'favorite-names', 'media-player', 'resource-gauge', 'tab-state-badges', 'whats-new'])
  })

  it('has the 11 pages in the order of the sidebar (the welcome page, the 8 categories, the two pages apart), each with its name, its short name and its blurb in both languages', async () => {
    const { en } = await import('@shared/i18n-en')
    const { fr } = await import('@shared/i18n-fr')
    expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([...SETTINGS_PAGES])
    expect(SETTINGS_PAGES).toHaveLength(11)
    expect(SETTINGS_CATEGORIES.map((category) => category.place)).toEqual(['start', ...Array<string>(8).fill('category'), 'apart', 'apart'])
    for (const category of SETTINGS_CATEGORIES) {
      for (const key of [category.label, category.short, category.blurb]) {
        expect((fr as Record<string, string>)[key], key).toBeTruthy()
        expect((en as Record<string, string>)[key], key).toBeTruthy()
      }
    }
  })
})

describe('what the categories draw', () => {
  it.each(SETTINGS_PAGES)('%s draws the keys the map gives it, and only those', (pane) => {
    const { own } = drawn(pane)
    const expected = new Set<string>(SETTINGS_KEYS[pane])
    expect([...expected].filter((key) => !own.has(key)), `Rangées qui manquent dans « ${pane} »`).toEqual([])
    expect([...own].filter((key) => !expected.has(key)), `Rangées de « ${pane} » que la carte ne connaît pas`).toEqual([])
  })

  it('draws again, marked as mirrors, the rows of « Pour commencer » and in Profils the rows each profile keeps on its own, and mirrors nothing anywhere else', () => {
    expect([...drawn('profiles').mirrors].sort()).toEqual(Object.keys(PER_PROFILE_KEYS).sort())
    expect([...drawn('home').mirrors].sort()).toEqual([...HOME_MIRROR_KEYS].sort())
    // « Fonctions en option » draws its own lines: the features to add are no longer drawn in a category.
    for (const pane of SETTINGS_PAGES.filter((candidate) => !['profiles', 'home'].includes(candidate))) expect([...drawn(pane).mirrors], pane).toEqual([])
    // A mirror stands for a setting that has its own row in a category, never for one that has none.
    for (const key of HOME_MIRROR_KEYS) expect(categoryOfKey(key), key).not.toBeNull()
    // The category that owns a mirrored row draws it for the profile of the space on screen, and says so.
    for (const [key, pane] of Object.entries(PER_PROFILE_KEYS)) {
      const row = markup(pane, snapshotWith()).split(`data-setting="${key}"`)[1]!.split('data-setting=')[0]!
      expect(row, key).toContain('class="pref-profile"')
      expect(row, key).toContain(frenchSpaces('profil « Profil par défaut »'))
    }
  })

  it('draws the switches that have no row of their own, each with the label of its feature', () => {
    for (const [id, pane] of Object.entries(FEATURE_ONLY_SWITCHES)) {
      const feature = FEATURES.find((f) => f.id === id)!
      const all = variants().map((snapshot) => markup(pane, snapshot)).join('\n')
      expect(all, `${id} dans ${pane}`).toContain(`aria-label="${feature.label.replace(/&/g, '&amp;')}"`)
    }
  })

  it('draws the groups that links lead to, under the id the anchors name, each in its own category', () => {
    // An anchor that starts a flow (the complete configuration) names no group.
    // Each category is drawn once in each variant, and every anchor is looked for in those drawings.
    const drawings = SETTINGS_PAGES.map((pane) => ({ pane, html: variants().map((snapshot) => markup(pane, snapshot)) }))
    for (const anchor of SETTINGS_ANCHORS.filter((name) => !FLOW_ANCHORS.has(name))) {
      const owners = drawings.filter(({ html }) => html.some((one) => one.includes(`id="${anchor}"`))).map(({ pane }) => pane)
      expect(owners, anchor).toHaveLength(1)
    }
  })

  it('keeps the words of the rows: the labels the panes had are still on screen', () => {
    const all = SETTINGS_PAGES.map((pane) => markup(pane, variants()[1]!)).join('\n')
    for (const label of ['Rechercher les mises à jour automatiquement', 'Mettre en veille les onglets inactifs', 'Bloquer les publicités et les traqueurs', 'Protection contre l’empreinte numérique', 'Épurer le nom des téléchargements', 'Afficher les aperçus au survol des onglets', 'Modifier les raccourcis clavier', 'Moteur de recherche', 'Archiver les onglets du jour inactifs', 'Dossier de téléchargement', 'Effacer les données de navigation']) {
      expect(all, label).toContain(label)
    }
  })

  // `blockTrackers` is an alias of `blockAds` (the blocker reads either), so the second switch with the same label is gone.
  it('draws one switch for the ads and the trackers, on while either key is, and writing both', () => {
    const rowOf = (patch: Partial<Settings>) => markup('protection', snapshotWith(patch)).split('data-setting="blockAds"')[1]!.split('data-setting=')[0]!
    expect(rowOf({ blockAds: false, blockTrackers: true })).toMatch(/role="switch"[^>]*checked=""/)
    expect(rowOf({ blockAds: true, blockTrackers: false })).toMatch(/role="switch"[^>]*checked=""/)
    expect(rowOf({ blockAds: false, blockTrackers: false })).not.toContain('checked=""')
    const html = markup('protection', snapshotWith())
    expect(html.match(/aria-label="Bloquer les publicités et les traqueurs"/g)).toHaveLength(1)
    expect(html).not.toContain('<span class="pref-title">Bloquer les publicités et les traqueurs</span>')
    expect(html).not.toContain('data-setting="blockTrackers"')
    // Off writes the alias too: otherwise the blocker, which reads either, would stay on.
    const update = vi.fn()
    const row = elementsOfCategory('protection', snapshotWith({ blockAds: true, blockTrackers: true }), update).find((element) => element.props['settingKey'] === 'blockAds')
    ;(row?.props['onChange'] as (on: boolean) => void)(false)
    ;(row?.props['onChange'] as (on: boolean) => void)(true)
    expect(update.mock.calls).toEqual([[{ blockAds: false, blockTrackers: false }], [{ blockAds: true, blockTrackers: true }]])
    expect(update.mock.calls.map(([patch]) => patch)).toEqual([adsBlockingPatch(false), adsBlockingPatch(true)])
  })

  it('offers « Recevoir les versions de test » next to the updates only in a build that carries a test channel, and writes the channel the box means', () => {
    const row = (html: string): string => html.split('data-setting="updateChannel"')[1]!.split('data-setting=')[0]!
    const without = markup('about', snapshotWith())
    expect(without).not.toContain('data-setting="updateChannel"')
    expect(without).not.toContain('Recevoir les versions de test')
    const html = markup('about', snapshotWith({}, { updateTestChannel: true }))
    expect(html.indexOf('data-setting="updateChannel"')).toBeGreaterThan(html.indexOf('data-setting="autoUpdate"'))
    expect(html.indexOf('data-setting="updateChannel"')).toBeLessThan(html.indexOf('data-setting="whatsNewSheet"'))
    expect(row(html)).toContain('Recevoir les versions de test')
    expect(row(html)).toContain(frenchSpaces('Les versions de test arrivent avant la version stable ; elles peuvent contenir des défauts.'))
    expect(row(html)).not.toContain('checked=""')
    expect(row(markup('about', snapshotWith({ updateChannel: 'test' }, { updateTestChannel: true })))).toMatch(/role="switch"[^>]*checked=""/)
    const update = vi.fn()
    const found = elementsOfCategory('about', snapshotWith({}, { updateTestChannel: true }), update).find((element) => element.props['settingKey'] === 'updateChannel')
    ;(found?.props['onChange'] as (on: boolean) => void)(true)
    ;(found?.props['onChange'] as (on: boolean) => void)(false)
    expect(update.mock.calls).toEqual([[{ updateChannel: 'test' }], [{ updateChannel: 'stable' }]])
  })

  it('no longer sends anyone to Profils, or from Profils to Vie privée, for a setting that has its row in its own category', () => {
    const all = SETTINGS_PAGES.map((pane) => markup(pane, snapshotWith())).join('\n')
    expect(all).not.toContain('Réglages du profil…')
    expect(all).not.toContain('Plus de réglages…')
    expect(all).not.toContain('Réglages de la recherche…')
    expect(all).not.toContain('class="pref-row nav-row"')
  })
})

/** A part of a page drawn with the settings it shows (the dots of the rows not at their default). */
const settled = (pane: SettingsPage, patch: Partial<Settings> = {}, pass: FoldPass = 'all') =>
  renderToStaticMarkup(createElement(SettingsStateContext.Provider, { value: snapshotWith(patch).state.settings }, createElement(FoldPassContext.Provider, { value: pass }, createElement(CategoryContent, { pane, snapshot: snapshotWith(patch), update: noop, goTo: noop }))))

describe('the top of a page and its fold « Plus de réglages » (shared/settings-placement.ts)', () => {

  /**
   * What a part draws that a person reads or uses: the rows, the callouts, the lines of buttons, the paragraphs and the separators (each tag as drawn),
   * the settings they stand for and the search ids they carry (a group split in two carries its own in each part), and the ids an anchor may name.
   */
  const units = (html: string): string[] => {
    const clean = html.replace(/ (id|aria-describedby|aria-controls|aria-labelledby|for)="_[^"]*"/g, '')
    const tags = [...clean.matchAll(/<(?!section\b)[a-z0-9]+[^>]*class="(?:pref-row|pref-callout|pref-buttons|icon-grid|pref-sep|links-text|pref-intro|pref-note)[^"]*"[^>]*>/g)].map((match) => match[0])
    const keys = [...clean.matchAll(/data-setting="([^"]*)"/g)].flatMap((match) => match[1]!.split(' ').map((key) => `key ${key}`))
    const searches = [...clean.matchAll(/data-search="([^"]*)"/g)].map((match) => `search ${match[1]}`)
    const ids = [...clean.matchAll(/ id="([^"]*)"/g)].map((match) => `id ${match[1]}`)
    return [...tags, ...keys, ...searches, ...ids].sort()
  }

  it('draws every row once, at the top of its page, in its fold or on one of its subpages: nothing is lost, nothing is drawn twice', () => {
    for (const snapshot of variants()) {
      for (const pane of SETTINGS_PAGES) {
        const whole = units(markup(pane, snapshot))
        const subpages = SUBPAGES.filter((subpage) => subpage.pane === pane).flatMap((subpage) => units(markup(pane, snapshot, `sub:${subpage.id}`)))
        // The rows that open a subpage are the page's own: what the subpage holds stands in their place in a page drawn whole.
        const split = [...units(withoutEntries(markup(pane, snapshot, 'page'))), ...units(withoutEntries(markup(pane, snapshot, 'more'))), ...subpages].sort()
        expect(split, pane).toEqual(whole)
      }
    }
  })

  it('keeps in the fold only the settings the table does not put at the top, and at the top only those it does, but for what a page draws whole', () => {
    // What a page draws whole at its top: the editor of the shortcuts (with ⌃Tab under it), the list of the profiles, and the pages of rows drawn again
    // (« Pour commencer », « Fonctions en option »), which have no fold.
    const drawnWhole = new Set(['tabCycleRecent'])
    for (const pane of SETTINGS_PAGES) {
      for (const key of keysIn(markup(pane, snapshotWith(), 'more'))) expect(placementOf(key as never), `${pane}: ${key} est dans le repli`).toBe('more')
      if (pane === 'profiles' || pane === 'home' || pane === 'features') continue
      for (const key of keysIn(markup(pane, snapshotWith(), 'page'))) if (!drawnWhole.has(key)) expect(placementOf(key as never), `${pane}: ${key} est en haut`).toBe('page')
    }
    for (const key of PAGE_KEYS) expect(categoryOfKey(key), key).not.toBeNull()
  })

  it('names every section of a fold: a group that waits there has a title, so that the line of the fold can say it', () => {
    for (const snapshot of variants()) {
      for (const pane of SETTINGS_PAGES) {
        const untitled = [...markup(pane, snapshot, 'more').matchAll(/<section class="pref-section"[^>]*>(?!<h3>)[\s\S]{0,120}/g)].map((match) => match[0])
        expect(untitled, pane).toEqual([])
      }
    }
  })

  it('marks every row with its place, from the table', () => {
    for (const pane of SETTINGS_PAGES) {
      const html = markup(pane, snapshotWith())
      for (const [, key, place] of html.matchAll(/class="pref-row[^"]*" data-setting="([^" ]+)" data-placement="(page|more)"/g)) expect(place, key).toBe(placementOf(key as never))
    }
  })

  it('shows a few rows at the top of each page, and the rows one looks for first', () => {
    const top = (pane: SettingsPage) => markup(pane, snapshotWith(), 'page')
    for (const pane of SETTINGS_PAGES) expect(top(pane).split('class="pref-row').length - 1, pane).toBeGreaterThan(0)
    // What only informs (the version, the state of the engine, the dashboard of the blocker) waits in the fold; the rows one looks for are at the top.
    const all = SETTINGS_PAGES.map(top).join('\n')
    for (const word of ['État de Lucium', 'Tableau de bord']) expect(all, word).not.toContain(word)
    for (const [pane, word] of [['protection', 'Effacer les données de navigation'], ['tools', 'Ouvrir la page Extensions'], ['files', 'Dossier de téléchargement'], ['navigation', 'Moteur de recherche']] as const) expect(top(pane), word).toContain(word)
  })

  it('splits a group between the two: its rows at the top under its title, the others in the fold under the same title, the anchor on the top', () => {
    // "Mise en veille": the delay is at the top; the cap, the freezing, the mode, the audible and the pinned tabs, the notice, the tabs loaded at the launch wait.
    const section = (html: string) => html.split('<span class="pref-title">Mise en veille</span>')[1]!.split('</section>')[0]!
    const top = section(settled('tabs', {}, 'page'))
    const fold = section(settled('tabs', {}, 'more'))
    expect(top).toContain('data-setting="sleepAfterMinutes"')
    expect(top).not.toContain('data-setting="sleepSkipAudible"')
    for (const key of ['sleepAwakeMax', 'sleepFreezeAfterMinutes', 'sleepMode', 'sleepSkipAudible', 'sleepSkipPinned', 'sleepNotify']) expect(fold, key).toContain(`data-setting="${key}" data-placement="more"`)
    expect(fold).toContain('aria-label="Délai de mise en veille"')
    // "Au lancement": the preset at the top, standing for the windows of the last session; their switch and the loading of every tab wait.
    const launch = (html: string) => html.split('<span class="pref-title">Au lancement</span>')[1]!.split('</section>')[0]!
    expect(launch(settled('tabs', {}, 'page'))).toMatch(/<div class="pref-row preset-row" data-setting="restoreWindows" data-placement="page">/)
    expect(launch(settled('tabs', {}, 'more'))).toContain('aria-label="Rouvrir les fenêtres de la session précédente"')
    expect(launch(settled('tabs', {}, 'more'))).toContain('data-setting="loadAllTabsAtLaunch" data-placement="more"')
    // A group a link leads to keeps its id on the part at the top; the part in the fold has none (an id is once in a page).
    const extensions = settled('tools', { extensionPaths: ['/tmp/ext'] } as Partial<Settings>, 'page')
    expect(extensions).toMatch(/<section class="pref-section" id="extensions"/)
    expect(settled('tools', { extensionPaths: ['/tmp/ext'] } as Partial<Settings>, 'more')).not.toContain('id="extensions"')
  })

  it('sends a group that waits whole to the fold, with its title, its count and its rows; a group of no setting stays at the top', () => {
    const fold = settled('protection', {}, 'more')
    expect(fold).toContain('<span class="pref-title">Mode de blocage</span><span class="pref-count">1</span>')
    expect(fold.split('<span class="pref-title">Mode de blocage</span>')[1]!.split('</section>')[0]).toContain('data-setting="blockMode"')
    expect(settled('protection', {}, 'page')).not.toContain('Mode de blocage')
    // A group that informs, placed outright in the fold, goes there whole with no count: it holds no setting.
    expect(settled('about', {}, 'more')).toContain('<h3><span class="pref-title">État de Lucium</span></h3>')
    // The filter lists are on their subpage, whole (its head names them: the group has no title of its own there); the page says them by the row that
    // opens it, counted with the group that holds it; a search finds the group under its title.
    expect(fold).not.toContain('Listes de filtres')
    expect(settled('protection', {}, 'sub:filterlists')).toContain('data-setting="disabledFilterLists filterUpdateDays customFilterListsEnabled customFilterLists"')
    expect(settled('protection', {}, 'sub:filterlists')).not.toContain('<span class="pref-title">Listes de filtres</span>')
    expect(settled('protection', {}, 'all')).toContain('<span class="pref-title">Listes de filtres</span><span class="pref-count">4</span>')
    expect(settled('protection', {}, 'page')).toContain('<span class="pref-title">Réseau et listes de filtres</span><span class="pref-count">10</span>')
    // The title of a part counts its own settings, the rows of a component that draws several (the engine, the archive delay) included. The level of
    // protection stands for no setting of its own: its group has no count; the switches of the blocker are under it.
    expect(settled('protection', {}, 'page')).toContain('<span class="pref-title">Protection</span></h3>')
    expect(settled('protection', {}, 'page')).toContain('<span class="pref-title">Bloqueur</span><span class="pref-count">2</span>')
    expect(settled('navigation', {}, 'page')).toContain('<span class="pref-title">Moteur de recherche</span><span class="pref-count">2</span>')
    expect(settled('tabs', {}, 'page')).toContain('<span class="pref-title">Archivage et organisation</span><span class="pref-count">1</span>')
  })

  it('keeps a group at the top while it holds one row placed there: the page of the extensions stays with the row of the folders, the Web Store waits', () => {
    const withFolder = { extensionPaths: ['/tmp/ext'] } as Partial<Settings>
    const top = settled('tools', withFolder, 'page').split('<span class="pref-title">Extensions</span>')[1]!.split('</section>')[0]!
    const fold = settled('tools', withFolder, 'more').split('<span class="pref-title">Extensions</span>')[1]!.split('</section>')[0]!
    expect(top).toContain('Ouvrir la page Extensions')
    expect(top).toContain('data-subpage-entry="extensionfolders"')
    expect(top).not.toContain('data-setting="webStoreInstall"')
    expect(fold).toContain('data-setting="webStoreInstall"')
    // The folders themselves, and the button that loads one, are on their subpage only.
    for (const text of ['<code>/tmp/ext</code>', 'Charger une extension']) {
      expect(top + fold, text).not.toContain(text)
      expect(settled('tools', withFolder, 'sub:extensionfolders'), text).toContain(text)
    }
  })

  it('draws no fold of its own anywhere: no group hides itself, the page has one fold, drawn by the window', () => {
    for (const snapshot of variants()) {
      for (const pane of SETTINGS_PAGES) {
        for (const pass of ['page', 'more'] as const) {
          const html = markup(pane, snapshot, pass)
          expect(html, `${pane} ${pass}`).not.toMatch(/<section[^>]*hidden/)
          // The only <details> a category draws are the explanations of a row (« Voir l’effet » is a button, the legend of the costs is the window's).
          expect(html.match(/<details/g) ?? [], `${pane} ${pass}`).toEqual([])
        }
      }
    }
  })
})

describe('the subpages (shared/settings-subpages.ts)', () => {
  /** The parts of the page of a subpage that show it, over the states of `variants`. */
  const drawingsOf = (subpage: (typeof SUBPAGES)[number], pass: FoldPass) => variants().map((snapshot) => markup(subpage.pane, snapshot, pass))

  it('draws each subpage alone with the settings it holds, all of them, and no row of the page around it', () => {
    for (const subpage of SUBPAGES) {
      const drawn = drawingsOf(subpage, `sub:${subpage.id}`)
      expect(drawn.some((html) => html.includes(`data-subpage="${subpage.id}"`)), subpage.id).toBe(true)
      const keys = new Set(drawn.flatMap((html) => [...keysIn(html)]))
      expect([...keys].sort(), subpage.id).toEqual([...subpage.keys].sort())
      // Nothing of another subpage either.
      for (const html of drawn) expect([...html.matchAll(/data-subpage="([a-z]+)"/g)].map((match) => match[1]).filter((id) => id !== subpage.id), subpage.id).toEqual([])
    }
  })

  it('says each subpage on its page by the row that opens it: one button, the settings it holds, at the place the map gives it', () => {
    for (const subpage of SUBPAGES) {
      const part = subpage.at
      const other = part === 'page' ? 'more' : 'page'
      const here = drawingsOf(subpage, part).filter((html) => html.includes(`data-subpage-entry="${subpage.id}"`))
      expect(here.length, subpage.id).toBeGreaterThan(0)
      for (const html of here) {
        const row = new RegExp(`<div class="pref-row subpage-entry"( data-setting="([^"]*)")? data-placement="${part}" data-subpage-entry="${subpage.id}"><button type="button" class="subpage-open">`).exec(html)
        expect(row, subpage.id).not.toBeNull()
        expect((row![2] ?? '').split(' ').filter(Boolean), subpage.id).toEqual([...subpage.keys])
        expect(html.split(`data-subpage-entry="${subpage.id}"`).length - 1, subpage.id).toBe(1)
      }
      for (const html of drawingsOf(subpage, other)) expect(html, subpage.id).not.toContain(`data-subpage-entry="${subpage.id}"`)
    }
  })

  it('draws, for a page drawn whole (a search, « Réglages modifiés »), what each subpage holds and not the row that opens it', () => {
    for (const pane of SETTINGS_PAGES) {
      for (const html of variants().map((snapshot) => markup(pane, snapshot))) expect(html, pane).not.toContain('data-subpage-entry')
    }
    expect(markup('protection', snapshotWith())).toContain('data-subpage="filterlists"')
  })

  it('puts the editor of the shortcuts on its subpage, and ⌃Tab with the row that opens it at the top of Clavier et souris', () => {
    const top = settled('keyboard', {}, 'page')
    expect(top).not.toContain('class="shortcuts-layout"')
    const section = top.split('<span class="pref-title">Raccourcis clavier</span>')[1]!.split('</section>')[0]!
    expect(section).toContain('data-subpage-entry="shortcuts"')
    expect(section).toContain('data-setting="tabCycleRecent"')
    expect(section.indexOf('data-subpage-entry="shortcuts"')).toBeLessThan(section.indexOf('data-setting="tabCycleRecent"'))
    const editor = settled('keyboard', {}, 'sub:shortcuts')
    expect(editor).toContain('class="shortcuts-layout" data-setting="keyBindings"')
    expect(editor).not.toContain('data-setting="tabCycleRecent"')
    // The row a search shows for the editor is there, marked so that a result never lands on it (settings-anchor.ts).
    expect(editor).toMatch(/<div class="shortcuts-jump" data-search-only="">[\s\S]*?data-setting="keyBindings"/)
  })
})

describe('the optional features', () => {
  /** From the marker of a row to the marker of the next one: its label, its hint, its control. */
  const rowOf = (html: string, key: string): string => html.split(`data-setting="${key}"`)[1]!.split('data-setting=')[0]!
  /** A text as the markup writes it. */
  const escaped = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  it('list the 29 features to add in « Fonctions en option », theme by theme: each line its switch, its short line (or the first sentence of its description) and its cost said in a sentence', () => {
    const html = markup('features', snapshotWith())
    const titles = [...html.matchAll(/<h3><span class="pref-title">([^<]*)<\/span>/g)].map((match) => match[1]!)
    for (const theme of FEATURE_THEMES) expect(titles, theme.id).toContain(escaped(setLanguageText(theme.title)))
    for (const id of CATALOGUE_FEATURES) {
      const feature = featureById(id)
      const row = rowOf(html, feature.key)
      expect(row, id).toContain(`role="switch" aria-label="${escaped(feature.label)}"`)
      expect(row, id).toContain(`<div class="pref-hint" id="`)
      expect(row, id).toContain(`>${escaped(featureLine(feature))}</div>`)
      expect(row, id).toContain(`<div class="pref-cost" id="`)
      expect(row, id).toContain(`>${escaped(costSentence(feature))}</div>`)
    }
  })

  it('unfold behind « En savoir plus », hidden until asked, the whole description and what the row said in its category, and offer it only where there is more than the first sentence', () => {
    const html = markup('features', snapshotWith())
    const toggled: string[] = []
    for (const id of CATALOGUE_FEATURES) {
      const feature = featureById(id)
      const row = rowOf(html, feature.key)
      if (!row.includes('class="pref-more-toggle"')) continue
      toggled.push(id)
      expect(row, id).toMatch(/<button type="button" class="pref-more-toggle" id="[^"]+" aria-expanded="false" aria-controls="[^"]+" aria-labelledby="[^"]+">En savoir plus<\/button><div class="pref-more-text" id="[^"]+" hidden="">/)
      // The whole description is there when it says more than the line.
      if (featureLine(feature) !== feature.description) expect(row, id).toContain(`<p>${escaped(feature.description)}</p>`)
    }
    // What the rows said in their category before they moved: kept, every word of it (the QR code computed in Lucium, the note of « Cookies par site »).
    expect(rowOf(html, 'qrCode')).toContain(`<p>${escaped(t('web-tools-settings.ajoute-code-qr-de-cette-page-au-menu'))}</p>`)
    expect(rowOf(html, 'cookieManager')).toContain(`<p>${escaped(t('privacy-extra-settings.chaque-interrupteur-est-reel-desactive-la'))}</p>`)
    expect(rowOf(html, 'guestProfile')).toContain(`<p>${escaped(t('guest-settings.une-fenetre-invite-garde-une-session-en'))}</p>`)
    // Every line says more behind « En savoir plus »: its whole description when its line is shorter, or what its row said in its category.
    expect(CATALOGUE_FEATURES.filter((id) => !toggled.includes(id))).toEqual([])
  })

  it('draw the switch of each feature to add in « Fonctions en option » only: no category draws its row or its switch any more', () => {
    for (const id of CATALOGUE_FEATURES) {
      const feature = featureById(id)
      for (const pane of SETTINGS_PAGES.filter((candidate) => candidate !== 'features')) {
        for (const snapshot of variants()) {
          const html = markup(pane, snapshot)
          expect(html, `${id} dans ${pane}`).not.toContain(`data-setting="${feature.key}"`)
          expect(html, `${id} dans ${pane}`).not.toContain(`aria-label="${escaped(feature.label)}"`)
        }
      }
    }
  })

  it('keep the state each feature starts with: the switch of a new profile shows the default of the registry', () => {
    const html = markup('features', snapshotWith())
    for (const id of CATALOGUE_FEATURES) {
      const input = /<input[^>]*role="switch"[^>]*>/.exec(rowOf(html, featureById(id).key))![0]
      expect(input.includes('checked=""'), id).toBe(featureDefault(id))
    }
  })

  it('say no cost on the rows of the categories: the preferences carry no mark of it, the page no legend', () => {
    for (const pane of SETTINGS_PAGES.filter((candidate) => candidate !== 'features')) {
      for (const snapshot of variants()) {
        const html = markup(pane, snapshot)
        expect(html, pane).not.toContain('cost-mark')
        expect(html, pane).not.toContain('pref-cost')
      }
    }
    expect(rowOf(markup('about', snapshotWith()), 'autoUpdate')).not.toMatch(/réseau</)
  })

  it('show the option of a feature under its line while the feature is on, and keep it, greyed, while it is off and the option is not at its default', () => {
    const settled = (patch: Partial<Settings>) => renderToStaticMarkup(createElement(SettingsStateContext.Provider, { value: snapshotWith(patch).state.settings }, createElement(CategoryContent, { pane: 'features', snapshot: snapshotWith(patch), update: noop, goTo: noop })))
    const on = settled({ notes: true })
    expect(on).toMatch(/<div class="feature-options"><div class="pref-row pref-check pref-check-split" data-setting="notesListButton"/)
    // The toolbar has no « Nouvelle note » button (a note is made from the panel): the one row of the feature is the button « Toutes les notes ».
    expect(on).not.toContain('data-setting="notesToolbarButton"')
    expect(rowOf(on, 'notesListButton')).toMatch(/role="switch"[^>]*checked=""/)
    expect(rowOf(on, 'notesListButton')).not.toContain('disabled=""')
    expect(rowOf(on, 'notesListButton')).toContain(escaped(t('notes.bouton-toutes-les-notes-dans-la-barre-d-outils')))
    expect(settled({ notes: false })).not.toContain('data-setting="notesListButton"')
    expect(rowOf(settled({ notes: false, notesListButton: false }), 'notesListButton')).toMatch(/role="switch"[^>]*disabled=""/)
    // The waking of the sleeping tabs follows the command of the View menu, whether the buttons of the sidebar are shown or not: always drawn.
    expect(settled({ showReloadAllButton: false })).toContain('data-setting="reloadAllWakes"')
  })

  it('mark a row that is not at its default, for a screen reader too', () => {
    const settings = snapshotWith({ sleepMode: 'freeze' }).state.settings
    const drawnWith = renderToStaticMarkup(createElement(SettingsStateContext.Provider, { value: settings }, createElement(CategoryContent, { pane: 'tabs', snapshot: snapshotWith({ sleepMode: 'freeze' }), update: noop, goTo: noop })))
    expect(drawnWith).toContain('class="pref-changed"')
    expect(drawnWith).toContain('<span class="sr-only">Modifié</span>')
    const clean = renderToStaticMarkup(createElement(SettingsStateContext.Provider, { value: snapshotWith().state.settings }, createElement(CategoryContent, { pane: 'tabs', snapshot: snapshotWith(), update: noop, goTo: noop })))
    expect(clean).not.toContain('pref-changed')
  })
})

describe('the animated cards', () => {
  const cardsOf = (pane: SettingsPage, open: string | null, pass?: FoldPass): string => {
    const content = createElement(IllustrationContext.Provider, { value: { open: open as never, toggle: noop } }, createElement(CategoryContent, { pane, snapshot: snapshotWith(), update: noop, goTo: noop }))
    return renderToStaticMarkup(pass === undefined ? content : createElement(FoldPassContext.Provider, { value: pass }, content))
  }


  it('gives every one of the 22 illustrated settings a "Voir l’effet" button on its row, in the category that draws it', () => {
    expect(ILLUSTRATIONS).toHaveLength(22)
    for (const illustration of ILLUSTRATIONS) {
      const pane = categoryOfKey(illustration.key)!
      // From the row's marker to the next row's: its label, its control, its button.
      const row = cardsOf(pane, null).split(`data-setting="${illustration.key}"`)[1]?.split('data-setting=')[0]
      expect(row, illustration.key).toBeDefined()
      expect(row, illustration.key).toContain('Voir l’effet')
    }
  })

  it('shows no card until a row is open', () => {
    for (const pane of SETTINGS_PAGES) expect(cardsOf(pane, null), pane).not.toContain('class="illu')
  })

  it('opens the card of the one row that is open, under its row, with its scene and its caption', () => {
    for (const illustration of ILLUSTRATIONS) {
      const pane = categoryOfKey(illustration.key)!
      const html = cardsOf(pane, illustration.key)
      const figures = [...html.matchAll(/<figure class="illu[^"]*" data-illu="([^"]+)"/g)].map((match) => match[1])
      expect(figures, illustration.key).toEqual([illustration.key])
      expect(html.indexOf('data-illu')).toBeGreaterThan(html.indexOf(`data-setting="${illustration.key}"`))
      expect(html, illustration.key).toContain('<div class="scene" aria-hidden="true">')
      expect(html, illustration.key).toContain('<figcaption>')
      expect(html, illustration.key).toContain('aria-expanded="true"')
    }
  })

  it('draws a scene for each card (the markup the sheet animates)', () => {
    for (const illustration of ILLUSTRATIONS) {
      const html = cardsOf(categoryOfKey(illustration.key)!, illustration.key)
      const scene = html.split('<div class="scene" aria-hidden="true">')[1]!.split('<span class="phase"')[0]!
      expect(scene.length, illustration.key).toBeGreaterThan(40)
    }
  })

  it('animates each scene in the sheet, by the id of its setting', () => {
    const sheet = illustrationsCss.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const illustration of ILLUSTRATIONS) expect(sheet, illustration.key).toMatch(new RegExp(`\\[data-illu='${illustration.key}'\\][^{]*\\{[^}]*animation(-name)?:`))
  })

  it('opens, at the top of their page, on the button of 13 of the 16 settings of the list; the others wait in « Plus de réglages », their button with them', () => {
    // The list itself is pinned in shared/settings-illustrations.test.ts; here, what the window draws must agree with the place of each row.
    const atTop: string[] = []
    for (const illustration of ILLUSTRATIONS.slice(0, 16)) {
      const pane = categoryOfKey(illustration.key)!
      const top = cardsOf(pane, null, 'page').split(`data-setting="${illustration.key}"`)[1]?.split('data-setting=')[0]
      const fold = cardsOf(pane, null, 'more').split(`data-setting="${illustration.key}"`)[1]?.split('data-setting=')[0]
      expect(top ?? fold, illustration.key).toContain('Voir l’effet')
      if (top !== undefined) atTop.push(illustration.key)
    }
    const expected = ILLUSTRATIONS.slice(0, 16).filter((illustration) => placementOf(illustration.key) === 'page').map((illustration) => illustration.key)
    expect(expected).toHaveLength(13)
    expect(atTop).toEqual(expected)
  })
})

// Where the groups that the engine suites look for sit (src/main/smoke-about.ts, smoke-webhardware.ts, smoke-downloads2.ts, smoke-spaces2.ts): the order of
// the groups of a category and the group each switch lives in, which a window of 8 categories made different from the single Advanced pane of before.
describe('where the groups that the engine suites look for sit', () => {
  /** The titles of the groups of a category, in the order they are drawn (the count that follows a title is a span of its own). */
  const titlesOf = (pane: SettingsPage): string[] => [...markup(pane, snapshotWith()).matchAll(/<h3><span class="pref-title">([^<]*)<\/span>/g)].map((match) => match[1]!)
  /** The labels of the switches inside the group titled `title` of a category. */
  const switchesOf = (pane: SettingsPage, title: string): string[] => {
    const html = markup(pane, snapshotWith())
    const section = html.split(`<span class="pref-title">${title}</span>`)[1]?.split('</section>')[0] ?? ''
    return [...section.matchAll(/role="switch" aria-label="([^"]*)"/g)].map((match) => match[1]!)
  }

  it('À propos et mises à jour: the updates, the icon, then « À propos », then the state of Lucium', () => {
    expect(titlesOf('about')).toEqual(['Mises à jour', 'Icône de l’application', 'À propos', 'État de Lucium'])
  })

  it('« À propos » is the section #about, whose card holds the name, the tagline and the five links', () => {
    const html = markup('about', snapshotWith())
    expect(html).toContain('<section class="pref-section" id="about" data-placement="page"><h3><span class="pref-title">À propos</span></h3><div class="pref-group about-group">')
    const card = html.split('<div class="pref-group about-group">')[1]!.split('</section>')[0]!
    expect(card.match(/class="pref-row nav-row about-link"/g)).toHaveLength(5)
    expect(card).toContain('Nouveautés')
  })

  it('Vie privée et sécurité: « API matérielles du web » comes right after « Autorisations des sites »', () => {
    const titles = titlesOf('protection')
    expect(titles[titles.indexOf('API matérielles du web') - 1]).toBe('Autorisations des sites')
  })

  it('Téléchargements et fichiers: the switches of the downloads are in « Téléchargements et lecture » and « Ouverture des fichiers »; the pause, « Ouvrir sans l’enregistrer » and the PDF with the address in « Fonctions en option » › Fichiers', () => {
    const downloads = switchesOf('files', 'Téléchargements et lecture')
    const opening = switchesOf('files', 'Ouverture des fichiers')
    for (const label of ['Demander où enregistrer chaque fichier', frenchSpaces('Classer « Lire plus tard » dans des dossiers')]) expect(downloads, label).toContain(label)
    expect(opening).toContain('Mémoriser l’application d’ouverture par type de fichier')
    const files = switchesOf('features', 'Fichiers')
    expect(files).toEqual(['Pause et reprise des téléchargements', 'Ouvrir sans l’enregistrer', 'Enregistrer en PDF avec l’adresse'])
  })

  it('Apparence: « Espaces et fenêtre » holds the side of the sidebar, a menu of its two sides, and has no switch for the picture of a space; the web panels are in « Fonctions en option » › Barre latérale et fenêtres', () => {
    const switches = switchesOf('appearance', 'Espaces et fenêtre')
    const group = markup('appearance', snapshotWith()).split('<span class="pref-title">Espaces et fenêtre</span>')[1]?.split('</section>')[0] ?? ''
    expect(group).toMatch(/<select class="field pop" aria-label="Côté de la barre latérale"[^>]*><option value="false" selected="">À gauche<\/option><option value="true">À droite<\/option><\/select>/)
    expect(switches).not.toContain('Côté de la barre latérale')
    expect(switches.some((label) => label.includes('image pour un espace') || label.includes('olets web'))).toBe(false)
    expect(switchesOf('features', 'Barre latérale et fenêtres')).toContain('Volets web')
  })
})
