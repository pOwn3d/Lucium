// The catalogue behind « Découvrir Lucium » (shared/discover.ts): every function of the registry has a task, every card leads somewhere that exists, the
// shortcut a card shows is the one in force, and the search understands the words of everyday, in French and in English, accents aside.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALL_DISCOVER_ENTRIES,
  DISCOVER_ENTRIES,
  DISCOVER_EXTRAS,
  DISCOVER_LEVELS,
  DISCOVER_REQUEST,
  DISCOVER_TASKS,
  FEATURE_TASKS,
  discoverKeys,
  discoverName,
  discoverOff,
  discoverSettingsRequest,
  settingsPageOf,
  discoverSummary,
  discoverWhere,
  filterDiscover,
  REGISTRY_ENTRIES,
  taskCounts,
  type DiscoverEntry
} from './discover'
import { FEATURES, featureById, type FeatureId } from './features'
import { setLanguage } from './i18n'
import { COMMANDS } from './keybindings'
import { defaultSettings } from './model'
import { categoryOfKey, resolveSettingsTarget } from './settings-catalog'
import { SETTINGS_PLACES } from './settings-path'

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

const ids = (entries: readonly DiscoverEntry[]): string[] => entries.map((entry) => entry.id)
const find = (id: string): DiscoverEntry => DISCOVER_ENTRIES.find((entry) => entry.id === id)!
const none = { query: '', task: 'all', level: 'all' } as const

describe('the tasks of the registry', () => {
  it('give every function of the registry a task, and name no function that is not in it', () => {
    const registry = FEATURES.map((feature) => feature.id).sort()
    expect(Object.keys(FEATURE_TASKS).sort()).toEqual(registry)
    for (const id of registry) expect(DISCOVER_TASKS, id).toContain(FEATURE_TASKS[id as FeatureId])
  })

  it('leave no task without a chosen card', () => {
    for (const task of DISCOVER_TASKS) expect(DISCOVER_ENTRIES.filter((entry) => entry.task === task).length, task).toBeGreaterThanOrEqual(1)
  })
})

