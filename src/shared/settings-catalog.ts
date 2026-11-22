// The structure of the Settings: short categories named by what one wants to do, one place for every setting (at the top of its page or in its
// fold « Plus de réglages », shared/settings-placement.ts), and what "Rétablir" does to a category.
//
// This file is the map; the panes (`src/renderer/*Settings.tsx`) are the territory. `SETTINGS_KEYS` says in which category the row of every key of
// `Settings` is drawn, `NO_CONTROL_KEYS` lists the keys that never had a row (and why), `PER_PROFILE_KEYS` the few that are drawn again in Profils
// for the profile picked there, and the test `src/renderer/settings-structure.test.ts` renders every category and fails for a key that is in none
// (a setting that disappears from the window) or for a row the map does not know.
//
// Pure: nothing here reads the window. The labels are keys of the catalogues, read when the window draws (the language of the moment).

import type { FeatureId } from './features'
import { t, type MessageKey } from './i18n'
import { isSettingsAnchor, SETTINGS_PAGES, type SettingsAnchor, type SettingsPage, type SettingsPane } from './ipc'
import { SUBPAGES } from './settings-subpages'
import type { Settings } from './model'
import { referenceSettings } from './model-defaults'

export type SettingKey = keyof Settings

/** The pictogram of a page in the sidebar (drawn in the renderer, settings-icons.tsx). */
export type CategoryIcon = 'home' | 'palette' | 'tab' | 'search' | 'shield' | 'download' | 'puzzle' | 'keyboard' | 'person' | 'sparkle' | 'info'

/** Where a page sits in the sidebar: the welcome page above a rule, the 8 categories, then the two pages apart under another rule. */
export type CategoryPlace = 'start' | 'category' | 'apart'

export interface SettingsCategory {
  id: SettingsPage
  icon: CategoryIcon
  place: CategoryPlace
  /** The name of the category (the heading of its content, the command bar, the search results). */
  label: MessageKey
  /** The name the sidebar shows: one short line, the sidebar is 204 px wide. */
  short: MessageKey
  /** One line under the name: what is in there. */
  blurb: MessageKey
}

/** In the order of the sidebar (the same as `SETTINGS_PAGES`, which a test pins). */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'home', icon: 'home', place: 'start', label: 'settings.cat-home', short: 'settings.cat-home', blurb: 'settings.cat-home-blurb' },
  { id: 'appearance', icon: 'palette', place: 'category', label: 'settings.cat-appearance', short: 'settings.cat-appearance-short', blurb: 'settings.cat-appearance-blurb' },
  { id: 'tabs', icon: 'tab', place: 'category', label: 'settings.cat-tabs', short: 'settings.cat-tabs', blurb: 'settings.cat-tabs-blurb' },
  { id: 'navigation', icon: 'search', place: 'category', label: 'settings.cat-navigation', short: 'settings.cat-navigation-short', blurb: 'settings.cat-navigation-blurb' },
  { id: 'protection', icon: 'shield', place: 'category', label: 'settings.cat-protection', short: 'settings.cat-protection-short', blurb: 'settings.cat-protection-blurb' },
  { id: 'files', icon: 'download', place: 'category', label: 'settings.cat-files', short: 'settings.cat-files-short', blurb: 'settings.cat-files-blurb' },
  { id: 'tools', icon: 'puzzle', place: 'category', label: 'settings.cat-tools', short: 'settings.cat-tools', blurb: 'settings.cat-tools-blurb' },
  { id: 'keyboard', icon: 'keyboard', place: 'category', label: 'settings.cat-keyboard', short: 'settings.cat-keyboard', blurb: 'settings.cat-keyboard-blurb' },
  { id: 'profiles', icon: 'person', place: 'category', label: 'settings.cat-profiles', short: 'settings.cat-profiles-short', blurb: 'settings.cat-profiles-blurb' },
  { id: 'features', icon: 'sparkle', place: 'apart', label: 'settings.cat-features', short: 'settings.cat-features', blurb: 'settings.cat-features-blurb' },
  { id: 'about', icon: 'info', place: 'apart', label: 'settings.cat-about', short: 'settings.cat-about-short', blurb: 'settings.cat-about-blurb' }
]

/** The page a name leads to: a page is itself; `general`, the category of the previous layout, is « Pour commencer ». */
export const pageOf = (pane: SettingsPane): SettingsPage => (pane === 'general' ? 'home' : pane)

export const categoryById = (pane: SettingsPane): SettingsCategory => SETTINGS_CATEGORIES.find((category) => category.id === pageOf(pane))!

