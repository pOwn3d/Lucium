// The way to a place of the Settings, as a text says it to send the reader there: « Réglages › Vie privée et sécurité › Verrouillage ». A path is never
// written by hand in the catalogues: a text says `{settingsPath}`, and the code gives it the path of a place of `SETTINGS_PLACES`, written from the map of the
// window (the name of the page in settings-catalog.ts, the fold « Plus de réglages » when the setting waits there, the title of the subpage in
// settings-subpages.ts, the title of the group). A page, a subpage or a group renamed, every text follows; a setting moved to another page, its path
// follows too. src/renderer/settings-paths.test.ts draws every page and checks that each place is where its path says, and refuses in the catalogues a
// path written by hand that leads nowhere.
//
// Pure: nothing here reads the window. The names are read in the language of the moment.

import { t, type MessageKey } from './i18n'
import type { SettingsPage } from './ipc'
import { categoryOfKey, settingsPaneLabel, type SettingKey } from './settings-catalog'
import { placementOf } from './settings-placement'
import { subpageOfKey } from './settings-subpages'

export interface SettingsPlace {
  /** The setting the text speaks of: its page, its subpage, and the fold when it waits there, are read from the map. */
  key?: SettingKey
  /** The page, for a place that is no setting (a group of buttons, a list, a page). */
  page?: SettingsPage
  /** For a place that is no setting: it waits in « Plus de réglages ». */
  fold?: boolean
  /** The title of the group it is in, as the window writes it (the same key of the catalogues). */
  group?: MessageKey
}

/** The places the texts send the reader to, by name. A text that needs another one adds it here: the test checks it on the window. */
export const SETTINGS_PLACES = {
  // The confirmation before quitting, and before closing a window
  quitWarning: { key: 'warnBeforeQuitting', group: 'settings.autres-reglages-des-fenetres' },
  // The icon of the application: said by the messages of the release scripts (main/verify-app.ts, main/publish-update.ts), which are plain Node and say it in English
  appIcon: { key: 'appIcon', group: 'settings.icone-de-l-application' },
  // The state of Lucium: its log of errors, its report
  engineStatus: { page: 'about', fold: true, group: 'engine-status.etat-d-lucium' },
  minimumFontSize: { key: 'minimumFontSize', group: 'settings.accessibilite' },
  archive: { key: 'autoArchiveHours', group: 'settings.archivage-et-organisation' },
  sleep: { key: 'sleepAfterMinutes', group: 'settings.mise-en-veille' },
  language: { key: 'language', group: 'lang.langue' },
  extensions: { page: 'tools', group: 'settings.extensions' },
  webStoreInstall: { key: 'webStoreInstall', group: 'settings.extensions' },
  extensionDataApis: { key: 'extensionDataApis', group: 'settings.extensions' },
  extensionTabCapture: { key: 'extensionTabCapture', group: 'settings.extensions' },
  boostSharing: { key: 'boostSharing', group: 'boost-share-settings.partage-des-retouches' },
  boostScriptImport: { key: 'boostScriptImport', group: 'boost-share-settings.partage-des-retouches' },
  translate: { key: 'translateLocal', group: 'translate.settings-title' },
  translateSystem: { key: 'translateSystemEngine', group: 'translate.settings-title' },
  filterLists: { key: 'disabledFilterLists' },
  customFilterLists: { key: 'customFilterListsEnabled' },
  proxy: { key: 'proxyEnabled' },
  siteExceptions: { key: 'fingerprintExceptions' },
  safeBrowsing: { key: 'safeBrowsing', group: 'privacy-settings.navigation-sure' },
  thirdPartyCookies: { key: 'blockThirdPartyCookies', group: 'privacy-settings.cookies-tiers' },
  redirectBypass: { key: 'unwrapRedirects', group: 'privacy-settings.confidentialite-renforcee' },
  blockPings: { key: 'blockPings', group: 'privacy-settings.protection-du-reseau' },
  trimReferer: { key: 'trimReferer', group: 'privacy-settings.protection-du-reseau' },
  httpsOnly: { key: 'httpsOnly', group: 'privacy-settings.protection-du-reseau' },
  clearOnClose: { key: 'siteDataClearOnClose' },
  webHardware: { key: 'webHardware', group: 'hardware-settings.api-materielles-du-web' },
  passwords: { key: 'passwordManager', group: 'passwords-panel.mots-de-passe' },
  lock: { key: 'lockEnabled', group: 'lock-settings.verrouillage' },
  blockers: { key: 'blockAds', group: 'settings.bloqueur' },
  autoBackup: { key: 'autoBackup', group: 'backup-settings.copies-automatiques' },
  shortcuts: { key: 'keyBindings' },
  mouseGestureSites: { key: 'mouseGestureExcludedHosts' },
  vimKeySites: { key: 'vimKeysExcludedHosts' },
  focusSites: { key: 'focusSites' },
  trackpad: { key: 'spaceSwipe', group: 'settings.pave-tactile' },
  profiles: { page: 'profiles' },
  webPanels: { key: 'webPanels', group: 'settings.fonctions-theme-fenetres' },
  bookmarkLibrary: { key: 'bookmarkManager', group: 'settings.fonctions-theme-signets' },
  notes: { key: 'notes', group: 'settings.fonctions-theme-signets' },
  summary: { page: 'features', group: 'ollama-settings.title' },
  // « Découvrir Lucium » (shared/discover.ts) says where to switch on the functions it presents
  protection: { page: 'protection' },
  pageIndex: { key: 'pageContentIndex' },
  historyKeep: { key: 'historyKeepDays' },
  pictureInPicture: { key: 'autoPictureInPicture' },
  workViews: { key: 'workViewsEnabled' },
  glance: { key: 'peekWithShift' },
  rememberScroll: { key: 'rememberScroll' },
  compactMode: { key: 'compactMode' },
  siteSearches: { key: 'siteSearches' },
  commandBarSize: { key: 'commandBarSize' }
} as const satisfies Record<string, SettingsPlace>

export type SettingsPlaceId = keyof typeof SETTINGS_PLACES

/** The steps of the way to a place, after « Réglages »: its page, « Plus de réglages » when it waits there, its subpage, its group. */
export function settingsPathSteps(place: SettingsPlace): string[] {
  const page = place.key !== undefined ? categoryOfKey(place.key) : place.page
  if (!page) throw new Error(`settingsPath: the place names no page (${place.key ?? 'no key'})`)
  const subpage = place.key !== undefined ? subpageOfKey(place.key) : undefined
  const folded = subpage !== undefined ? subpage.at === 'more' : place.key !== undefined ? placementOf(place.key) === 'more' : place.fold === true
  const subTitle = subpage !== undefined ? t(subpage.title) : null
  const group = place.group !== undefined ? t(place.group) : null
  return [settingsPaneLabel(page), folded ? t('settings.plus-de-reglages') : null, subTitle, group !== subTitle ? group : null].filter((step): step is string => step !== null)
}

/** « Réglages › Vie privée et sécurité › Verrouillage »: the way to a place, in the language of the interface, for the `{settingsPath}` of a text. */
export const settingsPath = (place: SettingsPlaceId): string => t('cmd.settings-pane', { pane: settingsPathSteps(SETTINGS_PLACES[place]).join(' › ') })