describe('the chosen cards', () => {
  it('number about thirty, with one id each, a dozen of them for a beginner and the functions of the 21-22 November among them', () => {
    expect(DISCOVER_ENTRIES.length).toBeGreaterThanOrEqual(28)
    expect(DISCOVER_ENTRIES.length).toBeLessThanOrEqual(40)
    expect(new Set(ids(DISCOVER_ENTRIES)).size).toBe(DISCOVER_ENTRIES.length)
    expect(DISCOVER_ENTRIES.filter((entry) => entry.level === 'beginner').length).toBeGreaterThanOrEqual(10)
    for (const entry of DISCOVER_ENTRIES) expect(DISCOVER_LEVELS, entry.id).toContain(entry.level)
    const fresh = ids(DISCOVER_ENTRIES.filter((entry) => entry.isNew))
    for (const id of ['tab-reminders', 'focus-mode', 'page-text-search', 'scroll-memory', 'capture-full', 'markdown', 'totp', 'prefixes', 'permission-once', 'third-party-cookies', 'site-javascript', 'space-transfer', 'floating-video']) {
      expect(fresh, id).toContain(id)
    }
  })

  it('say a name, a line and where to find the function, in both languages, and say it in words of their own', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const entry of DISCOVER_ENTRIES) {
        for (const text of [discoverName(entry), discoverSummary(entry), discoverWhere(entry)]) {
          expect(text.length, `${entry.id} ${language}`).toBeGreaterThan(3)
          expect(text, `${entry.id} ${language}`).not.toMatch(/[{}]|undefined/)
        }
      }
    }
    setLanguage('en')
    expect(discoverName(find('capture-full'))).not.toBe(discoverName(find('capture-full')).toLowerCase())
    setLanguage('fr')
    expect(discoverName(find('markdown'))).toBe('Enregistrer la page en Markdown')
  })

  it('take the name and the line of a function of the registry from the registry, unless the card has its own', () => {
    const notes = find('notes')
    expect(notes.feature).toBe('notes')
    expect(discoverName(notes)).toBe(featureById('notes').label)
    expect(discoverName(find('capture-full'))).not.toBe('')
    expect(find('capture-full').feature).toBeUndefined()
  })

  it('give every card words to be found by, in French and in English', () => {
    for (const entry of DISCOVER_ENTRIES) expect(entry.keywords.trim().split(/\s+/).length, entry.id).toBeGreaterThanOrEqual(4)
    expect(find('bookmarks').keywords).toMatch(/signets/)
    expect(find('bookmarks').keywords).toMatch(/bookmarks/)
    expect(find('totp').keywords).toMatch(/2fa/)
  })

  it('file a card of the registry under the task of the registry', () => {
    for (const entry of DISCOVER_ENTRIES) if (entry.feature) expect(entry.task, entry.id).toBe(FEATURE_TASKS[entry.feature])
  })

  it('name a function that exists in the registry', () => {
    for (const entry of DISCOVER_ENTRIES) if (entry.feature) expect(() => featureById(entry.feature!), entry.id).not.toThrow()
    for (const entry of DISCOVER_ENTRIES) if (entry.feature) expect(featureById(entry.feature), entry.id).toBeDefined()
  })

  it('lead to a setting that exists, by the page the setting is drawn on', () => {
    for (const entry of DISCOVER_ENTRIES) {
      const request = discoverSettingsRequest(entry)
      expect(request.panel).toBe('settings')
      expect(resolveSettingsTarget(request.pane, request.anchor), entry.id).not.toBeNull()
    }
    const key = featureById('cookie-manager').key
    expect(discoverSettingsRequest(find('cookie-manager')).pane).toBe(categoryOfKey(key) ?? 'features')
    expect(discoverSettingsRequest(find('permission-once'))).toEqual({ panel: 'settings', pane: 'protection', anchor: 'permissions' })
  })

  it('send a setting no page draws to « Fonctions en option », and any other to its page', () => {
    expect(settingsPageOf('thisSettingDoesNotExist')).toBe('features')
    expect(settingsPageOf('blockThirdPartyCookies')).toBe(categoryOfKey('blockThirdPartyCookies'))
    expect(settingsPageOf('blockThirdPartyCookies')).not.toBe('features')
    for (const entry of REGISTRY_ENTRIES) expect(discoverSettingsRequest(entry).pane, entry.id).toBe(settingsPageOf(featureById(entry.feature!).key))
  })

  it('open only what the interface has: a panel, an API call it already makes, a page of the Settings, or nothing and say how', () => {
    const calls = new Set(DISCOVER_ENTRIES.flatMap((entry) => (entry.try.kind === 'call' ? [entry.try.call] : [])))
    expect([...calls].sort()).toEqual(['captureFullPage', 'newPrivateTab', 'saveMarkdown'])
    for (const entry of DISCOVER_ENTRIES) expect(['open', 'call', 'setting', 'hint'], entry.id).toContain(entry.try.kind)
    expect(find('command-bar').try).toEqual({ kind: 'open', request: { panel: 'commandbar', mode: 'new', initial: '' } })
    expect(find('tab-search').try).toEqual({ kind: 'open', request: { panel: 'commandbar', mode: 'tabs', initial: '' } })
    expect(find('prefixes').try).toEqual({ kind: 'open', request: { panel: 'commandbar', mode: 'new', initial: '* ' } })
    expect(find('mini-window').try).toEqual({ kind: 'open', request: { panel: 'commandbar', mode: 'little', initial: '' } })
    expect(find('split-view').try).toEqual({ kind: 'open', request: { panel: 'commandbar', mode: 'split', initial: '' } })
  })
})

describe('the shortcut of a card', () => {
  it('is a command that exists', () => {
    const known = new Set(COMMANDS.map((command) => command.id))
    for (const entry of DISCOVER_ENTRIES) if (entry.shortcut !== undefined) expect(known.has(entry.shortcut), entry.id).toBe(true)
  })

  it('is read from the shortcuts in force: the default, the one the person gave, none when it was taken off, and the keys of the system', () => {
    const capture = find('capture')
    expect(capture.shortcut).toBe('captureRegion')
    expect(discoverKeys(capture, {}, 'darwin')).toEqual({ keys: ['⇧', '⌘', '2'], text: '⇧⌘2' })
    expect(discoverKeys(capture, { captureRegion: 'CmdOrCtrl+Alt+9' }, 'darwin')).toEqual({ keys: ['⌥', '⌘', '9'], text: '⌥⌘9' })
    expect(discoverKeys(capture, { captureRegion: '' }, 'darwin')).toBeNull()
    expect(discoverKeys(capture, {}, 'win32')?.text).toBe('Ctrl+Maj+2')
  })

  it('is null for a card with no command, and for a command nothing is bound to by default', () => {
    expect(find('prefixes').shortcut).toBeUndefined()
    expect(discoverKeys(find('prefixes'), {}, 'darwin')).toBeNull()
    expect(find('markdown').shortcut).toBe('saveMarkdown')
    expect(discoverKeys(find('markdown'), {}, 'darwin')).toBeNull()
    expect(discoverKeys(find('markdown'), { saveMarkdown: 'CmdOrCtrl+Alt+M' }, 'darwin')?.text).toBe('⌥⌘M')
  })
})

