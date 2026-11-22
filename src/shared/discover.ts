// « Découvrir Lucium »: what Lucium can do, by what a person wants to do, with where to find it, its shortcut and a button that tries it. The panel
// (renderer/Discover.tsx) draws this catalogue; nothing here reads the window.
//
// Two layers (docs/fonctions.md, « Découvrir Lucium »):
//  - the cards: some thirty functions chosen to be shown, each with a task, a level, the words a person may search it by (French and English), what its
//    button does, the command whose shortcut it shows (read from the shortcuts in force, never written in a text) and one sentence that says where to
//    find it. A function of the registry (features.ts) lends its name and its line, unless the card says them better.
//  - the others: every function of the registry that has no card, listed by name with the setting that governs it. `FEATURE_TASKS` gives each of them
//    a task, and a function added to the registry without one does not compile.
// What a button does is one of four things, and never something new: it opens a panel the interface may open (the main process checks it:
// main/shell/discover-wiring.test.ts), it makes a call the interface already makes, it opens the Settings, or, when the function needs a page or a click
// on a tab, it does nothing and the sentence says how to start it.

import { featureById, featureLine, FEATURES, type BooleanSettingKey, type FeatureId } from './features'
import { SCOPE_PREFIX } from './command-bar-groups'
import { acceleratorKeys, effectiveAccelerator, formatAccelerator, type KeyBindings } from './keybindings'
import { matchesWords, queryWords } from './settings-search'
import { categoryOfKey } from './settings-catalog'
import { settingsPath } from './settings-path'
import { t, type MessageKey, type Vars } from './i18n'
import type { OverlayRequest, SettingsPage } from './ipc'
import type { Settings } from './model'
import type { PlatformId } from './platform'

/** The panel, as Aide › Découvrir Lucium, the command bar and the links of the welcome sheets ask for it. The interface may ask for it. */
export const DISCOVER_REQUEST: OverlayRequest = { panel: 'discover' }

/** What a person wants to do: the chips of the panel, in its order. */
export const DISCOVER_TASKS = ['fast', 'organise', 'read', 'keep', 'focus', 'protect'] as const
export type DiscoverTask = (typeof DISCOVER_TASKS)[number]

export const TASK_LABELS: Readonly<Record<DiscoverTask, MessageKey>> = {
  fast: 'discover.tache-aller-plus-vite',
  organise: 'discover.tache-organiser',
  read: 'discover.tache-lire',
  keep: 'discover.tache-garder',
  focus: 'discover.tache-concentrer',
  protect: 'discover.tache-proteger'
}

/** Two levels, not three: the border of a third would be arbitrary. */
export const DISCOVER_LEVELS = ['beginner', 'advanced'] as const
export type DiscoverLevel = (typeof DISCOVER_LEVELS)[number]

/** The calls the interface already makes that a card may trigger (renderer/Discover.tsx maps each to its API call; a Record there fails to compile for a missing one). */
export type DiscoverCall = 'captureFullPage' | 'saveMarkdown' | 'newPrivateTab'

export type DiscoverTry =
  /** A panel of the layer: the interface may open it (`validOverlay`). */
  | { kind: 'open'; request: OverlayRequest }
  | { kind: 'call'; call: DiscoverCall }
  /** The function is a setting: its one button is « Régler ». */
  | { kind: 'setting' }
  /** The function works on a page, a selection or a click on a tab: no button, the « where » line says how to start it. */
  | { kind: 'hint' }

export type SettingsRequest = Extract<OverlayRequest, { panel: 'settings' }>

