// @vitest-environment happy-dom
// The search of the Settings on the real rows of the window, in French and in English: the queries of the study of 12 November 2026 find what a person
// typing them looks for, first; no row is lost (each is found by its own name, and by each synonym that names it); few results are off the subject; and
// the filter hides, marks and paints what it should in the document. The first two sets of queries come from the study of the Settings of 12 November
// 2026: the 36 queries of its analysis, and 25 queries written afterwards, which were not used to write the synonyms (they measure what the search does
// with words it was not tuned for).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, type Language } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { settingsAnswer } from '@shared/settings-answers'
import { queryWords, rankUnits } from '@shared/settings-search'
import { SETTINGS_SYNONYMS } from '@shared/settings-synonyms'
import { createInitialState } from '@shared/sidebar'
import { SettingsView } from './SettingsWindow'
import { applySearch, BEST_ATTRIBUTE, collectUnits, wordRanges, type Unit } from './settings-filter'

/** The results of a search as the window draws them before it filters them: every row of every category, in a document. */
function drawResults(language: Language, patch: Partial<Settings> = {}): HTMLElement {
  setLanguage(language)
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const snapshot = { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [] } as unknown as UiSnapshot
  vi.stubGlobal('location', { hash: '#general' })
  // Any query draws every row: the filter (settings-filter.ts) runs in the window after the draw, which a static render does not do.
  const markup = renderToStaticMarkup(createElement(SettingsView, { snapshot, initialQuery: 'zzzz' }))
  const host = document.createElement('div')
  host.innerHTML = markup
  document.body.append(host)
  return host.querySelector<HTMLElement>('.settings-results')!
}

/**
 * The units of the results, as the search reads them, drawn once for each language: happy-dom keeps what a parse of the window made (some 35 MB) once
 * it has left the document, and a draw for each of the hundred queries ran the worker out of memory. The queries only read the units.
 */
const drawnUnits = new Map<Language, Unit[]>()
function unitsOf(language: Language, patch: Partial<Settings> = {}): Unit[] {
  if (Object.keys(patch).length > 0) return collectUnits(drawResults(language, patch))
  // The answers of the search (settings-answers.ts) are read in the language of the interface: it is set for every query, drawn or not.
  setLanguage(language)
  if (!drawnUnits.has(language)) drawnUnits.set(language, collectUnits(drawResults(language)))
  return drawnUnits.get(language)!
}

// Drawing every row of the window, once per language, is the slow part (seconds on a loaded machine): it is done here, with its own delay, so
// that the first query of each language does not carry it and time out.
beforeAll(() => {
  unitsOf('en')
  unitsOf('fr')
}, 60_000)

/** A query, and what answers it: one of the keys a row carries (`first`), or the id of an answer for what is not a setting (settings-answers.ts). */
interface QueryCase {
  query: string
  first?: readonly string[]
  answer?: string
}

/**
 * The 36 queries of the analysis, in French, with what each looks for. 34 have an answer: a row, or, for the import from another browser and the
 * default browser (whose row is drawn only when Lucium is not the default one), the answer of the search. « page d'accueil » and « nouvel onglet » name
 * nothing Lucium has: the answer of the search is all there is.
 */