describe('a card whose function is switched off', () => {
  it('says so by the setting it needs, and only for a card that needs one', () => {
    const settings = defaultSettings()
    expect(find('tab-reminders').needs).toBe('tabReminders')
    expect(discoverOff(find('tab-reminders'), { ...settings, tabReminders: false })).toBe(true)
    expect(discoverOff(find('tab-reminders'), { ...settings, tabReminders: true })).toBe(false)
    expect(discoverOff(find('command-bar'), { ...settings })).toBe(false)
  })
})

describe('the search', () => {
  it('shows every card for no words, and every card of a task and a level for the filters', () => {
    expect(ids(filterDiscover(none))).toEqual(ids(ALL_DISCOVER_ENTRIES))
    expect(ids(filterDiscover({ ...none, task: 'keep' }))).toEqual(ids(ALL_DISCOVER_ENTRIES.filter((entry) => entry.task === 'keep')))
    expect(ids(filterDiscover({ ...none, level: 'beginner' }))).toEqual(ids(ALL_DISCOVER_ENTRIES.filter((entry) => entry.level === 'beginner')))
    const both = filterDiscover({ ...none, task: 'keep', level: 'advanced' })
    expect(both.length).toBeGreaterThan(0)
    expect(both.every((entry) => entry.task === 'keep' && entry.level === 'advanced')).toBe(true)
  })

  it('understands the words of everyday in French and in English, accents and case aside', () => {
    expect(ids(filterDiscover({ ...none, query: 'marque-pages' }))).toContain('bookmarks')
    expect(ids(filterDiscover({ ...none, query: 'BOOKMARKS' }))).toContain('bookmarks')
    expect(ids(filterDiscover({ ...none, query: 'double authentification' }))).toContain('totp')
    expect(ids(filterDiscover({ ...none, query: '2FA' }))).toContain('totp')
    expect(ids(filterDiscover({ ...none, query: 'screenshot' }))).toContain('capture')
    expect(ids(filterDiscover({ ...none, query: 'concentration' }))).toContain('focus-mode')
    expect(ids(filterDiscover({ ...none, query: 'concentré' }))).toContain('focus-mode')
    expect(ids(filterDiscover({ ...none, query: 'rappel' }))).toContain('tab-reminders')
    expect(ids(filterDiscover({ ...none, query: 'recette' }))).not.toContain('totp')
  })

  it('wants every word, in any order, and finds a word in the name, the line, the place or the keywords', () => {
    expect(ids(filterDiscover({ ...none, query: 'page entière capture' }))).toContain('capture-full')
    expect(ids(filterDiscover({ ...none, query: 'capture bookmarks' }))).toEqual([])
    expect(ids(filterDiscover({ ...none, query: 'xyzzy' }))).toEqual([])
  })

  it('combines the words with the filters', () => {
    expect(ids(filterDiscover({ query: 'capture', task: 'protect', level: 'all' }))).toEqual([])
    expect(ids(filterDiscover({ query: 'capture', task: 'keep', level: 'beginner' }))).toContain('capture')
    expect(ids(filterDiscover({ query: 'capture', task: 'keep', level: 'beginner' }))).not.toContain('capture-full')
  })

  it('searches in the language of the interface too', () => {
    setLanguage('en')
    expect(ids(filterDiscover({ ...none, query: 'reminder' }))).toContain('tab-reminders')
    expect(ids(filterDiscover({ ...none, query: 'one-time codes' }))).toContain('totp')
  })

  it('counts the cards of each task, for the chips', () => {
    const counts = taskCounts(ALL_DISCOVER_ENTRIES)
    expect(counts.all).toBe(ALL_DISCOVER_ENTRIES.length)
    for (const task of DISCOVER_TASKS) expect(counts[task]).toBe(ALL_DISCOVER_ENTRIES.filter((entry) => entry.task === task).length)
    expect(taskCounts(filterDiscover({ ...none, level: 'beginner' })).all).toBe(ALL_DISCOVER_ENTRIES.filter((entry) => entry.level === 'beginner').length)
  })
})