export interface DiscoverEntry {
  /** Never changes once published: it names the card for the tests and the docs. */
  id: string
  task: DiscoverTask
  level: DiscoverLevel
  /** The function of the registry the card speaks of: it lends its name and its line, and says which setting to adjust. */
  feature?: FeatureId
  /** The card's own name and line, when the function has no entry of the registry or the card says it better. */
  name?: MessageKey
  summary?: MessageKey
  /** The sentence that says where to find it, and the words it needs (read when the sentence is: the names of the menus follow the language). */
  where: MessageKey
  whereVars?: () => Vars
  /** Words a person may search it by, French and English, without accents: the search also reads the name, the line and the place. */
  keywords: string
  /** The command whose shortcut the card shows (shared/keybindings.ts `COMMANDS`): the keys in force, so a key the person changed shows. */
  shortcut?: string
  try: DiscoverTry
  /** The setting that must be on for the function to work: the card says it is switched off, and the button that needs it is not offered. */
  needs?: BooleanSettingKey
  /** Where « Régler » leads, when it is not the page of the setting of `feature`. */
  setting?: SettingsRequest
  /** « Nouveau »: a function of the version in preparation. The mark is taken off by the next version (docs/fonctions.md). */
  isNew?: true
}

/** « Fichier › Capturer »: the path of a menu entry, in the language of the moment; a trailing ellipsis is dropped, it would end a sentence badly. */
const menuPath = (...keys: MessageKey[]): string => keys.map((key) => t(key).replace(/…$/, '')).join(' › ')

const open = (request: OverlayRequest): DiscoverTry => ({ kind: 'open', request })
const bar = (mode: 'new' | 'tabs' | 'little' | 'split', initial = ''): DiscoverTry => open({ panel: 'commandbar', mode, initial })

