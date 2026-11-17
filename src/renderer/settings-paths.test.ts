// @vitest-environment happy-dom
// The paths to the Settings that the texts give the reader (« Réglages › Vie privée et sécurité › Verrouillage »): written from the map of the window
// (shared/settings-path.ts), never by hand. This test draws every page in both languages and checks that each place of `SETTINGS_PLACES` is where its path
// says (the page, « Plus de réglages » when it waits there, the subpage, the group that holds the setting), and refuses in the catalogues a path written
// by hand whose steps name nothing the window shows, there and in the documents a reader follows (the READMEs, docs/), where every step of a path is
// checked, not only its first (src/main/docs-settings-paths.test.ts checks the first one without drawing the window).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'
import { setLanguage, t, type Language } from '@shared/i18n'
import { SETTINGS_PAGES, type SettingsPage, type UiSnapshot } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { categoryOfKey, NO_CONTROL_KEYS, settingsPaneLabel, type SettingKey } from '@shared/settings-catalog'
import { SETTINGS_PLACES, settingsPath, settingsPathSteps, type SettingsPlace, type SettingsPlaceId } from '@shared/settings-path'
import { SUBPAGES, subpageOfKey } from '@shared/settings-subpages'
import { createInitialState } from '@shared/sidebar'
import { CategoryContent } from './SettingsCategories'
import { FoldPassContext, type FoldPass } from './settings-context'

// Every page drawn in every part, in two languages: up to a few seconds of processor on a loaded machine.
vi.setConfig({ testTimeout: 30_000 })
afterAll(() => setLanguage('fr'))

const noop = () => undefined

/** Every switch on, the lock not set and then set: the rows that wait for one or the other are drawn. */
function snapshots(): UiSnapshot[] {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const on: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaultSettings())) if (value === false) on[key] = true
  const settings = { ...state.settings, ...(on as Partial<Settings>) }
  const lock = { active: true, appLocked: false, lockedSpaces: [], guardedSpaces: [], touchId: true, retryInMs: 0 }
  return [{ state: { ...state, settings }, extensions: [], downloads: [] }, { state: { ...state, settings }, extensions: [], downloads: [], lock }] as unknown as UiSnapshot[]
}

/** A part of a page (its top, its fold, one of its subpages) as a document, drawn in each state of `snapshots`. */
function part(pane: SettingsPage, pass: FoldPass): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = snapshots()
    .map((snapshot) => renderToStaticMarkup(createElement(FoldPassContext.Provider, { value: pass }, createElement(CategoryContent, { pane, snapshot, update: noop, goTo: noop }))))
    .join('')
  return root
}

const keysOf = (el: Element): string[] => [el, ...el.querySelectorAll('[data-setting]')].flatMap((one) => (one.getAttribute('data-setting') ?? '').split(' '))
const titleOf = (section: Element): string => section.querySelector(':scope > h3 .pref-title')?.textContent ?? ''

/** What is wrong with a place, in the language of the moment: '' when the window shows it where its path says. */
function misplaced(place: SettingsPlace): string {
  const page = place.key !== undefined ? categoryOfKey(place.key) : place.page
  if (!page) return 'no page'
  const steps = settingsPathSteps(place)
  if (steps[0] !== settingsPaneLabel(page)) return `starts with « ${steps[0]} »`
  const subpage = place.key !== undefined ? subpageOfKey(place.key) : undefined
  const pass: FoldPass = subpage !== undefined ? `sub:${subpage.id}` : steps.includes(t('settings.plus-de-reglages')) ? 'more' : 'page'
  const root = part(page, pass)
  // The setting is drawn in that part, in the group its path names.
  const sections = [...root.querySelectorAll('section.pref-section')].filter((section) => place.key === undefined || keysOf(section).includes(place.key))
  if (place.key !== undefined && !keysOf(root).includes(place.key)) return `${place.key} is not drawn in « ${pass} »`
  if (place.group !== undefined && !sections.some((section) => titleOf(section) === t(place.group!))) return `no group « ${t(place.group)} » in « ${pass} »${place.key ? ` holding ${place.key}` : ''}`
  return ''
}