const ANALYSIS_QUERIES: readonly QueryCase[] = [
  { query: 'mode sombre', first: ['interfaceAppearance'] },
  { query: 'cookies', first: ['blockCookieBanners', 'cookieManager', 'clearProfileData'] },
  { query: 'ne pas me suivre', first: ['sendGpc', 'blockAds', 'stripTrackingParams'] },
  { query: 'mot de passe', first: ['passwordManager'] },
  { query: 'langue', first: ['language'] },
  { query: 'vitesse', first: ['sleepAfterMinutes', 'blockAds'] },
  { query: 'batterie', first: ['batterySaver', 'sleepAfterMinutes'] },
  { query: 'extensions', first: ['extensionList'] },
  { query: 'raccourci', first: ['keyBindings'] },
  { query: 'vider l’historique', first: ['clearProfileData'] },
  { query: 'proxy', first: ['proxyEnabled'] },
  { query: 'traduction', first: ['translateLocal'] },
  { query: 'télécharger', first: ['downloadFolder', 'downloadAskWhere'] },
  { query: 'page d’accueil', answer: 'homepage' },
  { query: 'moteur de recherche', first: ['searchUrlTemplate'] },
  { query: 'pop-up', first: ['popupExceptions'] },
  { query: 'notifications', first: ['sitePermissions'] },
  { query: 'taille du texte', first: ['uiScale'] },
  { query: 'zoom', first: ['uiScale', 'showZoomIndicator'] },
  { query: 'navigateur par défaut', first: ['defaultBrowser'], answer: 'default-browser' },
  { query: 'mémoire', first: ['sleepAfterMinutes'] },
  { query: 'publicités', first: ['blockAds'] },
  { query: 'rouvrir les onglets', first: ['restoreWindows'] },
  { query: 'caméra', first: ['sitePermissions'] },
  { query: 'barre latérale à droite', first: ['sidebarRight'] },
  { query: 'confidentialité', first: ['blockAds'] },
  { query: 'sauvegarde', first: ['autoBackup', 'exportData'] },
  { query: 'mise à jour', first: ['autoUpdate'] },
  { query: 'traqueurs', first: ['blockAds'] },
  { query: 'Touch ID', first: ['lockTouchId', 'lockEnabled'] },
  { query: 'dossier de téléchargement', first: ['downloadFolder'] },
  { query: 'nouvel onglet', answer: 'new-tab' },
  { query: 'lecture automatique', first: ['autoplayPolicy'] },
  { query: 'importer', answer: 'import' },
  { query: 'thème', first: ['interfaceAppearance'] },
  { query: 'police', first: ['uiScale'] }
]

/** The two queries of the analysis that name nothing Lucium has: only an answer can help. */
const NOTHING_TO_FIND = ['page d’accueil', 'nouvel onglet']

/** The 25 control queries, in French, written after the synonyms of the study and not used to write those of the search. */
const CONTROL_QUERIES: readonly QueryCase[] = [
  { query: 'son', first: ['autoplayPolicy', 'sleepSkipAudible', 'mediaPlayer'] },
  { query: 'vidéo flottante', first: ['autoPictureInPicture'] },
  { query: 'onglets épinglés', first: ['sleepSkipPinned', 'tidyPinnedTitles'] },
  { query: 'adresse complète', first: ['fullUrlInToolbar'] },
  { query: 'économiser', first: ['batterySaver', 'sleepAfterMinutes'] },
  { query: 'geler', first: ['sleepFreezeAfterMinutes', 'sleepMode'] },
  { query: 'gestes', first: ['mouseGestures', 'spaceSwipe'] },
  { query: 'historique de navigation', first: ['clearProfileData', 'historyOff'] },
  { query: 'icône', first: ['appIcon'] },
  { query: 'invité', first: ['guestProfile'] },
  { query: 'navigation privée', first: ['privateTabs', 'guestProfile'] },
  { query: 'dns', first: ['dohCustom', 'dohMode', 'dohProvider'] },
  { query: 'vpn', first: ['proxyEnabled'] },
  { query: 'vim', first: ['vimKeys'] },
  { query: 'vue scindée', first: ['dragToSplit', 'scrollSync'] },
  { query: 'copier le lien', first: ['stripCopiedLinks'] },
  { query: 'lire à voix haute', first: ['readAloud'] },
  { query: 'conteneur', first: ['tabContainers', 'containers'] },
  { query: 'nouveautés', first: ['whatsNewSheet'] },
  { query: 'quitter', first: ['warnBeforeQuitting'] },
  { query: 'archive', first: ['autoArchiveHours'] },
  { query: 'mini fenêtre', first: ['littleArcShortcut', 'externalLinksInLittleArc', 'littleArcArchiveHours'] },
  { query: 'contraste', first: ['readableMode', 'forceHighContrast'] },
  { query: 'animations', first: ['forceReduceMotion'] },
  { query: 'javascript', first: ['boostScriptImport', 'userScripts'] }
]