export const DISCOVER_ENTRIES: readonly DiscoverEntry[] = [
  // ---- Aller plus vite ----
  {
    id: 'command-bar',
    task: 'fast',
    level: 'beginner',
    name: 'discover.barre-nom',
    summary: 'discover.barre-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.ouvrir-la-barre-de-commandes') }),
    keywords: 'adresse recherche url omnibox aller site chercher commande address search go',
    shortcut: 'openLocation',
    try: bar('new')
  },
  {
    id: 'prefixes',
    task: 'fast',
    level: 'advanced',
    name: 'discover.prefixes-nom',
    summary: 'discover.prefixes-resume',
    where: 'discover.prefixes-ou',
    whereVars: () => ({ bookmarks: SCOPE_PREFIX.bookmarks, history: SCOPE_PREFIX.history }),
    keywords: 'signets historique favoris marque-pages etoile bookmarks history star filtrer filter',
    try: bar('new', '* '),
    isNew: true
  },
  {
    id: 'tab-search',
    task: 'fast',
    level: 'beginner',
    feature: 'tab-search',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.onglets', 'menu.rechercher-un-onglet') }),
    keywords: 'trouver onglet ouvert doublons fermer retrouver find tab open switch',
    shortcut: 'tabSearch',
    try: bar('tabs'),
    needs: 'tabSearch'
  },
  {
    id: 'page-text-search',
    task: 'fast',
    level: 'advanced',
    feature: 'page-content-index',
    name: 'discover.contenu-nom',
    where: 'discover.contenu-ou',
    whereVars: () => ({ path: settingsPath('pageIndex'), menu: menuPath('menu.archive', 'menu.afficher-l-historique') }),
    keywords: 'texte contenu phrase retrouver page lue historique plein texte full text content sentence history',
    shortcut: 'history',
    try: open({ panel: 'history' }),
    needs: 'pageContentIndex',
    isNew: true
  },
  {
    id: 'shortcut-help',
    task: 'fast',
    level: 'beginner',
    feature: 'shortcut-help',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.aide', 'menu.aide-des-raccourcis') }),
    keywords: 'raccourcis clavier touches aide liste shortcuts keyboard keys help cheat sheet',
    shortcut: 'shortcutHelp',
    try: open({ panel: 'shortcuts' }),
    needs: 'shortcutHelp'
  },

  // ---- Organiser mes onglets ----
  {
    id: 'spaces',
    task: 'organise',
    level: 'beginner',
    name: 'menu.espaces',
    summary: 'discover.espaces-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.espaces', 'manage-panels.gerer-les-espaces') }),
    keywords: 'profils groupes couleur travail perso projets separer spaces profiles work personal colour',
    shortcut: 'manageSpaces',
    try: open({ panel: 'spaces' })
  },
  {
    id: 'split-view',
    task: 'organise',
    level: 'advanced',
    name: 'discover.scinde-nom',
    summary: 'discover.scinde-resume',
    where: 'discover.scinde-ou',
    whereVars: () => ({ button: t('toolbar.ajouter-une-vue-scindee') }),
    keywords: 'cote a cote deux pages split grille ecran volet side by side two pages pane',
    shortcut: 'addSplit',
    try: bar('split')
  },
  {
    id: 'tab-reminders',
    task: 'organise',
    level: 'beginner',
    feature: 'tab-reminders',
    where: 'discover.rappel-ou',
    whereVars: () => ({ remind: t('reminder.me-le-rappeler'), menu: menuPath('menu.fichier', 'reminder.rappels-en-attente') }),
    keywords: 'plus tard programmer notification alarme heure revenir later remind alarm snooze',
    try: { kind: 'hint' },
    needs: 'tabReminders',
    isNew: true
  },
  {
    id: 'work-views',
    task: 'organise',
    level: 'advanced',
    feature: 'work-views',
    where: 'discover.vues-ou',
    whereVars: () => ({ path: settingsPath('workViews') }),
    keywords: 'vue travail groupe de sites ouvrir ensemble workspace layout work view sites together',
    try: open({ panel: 'workview' }),
    needs: 'workViewsEnabled'
  },
  {
    id: 'space-transfer',
    task: 'organise',
    level: 'advanced',
    name: 'discover.transfert-nom',
    summary: 'discover.transfert-resume',
    where: 'discover.transfert-ou',
    whereVars: () => ({ export: menuPath('menu.espaces', 'space-transfer.exporter-cet-espace'), import: menuPath('menu.espaces', 'space-transfer.importer-un-espace') }),
    keywords: 'exporter importer espace autre mac fichier sauvegarde export import space another mac file backup move',
    try: { kind: 'hint' },
    setting: { panel: 'settings', pane: 'tabs' },
    isNew: true
  },
  {
    id: 'archive',
    task: 'organise',
    level: 'beginner',
    name: 'menu.archive',
    summary: 'discover.archive-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.archive', 'keybindings.afficher-l-archive') }),
    keywords: 'onglets fermes retrouver rouvrir ranges historique closed tabs restore reopen history',
    shortcut: 'archive',
    try: open({ panel: 'archive' }),
    setting: { panel: 'settings', pane: 'tabs' }
  },

  // ---- Lire et travailler ----
  {
    id: 'mini-window',
    task: 'read',
    level: 'beginner',
    name: 'little-arc-settings.mini-fenetre',
    summary: 'discover.mini-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.nouvelle-mini-fenetre') }),
    keywords: 'apercu previsualiser lien petite fenetre flottante popup preview little window floating',
    shortcut: 'newLittleArc',
    try: bar('little'),
    setting: { panel: 'settings', pane: 'navigation', anchor: 'links' }
  },
  {
    id: 'glance',
    task: 'read',
    level: 'advanced',
    feature: 'peek-shift',
    name: 'discover.coup-d-oeil-nom',
    summary: 'discover.coup-d-oeil-resume',
    where: 'discover.coup-d-oeil-ou',
    whereVars: () => ({ path: settingsPath('glance') }),
    keywords: 'apercu lien maj clic carte peek glance preview shift click',
    try: { kind: 'hint' },
    needs: 'peekWithShift',
    setting: { panel: 'settings', pane: 'navigation', anchor: 'links' }
  },
  {
    id: 'find',
    task: 'read',
    level: 'beginner',
    name: 'cmd.rechercher-dans-la-page',
    summary: 'discover.chercher-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.edition', 'cmd.rechercher-dans-la-page') }),
    keywords: 'chercher mot texte page occurrence trouver remplacer find word text occurrence replace',
    shortcut: 'find',
    try: open({ panel: 'find' }),
    setting: { panel: 'settings', pane: 'navigation' }
  },
  {
    id: 'notes',
    task: 'read',
    level: 'beginner',
    feature: 'notes',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.notes') }),
    keywords: 'memo ecrire bloc-notes prendre note noter jotter memo write notepad',
    shortcut: 'notes',
    try: open({ panel: 'notes' }),
    needs: 'notes'
  },
  {
    id: 'floating-video',
    task: 'read',
    level: 'advanced',
    feature: 'auto-pip',
    name: 'discover.pip-nom',
    summary: 'discover.pip-resume',
    where: 'discover.pip-ou',
    whereVars: () => ({ path: settingsPath('pictureInPicture') }),
    keywords: 'video image dans image flottante twitch youtube direct live picture in picture floating pip',
    try: { kind: 'hint' },
    isNew: true
  },
  {
    id: 'scroll-memory',
    task: 'read',
    level: 'advanced',
    feature: 'remember-scroll',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('rememberScroll') }),
    keywords: 'position defilement relancer retrouver ou j en etais scroll position relaunch restore where i was',
    try: { kind: 'setting' },
    isNew: true
  },

  // ---- Garder et capturer ----
  {
    id: 'capture',
    task: 'keep',
    level: 'beginner',
    name: 'discover.capture-nom',
    summary: 'discover.capture-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.capturer') }),
    keywords: 'capture ecran image zone annoter dessiner screenshot screen picture annotate draw',
    shortcut: 'captureRegion',
    try: open({ panel: 'capture' }),
    setting: { panel: 'settings', pane: 'files' }
  },
  {
    id: 'capture-full',
    task: 'keep',
    level: 'advanced',
    name: 'discover.entiere-nom',
    summary: 'discover.entiere-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.capturer-la-page-entiere') }),
    keywords: 'capture page entiere longue defiler haut en bas full page long scroll whole screenshot',
    shortcut: 'captureFull',
    try: { kind: 'call', call: 'captureFullPage' },
    setting: { panel: 'settings', pane: 'files' },
    isNew: true
  },
  {
    id: 'markdown',
    task: 'keep',
    level: 'advanced',
    name: 'discover.markdown-nom',
    summary: 'discover.markdown-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.enregistrer-la-page-en-markdown') }),
    keywords: 'exporter md texte article sauvegarder obsidian save export markdown article text notes',
    shortcut: 'saveMarkdown',
    try: { kind: 'call', call: 'saveMarkdown' },
    setting: { panel: 'settings', pane: 'files' },
    isNew: true
  },
  {
    id: 'bookmarks',
    task: 'keep',
    level: 'beginner',
    feature: 'bookmarks',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.signets') }),
    keywords: 'signets marque-pages favoris etiquettes tags bookmarks favourites favorites save pages',
    shortcut: 'bookmarkList',
    try: open({ panel: 'bookmarks' }),
    needs: 'bookmarkManager'
  },
  {
    id: 'read-later',
    task: 'keep',
    level: 'beginner',
    name: 'discover.plus-tard-nom',
    summary: 'discover.plus-tard-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.liste-de-lecture') }),
    keywords: 'lire plus tard mettre de cote liste de lecture read later reading list save for later',
    shortcut: 'readLaterList',
    try: open({ panel: 'readlater' }),
    setting: { panel: 'settings', pane: 'tabs' }
  },
  {
    id: 'sessions',
    task: 'keep',
    level: 'advanced',
    name: 'menu.sessions',
    summary: 'discover.sessions-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.sessions') }),
    keywords: 'sessions enregistrer onglets ouverts rouvrir ensemble save open tabs restore group',
    shortcut: 'sessions',
    try: open({ panel: 'sessions' }),
    setting: { panel: 'settings', pane: 'tabs' }
  },

  // ---- Me concentrer ----
  {
    id: 'focus-mode',
    task: 'focus',
    level: 'advanced',
    feature: 'focus-mode',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('focusSites') }),
    keywords: 'concentration distraction travailler bloquer sites minuteur pomodoro pause focus distractions block timer',
    try: { kind: 'setting' },
    isNew: true
  },
  {
    id: 'compact-mode',
    task: 'focus',
    level: 'advanced',
    feature: 'compact-mode',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('compactMode') }),
    keywords: 'compact masquer barre laterale plein ecran epure minimal hide sidebar clean distraction free',
    shortcut: 'toggleCompact',
    try: { kind: 'setting' }
  },

  // ---- Protéger ma vie privée ----
  {
    id: 'protection',
    task: 'protect',
    level: 'beginner',
    name: 'discover.protection-nom',
    summary: 'discover.protection-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('protection') }),
    keywords: 'pub publicites bloqueur cookies suivi vie privee adblock traqueurs bannieres ads blocker tracking privacy banners',
    shortcut: 'settings',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'protection' }
  },
  {
    id: 'third-party-cookies',
    task: 'protect',
    level: 'advanced',
    feature: 'third-party-cookies',
    summary: 'discover.tiers-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('thirdPartyCookies') }),
    keywords: 'cookies tiers suivi pistage publicite third party tracking cross site block',
    try: { kind: 'setting' },
    isNew: true
  },
  {
    id: 'site-javascript',
    task: 'protect',
    level: 'advanced',
    name: 'discover.javascript-nom',
    summary: 'discover.javascript-resume',
    where: 'discover.javascript-ou',
    whereVars: () => ({ button: t('toolbar.infos-et-reglages-du-site') }),
    keywords: 'javascript scripts couper desactiver site page sans script turn off disable scripts site',
    shortcut: 'siteInfo',
    try: open({ panel: 'site' }),
    setting: { panel: 'settings', pane: 'protection' },
    isNew: true
  },
  {
    id: 'permission-once',
    task: 'protect',
    level: 'advanced',
    name: 'discover.cette-fois-nom',
    summary: 'discover.cette-fois-resume',
    where: 'discover.cette-fois-ou',
    whereVars: () => ({ button: t('permissions.autoriser-cette-fois') }),
    keywords: 'autorisation permission camera micro position notification cette fois une fois allow this time once',
    try: { kind: 'hint' },
    setting: { panel: 'settings', pane: 'protection', anchor: 'permissions' },
    isNew: true
  },
  {
    id: 'totp',
    task: 'protect',
    level: 'advanced',
    feature: 'password-manager',
    name: 'discover.totp-nom',
    summary: 'discover.totp-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.mots-de-passe') }),
    keywords: 'totp 2fa double authentification code usage unique mot de passe coffre authenticator two factor one time password vault',
    shortcut: 'passwords',
    try: open({ panel: 'passwords' }),
    needs: 'passwordManager',
    isNew: true
  },
  {
    id: 'private-tab',
    task: 'protect',
    level: 'beginner',
    feature: 'private-tabs',
    name: 'discover.prive-nom',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.fichier', 'menu.nouvel-onglet-prive') }),
    keywords: 'onglet prive incognito navigation privee sans trace private tab incognito no trace',
    shortcut: 'newPrivateTab',
    try: { kind: 'call', call: 'newPrivateTab' },
    needs: 'privateTabs'
  },
  {
    id: 'cookie-manager',
    task: 'protect',
    level: 'advanced',
    feature: 'cookie-manager',
    summary: 'discover.cookies-resume',
    where: 'discover.menu-ou',
    whereVars: () => ({ menu: menuPath('menu.affichage', 'menu.cookies-par-site') }),
    keywords: 'cookies par site effacer nettoyer garder sites clear clean keep per site',
    shortcut: 'cookieManager',
    try: open({ panel: 'cookies' }),
    needs: 'cookieManager'
  }
]

