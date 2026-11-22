import { describe, expect, it } from 'vitest'
import { interfaceMayDispatch } from './ipc-policy'
import { SETTINGS_ANCHORS, SETTINGS_PAGES, SETTINGS_SUBPAGES } from './ipc'
import { SUBPAGES } from './settings-subpages'
import { LOCK_SETTING_KEYS } from './lock'
import { defaultSettings, type Settings } from './model'
import { PROTECTION_OF_EARLIER_PROFILES, PROTECTION_OF_NEW_PROFILES } from './model-defaults'
import { reduce, createInitialState } from './sidebar'
import { FEATURES, featureById, featureDefault } from './features'
import {
  ANCHOR_PANE,
  CATALOGUE_FEATURES,
  FEATURE_THEMES,
  KEPT_ON_RESET,
  PER_PROFILE_KEYS,
  SETTINGS_CATEGORIES,
  SETTINGS_KEYS,
  categoryOfKey,
  allModifiedKeys,
  categoryResetPlan,
  isModified,
  isResettable,
  modifiedKeys,
  resetPlanOf,
  resolveSettingsTarget,
  settingsAnchorLabel,
  settingsPaneLabel,
  settingsPaneShortLabel,
  type SettingKey
} from './settings-catalog'

const ctx = { now: 1, newId: () => 'id' }

/** A settings object with every key moved off its default (a flipped switch, a larger number, a longer text or list). */
function everythingChanged(): Settings {
  const defaults = defaultSettings() as unknown as Record<string, unknown>
  const changed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'boolean') changed[key] = !value
    else if (typeof value === 'number') changed[key] = value + 1
    else if (typeof value === 'string') changed[key] = `${value}x`
    else if (Array.isArray(value)) changed[key] = [...value, 'x']
    else if (typeof value === 'object' && value !== null) changed[key] = { ...value, x: 1 }
    else changed[key] = 'x'
  }
  return changed as unknown as Settings
}

describe('the categories', () => {
  it('are the 11 pages of the window, in order, each with a title and a blurb', () => {
    expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([...SETTINGS_PAGES])
    expect(new Set(SETTINGS_PAGES).size).toBe(11)
    for (const pane of SETTINGS_PAGES) expect(settingsPaneLabel(pane).length, pane).toBeGreaterThan(2)
  })

  it('name themselves by what one wants to do, as the proposal of the Settings does, and the sidebar shortens the long names', () => {
    expect(SETTINGS_PAGES.map((pane) => settingsPaneLabel(pane))).toEqual([
      'Pour commencer', 'Apparence', 'Onglets et fenêtres', 'Navigation', 'Vie privée et sécurité', 'Téléchargements et fichiers', 'Extensions et outils', 'Clavier et souris', 'Profils', 'Fonctions en option', 'À propos et mises à jour'
    ])
    expect(settingsPaneShortLabel('tabs')).toBe('Onglets et fenêtres')
    expect(settingsPaneShortLabel('protection')).toBe('Vie privée')
    expect(settingsPaneShortLabel('files')).toBe('Téléchargements')
    expect(settingsPaneShortLabel('about')).toBe('À propos')
    // `general`, the category of the previous layout, is named as the page it leads to.
    expect(settingsPaneLabel('general')).toBe('Pour commencer')
  })

  it('draw again in Profils, for the profile picked there, the few settings each profile keeps on its own, each placed in the category of what it does', () => {
    expect(Object.keys(PER_PROFILE_KEYS).sort()).toEqual(['autoArchiveHours', 'searchSuggestions', 'searchUrlTemplate'])
    for (const [key, pane] of Object.entries(PER_PROFILE_KEYS)) {
      expect(categoryOfKey(key), key).toBe(pane)
      expect(pane, key).not.toBe('profiles')
    }
  })
})

