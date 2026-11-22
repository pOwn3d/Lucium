// The subpages of the Settings: the lists and the editors that a page names by one row (« Listes de filtres · 10 listes actives › ») and shows on a page
// of their own, with a way back to it. A subpage is a title, a way back, one line that says what it holds, and the list or the editor. Nothing on it is
// hidden without being said: the row that opens it stands for its settings (their dot when one is not at its default, their count in « Plus de
// réglages » when the row waits there), and the search and « Réglages modifiés » draw its rows where they would draw any other (the window opens the
// subpage to land on one). This file is the map; the panes draw the row (`SubpageEntry`) and the content (`Subpage`) where they belong.
//
// Pure: nothing here reads the window. The words are keys of the catalogues, read when the window draws.

import { t, tp, type MessageKey } from './i18n'
import type { SettingsPage, SettingsSubpage } from './ipc'
import type { PermissionDecision, Settings } from './model'
import type { SettingKey } from './settings-catalog'
import type { RowPlacement } from './settings-placement'
import { activeLists, FILTER_LISTS } from './filter-lists'
import { adsBlockingOn } from './blocker'
import { sitesWithAnswers } from './permissions'

export interface SettingsSubpageDef {
  id: SettingsSubpage
  /** The page whose row opens it, and that the way back leads to. */
  pane: SettingsPage
  /** Its name: the title of the subpage and the label of the row that opens it. */
  title: MessageKey
  /** One line under the title: what it holds, and where else it is filled. */
  intro: MessageKey
  /** The settings it holds, which the row that opens it stands for. A subpage of no setting (the scripts, which the main process keeps) has none. */
  keys: readonly SettingKey[]
  /** Where the row that opens it is drawn on its page: at the top, or in « Plus de réglages » with the group it belongs to. */
  at: RowPlacement
}

/** In the order of the sidebar, then of the page. */
export const SUBPAGES: readonly SettingsSubpageDef[] = [
  { id: 'contrast', pane: 'appearance', title: 'settings.sub-contrast', intro: 'settings.sub-contrast-intro', keys: ['siteReadableMode'], at: 'page' },
  { id: 'awake', pane: 'tabs', title: 'settings.sub-awake', intro: 'settings.sub-awake-intro', keys: ['sleepExcludedHosts', 'sleepExcludedKeepAll'], at: 'page' },
  { id: 'sitesearches', pane: 'navigation', title: 'settings.sub-sitesearches', intro: 'settings.sub-sitesearches-intro', keys: ['siteSearches'], at: 'page' },
  { id: 'linkroutes', pane: 'navigation', title: 'settings.choisissez-ou-les-liens-s-ouvrent-dans', intro: 'settings.sub-linkroutes-intro', keys: ['linkRoutes'], at: 'page' },
  { id: 'exceptions', pane: 'protection', title: 'settings.sub-exceptions', intro: 'settings.sub-exceptions-intro', keys: ['blockExceptions', 'popupExceptions', 'fingerprintExceptions', 'thirdPartyCookieExceptions', 'unwrapExceptions', 'safeBrowsingExceptions', 'httpsOnlyExceptions'], at: 'page' },
  { id: 'clearonclose', pane: 'protection', title: 'settings.sub-clearonclose', intro: 'settings.sub-clearonclose-intro', keys: ['siteDataClearOnCloseEnabled', 'siteDataClearOnClose', 'siteDataClearOnQuit', 'siteDataClearOnQuitAll', 'clearAllKeepHosts'], at: 'page' },
  { id: 'permissions', pane: 'protection', title: 'settings.sub-permissions', intro: 'settings.sub-permissions-intro', keys: ['siteAutoplay'], at: 'page' },
  { id: 'lockoptions', pane: 'protection', title: 'settings.sub-lockoptions', intro: 'settings.sub-lockoptions-intro', keys: ['lockApp', 'lockTouchId', 'lockPrivateIdle', 'lockedSpaces'], at: 'page' },
  { id: 'filterlists', pane: 'protection', title: 'feature.listes-de-filtres', intro: 'settings.sub-filterlists-intro', keys: ['disabledFilterLists', 'filterUpdateDays', 'customFilterListsEnabled', 'customFilterLists'], at: 'page' },
  { id: 'network', pane: 'protection', title: 'settings.sub-network', intro: 'settings.sub-network-intro', keys: ['dohCustom', 'dohMode', 'dohProvider', 'dohCustomUrl', 'proxyEnabled', 'proxy'], at: 'page' },
  { id: 'extensionfolders', pane: 'tools', title: 'settings.sub-extensionfolders', intro: 'settings.sub-extensionfolders-intro', keys: ['extensionPaths'], at: 'page' },
  { id: 'translatelists', pane: 'tools', title: 'settings.sub-translatelists', intro: 'settings.sub-translatelists-intro', keys: ['translateAlways', 'translateNeverSites'], at: 'page' },
  { id: 'shortcuts', pane: 'keyboard', title: 'settings.section-raccourcis-clavier', intro: 'settings.sub-shortcuts-intro', keys: ['keyBindings'], at: 'page' },
  { id: 'siteexclusions', pane: 'keyboard', title: 'settings.sub-siteexclusions', intro: 'settings.sub-siteexclusions-intro', keys: ['mouseGestureExcludedHosts', 'vimKeysExcludedHosts'], at: 'page' },
  { id: 'containers', pane: 'features', title: 'settings.sub-containers-title', intro: 'settings.sub-containers-intro', keys: ['containers', 'containerRules'], at: 'page' },
  { id: 'userscripts', pane: 'features', title: 'settings.sub-userscripts', intro: 'settings.sub-userscripts-intro', keys: [], at: 'page' },
  { id: 'focus', pane: 'features', title: 'focus.subpage-title', intro: 'focus.subpage-intro', keys: ['focusSites', 'focusScheduleOn', 'focusDays', 'focusFrom', 'focusTo', 'focusMinutes'], at: 'page' },
  { id: 'pagewatches', pane: 'features', title: 'web-tools-settings.pages-surveillees', intro: 'settings.sub-pagewatches-intro', keys: ['pageWatches'], at: 'page' },
  // The synchronisation with the iPhone is kept by the main process (src/main/sync/), not in the settings: the row that opens it says its state itself (`syncSummary`).
  { id: 'sync', pane: 'files', title: 'settings.sub-sync', intro: 'settings.sub-sync-intro', keys: [], at: 'page' }
]

