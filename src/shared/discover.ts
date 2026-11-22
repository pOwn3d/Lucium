// « Découvrir Lucium »: what Lucium can do, by what a person wants to do, with where to find it, its shortcut and a button that tries it. The panel
// (renderer/Discover.tsx) draws this catalogue; nothing here reads the window.
//
// Every function of Lucium has a card, in three layers (docs/fonctions.md, « Découvrir Lucium »), shown in this order under the task of each:
//  - the chosen cards (`DISCOVER_ENTRIES`): some thirty functions with the words a person may search them by (French and English), what the button does,
//    the command whose shortcut the card shows (read from the shortcuts in force, never written in a text) and one sentence that says where to find it.
//  - the functions without a switch (`DISCOVER_EXTRAS`): what docs/fonctions.md lists under « Fonctions sans interrupteur » and the menus, the panels and the
//    gestures that have no entry in the registry (reader mode, the task manager, the move of a tab…), written like the chosen cards.
//  - the rest of the registry (`REGISTRY_ENTRIES`): one card for each function of features.ts that has none yet, with the name and the line of the registry,
//    the page of the Settings that holds it and « Régler ». `FEATURE_TASKS` gives each of them a task, and a function added to the registry without one does
//    not compile; discover.test.ts fails for a function of the registry that has no card.
// What a button does is one of four things, and never something new: it opens a panel the interface may open (the main process checks it:
// main/shell/discover-wiring.test.ts), it makes a call the interface already makes, it opens the Settings, or, when the function needs a page or a click
// on a tab, it does nothing and the sentence says how to start it.

import { featureById, featureLine, FEATURES, isFeatureShownOn, type BooleanSettingKey, type Feature, type FeatureId } from './features'
import { SCOPE_PREFIX } from './command-bar-groups'
import { acceleratorKeys, effectiveAccelerator, formatAccelerator, type KeyBindings } from './keybindings'
import { matchesWords, queryWords } from './settings-search'
import { categoryOfKey, settingsPaneLabel } from './settings-catalog'
import { settingsPath, settingsPathSteps } from './settings-path'
import { t, type MessageKey, type Vars } from './i18n'
import { PAGE_TOGGLE_SHORTCUT } from './page-annotate'
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
  /**
   * The menu paths the sentence names, as the keys of the labels of the menus (`{menu}` of « Menu {menu}. » is `menus.menu`): written as data so that
   * discover-wiring.test.ts can compare each one with the menus as they are built. A path that is not a menu of the bar is not written here.
   */
  menus?: Readonly<Record<string, readonly MessageKey[]>>
  /** Words a person may search it by, French and English, without accents: the search also reads the name, the line and the place. */
  keywords: string
  /** The command whose shortcut the card shows (shared/keybindings.ts `COMMANDS`): the keys in force, so a key the person changed shows. */
  shortcut?: string
  /** The keys of a function whose shortcut is not a command of the list and cannot be changed there (the annotation of the page): shown as they are. */
  fixedKey?: string
  try: DiscoverTry
  /** The setting that must be on for the function to work: the card says it is switched off, and the button that needs it is not offered. */
  needs?: BooleanSettingKey
  /** Where « Régler » leads, when it is not the page of the setting of `feature`. */
  setting?: SettingsRequest
  /** A card made from the registry alone (name, line and place of the setting come from `features.ts`): the third layer. */
  fromRegistry?: true
  /** « Nouveau »: a function of the version in preparation. The mark is taken off by the next version (docs/fonctions.md). */
  isNew?: true
}

