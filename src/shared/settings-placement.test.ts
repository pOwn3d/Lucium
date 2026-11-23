// Where the rows of the Settings are drawn: the table of the rows at the top of their page names real settings that have a row, the rest waits in the
// fold « Plus de réglages » of its page.

import { describe, expect, it } from 'vitest'
import { SETTINGS_PAGES, type SettingsPage } from './ipc'
import { defaultSettings } from './model'
import { NO_CONTROL_KEYS, SETTINGS_KEYS, categoryOfKey, type SettingKey } from './settings-catalog'
import { PAGE_KEYS, placementOf } from './settings-placement'
import { subpageOfKey } from './settings-subpages'
import { createInitialState, parseSavedState } from './sidebar'

/** The keys of `keys` that wait in « Plus de réglages » (a key on a subpage is on its subpage, wherever the row that opens it is). */
const foldedKeys = (keys: readonly SettingKey[]): SettingKey[] => keys.filter((key) => subpageOfKey(key) === undefined && placementOf(key) === 'more')
/** The keys of `keys` that live on a subpage (shared/settings-subpages.ts). */
const subpageKeys = (keys: readonly SettingKey[]): SettingKey[] => keys.filter((key) => subpageOfKey(key) !== undefined)

describe('the rows at the top of their page', () => {
  it('are settings that exist and have a row (a key that left the model or lost its row would put a row in the wrong place silently)', () => {
    const known = new Set(Object.keys(defaultSettings()))
    for (const key of PAGE_KEYS) {
      expect(known.has(key), key).toBe(true)
      expect(key in NO_CONTROL_KEYS, key).toBe(false)
      expect(categoryOfKey(key), key).not.toBeNull()
    }
  })

  it('are a few a page, chosen by a decision: the table, category by category', () => {
    const byPane = Object.fromEntries(SETTINGS_PAGES.map((pane) => [pane, (SETTINGS_KEYS[pane] as readonly SettingKey[]).filter((key) => PAGE_KEYS.has(key))]))
    expect(byPane).toEqual({
      home: ['language', 'interfaceTranslated'],
      appearance: ['uiScale', 'interfaceAppearance', 'sidebarRight', 'compactMode', 'websiteAppearance', 'readableMode'],
      tabs: ['sleepAfterMinutes', 'autoArchiveHours', 'restoreWindows', 'warnBeforeClosingWindow', 'warnBeforeQuitting'],
      navigation: ['searchUrlTemplate', 'searchSuggestions', 'commandBarSize', 'externalLinksInLittleArc', 'modifiedClickBackground'],
      protection: ['blockAds', 'blockCookieBanners', 'stripTrackingParams', 'reduceFingerprint', 'historyOff', 'autoplayPolicy', 'lockEnabled', 'passwordManager'],
      files: ['downloadAskWhere', 'autoBackup'],
      tools: ['boostsEnabled', 'translateLocal', 'translateTarget'],
      keyboard: ['littleArcShortcut', 'annotateGlobalShortcut', 'mouseGestures', 'autoScroll', 'spaceSwipe', 'keyBindings', 'tabCycleRecent'],
      profiles: ['profileNames', 'profiles'],
      // The catalogue is drawn whole: every line of it at the top, and no fold.
      features: [...SETTINGS_KEYS.features],
      about: ['autoUpdate', 'windowsAutoUpdate', 'whatsNewSheet', 'appIcon']
    })
    // The variants of a setting, the regular expressions, the measures, what is right by default: in the fold.
    for (const key of ['forceReduceMotion', 'blockScriptlets', 'blockMode', 'panelSizes', 'webStoreInstall'] as const) {
      expect(placementOf(key), key).toBe('more')
    }
    // The lists, the DNS, the proxy, the options of the lock: on a subpage, said where the row that opens it is (at the top of these pages).
    for (const key of ['sleepExcludedHosts', 'siteSearches', 'customFilterLists', 'dohCustom', 'proxyEnabled', 'lockApp'] as const) {
      expect(subpageOfKey(key), key).toBeDefined()
      expect(placementOf(key), key).toBe(subpageOfKey(key)!.at)
      expect(placementOf(key), key).toBe('page')
    }
    // The subpages of « Fonctions en option » (the containers, the pages watched) are said by a row under the line of their feature, at the top.
    expect(subpageOfKey('pageWatches')?.pane).toBe('features')
    expect(placementOf('pageWatches')).toBe('page')
    expect(placementOf('containerRules')).toBe('page')
    // What a preset writes waits under it (shared/settings-presets.ts), but the setting its row stands for and, for the level of protection, the four
    // switches drawn under it.
    for (const key of ['stripCopiedLinks', 'sendGpc', 'blockMode', 'blockCosmetic', 'blockScriptlets', 'loadAllTabsAtLaunch', 'littleArcNewTabLinks', 'sleepAwakeMax'] as const) {
      expect(placementOf(key), key).toBe('more')
    }
  })

  it('leave every page with something at its top, and split each page in two without losing a key', () => {
    // A page that loses its last row at the top must be named here, and the decision is the maintainer's.
    const withoutTop: readonly SettingsPage[] = []
    for (const pane of SETTINGS_PAGES) {
      const keys = SETTINGS_KEYS[pane] as readonly SettingKey[]
      const top = keys.filter((key) => PAGE_KEYS.has(key))
      if (withoutTop.includes(pane)) expect(top, pane).toEqual([])
      else expect(top.length, pane).toBeGreaterThan(0)
      // Three places, each key in one: the top (a key of a subpage is there only by the row that opens it, drawn at the top), the fold, a subpage.
      expect(top.filter((key) => subpageOfKey(key) !== undefined && subpageOfKey(key)!.at !== 'page'), pane).toEqual([])
      expect(new Set([...top, ...foldedKeys(keys), ...subpageKeys(keys)]).size, pane).toBe(keys.length)
    }
    // Profils and « Fonctions en option » fold nothing: no « Plus de réglages » there.
    expect(foldedKeys(SETTINGS_KEYS.profiles)).toEqual([])
    expect(foldedKeys(SETTINGS_KEYS.features)).toEqual([])
    // The filter lists, the encrypted DNS and the proxy (in Vie privée et sécurité) are on two subpages, whose rows are at the top of the page.
    const listsAndNetwork = ['disabledFilterLists', 'filterUpdateDays', 'customFilterListsEnabled', 'customFilterLists', 'dohCustom', 'dohMode', 'dohProvider', 'dohCustomUrl', 'proxyEnabled', 'proxy'] as const
    expect(subpageKeys(listsAndNetwork)).toHaveLength(listsAndNetwork.length)
    expect(new Set(listsAndNetwork.map((key) => subpageOfKey(key)!.id))).toEqual(new Set(['filterlists', 'network']))
  })
})