describe('where an old address leads (resolveSettingsTarget)', () => {
  it('keeps the pages, with the group of theirs a link names', () => {
    for (const pane of SETTINGS_PAGES) expect(resolveSettingsTarget(pane), pane).toEqual({ pane })
    expect(resolveSettingsTarget('protection', 'permissions')).toEqual({ pane: 'protection', anchor: 'permissions' })
    expect(resolveSettingsTarget('files', 'downloads')).toEqual({ pane: 'files', anchor: 'downloads' })
    expect(resolveSettingsTarget('keyboard', 'shortcuts')).toEqual({ pane: 'keyboard', anchor: 'shortcuts' })
    expect(resolveSettingsTarget('about', 'about')).toEqual({ pane: 'about', anchor: 'about' })
    expect(resolveSettingsTarget('home', 'guide')).toEqual({ pane: 'home', anchor: 'guide' })
  })

  it('leads the category « Général » of the previous layout, and its groups, to the pages that hold them now', () => {
    expect(resolveSettingsTarget('general')).toEqual({ pane: 'home' })
    expect(resolveSettingsTarget('general', 'guide')).toEqual({ pane: 'home', anchor: 'guide' })
    expect(resolveSettingsTarget('general', 'about')).toEqual({ pane: 'about', anchor: 'about' })
    expect(resolveSettingsTarget('general', 'icon')).toEqual({ pane: 'about', anchor: 'icon' })
    expect(resolveSettingsTarget('general', 'permissions')).toEqual({ pane: 'home' })
  })

  it('leads each of the old categories (the 14, then the 8 that followed them) to the one that holds its rows now', () => {
    expect(resolveSettingsTarget('tabs')).toEqual({ pane: 'tabs' })
    expect(resolveSettingsTarget('spaces')).toEqual({ pane: 'appearance' })
    expect(resolveSettingsTarget('links')).toEqual({ pane: 'navigation', anchor: 'links' })
    expect(resolveSettingsTarget('search')).toEqual({ pane: 'navigation', anchor: 'engine' })
    expect(resolveSettingsTarget('privacy')).toEqual({ pane: 'protection' })
    expect(resolveSettingsTarget('files')).toEqual({ pane: 'files' })
    expect(resolveSettingsTarget('extensions')).toEqual({ pane: 'tools', anchor: 'extensions' })
    expect(resolveSettingsTarget('profiles')).toEqual({ pane: 'profiles' })
    expect(resolveSettingsTarget('security')).toEqual({ pane: 'protection', anchor: 'lock' })
    expect(resolveSettingsTarget('shortcuts')).toEqual({ pane: 'keyboard', anchor: 'shortcuts' })
    expect(resolveSettingsTarget('tools')).toEqual({ pane: 'tools' })
    expect(resolveSettingsTarget('icon')).toEqual({ pane: 'about', anchor: 'icon' })
    expect(resolveSettingsTarget('about')).toEqual({ pane: 'about' })
    expect(resolveSettingsTarget('keyboard')).toEqual({ pane: 'keyboard' })
    // An old category given an anchor of its own time: the anchor is the new category's, or is dropped.
    expect(resolveSettingsTarget('security', 'permissions')).toEqual({ pane: 'protection', anchor: 'lock' })
  })

  it('leads the groups of the old Réglages › Vie privée and Navigation to the page that holds them now', () => {
    expect(resolveSettingsTarget('privacy', 'permissions')).toEqual({ pane: 'protection', anchor: 'permissions' })
    expect(resolveSettingsTarget('privacy', 'lock')).toEqual({ pane: 'protection', anchor: 'lock' })
    expect(resolveSettingsTarget('navigation')).toEqual({ pane: 'navigation' })
    expect(resolveSettingsTarget('navigation', 'engine')).toEqual({ pane: 'navigation', anchor: 'engine' })
    expect(resolveSettingsTarget('navigation', 'links')).toEqual({ pane: 'navigation', anchor: 'links' })
    // The shortcuts left Navigation for Clavier et souris: the address of before leads there.
    expect(resolveSettingsTarget('navigation', 'shortcuts')).toEqual({ pane: 'keyboard', anchor: 'shortcuts' })
    // A group of another category is dropped, as for any old pane.
    expect(resolveSettingsTarget('navigation', 'permissions')).toEqual({ pane: 'navigation' })
  })

  it('leads every place of the old Advanced pane to the page that holds it', () => {
    expect(resolveSettingsTarget('advanced', 'privacy')).toEqual({ pane: 'protection' })
    expect(resolveSettingsTarget('advanced', 'permissions')).toEqual({ pane: 'protection', anchor: 'permissions' })
    expect(resolveSettingsTarget('advanced', 'extensions')).toEqual({ pane: 'tools', anchor: 'extensions' })
    expect(resolveSettingsTarget('advanced', 'about')).toEqual({ pane: 'about', anchor: 'about' })
    expect(resolveSettingsTarget('advanced', 'downloads')).toEqual({ pane: 'files', anchor: 'downloads' })
  })

  it('leads "Avancé" alone to « Pour commencer », and "Fonctions" to « Fonctions en option »', () => {
    expect(resolveSettingsTarget('advanced')).toEqual({ pane: 'home' })
    expect(resolveSettingsTarget('features')).toEqual({ pane: 'features' })
  })

  it('drops a group that belongs to another page, and leads nowhere for what is not a place', () => {
    expect(resolveSettingsTarget('tabs', 'permissions')).toEqual({ pane: 'tabs' })
    expect(resolveSettingsTarget('privacy', 'downloads')).toEqual({ pane: 'protection' })
    for (const bad of ['', 'nowhere', '__proto__', 'constructor', 42, null, undefined]) expect(resolveSettingsTarget(bad), String(bad)).toBeNull()
    expect(resolveSettingsTarget('advanced', '__proto__')).toEqual({ pane: 'home' })
  })

  it('has a category, and a name, for each group or subpage a link can name', () => {
    for (const anchor of [...SETTINGS_ANCHORS, ...SETTINGS_SUBPAGES]) {
      expect(SETTINGS_PAGES, anchor).toContain(ANCHOR_PANE[anchor])
      expect(settingsAnchorLabel(anchor).length, anchor).toBeGreaterThan(2)
    }
    expect(Object.keys(ANCHOR_PANE).sort()).toEqual([...new Set([...SETTINGS_ANCHORS, ...SETTINGS_SUBPAGES])].sort())
    expect(settingsAnchorLabel('shortcuts')).toBe('Modifier les raccourcis clavier')
    expect(settingsAnchorLabel('lock')).toBe('Verrouillage')
    expect(settingsAnchorLabel('filterlists')).toBe('Listes de filtres')
  })

  it('leads the address of a subpage to its page with the subpage, and drops it when another page names it', () => {
    for (const subpage of SUBPAGES) expect(resolveSettingsTarget(subpage.pane, subpage.id), subpage.id).toEqual({ pane: subpage.pane, anchor: subpage.id })
    expect(resolveSettingsTarget('protection', 'filterlists')).toEqual({ pane: 'protection', anchor: 'filterlists' })
    expect(resolveSettingsTarget('tabs', 'filterlists')).toEqual({ pane: 'tabs' })
    expect(resolveSettingsTarget('protection', 'filterlist')).toEqual({ pane: 'protection' })
  })
})