/** The title of a page, in the language of the interface. */
export const settingsPaneLabel = (pane: SettingsPane): string => t(categoryById(pane).label)

/** The name the sidebar shows. */
export const settingsPaneShortLabel = (pane: SettingsPane): string => t(categoryById(pane).short)

// ---------- where every setting is drawn ----------

/**
 * The keys whose row (a switch, a menu, a slider, a button, or the list they edit) is drawn in each category. Every key of `Settings` is here once, or in
 * `NO_CONTROL_KEYS`. The marker `data-setting` of the rows carries the same names: the test renders the categories and compares the two. The order
 * is the one of the groups of the category.
 */
export const SETTINGS_KEYS = {
  // Votre navigateur (the language; the default browser and the import are actions). The other rows of « Pour commencer » mirror those of their
  // category (`HOME_MIRROR_KEYS`).
  home: ['language', 'interfaceTranslated'],
  // Accessibilité · Interface · Taille des fenêtres et des panneaux · Barre latérale · Fenêtre · Sites web
  appearance: [
    'uiScale', 'panelSizes', 'forceReduceMotion', 'forceHighContrast', 'forceReduceTransparency',
    'hoverCards', 'interfaceAppearance', 'showZoomIndicator', 'fullUrlInToolbar', 'readableToolbarButton',
    'sidebarRight', 'compactMode', 'mediaPlayer', 'favoriteNames', 'resourceGauge',
    'windowVibrancy', 'sidebarOpacity', 'windowBorder', 'cardOutline',
    'websiteAppearance', 'readableMode', 'siteReadableMode', 'allowThemeToSites'
  ],
  // Mise en veille · Onglets du jour · Organisation · Vue scindée et vidéo · Fenêtres
  tabs: [
    'sleepAfterMinutes', 'sleepAwakeMax', 'sleepFreezeAfterMinutes', 'sleepMode', 'sleepSkipAudible', 'sleepSkipPinned', 'sleepNotify', 'loadAllTabsAtLaunch', 'sleepExcludedHosts', 'sleepExcludedKeepAll',
    'autoArchiveHours', 'tidyPinnedTitles', 'reopenHistory', 'backClosesOpenedTab',
    'tabStateBadges', 'tidyFoldersPosition',
    'dragToSplit', 'scrollSync', 'rememberScroll', 'autoPictureInPicture', 'sitePictureInPictureInLucium',
    'restoreWindows', 'dragWindowFromToolbar', 'warnBeforeClosingWindow', 'warnBeforeQuitting'
  ],
  // Moteur de recherche · Propositions de la barre de commandes · Apparence · Recherches rapides · Recherche dans un site · Mots-clés des extensions
  // · Mini-fenêtre et Coup d’œil · Ouverture des liens
  navigation: [
    'searchUrlTemplate', 'searchSuggestions', 'suggestHistory', 'suggestTabs', 'goToOpenTab', 'suggestArchive', 'suggestReadLater',
    'commandBarSize', 'commandBarShape', 'searchBangs', 'commandBarCalc', 'searchDiscovery', 'siteSearches', 'omniboxKeywords',
    'externalLinksInLittleArc', 'littleArcArchiveHours', 'littleArcNewTabLinks', 'littleArcModifier', 'littleDownloadBubble',
    'peekWithShift', 'peekOnExternalLinks', 'modifiedClickBackground', 'blankLinkBackground', 'linkRoutes'
  ],
  // Bloqueur · Protections · Historique et cookies · Effacement · Autorisations des sites · Verrouillage des espaces · Gestionnaire de mots de passe
  // · Listes de filtres · DNS chiffré · Proxy
  protection: [
    'blockAds', 'blockCookieBanners', 'blockMode', 'blockCosmetic', 'blockExceptions', 'popupExceptions',
    'httpsUpgrade', 'sendGpc', 'stripTrackingParams', 'stripCopiedLinks', 'blockThirdPartyCookies', 'thirdPartyCookieExceptions',
    'blockScriptlets', 'reduceFingerprint', 'fingerprintStrict', 'fingerprintExceptions',
    'historyOff', 'pageContentIndex', 'siteDataConfirm', 'siteDataNotify', 'siteDataAnimation', 'siteDataClearOnCloseEnabled', 'siteDataClearOnClose', 'siteDataClearOnQuit',
    'autoplayPolicy', 'siteAutoplay', 'allowScreenShare', 'webHardware',
    'lockEnabled', 'lockApp', 'lockTouchId', 'lockedSpaces', 'passwordManager',
    'disabledFilterLists', 'filterUpdateDays', 'customFilterListsEnabled', 'customFilterLists', 'dohCustom', 'dohMode', 'dohProvider', 'dohCustomUrl', 'proxyEnabled', 'proxy'
  ],
  // Téléchargements et lecture · Ouverture des fichiers · Signets (the export) · Icônes des sites · Copies automatiques · Export
  files: [
    'tidyDownloads', 'downloadStatusChip', 'downloadResume', 'downloadAskWhere', 'useReadLaterFolders',
    'openWithMemory', 'openWithApps',
    'resolveFavicons',
    'autoBackup', 'autoBackupMinutes', 'autoBackupKeep'
  ],
  // Extensions · Retouches · Partage des Retouches · Outils web · Traduction
  tools: [
    'webStoreInstall', 'webStoreUpdates', 'extensionPaths', 'chromeNativeHosts', 'extensionOverflow', 'extensionDataApis', 'extensionTabCapture',
    'boostsEnabled', 'boostSharing', 'boostScriptImport',
    'batterySaver',
    'translateLocal', 'translateSystemEngine', 'translateTarget', 'translateModelsDir', 'translateAlways', 'translateNeverSites'
  ],
  // Raccourcis dans toutes les applications (⌥⌘N, ⌥⌘M) · Gestes de souris · Défilement · Pavé tactile · Touches Vim · Raccourcis clavier
  keyboard: [
    'littleArcShortcut', 'annotateGlobalShortcut', 'mouseGestures', 'mouseGestureExcludedHosts', 'autoScroll', 'spaceSwipe', 'vimKeys', 'vimKeysExcludedHosts',
    'keyBindings', 'tabCycleRecent'
  ],
  // Vos profils · Le profil choisi (its own values of the settings of `PER_PROFILE_KEYS`, its history, its proxy, its data)
  profiles: ['profileNames', 'profiles'],
  // The catalogue of the features to add (`FEATURE_THEMES`), theme by theme: the switch of each feature, then what goes with it (its options, its list,
  // the settings of the page annotation and of the summary by a local model, which are no feature of the registry).
  features: [
    'tabTree', 'tabReminders', 'tabSearch', 'tabGroupFolders', 'showReloadAllButton', 'reloadAllWakes', 'showTabMemory', 'workViewsEnabled',
    'webPanels', 'nameWindows', 'independentWindows', 'webAppWindows', 'documentPictureInPicture',
    'tabContainers', 'privateTabs', 'guestProfile', 'containers', 'containerRules',
    'bookmarkManager', 'liveFolders', 'notes', 'notesListButton',
    'userScripts', 'qrCode', 'readAloud', 'pageWatch', 'annotateCapture', 'annotateAutoClear', 'annotateAutoClearSeconds', 'annotateLetterKeys', 'pageWatches', 'focusMode', 'focusSites', 'focusScheduleOn', 'focusDays', 'focusFrom', 'focusTo', 'focusMinutes', 'ollamaConfig', 'aiSummary',
    'downloadPause', 'openUnsaved', 'pdfWithSource',
    'findRegex',
    'cookieManager',
    'shortcutHelp',
    'urlAutomation'
  ],
  // Mises à jour · Icône du Dock · À propos · État de Lucium
  about: ['autoUpdate', 'updateChannel', 'whatsNewSheet', 'appIcon']
} as const satisfies Record<SettingsPage, readonly SettingKey[]>