describe('a card for every function', () => {
  it('has one card for each function of the registry: a function added to the registry without one fails here', () => {
    for (const feature of FEATURES) {
      const cards = ALL_DISCOVER_ENTRIES.filter((entry) => entry.feature === feature.id)
      expect(cards.length, `${feature.id} has no card`).toBe(1)
    }
  })

  it('has no card that names a function the registry does not know, and no id twice', () => {
    const registry = new Set<string>(FEATURES.map((feature) => feature.id))
    for (const entry of ALL_DISCOVER_ENTRIES) if (entry.feature !== undefined) expect(registry.has(entry.feature), entry.id).toBe(true)
    expect(new Set(ids(ALL_DISCOVER_ENTRIES)).size).toBe(ALL_DISCOVER_ENTRIES.length)
  })

  it('keeps the chosen cards first under their task, then the functions without a switch, then the rest of the registry', () => {
    expect(ids(ALL_DISCOVER_ENTRIES)).toEqual([...ids(DISCOVER_ENTRIES), ...ids(DISCOVER_EXTRAS), ...ids(REGISTRY_ENTRIES)])
    for (const task of DISCOVER_TASKS) {
      const kinds = ALL_DISCOVER_ENTRIES.filter((entry) => entry.task === task).map((entry) => (DISCOVER_ENTRIES.includes(entry) ? 0 : DISCOVER_EXTRAS.includes(entry) ? 1 : 2))
      expect(kinds, task).toEqual([...kinds].sort())
    }
  })

  it('says its name, its line and where to find it, in both languages, for the cards the registry lends its words to', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const entry of REGISTRY_ENTRIES) {
        expect(discoverName(entry), `${entry.id} ${language}`).toBe(featureById(entry.feature!).label)
        expect(discoverSummary(entry).length, `${entry.id} ${language}`).toBeGreaterThan(3)
        expect(discoverWhere(entry), `${entry.id} ${language}`).toMatch(/Réglages|Settings/)
        expect(discoverWhere(entry), `${entry.id} ${language}`).not.toMatch(/[{}]|undefined/)
      }
    }
  })

  it('leads « Régler » of each of them to the page that draws its setting, and files each under the task of the registry', () => {
    expect(REGISTRY_ENTRIES.length).toBeGreaterThan(50)
    for (const entry of REGISTRY_ENTRIES) {
      expect(entry.task, entry.id).toBe(FEATURE_TASKS[entry.feature!])
      expect(discoverSettingsRequest(entry).pane, entry.id).toBe(settingsPageOf(featureById(entry.feature!).key))
      expect(entry.try, entry.id).toEqual({ kind: 'setting' })
    }
  })

  it('says it is switched off from the switch of the function, when the card has no setting of its own to name', () => {
    const settings = defaultSettings()
    const card = REGISTRY_ENTRIES.find((entry) => entry.feature === 'warn-quit')!
    expect(discoverOff(card, { ...settings, warnBeforeQuitting: false })).toBe(true)
    expect(discoverOff(card, { ...settings, warnBeforeQuitting: true })).toBe(false)
  })

  it('finds a function of the registry by its name, and by the page of the Settings that holds it', () => {
    expect(ids(filterDiscover({ ...none, query: 'publicités' }))).toContain('registry-block-ads')
    expect(ids(filterDiscover({ ...none, query: 'xyzzy' }))).toEqual([])
    expect(ids(filterDiscover({ ...none, task: 'protect' })).filter((id) => id.startsWith('registry-')).length).toBe(REGISTRY_ENTRIES.filter((entry) => entry.task === 'protect').length)
    expect(ids(filterDiscover({ ...none, level: 'beginner' })).filter((id) => id.startsWith('registry-'))).toEqual([])
  })

  it('counts every card in the chips: the total is the number of functions the panel says', () => {
    const counts = taskCounts(ALL_DISCOVER_ENTRIES)
    expect(counts.all).toBe(ALL_DISCOVER_ENTRIES.length)
    expect(counts.all).toBeGreaterThanOrEqual(FEATURES.length)
    expect(DISCOVER_TASKS.reduce((sum, task) => sum + counts[task], 0)).toBe(counts.all)
  })
})