// « Fonctions en option » (the proposal of the Settings, 12 November 2026): the features to add leave their categories for one catalogue; the other
// features of the registry stay in their category, as preferences.
describe('the catalogue of the features to add', () => {
  /**
   * The 27 features of the proposal, theme by theme, as the validated mock-up lists them, and two added after it: the window of document
   * Picture-in-Picture, and the work views (decided on 13 November 2026), with the tabs.
   */
  const LISTED = [
    'tab-tree', 'tab-reminders', 'tab-search', 'tab-groups-ext', 'reload-all-button', 'tab-memory', 'work-views',
    'web-panels', 'name-windows', 'independent-windows', 'pwa', 'document-pip',
    'containers', 'private-tabs', 'guest-profile',
    'bookmarks', 'live-folders', 'notes',
    'user-scripts', 'qr-code', 'read-aloud', 'page-watch', 'focus-mode', 'annotate-capture',
    'download-pause', 'open-unsaved', 'pdf-with-source',
    'find-regex', 'cookie-manager', 'shortcut-help', 'applescript'
  ]

  it('lists the 31 features to add, each once, theme by theme, each theme named in both languages', async () => {
    const { en } = await import('./i18n-en')
    const { fr } = await import('./i18n-fr')
    expect([...CATALOGUE_FEATURES]).toEqual(LISTED)
    expect(new Set(CATALOGUE_FEATURES).size).toBe(31)
    expect(FEATURE_THEMES.map((theme) => theme.id)).toEqual(['tabs', 'windows', 'separate', 'bookmarks', 'pages', 'files', 'search', 'privacy', 'keyboard', 'automation'])
    for (const theme of FEATURE_THEMES) {
      expect((fr as Record<string, string>)[theme.title], theme.title).toBeTruthy()
      expect((en as Record<string, string>)[theme.title], theme.title).toBeTruthy()
    }
  })

  it('takes the 48 settings there (the 31 switches, their options and their lists), and leaves the 81 other features in their category', () => {
    // The rows of annexes/correspondance.csv whose new place is « Fonctions en option »: 33 lines of the catalogue and 3 lists; then the switch of document
    // Picture-in-Picture, the one of the work views and the second button of the notes.
    const moved = [
      'webPanels', 'tabTree', 'tabSearch', 'tabGroupFolders', 'showReloadAllButton', 'reloadAllWakes', 'showTabMemory', 'nameWindows', 'independentWindows', 'tabContainers',
      'containers', 'containerRules', 'findRegex', 'webAppWindows', 'urlAutomation', 'shortcutHelp', 'cookieManager', 'privateTabs', 'guestProfile', 'downloadPause',
      'openUnsaved', 'pdfWithSource', 'bookmarkManager', 'liveFolders', 'notes', 'notesListButton', 'userScripts', 'qrCode', 'readAloud', 'pageWatch', 'pageWatches',
      'focusMode', 'focusSites', 'focusScheduleOn', 'focusDays', 'focusFrom', 'focusTo', 'focusMinutes',
      'annotateCapture', 'annotateAutoClear', 'annotateAutoClearSeconds', 'annotateLetterKeys', 'ollamaConfig', 'aiSummary', 'documentPictureInPicture', 'workViewsEnabled', 'tabReminders'
    ]
    expect([...SETTINGS_KEYS.features].sort()).toEqual([...moved].sort())
    for (const key of moved) expect(categoryOfKey(key), key).toBe('features')
    const listed = new Set<string>(CATALOGUE_FEATURES)
    for (const feature of FEATURES) {
      if (listed.has(feature.id)) expect(categoryOfKey(feature.key), feature.id).toBe('features')
      else expect(categoryOfKey(feature.key), feature.id).not.toBe('features')
    }
    expect(FEATURES.length - listed.size).toBe(82)
  })

  it('keeps the state each feature starts with: seven on, the others off', () => {
    const on = CATALOGUE_FEATURES.filter((id) => featureDefault(id))
    // The work views cost nothing until one is saved: on, as decided on 13 November 2026.
    // The tab reminders cost nothing until one is set (one timer, armed only while a reminder waits).
    expect(on).toEqual(['tab-reminders', 'tab-search', 'work-views', 'private-tabs', 'notes', 'cookie-manager', 'shortcut-help'])
    for (const id of CATALOGUE_FEATURES) expect(defaultSettings()[featureById(id).key], id).toBe(featureDefault(id))
  })
})