/**
 * The settings that each profile may set on its own (shared/profiles.ts): their row is drawn in the category of what they do, for the profile of the
 * space on screen (with the mark "profil « … »"), and drawn again in Profils for the profile picked in its list. The second row is marked
 * `data-mirror`, and the test of the structure admits it there, and nowhere else.
 */
export const PER_PROFILE_KEYS = {
  searchUrlTemplate: 'navigation',
  searchSuggestions: 'navigation',
  autoArchiveHours: 'tabs'
} as const satisfies Partial<Record<SettingKey, SettingsPage>>

/**
 * The rows of the categories that « Pour commencer » draws again, as mirrors (`data-mirror`): the choices of the first minutes, the same settings as in
 * their category, never copies. The language is the page's own row (`SETTINGS_KEYS.home`); the default browser and the import are actions. Three of these
 * rows are presets that stand for a setting (the links of other applications, the launch, the sleep: shared/settings-presets.ts); the level of
 * protection, a preset too, is drawn there again under its search id, as no setting tells its levels apart.
 */
export const HOME_MIRROR_KEYS = [
  'interfaceAppearance', 'uiScale', 'sidebarRight',
  'passwordManager',
  'searchUrlTemplate', 'externalLinksInLittleArc',
  'restoreWindows', 'sleepAfterMinutes', 'autoArchiveHours',
  'downloadAskWhere'
] as const satisfies readonly SettingKey[]