// ---------- the registry, by task ----------

/** The task of every function of the registry: a function added to `FEATURES` without one does not compile. */
export const FEATURE_TASKS: Readonly<Record<FeatureId, DiscoverTask>> = {
  sleep: 'organise',
  'auto-archive': 'organise',
  'auto-pip': 'read',
  'media-player': 'read',
  'tab-state-badges': 'organise',
  boosts: 'read',
  'block-ads': 'protect',
  'block-cookie-banners': 'protect',
  'block-scriptlets': 'protect',
  fingerprint: 'protect',
  'https-first': 'protect',
  'global-privacy-control': 'protect',
  'third-party-cookies': 'protect',
  'strip-tracking': 'protect',
  'search-suggestions': 'fast',
  'theme-to-sites': 'read',
  'peek-shift': 'read',
  'peek-external': 'read',
  'external-links-little': 'read',
  'little-shortcut': 'fast',
  'little-archive': 'read',
  'little-modifier': 'read',
  'little-new-tab-links': 'read',
  'little-download-bubble': 'keep',
  'auto-backup': 'keep',
  favicons: 'organise',
  'tidy-downloads': 'keep',
  'native-hosts': 'read',
  'hover-cards': 'organise',
  'tidy-pinned-titles': 'organise',
  'reload-all-button': 'organise',
  'full-url': 'fast',
  'window-drag': 'organise',
  'auto-update': 'protect',
  'warn-quit': 'protect',
  'restore-windows': 'organise',
  'sidebar-right': 'organise',
  'web-panels': 'read',
  'screen-share': 'read',
  'tab-memory': 'organise',
  'download-status-chip': 'keep',
  'favorite-names': 'organise',
  'resource-gauge': 'organise',
  'boost-sharing': 'read',
  'web-store': 'read',
  'strip-copied-links': 'protect',
  'history-off': 'protect',
  doh: 'protect',
  proxy: 'protect',
  'cookie-manager': 'protect',
  'private-tabs': 'protect',
  'guest-profile': 'protect',
  'clear-on-close': 'protect',
  'custom-filter-lists': 'protect',
  lock: 'protect',
  'password-manager': 'protect',
  'reopen-history': 'organise',
  'extension-overflow': 'organise',
  'extension-data-apis': 'read',
  'extension-tab-capture': 'keep',
  'user-scripts': 'read',
  'qr-code': 'keep',
  'auto-scroll': 'read',
  'scroll-sync': 'read',
  'remember-scroll': 'read',
  'work-views': 'organise',
  'mouse-gestures': 'fast',
  'space-swipe': 'fast',
  'page-content-index': 'fast',
  'page-watch': 'read',
  'focus-mode': 'focus',
  'read-aloud': 'read',
  'battery-saver': 'focus',
  'download-pause': 'keep',
  'download-resume': 'keep',
  'download-ask-where': 'keep',
  'open-with': 'keep',
  'open-unsaved': 'keep',
  'pdf-with-source': 'keep',
  'read-later-folders': 'keep',
  'card-outline': 'focus',
  'back-closes-tab': 'fast',
  'tab-cycle-recent': 'fast',
  'drag-to-split': 'organise',
  'warn-close-window': 'protect',
  'zoom-indicator': 'read',
  'name-windows': 'organise',
  'search-bangs': 'fast',
  'search-discovery': 'fast',
  'interface-language': 'read',
  'translate-local': 'read',
  'command-bar-calc': 'fast',
  'tab-search': 'fast',
  'shortcut-help': 'fast',
  'vim-keys': 'fast',
  'tab-groups-ext': 'organise',
  'omnibox-keywords': 'fast',
  'find-regex': 'read',
  'compact-mode': 'focus',
  'tab-tree': 'organise',
  'web-hardware': 'protect',
  'annotate-capture': 'keep',
  applescript: 'fast',
  containers: 'protect',
  'independent-windows': 'organise',
  'tab-reminders': 'organise',
  bookmarks: 'keep',
  notes: 'read',
  'live-folders': 'organise',
  'whats-new': 'read',
  pwa: 'read',
  'document-pip': 'read'
}