/** « Fichier › Capturer »: the path of a menu entry, in the language of the moment; a trailing ellipsis is dropped, it would end a sentence badly. */
export const menuPath = (keys: readonly MessageKey[]): string => keys.map((key) => t(key).replace(/…$/, '')).join(' › ')

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
    menus: { menu: ['menu.fichier', 'menu.ouvrir-la-barre-de-commandes'] },
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
    menus: { menu: ['menu.onglets', 'menu.rechercher-un-onglet'] },
    keywords: 'trouver onglet ouvert doublons fermer retrouver find tab open switch',
    shortcut: 'tabSearch',
    try: bar('tabs'),
    needs: 'tabSearch'
  },
  {
    id: 'tab-grid',
    task: 'fast',
    level: 'beginner',
    feature: 'tab-grid',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.onglets', 'menu.vue-d-ensemble-des-onglets'] },
    keywords: 'grille vignettes apercu onglets ouverts visuel retrouver fermer deplacer overview grid thumbnails tabs visual',
    shortcut: 'tabGrid',
    try: open({ panel: 'tabgrid' }),
    needs: 'tabGrid',
    isNew: true
  },
  {
    id: 'page-text-search',
    task: 'fast',
    level: 'advanced',
    feature: 'page-content-index',
    name: 'discover.contenu-nom',
    where: 'discover.contenu-ou',
    whereVars: () => ({ path: settingsPath('pageIndex') }),
    menus: { menu: ['menu.archive', 'menu.afficher-l-historique'] },
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
    menus: { menu: ['menu.aide', 'menu.aide-des-raccourcis'] },
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
    menus: { menu: ['menu.espaces', 'manage-panels.gerer-les-espaces'] },
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
    whereVars: () => ({ remind: t('reminder.me-le-rappeler') }),
    menus: { menu: ['menu.fichier', 'reminder.rappels-en-attente'] },
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
    menus: { export: ['menu.espaces', 'space-transfer.exporter-cet-espace'], import: ['menu.espaces', 'space-transfer.importer-un-espace'] },
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
    menus: { menu: ['menu.archive', 'keybindings.afficher-l-archive'] },
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
    menus: { menu: ['menu.fichier', 'menu.nouvelle-mini-fenetre'] },
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
    where: 'discover.recherche-ou',
    whereVars: () => ({ item: t('menu.rechercher-2') }),
    menus: { menu: ['menu.edition', 'menu.rechercher'] },
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
    menus: { menu: ['menu.fichier', 'menu.notes'] },
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
    menus: { menu: ['menu.fichier', 'menu.capturer'] },
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
    menus: { menu: ['menu.fichier', 'menu.capturer-la-page-entiere'] },
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
    menus: { menu: ['menu.fichier', 'menu.enregistrer-la-page-en-markdown'] },
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
    menus: { menu: ['menu.fichier', 'menu.signets'] },
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
    menus: { menu: ['menu.fichier', 'menu.liste-de-lecture'] },
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
    menus: { menu: ['menu.fichier', 'menu.sessions'] },
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
    id: 'bypass-redirects',
    task: 'protect',
    level: 'advanced',
    feature: 'bypass-redirects',
    summary: 'discover.contournement-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('redirectBypass') }),
    keywords: 'redirection suivi lien amp pistage deplier adresse finale redirect tracking link unwrap debounce de-amp canonical',
    try: { kind: 'setting' },
    isNew: true
  },
  {
    id: 'safe-browsing',
    task: 'protect',
    level: 'beginner',
    feature: 'safe-browsing',
    summary: 'discover.sure-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('safeBrowsing') }),
    keywords: 'navigation sure hameconnage phishing malware logiciels malveillants site dangereux avertissement liste safe browsing warning dangerous',
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
    menus: { menu: ['menu.fichier', 'menu.mots-de-passe'] },
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
    menus: { menu: ['menu.fichier', 'menu.nouvel-onglet-prive'] },
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
    menus: { menu: ['menu.affichage', 'menu.cookies-par-site'] },
    keywords: 'cookies par site effacer nettoyer garder sites clear clean keep per site',
    shortcut: 'cookieManager',
    try: open({ panel: 'cookies' }),
    needs: 'cookieManager'
  }
]

// ---------- the functions that have no switch ----------

/**
 * What the registry does not hold: the functions of docs/fonctions.md « Fonctions sans interrupteur » (nothing to switch off, so no entry in features.ts), and
 * the menus, panels and gestures of everyday use. Written like the chosen cards; every menu path they name is compared with the menus as they are built
 * (main/shell/discover-wiring.test.ts).
 */