/**
 * The features to add rather than ways for Lucium to behave (« voulez-vous cette chose ? »): « Fonctions en option » lists them, theme by theme, one line
 * each (its switch, the first sentence of its description, its cost said in a sentence), and no category draws them. Every other feature of the registry
 * is a preference, switched in its category. A theme's title is a key of the catalogues.
 */
export interface FeatureTheme {
  id: 'tabs' | 'windows' | 'separate' | 'bookmarks' | 'pages' | 'files' | 'search' | 'privacy' | 'keyboard' | 'automation'
  title: MessageKey
  features: readonly FeatureId[]
}

export const FEATURE_THEMES: readonly FeatureTheme[] = [
  { id: 'tabs', title: 'settings.fonctions-theme-onglets', features: ['tab-tree', 'tab-reminders', 'tab-search', 'tab-groups-ext', 'reload-all-button', 'tab-memory', 'work-views'] },
  { id: 'windows', title: 'settings.fonctions-theme-fenetres', features: ['web-panels', 'name-windows', 'independent-windows', 'pwa', 'document-pip'] },
  { id: 'separate', title: 'settings.fonctions-theme-separer', features: ['containers', 'private-tabs', 'guest-profile'] },
  { id: 'bookmarks', title: 'settings.fonctions-theme-signets', features: ['bookmarks', 'live-folders', 'notes'] },
  { id: 'pages', title: 'settings.fonctions-theme-pages-web', features: ['user-scripts', 'qr-code', 'read-aloud', 'page-watch', 'focus-mode', 'annotate-capture'] },
  { id: 'files', title: 'settings.fonctions-theme-fichiers', features: ['download-pause', 'open-unsaved', 'pdf-with-source'] },
  { id: 'search', title: 'settings.fonctions-theme-recherche', features: ['find-regex'] },
  { id: 'privacy', title: 'settings.fonctions-theme-vie-privee', features: ['cookie-manager'] },
  { id: 'keyboard', title: 'settings.fonctions-theme-clavier', features: ['shortcut-help'] },
  { id: 'automation', title: 'settings.fonctions-theme-automatisation', features: ['applescript'] }
]

/** The features « Fonctions en option » lists, in its order. */
export const CATALOGUE_FEATURES: readonly FeatureId[] = FEATURE_THEMES.flatMap((theme) => theme.features)

/**
 * The optional features of a category whose switch has no row of its own in a pane (`FeatureSwitch`, renderer/FeaturesSettings.tsx): the registry
 * (shared/features.ts) was all that listed them, so each is drawn in the category it belongs to. The other features have their switch in the row of
 * their own setting, which `SETTINGS_KEYS` places, or in « Fonctions en option » (`FEATURE_THEMES`). A feature added later with no row of its own is
 * added here, and to its category's keys: src/renderer/settings-structure.test.ts fails until it is.
 */
export const FEATURE_ONLY_SWITCHES = {
  'compact-mode': 'appearance',
  'media-player': 'appearance',
  'favorite-names': 'appearance',
  'resource-gauge': 'appearance',
  'tab-state-badges': 'tabs',
  'download-status-chip': 'files',
  'whats-new': 'about'
} as const satisfies Partial<Record<FeatureId, SettingsPane>>

/**
 * The keys of `Settings` that have never had a row in the Settings window, and what sets them instead. Listed so that the test can tell a setting that
 * was never there from one that disappeared; a key is added here only with its reason.
 */