/** The card of a function of the registry, when it has one (the first, a function is on one card at most). */
const cardOf = (id: FeatureId): DiscoverEntry | undefined => DISCOVER_ENTRIES.find((entry) => entry.feature === id)

// ---------- what a card says ----------

/** The name of a card, in the language of the moment: its own, or the registry's. */
export function discoverName(entry: DiscoverEntry): string {
  if (entry.name !== undefined) return t(entry.name)
  return featureById(entry.feature!).label
}

/** The line of a card: its own, or the first sentence of the description of its function. */
export function discoverSummary(entry: DiscoverEntry): string {
  if (entry.summary !== undefined) return t(entry.summary)
  return featureLine(featureById(entry.feature!))
}

/** The sentence that says where to find the function. */
export function discoverWhere(entry: DiscoverEntry): string {
  return t(entry.where, entry.whereVars?.())
}

/** The keys of the shortcut in force for the card, as capsules (`keys`) and as a text (`text`: « ⇧⌘2 », « Ctrl+Maj+2 »); null when the card has no command or the command has no key. */
export function discoverKeys(entry: DiscoverEntry, bindings: KeyBindings | undefined, platform: PlatformId): { keys: string[]; text: string } | null {
  if (entry.shortcut === undefined) return null
  const accelerator = effectiveAccelerator(entry.shortcut, bindings, platform)
  if (accelerator === undefined) return null
  const text = formatAccelerator(accelerator, platform)
  const keys = acceleratorKeys(accelerator, platform)
  return { keys: keys.length > 0 ? keys : [text], text }
}