/** The queries of the analysis said in English, for the English interface (the English synonyms were written for them). */
const ENGLISH_QUERIES: readonly QueryCase[] = [
  { query: 'dark mode', first: ['interfaceAppearance'] },
  { query: 'cookies', first: ['blockCookieBanners', 'cookieManager', 'clearProfileData'] },
  { query: 'do not track', first: ['sendGpc', 'blockAds', 'stripTrackingParams'] },
  { query: 'password', first: ['passwordManager'] },
  { query: 'language', first: ['language'] },
  { query: 'speed', first: ['sleepAfterMinutes', 'blockAds'] },
  { query: 'battery', first: ['batterySaver', 'sleepAfterMinutes'] },
  { query: 'extensions', first: ['extensionList'] },
  { query: 'shortcuts', first: ['keyBindings'] },
  { query: 'clear history', first: ['clearProfileData'] },
  { query: 'proxy', first: ['proxyEnabled'] },
  { query: 'translation', first: ['translateLocal'] },
  { query: 'download', first: ['downloadFolder', 'downloadAskWhere'] },
  { query: 'homepage', answer: 'homepage' },
  { query: 'search engine', first: ['searchUrlTemplate'] },
  { query: 'pop-ups', first: ['popupExceptions'] },
  { query: 'notifications', first: ['sitePermissions'] },
  { query: 'text size', first: ['uiScale'] },
  { query: 'zoom', first: ['uiScale', 'showZoomIndicator'] },
  { query: 'default browser', first: ['defaultBrowser'], answer: 'default-browser' },
  { query: 'memory', first: ['sleepAfterMinutes'] },
  { query: 'ads', first: ['blockAds'] },
  { query: 'reopen tabs', first: ['restoreWindows'] },
  { query: 'camera', first: ['sitePermissions'] },
  { query: 'sidebar on the right', first: ['sidebarRight'] },
  { query: 'privacy', first: ['blockAds'] },
  { query: 'backup', first: ['autoBackup', 'exportData'] },
  { query: 'updates', first: ['autoUpdate'] },
  { query: 'trackers', first: ['blockAds'] },
  { query: 'Touch ID', first: ['lockTouchId', 'lockEnabled'] },
  { query: 'download folder', first: ['downloadFolder'] },
  { query: 'new tab', answer: 'new-tab' },
  { query: 'autoplay', first: ['autoplayPolicy'] },
  { query: 'import', answer: 'import' },
  { query: 'theme', first: ['interfaceAppearance'] },
  { query: 'font', first: ['uiScale'] }
]

/** Whether a row is one of those the query looks for. */
const isWanted = (unit: Unit, wanted: readonly string[] | undefined): boolean => (wanted ?? []).some((key) => unit.keys.includes(key))

afterEach(() => {
  setLanguage('fr')
  document.body.replaceChildren()
})

/** The rows a query shows, best first, as the window ranks them (with the answer of the query, when it has one). */
const results = (units: readonly Unit[], query: string): Unit[] => rankUnits(units, query, { answered: settingsAnswer(query) !== null }).map((one) => one.unit)

/** Whether the query finds first what it looks for: the row (its best result), or the answer for what is not a setting. */
function foundFirst(units: readonly Unit[], one: QueryCase): boolean {
  const best = results(units, one.query)[0]
  return (best !== undefined && isWanted(best, one.first)) || (one.answer !== undefined && settingsAnswer(one.query)?.id === one.answer)
}

/** The share of the results, over a set of queries, that are not what the query looks for. */
function offTopicShare(units: readonly Unit[], cases: readonly QueryCase[]): number {
  let shown = 0
  let off = 0
  for (const one of cases) {
    const found = results(units, one.query)
    shown += found.length
    off += found.filter((unit) => !isWanted(unit, one.first)).length
  }
  return off / shown
}