export const NO_CONTROL_KEYS = {
  autoplayPerSite:
    'deprecated: the switch « Un réglage pour chaque site » of the autoplay was a setting of a setting, which the panel of the site made useless; the choices of the sites now always apply and the panel always offers them, so nothing reads the key, which stays so that an older state file loads and keeps it',
  showAdvancedSettings: 'deprecated: the level of the window (Essentiel / Tous les réglages) is gone, each page folds its other rows in one « Plus de réglages » that names them; nothing reads the key, which stays so that an older state file loads and keeps it',
  sidebarVisible: 'the state of the window: View > Hide Sidebar (⌘S) and the command bar toggle it',
  sidebarWidth: 'the state of the window: the width is dragged on the edge of the sidebar',
  annotateBarHintSeen: 'a flag: the hint above the grip of the annotation bar (« drag the grip to place the bar ») was dismissed, so it is shown once',
  annotateBar: 'the state of the annotation bar: its grip drags it, and the menu of the grip (right click) sets its edge or floats it; remembered between uses',
  sidePanelWidth: 'the state of the window: the width is dragged on the edge of the side panel',
  showToolbar: 'the state of the window: View > Hide Toolbar',
  spellCheck: 'Edit > Spelling and Grammar',
  spaceImages: 'deprecated: the picture of a space is chosen in "Personnaliser l\'espace" (Émoji / Lettre / Image) whatever this says; the key stays so that an older state file loads',
  siteZoom: 'the zoom commands of the page (⌘+, ⌘-, ⌘0), kept per site',
  suggestionsNoticeSeen: 'a flag: the note under the command bar was read once',
  welcomeDone: 'a memory: the old welcome sheet was shown once, so a fresh profile is not mistaken for a new one',
  firstLaunchDone: 'flag: the first-launch guide was shown (Help › First Launch opens it again)',
  arcGuideSeen: 'flag: the guide for people coming from Arc was shown (Help › Coming from Arc? opens it again)',
  translateSystemNoticeSeen: 'a memory: the one-time notice of macOS\'s translation (Apple may count its use) was given, the first time macOS translated a page in one click',
  lastSeenVersion: 'a memory: the version the last launch ran, to tell an update (the sheet of the news is a feature, `whatsNewSheet`)',
  searchDiscoverySeen: 'a memory: the sites already offered their search',
  focusUntil: 'a memory: when the timer of the focus mode ends, written by its Start and Stop buttons and by the block page',
  focusSnoozeUntil: 'a memory: until when the focus mode was paused from its block page',
  usedProfiles: 'a memory: the profiles that have had a page, to tell a missing storage',
  retiredProfileIds: 'a memory: the ids of the deleted profiles, given to no new profile until the next launch removes their folders (written by the main process only)',
  siteDataTypes: 'the choices of the panel "Effacer les données du site", kept for its next use',
  siteDataSubdomains: 'the choices of the panel "Effacer les données du site", kept for its next use',
  siteDataReload: 'the choices of the panel "Effacer les données du site", kept for its next use',
  siteDataHttp: 'the choices of the panel "Effacer les données du site" (« Inclure HTTP » ticked by hand), kept for its next use',
  siteDataAutoClose: 'the choices of the panel "Effacer les données du site", kept for its next use',
  siteDataRecents: 'the sites erased last, offered by that panel',
  developerHosts: 'the Developer Mode of a site, in the site panel (⌃D): reloads without the cache, and its invalid certificate goes through unasked (« Non sécurisé »)',
  cookieKeepHosts: 'the sites to keep, in the "Cookies par site" panel',
  blockModeSites: 'the blocking mode of a site, in the site panel (its blocking row), kept per site',
  unpinnedExtensions: 'the extension icons taken out of the toolbar, by its own menu',
  updateFeedUrl: 'no control by design: the address of a feed written by hand, read (by `autoUpdate` and the menu) only by a build that carries no address of its own; the address built into a build is not this setting, and installing follows that one only (main/shell/update-source.ts)',
  updateNotices: 'a memory: the last version the notice of an update offered and how many times, so that a version passed over three times is no longer offered by itself, and a downloaded update dropped at the quit, told at the next launch (shared/auto-update.ts)',
  protectionBaseline: 'a memory: the protection the profile began with (Standard for a profile made before « Renforcée » was the default), which « modified » and « Rétablir » compare the protection with; written once, when the profile is made or its file first read',
  blockTrackers: 'the alias of `blockAds`, which the blocker reads with it: the switch « Bloquer les publicités et les traqueurs » shows and writes both (decision of 2026-11-03: no second switch with the same label)'
} as const satisfies Partial<Record<SettingKey, string>>

/**
 * What "Rétablir" never touches, with the reason: what you typed or built (lists of sites, routes, scripts' folders, filter lists), what only the main
 * process may write (the lock, the containers, the folder of the models, the applications remembered for a type of file), and the shortcuts, which
 * have their own "Tout réinitialiser". A reset puts back the switches, the menus and the sliders.
 */