export const DISCOVER_EXTRAS: readonly DiscoverEntry[] = [
  // ---- Protéger ma vie privée ----
  {
    id: 'history-range',
    task: 'protect',
    level: 'advanced',
    name: 'discover.historique-periode-nom',
    summary: 'discover.historique-periode-resume',
    where: 'discover.historique-periode-ou',
    whereVars: () => ({ path: settingsPath('historyKeep'), menu: menuPath(['menu.archive', 'menu.afficher-l-historique']) }),
    menus: { menu: ['menu.archive', 'menu.afficher-l-historique'] },
    keywords: 'effacer historique heure aujourd hui semaine tout periode plage vider supprimer clear history hour today week range delete forget',
    shortcut: 'history',
    try: open({ panel: 'history' }),
    isNew: true
  },
  {
    id: 'history-keep',
    task: 'protect',
    level: 'advanced',
    feature: 'history-purge',
    name: 'discover.historique-garder-nom',
    summary: 'discover.historique-garder-resume',
    where: 'discover.historique-garder-ou',
    whereVars: () => ({ path: settingsPath('historyKeep') }),
    keywords: 'historique garder conserver jours purge automatique oublier ancien 30 90 history keep days auto delete purge expire old',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'protection' },
    isNew: true
  },
  // ---- Aller plus vite ----
  {
    id: 'guided-setup',
    task: 'fast',
    level: 'beginner',
    name: 'discover.guide-nom',
    summary: 'discover.guide-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.aide', 'menu.configuration-rapide'] },
    keywords: 'regler questions configuration rapide guide assistant demarrer premier lancement setup questions guided quick configure',
    try: open({ panel: 'settings', pane: 'general', anchor: 'guide' }),
    setting: { panel: 'settings', pane: 'general', anchor: 'guide' }
  },
  {
    id: 'settings-search',
    task: 'fast',
    level: 'beginner',
    name: 'discover.reglages-nom',
    summary: 'discover.reglages-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.lucium', 'menu.reglages'] },
    keywords: 'reglages preferences options chercher reglage parametres settings preferences options search setting',
    shortcut: 'settings',
    try: open({ panel: 'settings', pane: 'home' }),
    setting: { panel: 'settings', pane: 'home' }
  },
  {
    id: 'presets',
    task: 'fast',
    level: 'beginner',
    name: 'discover.prereglages-nom',
    summary: 'discover.prereglages-resume',
    where: 'discover.prereglages-ou',
    keywords: 'prereglage preset niveau protection veille lancement liens plusieurs reglages d un coup standard renforcee stricte level sleep launch links at once',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'home' }
  },
  {
    id: 'shortcuts-custom',
    task: 'fast',
    level: 'advanced',
    name: 'discover.raccourcis-nom',
    summary: 'discover.raccourcis-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('shortcuts') }),
    keywords: 'raccourcis clavier touches personnaliser changer modifier combinaison shortcuts keyboard keys customise customize change rebind',
    shortcut: 'shortcutHelp',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'keyboard', anchor: 'shortcuts' }
  },
  {
    id: 'copy-markdown',
    task: 'fast',
    level: 'advanced',
    name: 'menu.copier-l-adresse-en-markdown',
    summary: 'discover.copier-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.edition', 'menu.copier-l-adresse-en-markdown'] },
    keywords: 'copier adresse lien markdown citation coller url copy address link quote paste',
    shortcut: 'copyUrlMarkdown',
    try: { kind: 'hint' }
  },
  {
    id: 'drop-links',
    task: 'fast',
    level: 'advanced',
    name: 'discover.depot-nom',
    summary: 'discover.depot-resume',
    where: 'discover.depot-ou',
    keywords: 'deposer glisser fichier lien disque pdf image ouvrir drop drag file link disk open',
    try: { kind: 'hint' }
  },

  // ---- Organiser mes onglets ----
  {
    id: 'space-themes',
    task: 'organise',
    level: 'beginner',
    name: 'discover.themes-nom',
    summary: 'discover.themes-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.espaces', 'menu.modifier-le-theme'] },
    keywords: 'theme couleur fond image gif video arriere plan personnaliser espace background colour color wallpaper customise customize',
    shortcut: 'editTheme',
    try: { kind: 'hint' },
    setting: { panel: 'settings', pane: 'appearance' }
  },
  {
    id: 'window-sidebar',
    task: 'organise',
    level: 'advanced',
    name: 'ctx.bloc-barre-de-cette-fenetre',
    summary: 'discover.barre-fenetre-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.affichage', 'menu.replier-la-barre-dans-cette-fenetre'] },
    keywords: 'barre laterale replier colonne icones cote droite gauche fenetre sidebar collapse icons side right left window',
    shortcut: 'dockSidebar',
    try: { kind: 'hint' },
    setting: { panel: 'settings', pane: 'appearance' }
  },
  {
    id: 'move-tab',
    task: 'organise',
    level: 'advanced',
    name: 'discover.deplacer-onglet-nom',
    summary: 'discover.deplacer-onglet-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.onglets', 'menu.deplacer-l-onglet-vers-le-haut'] },
    keywords: 'deplacer onglet haut bas ordre monter descendre clavier move tab up down order reorder keyboard',
    shortcut: 'moveTabUp',
    try: { kind: 'hint' }
  },
  {
    id: 'move-to-window',
    task: 'organise',
    level: 'advanced',
    name: 'ctx.deplacer-vers-la-fenetre',
    summary: 'discover.fenetre-resume',
    where: 'discover.fenetre-ou',
    whereVars: () => ({ item: t('ctx.deplacer-vers-la-fenetre') }),
    keywords: 'deplacer onglet autre fenetre envoyer nouvelle fenetre move tab other window send new window',
    try: { kind: 'hint' }
  },
  {
    id: 'auto-reload',
    task: 'organise',
    level: 'advanced',
    name: 'menu.recharger-automatiquement',
    summary: 'discover.recharger-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.affichage', 'menu.recharger-automatiquement'] },
    keywords: 'recharger actualiser intervalle automatique page surveiller toutes les secondes reload refresh interval automatic every seconds',
    try: { kind: 'hint' }
  },
  {
    id: 'task-manager',
    task: 'organise',
    level: 'advanced',
    name: 'discover.taches-nom',
    summary: 'discover.taches-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.aide', 'menu.depannage', 'menu.ouvrir-le-gestionnaire-de-taches'] },
    keywords: 'gestionnaire taches memoire processeur onglet lourd fermer ralentit task manager memory cpu heavy tab slow',
    shortcut: 'taskManager',
    try: { kind: 'hint' }
  },
  {
    id: 'app-icon',
    task: 'organise',
    level: 'advanced',
    name: 'discover.icone-nom',
    summary: 'discover.icone-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('appIcon') }),
    keywords: 'icone application dock couleur logo version app icon dock colour color logo',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'about', anchor: 'icon' }
  },
  {
    id: 'panel-size',
    task: 'organise',
    level: 'advanced',
    name: 'discover.taille-nom',
    summary: 'discover.taille-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: pagePath('appearance') }),
    keywords: 'taille fenetres panneaux ecran grand petit ultra large zoom interface size windows panels screen large small ultrawide',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'appearance', anchor: 'panelsize' }
  },
  {
    id: 'glass-effect',
    task: 'organise',
    level: 'advanced',
    name: 'discover.verre-nom',
    summary: 'discover.verre-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: pagePath('appearance') }),
    keywords: 'verre transparence vibrancy opacite barre laterale fenetre translucide glass transparency opacity sidebar window translucent',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'appearance' }
  },

  // ---- Lire et travailler ----
  {
    id: 'reader-mode',
    task: 'read',
    level: 'beginner',
    name: 'menu.mode-lecture',
    summary: 'discover.lecture-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.affichage', 'menu.mode-lecture'] },
    keywords: 'lecture article epure lisible texte sans pub readability reader article clean readable text distraction',
    shortcut: 'readerMode',
    try: { kind: 'hint' }
  },
  {
    id: 'find-replace',
    task: 'read',
    level: 'advanced',
    name: 'menu.trouver-et-remplacer',
    summary: 'discover.remplacer-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.edition', 'menu.rechercher', 'menu.trouver-et-remplacer'] },
    keywords: 'remplacer chercher mot champ texte formulaire changer replace find word field text form change',
    shortcut: 'findReplace',
    try: open({ panel: 'findreplace' }),
    setting: { panel: 'settings', pane: 'navigation' }
  },
  {
    id: 'extensions-page',
    task: 'read',
    level: 'beginner',
    name: 'menu.extensions',
    summary: 'discover.extensions-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.extensions', 'menu.gerer-les-extensions'] },
    keywords: 'extensions modules complements chrome web store ajouter installer gerer add ons plugins install manage',
    shortcut: 'manageExtensions',
    try: open({ panel: 'extensions' }),
    setting: { panel: 'settings', pane: 'tools' }
  },
  {
    id: 'developer-tools',
    task: 'read',
    level: 'advanced',
    name: 'menu.outils-de-developpement',
    summary: 'discover.dev-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.affichage', 'menu.developpeur', 'menu.outils-de-developpement'] },
    keywords: 'developpeur outils inspecter console reseau source code page devtools developer inspect console network source',
    shortcut: 'devTools',
    try: { kind: 'hint' }
  },
  {
    id: 'page-summary',
    task: 'read',
    level: 'advanced',
    name: 'discover.resume-page-nom',
    summary: 'discover.resume-page-resume',
    where: 'discover.resume-page-ou',
    whereVars: () => ({ path: settingsPath('summary') }),
    menus: { menu: ['menu.fichier', 'menu.resumer-la-page'] },
    keywords: 'resume resumer page article modele local ollama texte court summary summarize page article local model text short',
    try: { kind: 'hint' },
    needs: 'aiSummary',
    setting: { panel: 'settings', pane: 'features' }
  },

  // ---- Garder et capturer ----
  {
    id: 'history',
    task: 'keep',
    level: 'beginner',
    name: 'discover.historique-nom',
    summary: 'discover.historique-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.archive', 'menu.afficher-l-historique'] },
    keywords: 'historique pages visitees retrouver site hier effacer history visited pages find site yesterday clear',
    shortcut: 'history',
    try: open({ panel: 'history' }),
    setting: { panel: 'settings', pane: 'protection' }
  },
  {
    id: 'downloads',
    task: 'keep',
    level: 'beginner',
    name: 'discover.telechargements-nom',
    summary: 'discover.telechargements-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.archive', 'menu.afficher-les-telechargements'] },
    keywords: 'telechargements fichiers telecharges dossier ouvrir downloads files downloaded folder open',
    shortcut: 'downloads',
    try: open({ panel: 'downloads' }),
    setting: { panel: 'settings', pane: 'files' }
  },
  {
    id: 'import-browser',
    task: 'keep',
    level: 'beginner',
    name: 'discover.import-nom',
    summary: 'discover.import-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.lucium', 'menu.importer-depuis-un-autre-navigateur'] },
    keywords: 'importer signets mots de passe historique chrome safari firefox arc autre navigateur import bookmarks passwords history other browser',
    shortcut: 'importData',
    try: open({ panel: 'import' })
  },
  {
    id: 'export-bookmarks',
    task: 'keep',
    level: 'advanced',
    name: 'discover.export-signets-nom',
    summary: 'discover.export-signets-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.lucium', 'menu.exporter-les-signets-html'] },
    keywords: 'exporter signets favoris fichier html sauvegarder autre navigateur export bookmarks favourites favorites file html backup',
    try: { kind: 'hint' }
  },
  {
    id: 'annotate-page',
    task: 'keep',
    level: 'advanced',
    name: 'menu.annoter-cette-page',
    summary: 'discover.annoter-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.fichier', 'menu.annoter-cette-page'] },
    keywords: 'annoter dessiner surligner flecher page ecran partager presenter annotate draw highlight arrow page screen share present',
    fixedKey: PAGE_TOGGLE_SHORTCUT,
    try: { kind: 'hint' }
  },

  // ---- Protéger ma vie privée ----
  {
    id: 'private-window',
    task: 'protect',
    level: 'beginner',
    name: 'menu.nouvelle-fenetre-privee',
    summary: 'discover.fenetre-privee-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.fichier', 'menu.nouvelle-fenetre-privee'] },
    keywords: 'fenetre privee incognito sans trace navigation privee private window incognito no trace private browsing',
    shortcut: 'privateWindow',
    try: { kind: 'hint' }
  },
  {
    id: 'clear-site-data',
    task: 'protect',
    level: 'advanced',
    name: 'discover.efface-site-nom',
    summary: 'discover.efface-site-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.archive', 'menu.effacer-les-donnees-du-site'] },
    keywords: 'effacer donnees site cookies stockage cache oublier nettoyer clear site data cookies storage cache forget clean',
    shortcut: 'clearSiteData',
    try: open({ panel: 'sitedata' }),
    setting: { panel: 'settings', pane: 'protection', anchor: 'sitedata' }
  },
  {
    id: 'profiles',
    task: 'protect',
    level: 'advanced',
    name: 'discover.profils-nom',
    summary: 'discover.profils-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.fichier', 'menu.nouveau-profil'] },
    keywords: 'profils separer travail perso cookies historique reglages propres profiles separate work personal cookies history own settings',
    shortcut: 'newProfile',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'profiles' }
  },
  {
    id: 'certificate-warning',
    task: 'protect',
    level: 'beginner',
    name: 'discover.certificat-nom',
    summary: 'discover.certificat-resume',
    where: 'discover.certificat-ou',
    keywords: 'certificat securite connexion pas privee https site dangereux avertissement certificate security connection not private https unsafe warning',
    try: { kind: 'hint' }
  },

  // ---- Added after the review: what the menus, the context menus and the Settings hold that the first pass left out ----
  {
    id: 'fake-fill',
    task: 'fast',
    level: 'advanced',
    name: 'discover.fausses-donnees-nom',
    summary: 'discover.fausses-donnees-resume',
    where: 'discover.fausses-donnees-ou',
    whereVars: () => ({ item: t('fake-fill.menu') }),
    keywords: 'formulaire remplir fausses donnees test faux nom adresse champ clic droit form fill fake data test dummy name address field right click',
    try: { kind: 'hint' }
  },
  {
    id: 'share-annotated-window',
    task: 'keep',
    level: 'advanced',
    name: 'discover.partage-annote-nom',
    summary: 'discover.partage-annote-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.fichier', 'menu.partager-une-fenetre-annotee'] },
    keywords: 'partager fenetre annotee visio visioconference presenter ecran dessiner share annotated window video call present screen draw',
    try: { kind: 'hint' }
  },
  {
    id: 'blank-window',
    task: 'fast',
    level: 'advanced',
    name: 'menu.fenetre-vierge',
    summary: 'discover.fenetre-vierge-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.fichier', 'menu.fenetre-vierge'] },
    keywords: 'fenetre vierge nouvelle vide sans barre commandes blank window new empty without command bar',
    shortcut: 'blankWindow',
    try: { kind: 'hint' }
  },
  {
    id: 'site-searches',
    task: 'fast',
    level: 'advanced',
    name: 'discover.recherches-site-nom',
    summary: 'discover.recherches-site-resume',
    where: 'discover.recherches-site-ou',
    whereVars: () => ({ path: settingsPath('siteSearches') }),
    keywords: 'recherche site mot cle raccourci tab yt youtube wikipedia moteur ajouter site search keyword shortcut tab engine add',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'navigation' }
  },
  {
    id: 'space-videos',
    task: 'organise',
    level: 'advanced',
    name: 'discover.videos-lucium-nom',
    summary: 'discover.videos-lucium-resume',
    where: 'discover.menu-ou',
    menus: { menu: ['menu.espaces', 'menu.modifier-le-theme'] },
    keywords: 'video fond espace fournies lucium pause arriere plan animee background space bundled paused animated wallpaper',
    shortcut: 'editTheme',
    try: { kind: 'hint' },
    setting: { panel: 'settings', pane: 'appearance' }
  },
  {
    id: 'annotate-bar-position',
    task: 'keep',
    level: 'advanced',
    name: 'discover.position-annotation-nom',
    summary: 'discover.position-annotation-resume',
    where: 'discover.position-annotation-ou',
    menus: { menu: ['menu.fichier', 'menu.annoter-cette-page'] },
    keywords: 'barre annotation position poignee deplacer droite gauche haut bas flottante annotate bar position handle move right left top bottom floating',
    try: { kind: 'hint' }
  },
  {
    id: 'delete-profile',
    task: 'protect',
    level: 'advanced',
    name: 'discover.supprimer-profil-nom',
    summary: 'discover.supprimer-profil-resume',
    where: 'discover.reglage-ou',
    whereVars: () => ({ path: settingsPath('profiles') }),
    keywords: 'supprimer profil effacer donnees cookies historique delete profile erase data cookies history remove',
    try: { kind: 'setting' },
    setting: { panel: 'settings', pane: 'profiles' }
  },
  {
    id: 'command-bar-preview',
    task: 'fast',
    level: 'beginner',
    name: 'discover.apercu-lignes-nom',
    summary: 'discover.apercu-lignes-resume',
    where: 'discover.apercu-lignes-ou',
    whereVars: () => ({ path: settingsPath('commandBarSize') }),
    keywords: 'apercu ligne barre commandes surbrillance colonne droite icone preview line command bar highlighted column right icon',
    try: { kind: 'hint' },
    setting: { panel: 'settings', pane: 'navigation' }
  }
]