export const subpageById = (id: SettingsSubpage): SettingsSubpageDef => SUBPAGES.find((subpage) => subpage.id === id)!

/** The subpage an address shows: its anchor when that names a subpage of its page, else none (the page itself). */
export const subpageAt = (pane: SettingsPage, anchor: string | undefined): SettingsSubpage | null => {
  const found = SUBPAGES.find((subpage) => subpage.id === anchor)
  return found !== undefined && found.pane === pane ? found.id : null
}

/** The subpage that holds the row of a setting, if any: a result of the search that names it opens that subpage. */
export const subpageOfKey = (key: string): SettingsSubpageDef | undefined => SUBPAGES.find((subpage) => (subpage.keys as readonly string[]).includes(key))

/** The name of a subpage, in the language of the interface. */
export const subpageTitle = (id: SettingsSubpage): string => t(subpageById(id).title)

// ---------- what the row that opens a subpage says of it ----------

/** What the state of a subpage is read from: the settings, the answers given to the sites, and the spaces the lock guards. */
export interface SubpageFacts {
  settings: Settings
  sitePermissions?: Readonly<Record<string, Readonly<Record<string, PermissionDecision>>>>
}

/** "Aucun site", "1 site", "3 sites". */
const sites = (count: number): string => (count === 0 ? t('settings.sub-no-site') : tp('settings.sub-sites', count))
const distinct = (...lists: ReadonlyArray<readonly string[]>): number => new Set(lists.flat()).size
const rules = (count: number): string => (count === 0 ? t('settings.sub-no-rule') : tp('settings.sub-rules', count))

/** The lists the blocker uses: the shipped ones of a kind that is on and not switched off one by one, and the lists brought by the user while the ads are blocked. */
export function activeFilterListCount(settings: Settings): number {
  const ads = adsBlockingOn(settings)
  const shipped = activeLists(FILTER_LISTS, { ads, cookieBanners: settings.blockCookieBanners, disabledLists: settings.disabledFilterLists }).length
  const own = ads && settings.customFilterListsEnabled ? settings.customFilterLists.filter((list) => list.enabled).length : 0
  return shipped + own
}