describe('the queries of the analysis (36, in French)', () => {
  const units = (): Unit[] => unitsOf('fr')

  it.each(ANALYSIS_QUERIES.filter((one) => !NOTHING_TO_FIND.includes(one.query)).map((one) => [one.query, one] as const))('« %s » finds first what it looks for', (_query, one) => {
    const all = units()
    expect(foundFirst(all, one), results(all, one.query).slice(0, 3).map((unit) => unit.fields.label).join(' | ')).toBe(true)
  })

  it('reads a phrase as one: « mode sombre » is about the dark appearance, not about every « mode »', () => {
    for (const [language, query] of [['fr', 'mode sombre'], ['en', 'dark mode']] as const) {
      const found = results(unitsOf(language), query).map((unit) => unit.ownKeys[0])
      expect(found[0], query).toBe('interfaceAppearance')
      expect([...found].sort(), query).toEqual(['interfaceAppearance', 'readableMode', 'websiteAppearance'])
    }
  })

  it('answers the two that name nothing Lucium has, and shows nothing that only mentions their words', () => {
    const all = units()
    for (const query of NOTHING_TO_FIND) {
      const one = ANALYSIS_QUERIES.find((candidate) => candidate.query === query)!
      expect(settingsAnswer(query)?.id, query).toBe(one.answer)
    }
    // « page d'accueil » used to show the row of the icons, whose help says « sa page d'accueil ».
    expect(results(all, 'page d’accueil')).toEqual([])
  })

  it('finds first at least 32 of the 34 that have an answer, and keeps under 60 % of its results off the subject (82 % before; 56 % since the lines of the security check page and the password warning, which say the words of «mot de passe» and «mises à jour»)', () => {
    const all = units()
    const answered = ANALYSIS_QUERIES.filter((one) => !NOTHING_TO_FIND.includes(one.query))
    expect(answered).toHaveLength(34)
    expect(answered.filter((one) => foundFirst(all, one)).length).toBeGreaterThanOrEqual(32)
    expect(offTopicShare(all, ANALYSIS_QUERIES)).toBeLessThan(0.6)
  })
})

/**
 * The control queries were not used to write the synonyms: what they score is what the search does with words it was not tuned for. Two are known to
 * miss: « économiser » (no row says it, and no synonym was written for it) and « animations » (« Animation sur la page » starts with the word, before
 * « Toujours réduire les animations »).
 */
const CONTROL_MISSES = ['économiser', 'animations']

describe('the control queries (25, in French, not used to write the synonyms)', () => {
  it.each(CONTROL_QUERIES.filter((one) => !CONTROL_MISSES.includes(one.query)).map((one) => [one.query, one] as const))('« %s » finds first what it looks for', (_query, one) => {
    const all = unitsOf('fr')
    expect(foundFirst(all, one), results(all, one.query).slice(0, 3).map((unit) => unit.fields.label).join(' | ')).toBe(true)
  })

  it('finds first at least 22 of the 25, and keeps under 35 % of its results off the subject (70 % before)', () => {
    const all = unitsOf('fr')
    expect(CONTROL_QUERIES.filter((one) => foundFirst(all, one)).length).toBeGreaterThanOrEqual(22)
    expect(offTopicShare(all, CONTROL_QUERIES)).toBeLessThan(0.35)
  })
})

describe('the queries of the analysis in English, on the English interface', () => {
  it.each(ENGLISH_QUERIES.map((one) => [one.query, one] as const))('“%s” finds first what it looks for', (_query, one) => {
    const all = unitsOf('en')
    expect(foundFirst(all, one), results(all, one.query).slice(0, 3).map((unit) => unit.fields.label).join(' | ')).toBe(true)
  })
})

/**
 * The presets (settings-presets.ts), by their names and by the names of their options: the row of the preset comes first, the switches it writes after
 * it. Written with the wiring of the presets, not part of the study's sets: two synonyms were added for them (« protection », "sleep").
 */