export const KEPT_ON_RESET = {
  // typed or built by the user
  sleepExcludedHosts: 'a list of sites',
  siteReadableMode: 'a list of sites',
  blockExceptions: 'a list of sites',
  blockModeSites: 'a list of sites',
  popupExceptions: 'a list of sites',
  fingerprintExceptions: 'a list of sites',
  thirdPartyCookieExceptions: 'a list of sites',
  mouseGestureExcludedHosts: 'a list of sites',
  vimKeysExcludedHosts: 'a list of sites',
  translateNeverSites: 'a list of sites',
  translateAlways: 'a list of languages',
  siteDataClearOnClose: 'a list of sites',
  siteAutoplay: 'a list of sites',
  linkRoutes: 'the routes of the links',
  siteSearches: 'the keywords of the site searches',
  pageWatches: 'the pages being watched',
  focusSites: 'a list of sites',
  focusUntil: 'a memory: when the timer of the focus mode ends, written by its Start button and by the block page',
  focusSnoozeUntil: 'a memory: until when the focus mode was paused from its block page',
  extensionPaths: 'the folders of the unpacked extensions',
  customFilterLists: 'the lists the user brought',
  dohCustomUrl: 'an address typed',
  proxy: 'an address typed',
  profileNames: 'the names of the profiles',
  profiles: 'what each profile sets on its own',
  keyBindings: 'the shortcuts have their own "Tout réinitialiser"',
  // the interface may not write them (ipc-policy.ts), so a patch that held one would be refused whole
  containers: 'changed through the container actions only',
  containerRules: 'changed through the container actions only',
  translateModelsDir: 'chosen in the system folder box by the main process',
  retiredProfileIds: 'written by the main process when a profile is deleted, emptied by the next launch',
  protectionBaseline: 'what a reset goes back to for the protection: it is not a choice of the profile, and the interface may not write it',
  openWithApps: 'the interface may forget one, never name one',
  lockEnabled: 'the lock changes through its own handler, after the passphrase',
  lockApp: 'the lock changes through its own handler, after the passphrase',
  lockedSpaces: 'the lock changes through its own handler, after the passphrase',
  lockTouchId: 'the lock changes through its own handler, after the passphrase'
} as const satisfies Partial<Record<SettingKey, string>>

const KEPT: ReadonlySet<string> = new Set(Object.keys(KEPT_ON_RESET))

/** The page that draws the row of a key, or null for a key that has none (see `NO_CONTROL_KEYS`). */
export function categoryOfKey(key: string): SettingsPage | null {
  for (const pane of SETTINGS_PAGES) if ((SETTINGS_KEYS[pane] as readonly string[]).includes(key)) return pane
  return null
}

/** Whether a reset puts the key back: false for the keys of `KEPT_ON_RESET`. */
export const isResettable = (key: string): boolean => !KEPT.has(key)

// ---------- "Rétablir" ----------

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * What a reset writes for a key: its default. The local model of the summary is one setting that holds a switch, two sliders, and an address and a
 * model name that were typed: the switch and the sliders go back, what was typed stays, as for every other address typed (`KEPT_ON_RESET`).
 */
function resetValue(settings: Settings, defaults: Settings, key: SettingKey): unknown {
  if (key === 'ollamaConfig') return { ...defaults.ollamaConfig, url: settings.ollamaConfig.url, model: settings.ollamaConfig.model }
  return defaults[key]
}

/**
 * Whether a setting the reset would touch is not at the value a reset gives it. What a reset gives is the default, but for the protection, which is the one
 * the profile began with (`referenceSettings`): a profile made before « Renforcée » is not marked for what it never changed.
 */
export function isModified(settings: Settings, key: SettingKey): boolean {
  return isResettable(key) && !same(settings[key], resetValue(settings, referenceSettings(settings), key))
}

/**
 * Whether the row of a key shows the value of a profile other than the default one (`profileId`, the profile of the space on screen): the settings of
 * `PER_PROFILE_KEYS` are then that profile's own, which has no default to go back to here (« Comme le défaut » in Profils sets it to follow the default
 * profile). Such a key is not counted as changed, and no reset touches it, as the tooltip of « Rétablir » says.
 */
const shownForAnotherProfile = (key: string, profileId: string | undefined): boolean => profileId !== undefined && profileId !== 'default' && Object.hasOwn(PER_PROFILE_KEYS, key)

/**
 * The keys of a category a reset would change: resettable, and not at their default value. `profileId`: the profile of the space on screen, whose own
 * values the rows of `PER_PROFILE_KEYS` show (left out when it is not the default profile).
 */
export function modifiedKeys(pane: SettingsPane, settings: Settings, profileId?: string): SettingKey[] {
  const defaults = referenceSettings(settings)
  return (SETTINGS_KEYS[pageOf(pane)] as readonly SettingKey[]).filter((key) => isResettable(key) && !shownForAnotherProfile(key, profileId) && !same(settings[key], resetValue(settings, defaults, key)))
}