describe('the functions without a switch', () => {
  it('number a score and more, each with words in both languages, a name, a line and a place', () => {
    expect(DISCOVER_EXTRAS.length).toBe(37)
    expect(ALL_DISCOVER_ENTRIES.length).toBe(168)
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const entry of DISCOVER_EXTRAS) {
        for (const text of [discoverName(entry), discoverSummary(entry), discoverWhere(entry)]) {
          expect(text.length, `${entry.id} ${language}`).toBeGreaterThan(3)
          expect(text, `${entry.id} ${language}`).not.toMatch(/[{}]|undefined/)
        }
      }
    }
    for (const entry of DISCOVER_EXTRAS) expect(entry.keywords.trim().split(/\s+/).length, entry.id).toBeGreaterThanOrEqual(4)
  })

  it('name what docs/fonctions.md lists as without a switch, and what the menus hold', () => {
    const wanted = ['reader-mode', 'auto-reload', 'task-manager', 'import-browser', 'clear-site-data', 'extensions-page', 'private-window', 'window-sidebar', 'move-to-window', 'move-tab', 'guided-setup', 'annotate-page', 'panel-size', 'glass-effect', 'drop-links', 'app-icon', 'presets', 'certificate-warning', 'developer-tools', 'page-summary', 'fake-fill', 'share-annotated-window', 'blank-window', 'site-searches', 'space-videos', 'annotate-bar-position', 'delete-profile', 'command-bar-preview']
    for (const id of wanted) expect(ids(DISCOVER_EXTRAS), id).toContain(id)
  })

  it('say where the eight functions added after the first review are, as the menus and the Settings name the place', () => {
    const where = (id: string): string => discoverWhere(DISCOVER_EXTRAS.find((entry) => entry.id === id)!)
    setLanguage('fr')
    expect(where('blank-window')).toBe('Menu Fichier › Fenêtre vierge.')
    expect(where('share-annotated-window')).toBe('Menu Fichier › Partager une fenêtre annotée.')
    expect(where('space-videos')).toBe('Menu Espaces › Modifier le thème.')
    expect(where('site-searches')).toContain('Réglages › Navigation › Recherches par mot-clé')
    expect(where('delete-profile')).toBe('Se règle dans Réglages › Profils.')
    expect(where('fake-fill')).toContain('Remplir avec de fausses données')
    expect(where('annotate-bar-position')).toContain('Menu Fichier › Annoter cette page')
    expect(where('command-bar-preview')).toContain('Réglages › Navigation')
    const pane = (id: string) => discoverSettingsRequest(DISCOVER_EXTRAS.find((entry) => entry.id === id)!).pane
    expect([pane('delete-profile'), pane('site-searches'), pane('command-bar-preview'), pane('space-videos')]).toEqual(['profiles', 'navigation', 'navigation', 'appearance'])
    setLanguage('en')
    expect(where('blank-window')).toBe('Menu File › Blank Window.')
    expect(where('delete-profile')).toContain('Settings › Profiles')
    setLanguage('fr')
  })

  it('show the keys of a shortcut that no command carries as they are, and of the others as they are set', () => {
    const annotate = DISCOVER_EXTRAS.find((entry) => entry.id === 'annotate-page')!
    expect(discoverKeys(annotate, {}, 'darwin')?.text).toBe('⌥⌘M')
    expect(discoverKeys(DISCOVER_EXTRAS.find((entry) => entry.id === 'history')!, { history: 'CmdOrCtrl+Alt+9' }, 'darwin')?.text).toBe('⌥⌘9')
  })

  it('lead to a setting that exists, and name a command that exists for the shortcut', () => {
    const known = new Set(COMMANDS.map((command) => command.id))
    for (const entry of DISCOVER_EXTRAS) {
      expect(resolveSettingsTarget(discoverSettingsRequest(entry).pane, discoverSettingsRequest(entry).anchor), entry.id).not.toBeNull()
      if (entry.shortcut !== undefined) expect(known.has(entry.shortcut), entry.id).toBe(true)
    }
  })
})

describe('the request of the panel', () => {
  it('is the panel `discover`', () => {
    expect(DISCOVER_REQUEST).toEqual({ panel: 'discover' })
  })

  it('names places of the Settings that the paths of the texts know', () => {
    expect(SETTINGS_PLACES.protection).toEqual({ page: 'protection' })
  })
})