const PRESET_QUERIES: ReadonlyArray<readonly [Language, string, string]> = [
  ['fr', 'protection', 'protectionLevel'],
  ['fr', 'niveau de protection', 'protectionLevel'],
  ['fr', 'renforcée', 'protectionLevel'],
  ['fr', 'veille', 'sleepAfterMinutes'],
  ['fr', 'au lancement', 'restoreWindows'],
  ['fr', 'liens', 'externalLinksInLittleArc'],
  ['en', 'protection', 'protectionLevel'],
  ['en', 'enhanced', 'protectionLevel'],
  ['en', 'sleep', 'sleepAfterMinutes'],
  ['en', 'at launch', 'restoreWindows'],
  ['en', 'links', 'externalLinksInLittleArc']
]

describe('the presets', () => {
  it.each(PRESET_QUERIES)('(%s) « %s » finds first the row of its preset', (language, query, key) => {
    const best = results(unitsOf(language), query)[0]
    expect(best?.el.classList.contains('preset-row'), best?.fields.label).toBe(true)
    expect(best?.ownKeys).toContain(key)
  })
})

// Each check searches every row of the window, in both languages: seconds when the whole suite shares the machine.
describe('no row is lost', { timeout: 30_000 }, () => {
  it.each(['fr', 'en'] as const)('every row that is a setting is found by its own name (%s)', (language: Language) => {
    const all = unitsOf(language)
    const lost = all.filter((unit) => unit.ownKeys.length > 0 && unit.fields.label.trim() !== '' && queryWords(unit.fields.label).length > 0).filter((unit) => !results(all, unit.fields.label).includes(unit))
    expect(lost.map((unit) => `${unit.ownKeys.join(' ')}: ${unit.fields.label}`)).toEqual([])
  })

  it('every synonym finds one of the rows it names, among those the window draws', () => {
    const all = unitsOf('fr')
    const drawn = new Set(all.flatMap((unit) => unit.keys))
    const lost = Object.entries(SETTINGS_SYNONYMS)
      .filter(([, targets]) => targets.some((target) => drawn.has(target)))
      .filter(([word, targets]) => !results(all, word).some((unit) => targets.some((target) => unit.keys.includes(target))))
      .map(([word]) => word)
    expect(lost).toEqual([])
  })

  it('still finds what the window tests ask of it: « publicités » and "ads" the ad blocker, "backup" the automatic copies', () => {
    const all = unitsOf('fr')
    for (const [query, key] of [['publicités', 'blockAds'], ['ads', 'blockAds'], ['backup', 'autoBackup'], ['veille', 'sleepAfterMinutes'], ['mémoire', 'sleepAfterMinutes']] as const) {
      expect(results(all, query).some((unit) => unit.keys.includes(key)), query).toBe(true)
    }
  })

  it('reads a group that carries its setting and draws one row as that row: « Langue de l’interface » is the setting of the language', () => {
    const language = unitsOf('fr').find((unit) => unit.fields.label === 'Langue de l’interface')!
    expect(language.ownKeys).toContain('language')
    // A group of many rows (the searches of the sites) does not give its key to each of them.
    expect(unitsOf('fr').filter((unit) => unit.groupKeys!.includes('siteSearches') && unit.ownKeys.includes('siteSearches'))).toEqual([])
  })

  it('reads a line of « Fonctions en option » by its name and its one line, never by the words of its cost or of « En savoir plus », which every line has', () => {
    const folders = unitsOf('fr').find((unit) => unit.ownKeys.includes('liveFolders'))!
    expect(folders.place.category).toBe('Fonctions en option')
    expect(folders.fields.label).toBe('Dossiers en direct (flux RSS, dépôts GitHub publics)')
    expect(folders.fields.hint).toMatch(/^Un dossier de la barre latérale suit un flux/)
    for (const said of ['Allumée', 'Coupée', 'réseau', 'En savoir plus']) expect(`${folders.fields.label} ${folders.fields.hint} ${folders.fields.more}`, said).not.toContain(said)
    // A word of the cost finds no line of a feature by it: « minuterie » is in the cost of three of them, and in no other word they show.
    expect(results(unitsOf('fr'), 'minuterie').filter((unit) => unit.el.classList.contains('pref-feature')).map((unit) => unit.ownKeys)).toEqual([])
  })

  it('reads the choices of a menu without what is said of them between brackets', () => {
    const border = unitsOf('fr').find((unit) => unit.keys.includes('windowBorder'))!
    expect(border.fields.options).not.toMatch(/défaut/)
    expect(border.fields.more).toMatch(/par défaut/)
  })
})