/** Every key of every category that is not at its default (« Réglages modifiés »), in the order of the categories. */
export const allModifiedKeys = (settings: Settings, profileId?: string): SettingKey[] => SETTINGS_PAGES.flatMap((pane) => modifiedKeys(pane, settings, profileId))

export interface ResetPlan {
  /** The settings to write: each changed key at its default. */
  patch: Partial<Settings>
  /** What puts them back as they were (the notice's "Annuler"). */
  undo: Partial<Settings>
  keys: SettingKey[]
}

/** The keys a row writes with its own: the switch of the ads writes its alias too (privacy-dashboard.ts), so putting one back puts back both. */
const WRITTEN_WITH: Readonly<Partial<Record<SettingKey, readonly SettingKey[]>>> = { blockAds: ['blockTrackers'] }

/**
 * What puts `keys` back at their default, and what undoes it (the notice's "Annuler"). Null when none of them has moved. Never names a key of
 * `KEPT_ON_RESET`, so the main process refuses nothing.
 */
export function resetPlanOf(keys: readonly SettingKey[], settings: Settings): ResetPlan | null {
  const moved = keys.filter((key) => isModified(settings, key))
  if (moved.length === 0) return null
  const defaults = referenceSettings(settings)
  const patch: Record<string, unknown> = {}
  const undo: Record<string, unknown> = {}
  for (const key of moved) {
    for (const written of [key, ...(WRITTEN_WITH[key] ?? [])]) {
      patch[written] = resetValue(settings, defaults, written)
      undo[written] = settings[written]
    }
  }
  return { patch: patch as Partial<Settings>, undo: undo as Partial<Settings>, keys: moved }
}

/**
 * "Rétablir les valeurs par défaut" of a category: the keys that differ from their default go back to it, and the same keys with their old values are kept
 * for the "Annuler" of the notice. Null when there is nothing to put back. `profileId`: the profile of the space on screen (`modifiedKeys`).
 */
export const categoryResetPlan = (pane: SettingsPane, settings: Settings, profileId?: string): ResetPlan | null => resetPlanOf(modifiedKeys(pane, settings, profileId), settings)

// ---------- the old addresses ----------

/**
 * A place of Settings: a category, and a group of its rows to scroll to or a subpage to open. The anchors are those of `SETTINGS_ANCHORS` and the
 * subpages of `SETTINGS_SUBPAGES`, each belonging to one category.
 */
export interface SettingsTarget {
  pane: SettingsPage
  anchor?: SettingsAnchor
}

/**
 * The page an anchor lives in: an anchor given with another page is dropped, unless that page held it in the previous layout (`FORMER_ANCHOR_PANE`).
 * A subpage is an anchor of its page (shared/settings-subpages.ts).
 */
export const ANCHOR_PANE: Readonly<Record<SettingsAnchor, SettingsPage>> = {
  ...(Object.fromEntries(SUBPAGES.map((subpage) => [subpage.id, subpage.pane])) as Record<(typeof SUBPAGES)[number]['id'], SettingsPage>),
  icon: 'about',
  about: 'about',
  status: 'about',
  engine: 'navigation',
  links: 'navigation',
  shortcuts: 'keyboard',
  permissions: 'protection',
  sitedata: 'protection',
  lock: 'protection',
  downloads: 'files',
  extensions: 'tools',
  guide: 'home',
  panelsize: 'appearance'
}

/** The anchors that moved with the sidebar, and the category that held them before: `#general/about`, `#navigation/shortcuts` lead to their new page. */
const FORMER_ANCHOR_PANE: Readonly<Partial<Record<SettingsAnchor, SettingsPane>>> = {
  icon: 'general',
  about: 'general',
  guide: 'general',
  shortcuts: 'navigation'
}

/** The anchors that start a flow of the window instead of scrolling to a group: no element carries their id. */
export const FLOW_ANCHORS: ReadonlySet<SettingsAnchor> = new Set<SettingsAnchor>(['guide'])