describe('"Rétablir" of a category', () => {
  it('has nothing to do while the category is as shipped', () => {
    for (const pane of SETTINGS_PAGES) {
      expect(categoryResetPlan(pane, defaultSettings()), pane).toBeNull()
      expect(modifiedKeys(pane, defaultSettings()), pane).toEqual([])
    }
  })

  it('puts back the settings that moved, and only those of the category, and keeps what it changed for "Annuler"', () => {
    const settings = { ...defaultSettings(), sleepMode: 'freeze', sleepNotify: true, blockAds: !defaultSettings().blockAds } as Settings
    const plan = categoryResetPlan('tabs', settings)!
    expect(plan.keys.sort()).toEqual(['sleepMode', 'sleepNotify'])
    expect(plan.patch).toEqual({ sleepMode: defaultSettings().sleepMode, sleepNotify: defaultSettings().sleepNotify })
    expect(plan.undo).toEqual({ sleepMode: 'freeze', sleepNotify: true })
    expect(categoryResetPlan('protection', settings)!.keys).toEqual(['blockAds'])
  })

  it('leaves the lists, the routes, the shortcuts and the lock alone, whatever moved', () => {
    const changed = everythingChanged()
    for (const pane of SETTINGS_PAGES) {
      const plan = categoryResetPlan(pane, changed)
      for (const key of plan?.keys ?? []) {
        expect(isResettable(key), `${pane}.${key}`).toBe(true)
        expect(key in KEPT_ON_RESET, `${pane}.${key}`).toBe(false)
      }
    }
    for (const key of [...LOCK_SETTING_KEYS, 'keyBindings', 'linkRoutes', 'siteSearches', 'blockExceptions', 'customFilterLists', 'containers', 'containerRules', 'extensionPaths', 'openWithApps', 'translateModelsDir'] as const) {
      expect(isResettable(key), key).toBe(false)
      expect(isModified(changed, key), key).toBe(false)
    }
  })

  it('writes a patch that the main process accepts, for every category, even with every setting moved', () => {
    const changed = everythingChanged()
    for (const pane of SETTINGS_PAGES) {
      const plan = categoryResetPlan(pane, changed)
      if (!plan) continue
      expect(interfaceMayDispatch({ type: 'settings/update', patch: plan.patch }, [], {}), `${pane} (reset)`).toBe(true)
      expect(interfaceMayDispatch({ type: 'settings/update', patch: plan.undo }, [], {}), `${pane} (undo)`).toBe(true)
    }
  })

  it('does what it says through the reducer: the category as shipped, then back as it was', () => {
    const start = createInitialState(ctx)
    const moved = reduce(start, { type: 'settings/update', patch: { sleepMode: 'freeze', sleepNotify: true, dragToSplit: !start.settings.dragToSplit, blockMode: 'strict', blockExceptions: ['a.example'] } }, ctx)
    const tabs = categoryResetPlan('tabs', moved.settings)!
    const reset = reduce(moved, { type: 'settings/update', patch: tabs.patch }, ctx)
    expect(modifiedKeys('tabs', reset.settings)).toEqual([])
    // Another category was not touched, nor the list of sites kept in it.
    expect(reset.settings.blockMode).toBe('strict')
    expect(reset.settings.blockExceptions).toEqual(['a.example'])
    const back = reduce(reset, { type: 'settings/update', patch: tabs.undo }, ctx)
    expect(back.settings).toEqual(moved.settings)
    // The reset of a category that has a list leaves the list, and a second reset has nothing left to do.
    const privacy = categoryResetPlan('protection', moved.settings)!
    expect(privacy.keys).toEqual(['blockMode'])
    expect(categoryResetPlan('protection', reduce(moved, { type: 'settings/update', patch: privacy.patch }, ctx).settings)).toBeNull()
  })

  it('counts a modified setting only when it can be put back', () => {
    const settings = { ...defaultSettings(), lockEnabled: true, keyBindings: { newTab: 'Ctrl+T' } } as Settings
    expect(modifiedKeys('protection', settings)).toEqual([])
    expect(modifiedKeys('navigation', settings)).toEqual([])
    expect(isModified({ ...defaultSettings(), uiScale: 120 } as Settings, 'uiScale' as SettingKey)).toBe(true)
  })

  it('names, in the map, only keys that exist (the types check it; this reads the defaults too)', () => {
    const keys = new Set(Object.keys(defaultSettings()))
    for (const pane of SETTINGS_PAGES) for (const key of SETTINGS_KEYS[pane]) expect(keys.has(key), `${pane}.${key}`).toBe(true)
    for (const key of Object.keys(KEPT_ON_RESET)) expect(keys.has(key), key).toBe(true)
  })
})