/** Whether the function of a card is switched off, so that its button could do nothing. */
export const discoverOff = (entry: DiscoverEntry, settings: Pick<Settings, BooleanSettingKey>): boolean => entry.needs !== undefined && !settings[entry.needs]

/** The page of the Settings that draws the row of a setting; « Fonctions en option » for a setting no page draws (a feature added before its row). */
export const settingsPageOf = (key: string): SettingsPage => categoryOfKey(key) ?? 'features'

/** « Régler »: the page of the Settings that holds the function (its setting when the registry gives it one, else « Fonctions en option »). */
export function discoverSettingsRequest(entry: DiscoverEntry): SettingsRequest {
  if (entry.setting !== undefined) return entry.setting
  return { panel: 'settings', pane: entry.feature !== undefined ? settingsPageOf(featureById(entry.feature).key) : 'features' }
}

// ---------- the search ----------

export interface DiscoverFilter {
  query: string
  task: DiscoverTask | 'all'
  level: DiscoverLevel | 'all'
}

/**
 * The cards that answer the words and the filters, in the order of the catalogue. The search is the one of the Settings (shared/settings-search.ts): every
 * word must begin a word of the name, the line, the place or the keywords, accents, case, plural and the common words aside, in French and in English.
 */
export function filterDiscover(filter: DiscoverFilter, entries: readonly DiscoverEntry[] = DISCOVER_ENTRIES): DiscoverEntry[] {
  const words = queryWords(filter.query)
  return entries.filter((entry) => {
    if (filter.task !== 'all' && entry.task !== filter.task) return false
    if (filter.level !== 'all' && entry.level !== filter.level) return false
    return words.length === 0 || matchesWords(`${discoverName(entry)} ${discoverSummary(entry)} ${discoverWhere(entry)} ${entry.keywords}`, words)
  })
}