/** « Réglages › Apparence »: the way to a page of the Settings, in the language of the moment. */
function pagePath(page: SettingsPage): string {
  return t('cmd.settings-pane', { pane: settingsPaneLabel(page) })
}

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
  'safe-browsing': 'protect',
  'strip-tracking': 'protect',
  'bypass-redirects': 'protect',
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
  'tab-grid': 'fast',
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
  'history-purge': 'protect',
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

/** The functions of the registry that a chosen card or a function without a switch already speaks of: they get no card from the registry alone. */
const carded = (): ReadonlySet<string> => new Set([...DISCOVER_ENTRIES, ...DISCOVER_EXTRAS].flatMap((entry) => (entry.feature !== undefined ? [entry.feature] : [])))

/** « Réglages › Vie privée et sécurité › Protection »: where the setting of a function of the registry is drawn (the page « Fonctions en option » for a setting no page draws). */
function registryPath(feature: Feature): string {
  const steps = categoryOfKey(feature.key) !== null ? settingsPathSteps({ key: feature.key }) : [settingsPaneLabel('features')]
  return t('cmd.settings-pane', { pane: steps.join(' › ') })
}

/**
 * The third layer: one card for every function of the registry that has none yet. It lends its name and its line, says where its setting is, and offers
 * « Régler ». They are for those who go further, so the level « Pour débuter » leaves them out.
 */