describe('« Rétablir » and the local model of the summary', () => {
  const typed = { enabled: true, url: 'http://127.0.0.1:11500', model: 'llama3.2', maxTokens: 400, temperature: 1.2 }

  it('puts back the switch and the sliders, and keeps the address and the model that were typed', () => {
    const defaults = defaultSettings()
    const plan = categoryResetPlan('features', { ...defaults, ollamaConfig: typed })!
    expect(plan.keys).toEqual(['ollamaConfig'])
    expect(plan.patch.ollamaConfig).toEqual({ ...defaults.ollamaConfig, url: typed.url, model: typed.model })
    // « Annuler » gives everything back.
    expect(plan.undo.ollamaConfig).toEqual(typed)
  })

  it('has nothing to put back when only the address and the model differ from the defaults', () => {
    const defaults = defaultSettings()
    const settings = { ...defaults, ollamaConfig: { ...defaults.ollamaConfig, url: typed.url, model: typed.model } }
    expect(isModified(settings, 'ollamaConfig')).toBe(false)
    expect(categoryResetPlan('features', settings)).toBeNull()
  })
})

describe('the protection a profile began with', () => {
  const PROTECTION = ['blockCookieBanners', 'sendGpc', 'stripTrackingParams', 'stripCopiedLinks'] as const
  // A profile made before « Renforcée » (its file names no baseline: sidebar-state.ts), and one made since, each at the protection it began with.
  const earlier = { ...defaultSettings(), ...PROTECTION_OF_EARLIER_PROFILES, protectionBaseline: 'standard' } as Settings
  const since = defaultSettings()

  it('marks nothing on a profile at the protection it began with, whichever it began with: not the category, not the sum, not a reset', () => {
    for (const settings of [earlier, since]) {
      expect(allModifiedKeys(settings), settings.protectionBaseline).toEqual([])
      expect(categoryResetPlan('protection', settings), settings.protectionBaseline).toBeNull()
      for (const key of PROTECTION) expect(isModified(settings, key), `${settings.protectionBaseline} ${key}`).toBe(false)
    }
  })

  it('does not count the protection of an earlier profile among the settings it changed, only what it did change', () => {
    const settings = { ...earlier, uiScale: 120 } as Settings
    expect(allModifiedKeys(settings)).toEqual(['uiScale'])
    expect(resetPlanOf(allModifiedKeys(settings), settings)?.patch).toEqual({ uiScale: defaultSettings().uiScale })
  })

  it('puts back to Standard what an earlier profile switched on, and to « Renforcée » what a profile made since switched off', () => {
    const switchedOn = { ...earlier, blockCookieBanners: true, sendGpc: true } as Settings
    expect(modifiedKeys('protection', switchedOn)).toEqual(['blockCookieBanners', 'sendGpc'])
    const plan = categoryResetPlan('protection', switchedOn)!
    expect(plan.patch).toEqual({ blockCookieBanners: false, sendGpc: false })
    expect(plan.undo).toEqual({ blockCookieBanners: true, sendGpc: true })
    expect(resetPlanOf(allModifiedKeys(switchedOn), switchedOn)?.patch).toEqual({ blockCookieBanners: false, sendGpc: false })

    const standardChosen = { ...since, ...PROTECTION_OF_EARLIER_PROFILES } as Settings
    expect(modifiedKeys('protection', standardChosen)).toEqual([...PROTECTION])
    expect(categoryResetPlan('protection', standardChosen)?.patch).toEqual(PROTECTION_OF_NEW_PROFILES)
    expect(resetPlanOf(allModifiedKeys(standardChosen), standardChosen)?.patch).toEqual(PROTECTION_OF_NEW_PROFILES)
  })

  it('is no setting a reset puts back: it never leaves a plan, and a plan through the reducer leaves it as it was', () => {
    expect(isResettable('protectionBaseline')).toBe(false)
    expect(isModified({ ...since, protectionBaseline: 'standard' } as Settings, 'protectionBaseline')).toBe(false)
    const start = createInitialState(ctx)
    const old = reduce(start, { type: 'settings/update', patch: { ...PROTECTION_OF_EARLIER_PROFILES, uiScale: 120 } }, ctx)
    const settings = { ...old.settings, protectionBaseline: 'standard' } as Settings
    const plan = resetPlanOf(allModifiedKeys(settings), settings)!
    expect(Object.keys(plan.patch)).not.toContain('protectionBaseline')
    const reset = reduce({ ...old, settings }, { type: 'settings/update', patch: plan.patch }, ctx)
    expect(reset.settings.protectionBaseline).toBe('standard')
    expect(allModifiedKeys(reset.settings)).toEqual([])
  })
})