describe('the filter in the window', () => {
  it('hides what it does not keep, with the groups and categories left empty, and marks the best result', () => {
    const root = drawResults('fr')
    const outcome = applySearch(root, 'raccourci', queryWords('raccourci'))
    expect(outcome.best?.keys).toContain('keyBindings')
    expect(outcome.ranked[0]).toBe(outcome.best)
    expect(outcome.shown).toBe(outcome.ranked.length)
    expect(root.querySelectorAll(`[${BEST_ATTRIBUTE}]`)).toHaveLength(1)
    expect(root.querySelector(`[${BEST_ATTRIBUTE}]`)).toBe(outcome.best!.el)
    const visible = outcome.units.filter((unit) => !unit.el.hidden)
    expect(visible).toHaveLength(outcome.shown)
    expect(root.querySelector<HTMLElement>('[data-category-label="Apparence"]')!.hidden).toBe(true)
    // Another query moves the mark; nothing found leaves none.
    applySearch(root, 'proxy', queryWords('proxy'))
    expect(root.querySelector(`[${BEST_ATTRIBUTE}]`)?.getAttribute('data-setting')).toContain('proxyEnabled')
    expect(applySearch(root, 'zzzz', queryWords('zzzz')).best).toBeNull()
    expect(root.querySelectorAll(`[${BEST_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('beside an answer, leaves out the rows that only mention the words', () => {
    const root = drawResults('fr')
    // The default browser has a row of its own now (« Pour commencer »), named by the words: it is a setting, so it stays beside the answer.
    const defaultBrowser = applySearch(root, 'navigateur par défaut', queryWords('navigateur par défaut'), { answered: true })
    expect(defaultBrowser.ranked.map((unit) => unit.keys)).toEqual([['defaultBrowser']])
    expect(applySearch(root, 'nouvel onglet', queryWords('nouvel onglet'), { answered: true }).ranked.every((unit) => /nouvel onglet/.test(unit.fields.label))).toBe(true)
  })

  it('paints a word at the start of a word only: "id" in « Touch ID », not in « rapide »', () => {
    const el = document.createElement('div')
    el.textContent = 'Recherche rapide avec Touch ID, et les onglets'
    document.body.append(el)
    const painted = (words: string[]) => wordRanges(el, words).map((range) => range.toString())
    expect(painted(['id'])).toEqual(['ID'])
    expect(painted(['onglet'])).toEqual(['onglet'])
    expect(painted(['rap'])).toEqual(['rap'])
  })

  it('collects every row once, with the parts it is read by', () => {
    const units = collectUnits(drawResults('fr'))
    const appearance = units.find((unit) => unit.ownKeys.includes('interfaceAppearance'))!
    expect(appearance.fields.label).toBe('Apparence de Lucium')
    expect(appearance.fields.options).toMatch(/Sombre/)
    expect(appearance.fields.hint).toMatch(/Clair, sombre/)
    expect(appearance.place).toEqual({ category: 'Apparence', subpage: '', group: 'Affichage' })
    // A row of a subpage says the subpage it is on.
    expect(units.find((unit) => unit.ownKeys.includes('proxyEnabled'))!.place).toEqual({ category: 'Vie privée et sécurité', subpage: 'DNS chiffré et proxy', group: 'Proxy' })
    expect(new Set(units.map((unit) => unit.el)).size).toBe(units.length)
  })
})