/** The name of the group or the subpage an anchor leads to: its title (the command bar and a typed `chrome://` address say "Réglages › <group>"). */
const ANCHOR_LABEL_KEYS: Readonly<Record<SettingsAnchor, MessageKey>> = {
  ...(Object.fromEntries(SUBPAGES.map((subpage) => [subpage.id, subpage.title])) as Record<(typeof SUBPAGES)[number]['id'], MessageKey>),
  icon: 'settings.icone-de-l-application',
  about: 'about-settings.a-propos',
  status: 'engine-status.etat-d-lucium',
  engine: 'settings-profiles.moteur-de-recherche',
  links: 'little-arc-settings.mini-fenetre',
  shortcuts: 'cmd.modifier-les-raccourcis-clavier',
  permissions: 'settings.autorisations-memorisees',
  sitedata: 'site-data-settings.titre',
  lock: 'lock-settings.verrouillage',
  downloads: 'download-settings.telechargements-et-lecture',
  extensions: 'settings.extensions',
  guide: 'guide.configuration-rapide',
  panelsize: 'panel-size.titre'
}

export const settingsAnchorLabel = (anchor: SettingsAnchor): string => t(ANCHOR_LABEL_KEYS[anchor])

const isPage = (value: unknown): value is SettingsPage => (SETTINGS_PAGES as readonly unknown[]).includes(value)
const isAnchor = isSettingsAnchor

/**
 * The old panes and what they became. The 16 categories of an earlier cut (and the 14 before them) became categories of today: `windows` and `sleep`
 * lead to `tabs`; `search`, `commandbar` and `links` to `navigation` (the mini window and the engine keep their anchor); `shortcuts` to `keyboard`;
 * `history`, `network` and `lock` to `protection` (`lock` keeps its anchor). `privacy`, `security` and the others are followed the same way. Before them,
 * "Avancé" held 25 groups that are now spread over the categories, so its places are told by their anchor (`advanced/privacy`, `advanced/extensions`…);
 * "Avancé" alone leads to the first page. `general`, the category of the previous layout, leads to « Pour commencer » (its updates, its icon and « À
 * propos » are in « À propos et mises à jour », reached by their anchor).
 */
const LEGACY_PANES: Readonly<Record<string, SettingsTarget>> = {
  general: { pane: 'home' },
  spaces: { pane: 'appearance' },
  privacy: { pane: 'protection' },
  windows: { pane: 'tabs' },
  sleep: { pane: 'tabs' },
  search: { pane: 'navigation', anchor: 'engine' },
  commandbar: { pane: 'navigation' },
  links: { pane: 'navigation', anchor: 'links' },
  shortcuts: { pane: 'keyboard', anchor: 'shortcuts' },
  history: { pane: 'protection' },
  network: { pane: 'protection' },
  lock: { pane: 'protection', anchor: 'lock' },
  security: { pane: 'protection', anchor: 'lock' },
  extensions: { pane: 'tools', anchor: 'extensions' },
  icon: { pane: 'about', anchor: 'icon' },
  advanced: { pane: 'home' }
}
/** The groups an old pane's address may name: each leads to the category that holds it now. */
const LEGACY_PANE_ANCHORS: Readonly<Record<string, readonly SettingsAnchor[]>> = {
  privacy: ['permissions', 'lock']
}
const LEGACY_ADVANCED_ANCHORS: Readonly<Record<string, SettingsTarget>> = {
  privacy: { pane: 'protection' },
  permissions: { pane: 'protection', anchor: 'permissions' },
  extensions: { pane: 'tools', anchor: 'extensions' },
  about: { pane: 'about', anchor: 'about' },
  downloads: { pane: 'files', anchor: 'downloads' }
}

/**
 * Where an address of Settings leads: a category (and a place in it), or an old pane (and its anchor), as the code, a typed `chrome://` address, a saved
 * hash or a debug variable may still say them. Null for anything else.
 */
export function resolveSettingsTarget(pane: unknown, anchor?: unknown): SettingsTarget | null {
  if (typeof pane !== 'string') return null
  // An anchor that moved with the sidebar leads to its new page from the category that held it (`#general/about`, `#navigation/shortcuts`).
  if (isAnchor(anchor) && FORMER_ANCHOR_PANE[anchor] === pane) return { pane: ANCHOR_PANE[anchor], anchor }
  if (isPage(pane)) return isAnchor(anchor) && ANCHOR_PANE[anchor] === pane ? { pane, anchor } : { pane }
  if (pane === 'advanced' && typeof anchor === 'string' && Object.hasOwn(LEGACY_ADVANCED_ANCHORS, anchor)) return { ...LEGACY_ADVANCED_ANCHORS[anchor]! }
  if (Object.hasOwn(LEGACY_PANE_ANCHORS, pane) && isAnchor(anchor) && LEGACY_PANE_ANCHORS[pane]!.includes(anchor)) return { pane: ANCHOR_PANE[anchor], anchor }
  return Object.hasOwn(LEGACY_PANES, pane) ? { ...LEGACY_PANES[pane]! } : null
}