// The level « Essentiel / Tous les réglages » is gone; a state file of an earlier version still holds the choice it kept.
describe('the level an earlier version kept in the state file', () => {
  const saved = (value: unknown): string => {
    const state = createInitialState({ now: 1, newId: () => 'id' })
    return JSON.stringify({ ...state, settings: { ...state.settings, showAdvancedSettings: value } })
  }

  it('loads, and is kept as the file says it: nothing rewrites it behind the person’s back', () => {
    expect(parseSavedState(saved(true)).settings.showAdvancedSettings).toBe(true)
    expect(parseSavedState(saved(false)).settings.showAdvancedSettings).toBe(false)
  })

  it('loads a damaged value as off, and a file without the key as off, without failing', () => {
    expect(parseSavedState(saved('oui')).settings.showAdvancedSettings).toBe(false)
    const state = createInitialState({ now: 1, newId: () => 'id' })
    const { showAdvancedSettings: _gone, ...settings } = state.settings
    expect(parseSavedState(JSON.stringify({ ...state, settings })).settings.showAdvancedSettings).toBe(false)
  })

  it('has no row and says why: the key is listed among the settings without a control, as deprecated', () => {
    expect(categoryOfKey('showAdvancedSettings')).toBeNull()
    expect(NO_CONTROL_KEYS.showAdvancedSettings).toMatch(/^deprecated/)
  })
})
