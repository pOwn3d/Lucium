// Where a row of the Settings window is drawn on its page: at the top, with what one changes in the first weeks, or in the one fold at the foot of the
// page, « Plus de réglages », whose line names the sections it holds. Nothing is hidden without being said: the fold is the only place a row waits
// (the global level « Essentiel / Tous les réglages » is gone). A row is at the top when it is listed here; the panes derive the place of a row from
// its key (settings-parts.tsx), so one table says it all. Pure: nothing here reads the window.

import { SETTINGS_KEYS, type SettingKey } from './settings-catalog'
import { subpageOfKey } from './settings-subpages'

/** At the top of the page, or in « Plus de réglages ». */
export type RowPlacement = 'page' | 'more'

/**
 * The settings drawn at the top of their page, by key of `Settings`. A row with no key (a button, an entry of a list, a form) is at the top unless its
 * pane says otherwise. The keys of lists (sites, routes, filter lists…) are in the fold: a list is what one adds to once the switch above it is on.
 */
export const PAGE_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  // Pour commencer (the language and whether the interface follows it are one row; the page draws everything at its top)
  'language', 'interfaceTranslated',
  // Apparence: Thème · Taille · Barre latérale · Pages web
  'interfaceAppearance', 'uiScale', 'sidebarRight', 'compactMode', 'websiteAppearance', 'readableMode',
  // Onglets et fenêtres: Au lancement · Onglets du jour · Mise en veille · Fermer et quitter. The windows of the last session and the delay of the sleep
  // are the rows of the presets « Quand vous ouvrez Lucium » and « Mettre en veille » (settings-presets.ts); their own switch and menu wait in the fold.
  'restoreWindows', 'autoArchiveHours', 'sleepAfterMinutes', 'warnBeforeClosingWindow', 'warnBeforeQuitting',
  // Navigation: Moteur de recherche · Barre de commandes · Liens (the links of other applications: the row of the preset « Liens venus d’autres
  // applications »; their switch waits in the fold)
  'searchUrlTemplate', 'searchSuggestions', 'commandBarSize', 'externalLinksInLittleArc', 'modifiedClickBackground',
  // Vie privée et sécurité: Protection · Historique et données · Autorisations des sites · Mots de passe et verrouillage. Protection is the preset
  // « Niveau de protection » (settings-presets.ts), a row of no key, with four of the switches it writes under it; its five others wait in the fold.
  'blockAds', 'blockCookieBanners', 'stripTrackingParams', 'reduceFingerprint', 'historyOff', 'autoplayPolicy', 'passwordManager', 'lockEnabled',
  // Téléchargements et fichiers: Où enregistrer · Copies et export
  'downloadAskWhere', 'autoBackup',
  // Extensions et outils: Retouches · Traduction
  'boostsEnabled', 'translateLocal', 'translateTarget',
  // Clavier et souris: Raccourcis dans toutes les applications · Souris et pavé tactile · Raccourcis clavier
  'littleArcShortcut', 'annotateGlobalShortcut', 'mouseGestures', 'autoScroll', 'spaceSwipe', 'tabCycleRecent', 'keyBindings',
  // Profils
  'profileNames', 'profiles',
  // Fonctions en option: the page is the catalogue, every line of it at the top (one line a feature, its options under it), and has no fold
  ...SETTINGS_KEYS.features,
  // À propos et mises à jour
  'autoUpdate', 'windowsAutoUpdate', 'whatsNewSheet', 'appIcon'
])

/**
 * Where the row of a setting is said on its page: at the top when it is in `PAGE_KEYS`, in « Plus de réglages » otherwise. A setting that lives on a
 * subpage (shared/settings-subpages.ts) is said by the row that opens it, so its place is that row's.
 */
export const placementOf = (key: SettingKey): RowPlacement => (PAGE_KEYS.has(key) ? 'page' : (subpageOfKey(key)?.at ?? 'more'))

/**
 * Whether the row of a setting is out of sight on its page, under « Plus de réglages »: what the notice of a preset counts apart (« dont 2 dans « Plus
 * de réglages » »). The setting a preset row stands for is at the top: the preset shows it.
 */
export const inFold = (key: SettingKey): boolean => placementOf(key) === 'more'