/** The names a step of a path written by hand may give on a page, in the language of the moment: its groups, its subpages, its rows, its fold. */
function namesOf(pane: SettingsPage): Set<string> {
  const names = new Set<string>([t('settings.plus-de-reglages'), ...SUBPAGES.filter((subpage) => subpage.pane === pane).map((subpage) => t(subpage.title))])
  for (const pass of ['all', ...SUBPAGES.filter((subpage) => subpage.pane === pane).map((subpage) => `sub:${subpage.id}` as const)] as FoldPass[]) {
    const root = part(pane, pass)
    for (const title of root.querySelectorAll('.pref-title')) names.add((title.textContent ?? '').trim())
    for (const label of root.querySelectorAll('.pref-label')) names.add((label.firstChild?.textContent ?? '').trim())
  }
  return names
}

/** « Réglages › » at the start of a path of ours (not « Réglages Système › », the window of macOS, nor « Site Info and Settings › », a panel). */
const ROOT: Readonly<Record<Language, RegExp>> = { fr: /Réglages › ([^.;,()«»“”:\n]+)/g, en: /(?<!System |and )Settings › ([^.;,()«»“”:\n]+)/g }

/** The paths written by hand in a text that lead nowhere: the first step that is not a page, or not a name of that page. */
export function strayPaths(text: string, language: Language, pages: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const stray: string[] = []
  for (const [whole, rest] of text.matchAll(ROOT[language])) {
    const steps = rest!.split(' › ').map((step) => step.trim())
    if (steps[0]!.startsWith('{')) continue
    const names = pages.get(steps[0]!)
    if (!names) {
      stray.push(whole)
      continue
    }
    if (steps.slice(1).some((step) => !step.startsWith('{') && !names.has(step))) stray.push(whole)
  }
  return stray
}

/** The source files of the application (no test, no catalogue). */
function sources(dir = join(process.cwd(), 'src')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name)
    if (statSync(file).isDirectory()) return sources(file)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|test-support|i18n-(?:fr|en)\.ts$/.test(name) ? [file] : []
  })
}

/** The arguments of the call a key is the first argument of: from the key to the bracket that closes the call. */
function callAt(source: string, at: number): string {
  let depth = 1
  for (let index = at; index < source.length; index++) {
    if (source[index] === '(') depth++
    if (source[index] === ')' && --depth === 0) return source.slice(at, index)
  }
  return source.slice(at)
}