export const REGISTRY_ENTRIES: readonly DiscoverEntry[] = (() => {
  const done = carded()
  return FEATURES.flatMap((feature): DiscoverEntry[] => {
    const id = feature.id as FeatureId
    if (done.has(id)) return []
    return [{ id: `registry-${id}`, task: FEATURE_TASKS[id], level: 'advanced', feature: id, where: 'discover.reglage-ou', whereVars: () => ({ path: registryPath(feature) }), keywords: '', try: { kind: 'setting' }, fromRegistry: true }]
  })
})()

/** Every card of the panel, in the order it shows them under each task: the chosen ones first, then the functions without a switch, then the rest of the registry. */
export const ALL_DISCOVER_ENTRIES: readonly DiscoverEntry[] = [...DISCOVER_ENTRIES, ...DISCOVER_EXTRAS, ...REGISTRY_ENTRIES]

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
  const vars: Record<string, string | number> = { ...entry.whereVars?.() }
  for (const [name, keys] of Object.entries(entry.menus ?? {})) vars[name] = menuPath(keys)
  return t(entry.where, vars)
}

/** The keys of the shortcut in force for the card, as capsules (`keys`) and as a text (`text`: « ⇧⌘2 », « Ctrl+Maj+2 »); null when the card has no command or the command has no key. */
export function discoverKeys(entry: DiscoverEntry, bindings: KeyBindings | undefined, platform: PlatformId): { keys: string[]; text: string } | null {
  if (entry.shortcut === undefined && entry.fixedKey === undefined) return null
  const accelerator = entry.shortcut !== undefined ? effectiveAccelerator(entry.shortcut, bindings, platform) : entry.fixedKey
  if (accelerator === undefined) return null
  const text = formatAccelerator(accelerator, platform)
  const keys = acceleratorKeys(accelerator, platform)
  return { keys: keys.length > 0 ? keys : [text], text }
}

/** Whether the function of a card is switched off, so that its button could do nothing; a card of the registry alone says it from the switch of its function. */
export function discoverOff(entry: DiscoverEntry, settings: Settings): boolean {
  if (entry.needs !== undefined) return !settings[entry.needs]
  return entry.fromRegistry === true && entry.feature !== undefined && !isFeatureShownOn(settings, entry.feature)
}

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
export function filterDiscover(filter: DiscoverFilter, entries: readonly DiscoverEntry[] = ALL_DISCOVER_ENTRIES): DiscoverEntry[] {
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