/** The sites a permission or an autoplay of their own was remembered for, by host. */
function rememberedSites(facts: SubpageFacts): number {
  const origins = sitesWithAnswers((facts.sitePermissions ?? {}) as Record<string, Record<string, PermissionDecision>>).map(([origin]) => origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, ''))
  return distinct(origins, Object.keys(facts.settings.siteAutoplay))
}

/** The state the row of a subpage says, right of its name: a count of what the list holds, or what the settings it holds amount to. */
export function subpageSummary(id: SettingsSubpage, facts: SubpageFacts): string {
  const { settings } = facts
  switch (id) {
    case 'contrast':
      return sites(Object.keys(settings.siteReadableMode).length)
    case 'awake':
      return sites(settings.sleepExcludedHosts.length)
    case 'containers':
      return settings.containers.length === 0 ? t('settings.sub-no-container') : tp('settings.sub-containers', settings.containers.length)
    case 'sitesearches':
      return settings.siteSearches.length === 0 ? t('settings.sub-no-keyword') : tp('settings.sub-keywords', settings.siteSearches.length)
    case 'linkroutes':
      return rules(settings.linkRoutes.length)
    case 'exceptions':
      return sites(distinct(settings.blockExceptions, settings.popupExceptions, settings.fingerprintExceptions, settings.thirdPartyCookieExceptions, settings.unwrapExceptions, settings.safeBrowsingExceptions, settings.httpsOnlyExceptions))
    case 'clearonclose':
      return settings.siteDataClearOnCloseEnabled ? sites(settings.siteDataClearOnClose.length) : t('settings.sub-off')
    case 'permissions': {
      const count = rememberedSites(facts)
      return count === 0 ? t('settings.sub-no-permission') : tp('settings.sub-sites', count)
    }
    case 'lockoptions':
      return settings.lockApp ? t('settings.sub-lock-app') : t('settings.sub-lock-on')
    case 'filterlists': {
      const count = activeFilterListCount(settings)
      return count === 0 ? t('settings.sub-no-list') : tp('settings.sub-lists', count)
    }
    case 'network':
      return settings.dohCustom && settings.proxyEnabled ? t('settings.sub-network-both') : settings.dohCustom ? t('settings.sub-network-dns') : settings.proxyEnabled ? t('settings.sub-network-proxy') : t('settings.sub-network-auto')
    case 'extensionfolders':
      return settings.extensionPaths.length === 0 ? t('settings.sub-no-folder') : tp('settings.sub-folders', settings.extensionPaths.length)
    case 'translatelists':
      return rules(settings.translateAlways.length + settings.translateNeverSites.length)
    case 'userscripts':
      // The scripts live in the main process: the pane that draws the row counts them (`scriptsSummary`).
      return ''
    case 'sync':
      // The synchronisation lives in the main process too: the row is drawn with its state (`syncSummary`).
      return ''
    case 'focus':
      return sites(settings.focusSites.length)
    case 'pagewatches':
      return settings.pageWatches.length === 0 ? t('settings.sub-no-page') : tp('settings.sub-pages', settings.pageWatches.length)
    case 'shortcuts': {
      const changed = Object.keys(settings.keyBindings).length
      return changed === 0 ? t('settings.sub-shortcuts-default') : tp('settings.sub-shortcuts-changed', changed)
    }
    case 'siteexclusions':
      return sites(distinct(settings.mouseGestureExcludedHosts, settings.vimKeysExcludedHosts))
  }
}

/** What the row of the scripts says: how many were imported. */
export const scriptsSummary = (count: number): string => (count === 0 ? t('settings.sub-no-script') : tp('settings.sub-scripts', count))

/** What the row of the synchronisation says of it: off, or how many devices are paired and whether this Mac is listening for them. */
export function syncSummary(status: { enabled: boolean; devices: number; listening: boolean }): string {
  if (!status.enabled) return t('sync.state-off')
  const devices = status.devices === 0 ? t('sync.state-none') : tp('sync.state-devices', status.devices)
  return status.listening ? `${devices} · ${t('sync.state-listening')}` : devices
}