/** The calls of a text that says `{settingsPath}` that give it none: the reader would see « {settingsPath} ». */
export function callsWithoutPath(files: ReadonlyArray<readonly [string, string]>, keys: readonly string[]): string[] {
  const missing: string[] = []
  for (const key of keys) {
    let calls = 0
    for (const [file, source] of files) {
      // The key as the first argument of a call, or as one of the two of a choice there (`t(one ? 'a' : 'b', …)`).
      for (const match of source.matchAll(new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g'))) {
        calls++
        if (!/\bsettingsPath: settingsPath\(/.test(callAt(source, match.index! + match[0].length))) missing.push(`${key} in ${file.split('/src/')[1]}`)
      }
    }
    if (calls === 0) missing.push(`${key}: never called`)
  }
  return missing
}

/** The pages of the window and the names each shows, in a language: drawn once per language, as drawing every page takes a few seconds. */
const drawn = new Map<Language, Map<string, Set<string>>>()
function pagesIn(language: Language): Map<string, Set<string>> {
  setLanguage(language)
  if (!drawn.has(language)) drawn.set(language, new Map(SETTINGS_PAGES.map((pane) => [settingsPaneLabel(pane), namesOf(pane)])))
  return drawn.get(language)!
}

/** A name as a document and the window may both write it: the curly apostrophe of the interface and the straight one typed, the non-breaking spaces. */
const plain = (text: string): string => text.replace(/[’‘]/g, "'").replace(/[  ]/g, ' ').trim()

/** « Réglages › » in a document (not « Réglages Système › », the window of macOS): the rest of the line is looked at without being consumed, as it may hold a second path. */
const DOC_ROOT: Readonly<Record<Language, RegExp>> = { fr: /(?<!Système )Réglages › (?=([^\n]*))/g, en: /(?<!System |and )Settings › (?=([^\n]*))/g }

/** What follows « Réglages › » without being a page: the entry of the command bar that opens the guided setup, which it writes « Réglages › Régler en quelques questions », by the name of the guide. */
const NOT_A_PAGE: Readonly<Record<Language, string>> = { fr: fr['guide.configuration-rapide'], en: en['guide.configuration-rapide'] }

/**
 * The paths of a document that lead nowhere. A document goes on in prose after a path (« Réglages › Apparence au groupe de la taille »), so the path
 * ends at the first mark that cannot be in a name (a full stop, a comma, a bracket, a quote, the stars and the backquote of Markdown), and its last step
 * only has to start with a name the page shows; every step before it is a page, or a name of the page it is on: a group, a subpage, a row, the fold.
 */
export function strayDocPaths(text: string, language: Language, pages: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const named = new Map([...pages].map(([page, names]) => [plain(page), new Set([...names].map(plain))]))
  const startsWithOne = (step: string, names: Iterable<string>): boolean => [...names].some((name) => name !== '' && (step === name || step.startsWith(`${name} `)))
  const stray: string[] = []
  for (const [whole, rest] of text.matchAll(DOC_ROOT[language])) {
    const steps = plain(rest!.split(/[.;,()«»“”":|*`[\]]/)[0]!)
      .split(/ ?› ?/)
      .map((step) => step.trim())
    while (steps.length > 0 && steps[steps.length - 1] === '') steps.pop()
    if (steps.length === 0 || steps[0]!.startsWith(NOT_A_PAGE[language])) continue
    const page = steps.length === 1 ? [...named.keys()].find((name) => startsWithOne(steps[0]!, [name])) : named.has(steps[0]!) ? steps[0] : undefined
    const names = page === undefined ? undefined : named.get(page)!
    const fine = names !== undefined && steps.slice(1).every((step, at, after) => (at === after.length - 1 ? startsWithOne(step, names) : names.has(step)))
    if (!fine) stray.push(`${whole.split(' › ')[0]} › ${steps.join(' › ')}`)
  }
  return stray
}

/** The documents a reader follows today: the READMEs and the other documents of the root, docs/ and docs/community/. The changelogs say where a setting was when their version came out. */
function documents(): string[] {
  const markdown = (folder: string): string[] =>
    readdirSync(join(process.cwd(), folder))
      .filter((name) => name.endsWith('.md') && !name.startsWith('CHANGELOG'))
      .map((name) => join(folder, name))
  return [...markdown('.'), ...markdown('docs'), ...markdown('docs/community')].sort()
}

describe('the paths to the Settings', () => {
  it('lead, for every place of the table, to the page, the fold, the subpage and the group that hold it, in both languages', () => {
    const wrong: string[] = []
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const [id, place] of Object.entries(SETTINGS_PLACES) as Array<[SettingsPlaceId, SettingsPlace]>) {
        const why = misplaced(place)
        if (why) wrong.push(`${language}:${id} (${settingsPath(id)}): ${why}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('are written from the map: the name of the page, « Plus de réglages » for a setting that waits there, the subpage, the group', () => {
    setLanguage('fr')
    expect(settingsPath('lock')).toBe('Réglages › Vie privée et sécurité › Verrouillage')
    expect(settingsPath('boostSharing')).toBe('Réglages › Extensions et outils › Plus de réglages › Partage des Retouches')
    expect(settingsPath('customFilterLists')).toBe('Réglages › Vie privée et sécurité › Listes de filtres')
    expect(settingsPath('engineStatus')).toBe('Réglages › À propos et mises à jour › Plus de réglages › État de Lucium')
    setLanguage('en')
    expect(settingsPath('lock')).toBe(`Settings › ${en['settings.cat-protection']} › ${en['lock-settings.verrouillage']}`)
  })

  it('refuse a place that names no page: a setting of no row has no path', () => {
    const key = Object.keys(NO_CONTROL_KEYS)[0] as SettingKey
    expect(() => settingsPathSteps({ key })).toThrow(/no page/)
  })

  it('find a path written by hand that leads nowhere, and let a true one through', () => {
    setLanguage('fr')
    const pages = new Map([[settingsPaneLabel('protection'), namesOf('protection')]])
    expect(strayPaths('Activez-le dans Réglages › Vie privée et sécurité › Verrouillage.', 'fr', pages)).toEqual([])
    expect(strayPaths('Voir Réglages › Vie privée et sécurité › Plus de réglages › Mode de blocage ; puis Réglages › {pane}', 'fr', pages)).toEqual([])
    expect(strayPaths('Voir Réglages › Vie privée et sécurité › Verrou, ou Réglages › Avancé.', 'fr', pages)).toEqual(['Réglages › Vie privée et sécurité › Verrou', 'Réglages › Avancé'])
    expect(strayPaths('Réglages Système › Confidentialité et sécurité › Réseau local', 'fr', pages)).toEqual([])
    setLanguage('en')
    expect(strayPaths('System Settings › Privacy & Security, or Site Info and Settings › Blocking', 'en', new Map())).toEqual([])
    expect(strayPaths('Settings › Advanced › Mini Window', 'en', new Map())).toEqual(['Settings › Advanced › Mini Window'])
  })

  it('are never written by hand in the catalogues to a place the window does not have, in either language', () => {
    const stray: string[] = []
    for (const [language, catalogue] of [['fr', fr], ['en', en]] as const) {
      const pages = pagesIn(language)
      for (const [key, text] of Object.entries(catalogue)) for (const path of strayPaths(text, language, pages)) stray.push(`${language}:${key} « ${path} »`)
    }
    expect(stray).toEqual([])
  })

  it('find in a document a path whose steps lead nowhere, read up to where the prose goes on, and let a true one through', () => {
    const pages = pagesIn('fr')
    const ok = [
      'voir *Réglages › Vie privée et sécurité › Plus de réglages › Mode de blocage* ;',
      'Réglages › Apparence au groupe de la taille (ancre `panelsize`)',
      'Réglages › Navigation › Recherches par mot-clé, une sous-page',
      'Réglages › Navigation › Plus de réglages › « Mots-clés d’extension dans la barre de commandes »',
      'Réglages › À propos et mises à jour › Icône de l\'application dit que…',
      'la barre de commandes (« Réglages › Régler en quelques questions »)',
      'Réglages Système › Général › Langue et région'
    ]
    for (const text of ok) expect(strayDocPaths(text, 'fr', pages), text).toEqual([])
    expect(strayDocPaths('Réglages › Navigation › Raccourcis ; puis Réglages › Apparence › Accessibilité › Toujours', 'fr', pages)).toEqual(['Réglages › Navigation › Raccourcis', 'Réglages › Apparence › Accessibilité › Toujours'])
    expect(strayDocPaths('**Réglages › Vie privée et sécurité › Verrou** : « Régler »', 'fr', pages)).toEqual(['Réglages › Vie privée et sécurité › Verrou'])
    expect(strayDocPaths('*Settings › Keyboard and mouse › Keyboard shortcuts*, or *Settings › Advanced*', 'en', pagesIn('en'))).toEqual(['Settings › Advanced'])
  })

  it('are never written in the documents to a place the window does not have: every step, in both languages', () => {
    const stray: string[] = []
    for (const language of ['fr', 'en'] as const) {
      const pages = pagesIn(language)
      for (const file of documents()) for (const path of strayDocPaths(readFileSync(join(process.cwd(), file), 'utf8'), language, pages)) stray.push(`${file}: ${path}`)
    }
    expect(documents().length).toBeGreaterThan(10)
    expect(stray).toEqual([])
  })

  it('are given to every call of a text that says {settingsPath}', () => {
    const keys = [...new Set(Object.entries(fr).filter(([, text]) => text.includes('{settingsPath}')).map(([key]) => key.replace(/\.(?:one|other)$/, '')))]
    expect(keys.length).toBeGreaterThan(30)
    expect(callsWithoutPath([['a.ts', "t('k.a', { settingsPath: settingsPath('lock') }); tp('k.b', 2, { n: f(1), settingsPath: settingsPath('notes') }); t(one ? 'k.c' : 'k.d', { settingsPath: settingsPath('profiles') })"]], ['k.a', 'k.b', 'k.c', 'k.d'])).toEqual([])
    expect(callsWithoutPath([['a.ts', "t('k.a'); t('k.b', { n: f(1) })"]], ['k.a', 'k.b', 'k.c'])).toEqual(['k.a in undefined', 'k.b in undefined', 'k.c: never called'])
    expect(callsWithoutPath(sources().map((file) => [file, readFileSync(file, 'utf8')] as const), keys)).toEqual([])
  })
})