/** How many cards each chip would show: `all`, and one count per task. */
export function taskCounts(entries: readonly DiscoverEntry[]): Record<DiscoverTask | 'all', number> {
  const counts = { all: entries.length, fast: 0, organise: 0, read: 0, keep: 0, focus: 0, protect: 0 }
  for (const entry of entries) counts[entry.task]++
  return counts
}

/** A function of the registry that has no card: its name, its line, its task and the page of the Settings that holds it. */
export interface OtherFeature {
  feature: ReturnType<typeof featureById>
  task: DiscoverTask
  name: string
  line: string
  request: SettingsRequest
}

/**
 * « Toutes les autres fonctions »: the registry without the functions that have a card, by the words and the task. They all are for those who go further:
 * the level « Pour débuter » leaves them out.
 */
export function otherFeatures(filter: DiscoverFilter): OtherFeature[] {
  if (filter.level === 'beginner') return []
  const words = queryWords(filter.query)
  const rows: OtherFeature[] = []
  for (const feature of FEATURES) {
    const id = feature.id as FeatureId
    if (cardOf(id) !== undefined) continue
    const task = FEATURE_TASKS[id]
    if (filter.task !== 'all' && task !== filter.task) continue
    const name = feature.label
    const line = featureLine(feature)
    if (words.length > 0 && !matchesWords(`${name} ${line}`, words)) continue
    rows.push({ feature, task, name, line, request: { panel: 'settings', pane: settingsPageOf(feature.key) } })
  }
  return rows
}
