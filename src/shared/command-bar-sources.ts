// Where the rows of the command bar come from: the actions of each function that is on, and the tabs, spaces, bookmarks, sessions, panels,
// extensions and windows that match what is typed. `rankCandidates` (command-bar.ts) puts them together. Moved out of command-bar.ts as it was.

import { SETTINGS_ANCHORS, SETTINGS_PAGES, type ExtensionInfo } from './ipc'
import { ANCHOR_PANE, settingsAnchorLabel, settingsPaneLabel } from './settings-catalog'
import { tabName, type SidebarState, type SplitView, type TabItem } from './model'
import { autoReloadLabel, isAutoReloadable } from './auto-reload'
import { compactLabel, isCompact } from './compact'
import { isReadLaterUrl } from './read-later'
import { filterBookmarks, isBookmarkUrl } from './bookmarks'
import { asideRefusal } from './sessions'
import { shownWorkViews } from './work-views'
import { activeTab, splitFor } from './sidebar'
import { hostOf } from './url'
import { webPanelRefusal } from './web-panels'
import type { NamedWindow } from './window-names'
import { sidebarPlacement, type WindowSidebar, type WindowSidebarChange } from './window-sidebar'
import { t, tp } from './i18n'
import { cleanNoteText, defaultNoteLink, notesContext } from './notes'
import { isReadableWebPage, siteReadableOf, type ReadableMode } from './readable-mode'
import type { Candidate, CommandAction } from './command-bar-types'
import { actionDetail } from './command-bar-shortcuts'
import type { PlatformId } from './platform'
import { canOpenInPrivate } from './private-window'
import { fold, matchScore, byScore, nameScore } from './command-bar-match'

export const MAX_TABS = 6
export const MAX_ARCHIVED = 3
const MAX_READ_LATER = 3
const MAX_BOOKMARKS = 4
export const MAX_HISTORY = 4
export const MAX_SUGGESTIONS = 4
const MAX_SPACES = 4
const MAX_MOVES = 6
const MAX_SESSIONS = 5
const MAX_WORK_VIEWS = 5
const MAX_WINDOWS = 4
const MAX_EXTENSIONS = 6
/** Keywords offered while a "!" is being typed. */
export const MAX_BANG_HINTS = 5
/** The name a folder made from the bar starts with, and the command's own label. */
export const newFolderName = (): string => t('cmd.nouveau-dossier')
export const SPACE_EMOJIS = ['🚀', '🎨', '📚', '🛠️', '🌱', '🎧', '💡', '🧪']

export function actionCandidates(state: SidebarState, platform: PlatformId | undefined): Candidate[] {
  const tab = activeTab(state)
  const list: Candidate[] = []
  if (tab) {
    list.push({
      kind: 'action',
      id: 'action:pin-toggle',
      label: tab.pinned ? t('cmd.desepingler-l-onglet') : t('cmd.epingler-l-onglet'),
      detail: t('cmd.action'),
      action: 'pin-toggle'
    })
  }
  list.push(
    {
      kind: 'action',
      id: 'action:toggle-sidebar',
      label: state.settings.sidebarVisible ? t('cmd.masquer-la-barre-laterale') : t('cmd.afficher-la-barre-laterale'),
      detail: t('cmd.action'),
      action: 'toggle-sidebar'
    },
    { kind: 'action', id: 'action:clear-today', label: t('cmd.vider-les-onglets-du-jour'), detail: t('cmd.action'), action: 'clear-today' },
    { kind: 'action', id: 'action:new-space', label: t('cmd.nouvel-espace'), detail: t('cmd.action'), action: 'new-space' },
    { kind: 'action', id: 'action:edit-space', label: t('cmd.modifier-l-espace-nom-icone-couleur-profil'), detail: t('cmd.action'), action: 'edit-space' },
    { kind: 'action', id: 'action:edit-theme', label: t('cmd.modifier-le-theme-de-l-espace'), detail: t('cmd.action'), action: 'edit-theme' },
    { kind: 'action', id: 'action:find', label: t('cmd.rechercher-dans-la-page'), detail: actionDetail('find', state, platform), action: 'find' },
    { kind: 'action', id: 'action:downloads', label: t('cmd.afficher-les-telechargements'), detail: t('cmd.action'), action: 'downloads' },
    { kind: 'action', id: 'action:capture', label: t('cmd.capturer-la-partie-visible'), detail: actionDetail('capture', state, platform), action: 'capture' },
    { kind: 'action', id: 'action:capture-region', label: t('cmd.capturer-une-zone'), detail: actionDetail('capture-region', state, platform), action: 'capture-region' },
    { kind: 'action', id: 'action:capture-full', label: t('cmd.capturer-la-page-entiere'), detail: actionDetail('capture-full', state, platform), action: 'capture-full' },
    { kind: 'action', id: 'action:archive', label: t('cmd.ouvrir-l-archive'), detail: actionDetail('archive', state, platform), action: 'archive' },
    { kind: 'action', id: 'action:site-info', label: t('cmd.infos-et-reglages-du-site'), detail: actionDetail('site-info', state, platform), action: 'site-info' },
    { kind: 'action', id: 'action:settings', label: t('cmd.reglages'), detail: actionDetail('settings', state, platform), action: 'settings' }
  )
  return list
}

/**
 * The automatic reload of the tab on screen, offered when typed: set or change it (opens the interval panel), and stop it when it is on.
 * Only for a page that can be reloaded.
 */
export function autoReloadActions(state: SidebarState): Candidate[] {
  const tab = activeTab(state)
  if (!tab || !isAutoReloadable(tab.url)) return []
  const detail = tab.autoReload ? t('cmd.auto-reload-active', { every: autoReloadLabel(tab.autoReload.seconds) }) : t('cmd.action')
  return [
    { kind: 'action', id: 'action:auto-reload', label: t('cmd.recharger-l-onglet-automatiquement'), detail, action: 'auto-reload' },
    ...(tab.autoReload ? ([{ kind: 'action', id: 'action:auto-reload-off', label: t('cmd.arreter-de-recharger-l-onglet'), detail: t('cmd.action'), action: 'auto-reload-off' }] satisfies Candidate[]) : [])
  ]
}

/** The mode each command of the readable mode gives the site on screen (`null`: it follows the default again). */
export const READABLE_COMMANDS = { 'readable-dark': 'dark', 'readable-light': 'light', 'readable-original': 'original', 'readable-default': null } as const satisfies Partial<Record<CommandAction, ReadableMode | null>>

/**
 * "Contraste de la page : sombre / clair / original pour ce site", and "…comme les autres sites" for a site that has a choice of its own: offered when
 * typed (by this name or by the former one, "mode lisible"), for a web page. Not for a private tab or in a private window: the site would be written to the settings.
 */
export function readableActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  const tab = activeTab(state)
  if (inPrivateWindow || !tab || tab.private === true || !isReadableWebPage(tab.url)) return []
  return [
    { kind: 'action', id: 'action:readable-dark', label: t('cmd.contraste-de-la-page-sombre-pour-ce-site'), detail: t('cmd.action'), action: 'readable-dark' },
    { kind: 'action', id: 'action:readable-light', label: t('cmd.contraste-de-la-page-clair-pour-ce-site'), detail: t('cmd.action'), action: 'readable-light' },
    { kind: 'action', id: 'action:readable-original', label: t('cmd.contraste-de-la-page-original-pour-ce-site'), detail: t('cmd.action'), action: 'readable-original' },
    ...(siteReadableOf(state.settings.siteReadableMode, tab.url) !== null
      ? ([{ kind: 'action', id: 'action:readable-default', label: t('cmd.contraste-de-la-page-comme-les-autres-sites'), detail: t('cmd.action'), action: 'readable-default' }] satisfies Candidate[])
      : [])
  ]
}

/** "Enregistrer la page en Markdown" (whole page, one click) and "Exporter la page en Markdown" (the picker): offered when typed, and only with a web page on screen (the one kind the export reads). */
export function markdownActions(state: SidebarState): Candidate[] {
  const tab = activeTab(state)
  if (!tab || !/^https?:\/\//i.test(tab.url)) return []
  return [
    { kind: 'action', id: 'action:save-markdown', label: t('cmd.enregistrer-la-page-en-markdown'), detail: t('cmd.action'), action: 'save-markdown' },
    { kind: 'action', id: 'action:export-markdown', label: t('cmd.exporter-la-page-en-markdown'), detail: t('cmd.action'), action: 'export-markdown' }
  ]
}

/**
 * "Passer en mode compact" (or "Quitter…") and the commands of the tab tree: offered when typed, each only while its function is on, and the
 * tree's only for a tab they apply to (one with children to fold, one with a parent to leave).
 */
export function layoutActions(state: SidebarState): Candidate[] {
  const tab = activeTab(state)
  const tree = state.settings.tabTree && tab !== undefined
  return [
    ...(state.settings.compactMode ? ([{ kind: 'action', id: 'action:toggle-compact', label: compactLabel(isCompact(state.settings)), detail: t('cmd.action'), action: 'toggle-compact' }] satisfies Candidate[]) : []),
    ...(tree && state.tabs.some((t) => t.parentId === tab.id)
      ? ([{ kind: 'action', id: 'action:toggle-tab-branch', label: tab.treeCollapsed ? t('ctx.deplier-les-onglets-enfants') : t('ctx.replier-les-onglets-enfants'), detail: t('cmd.action'), action: 'toggle-tab-branch' }] satisfies Candidate[])
      : []),
    ...(tree && tab.parentId !== undefined ? ([{ kind: 'action', id: 'action:detach-tab', label: t('menu.sortir-l-onglet-de-son-parent'), detail: t('cmd.action'), action: 'detach-tab' }] satisfies Candidate[]) : [])
  ]
}

/**
 * The sidebar of this window, offered when typed (« coller », « barre », « dock »…): docked to a column of icons or the full one back, the other side
 * than the one on screen, and « comme les nouvelles fenêtres » only for a window that chose a side of its own. `own`: the window's choice (the snapshot's).
 */
export function windowSidebarActions(state: SidebarState, own: WindowSidebar | undefined): Candidate[] {
  const placement = sidebarPlacement(state.settings, own)
  return [
    { kind: 'action', id: 'action:toggle-dock', label: placement.docked ? t('cmd.deplier-la-barre-laterale') : t('cmd.replier-la-barre-laterale-icones-seules'), detail: t('cmd.action'), action: 'toggle-dock' },
    placement.right
      ? { kind: 'action', id: 'action:sidebar-left', label: t('cmd.barre-laterale-a-gauche-dans-cette-fenetre'), detail: t('cmd.action'), action: 'sidebar-left' }
      : { kind: 'action', id: 'action:sidebar-right', label: t('cmd.barre-laterale-a-droite-dans-cette-fenetre'), detail: t('cmd.action'), action: 'sidebar-right' },
    ...(placement.own !== null ? ([{ kind: 'action', id: 'action:sidebar-follow', label: t('cmd.barre-laterale-comme-les-nouvelles-fenetres'), detail: t('cmd.action'), action: 'sidebar-follow' }] satisfies Candidate[]) : [])
  ]
}

/** What an entry of the sidebar of this window asks the main process (`windowSidebar` of the API); null for every other action. */
export function windowSidebarChangeOf(action: CommandAction): WindowSidebarChange | null {
  switch (action) {
    case 'toggle-dock':
      return { op: 'toggle-dock' }
    case 'sidebar-left':
      return { op: 'side', side: 'left' }
    case 'sidebar-right':
      return { op: 'side', side: 'right' }
    case 'sidebar-follow':
      return { op: 'side', side: null }
    default:
      return null
  }
}

/** Commands that only show up when what is typed asks for them: listing them on an empty bar would bury the rest. */
export function searchOnlyActions(state: Pick<SidebarState, 'settings'>, platform: PlatformId | undefined): Candidate[] {
  return [
    { kind: 'action', id: 'action:new-folder', label: newFolderName(), detail: t('cmd.action'), action: 'new-folder' },
    { kind: 'action', id: 'action:edit-shortcuts', label: t('cmd.modifier-les-raccourcis-clavier'), detail: t('cmd.action'), action: 'edit-shortcuts' },
    { kind: 'action', id: 'action:clear-site-data', label: t('cmd.effacer-les-donnees-du-site'), detail: actionDetail('clear-site-data', state, platform), action: 'clear-site-data' },
    { kind: 'action', id: 'action:clear-site-now', label: t('cmd.effacer-les-donnees-du-site-maintenant'), detail: actionDetail('clear-site-now', state, platform), action: 'clear-site-now' },
    { kind: 'action', id: 'action:reload-all', label: t('cmd.actualiser-tous-les-onglets'), detail: t('cmd.action'), action: 'reload-all' },
    { kind: 'action', id: 'action:recent-notices', label: t('cmd.notifications-recentes'), detail: t('cmd.action'), action: 'recent-notices' }
  ]
}

/** « Découvrir Lucium »: offered when typed, except in a private window, which does not open the panel (its entry of the Aide menu is greyed out for the same reason). */
export function discoverActions(inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow && !canOpenInPrivate('discover')) return []
  return [{ kind: 'action', id: 'action:discover', label: t('discover.titre'), detail: t('cmd.action'), action: 'discover' }]
}

/** "Rechercher un onglet…": offered when typed, while the function is on; choosing it puts the bar in "Onglets" mode (the shortcut is ⇧⌘A). */
export function tabSearchActions(state: SidebarState): Candidate[] {
  if (!state.settings.tabSearch) return []
  return [{ kind: 'action', id: 'action:search-tabs', label: t('cmd.rechercher-un-onglet'), detail: t('cmd.action'), action: 'search-tabs' }]
}

/** "Ouvrir le Chrome Web Store": offered when typed, while installing from it is allowed. Extensions do not run in a private window. */
export function webStoreActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow || !state.settings.webStoreInstall) return []
  return [{ kind: 'action', id: 'action:web-store', label: t('cmd.ouvrir-le-chrome-web-store'), detail: t('cmd.action'), action: 'web-store' }]
}

/**
 * "Nouvel onglet privé" and "Cookies par site": offered when typed, each only while its setting is on. A private window has no such tab to
 * open (all its tabs are private) and no profile whose cookies to list.
 */
export function privacyActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow) return []
  return [
    ...(state.settings.privateTabs ? ([{ kind: 'action', id: 'action:new-private-tab', label: t('cmd.nouvel-onglet-prive'), detail: t('cmd.action'), action: 'new-private-tab' }] satisfies Candidate[]) : []),
    ...(state.settings.cookieManager ? ([{ kind: 'action', id: 'action:cookie-manager', label: t('cmd.cookies-par-site'), detail: t('cmd.action'), action: 'cookie-manager' }] satisfies Candidate[]) : [])
  ]
}

export const MAX_CONTAINER_ACTIONS = 6

/**
 * One "Nouvel onglet dans le conteneur « X »" per container, and "Ouvrir cette page dans le conteneur « X »" for the page on screen when it is a web
 * page not in that container already: offered when typed, only while tab containers are on. A private window has none.
 */
export function containerActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  const { tabContainers, containers } = state.settings
  if (inPrivateWindow || !tabContainers || containers.length === 0) return []
  const tab = activeTab(state)
  const movable = tab !== undefined && tab.private !== true && /^https?:\/\//i.test(tab.url)
  return containers.flatMap((container): Candidate[] => [
    { kind: 'container', id: `container:new:${container.id}`, label: t('command-bar.nouvel-onglet-dans-le-conteneur-name', { name: container.name }), detail: t('command-bar.conteneur'), containerId: container.id, mode: 'new' },
    ...(movable && tab.container !== container.id
      ? ([{ kind: 'container', id: `container:reopen:${container.id}`, label: t('command-bar.ouvrir-cette-page-dans-le-conteneur-name', { name: container.name }), detail: t('command-bar.conteneur'), containerId: container.id, mode: 'reopen', tabId: tab.id }] satisfies Candidate[])
      : [])
  ])
}

/**
 * "Mots de passe" and "Remplir l'identifiant et le mot de passe": offered when typed, while the password manager is on. A private window
 * keeps and fills nothing, so it gets neither. Nothing is filled by being listed: choosing "Remplir" is the gesture that asks for it.
 */
export function passwordActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow || !state.settings.passwordManager) return []
  return [
    { kind: 'action', id: 'action:passwords', label: t('passwords-panel.mots-de-passe'), detail: t('cmd.action'), action: 'passwords' },
    { kind: 'action', id: 'action:fill-password', label: t('menu.remplir-l-identifiant-et-le-mot-de-passe'), detail: t('cmd.action'), action: 'fill-password' }
  ]
}

/**
 * "Lire plus tard" and "Ouvrir la liste de lecture": offered when typed, like the other commands of ours. A private window keeps no
 * list, so it gets neither; saving needs a web page on screen.
 */
export function readLaterActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow) return []
  const tab = activeTab(state)
  return [
    ...(tab && isReadLaterUrl(tab.url) ? ([{ kind: 'action', id: 'action:read-later', label: t('cmd.lire-plus-tard'), detail: t('cmd.action'), action: 'read-later' }] satisfies Candidate[]) : []),
    { kind: 'action', id: 'action:read-later-list', label: t('cmd.ouvrir-la-liste-de-lecture'), detail: t('cmd.action'), action: 'read-later-list' }
  ]
}

/**
 * Bringing in a Tweak (a file, or the link on the clipboard) and a theme (a file), and saving the theme of the space as a file: offered when
 * typed, like the other commands of ours. A private window keeps no Tweak, space or theme, so it gets none of them, and neither does a person who switched sharing off.
 */
export function shareActions(inPrivateWindow: boolean, enabled: boolean): Candidate[] {
  if (inPrivateWindow || !enabled) return []
  return [
    { kind: 'action', id: 'action:import-boost', label: t('cmd.importer-une-retouche'), detail: t('cmd.action'), action: 'import-boost' },
    { kind: 'action', id: 'action:paste-boost', label: t('cmd.coller-une-retouche-copiee'), detail: t('cmd.action'), action: 'paste-boost' },
    { kind: 'action', id: 'action:import-theme', label: t('cmd.importer-un-theme-depuis-un-fichier'), detail: t('cmd.action'), action: 'import-theme' },
    { kind: 'action', id: 'action:export-theme', label: t('cmd.exporter-le-theme-de-l-espace-dans-un'), detail: t('cmd.action'), action: 'export-theme' }
  ]
}

/**
 * The commands of the library functions, each only while its setting is on (none in a private window, which keeps no bookmark or folder and
 * has no application windows): "Ajouter aux signets" and "Ouvrir comme application" need a web page on screen.
 */
export function libraryActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow) return []
  const { bookmarkManager, liveFolders, webAppWindows } = state.settings
  const tab = activeTab(state)
  const web = tab !== undefined && isBookmarkUrl(tab.url)
  const action = (id: CommandAction, label: string): Candidate => ({ kind: 'action', id: `action:${id}`, label, detail: t('cmd.action'), action: id })
  return [
    ...(bookmarkManager && web ? [action('bookmark-add', t('menu.ajouter-aux-signets'))] : []),
    ...(bookmarkManager ? [action('bookmarks-list', t('command-bar.ouvrir-les-signets'))] : []),
    ...(liveFolders ? [action('live-folder-new', t('menu.nouveau-dossier-en-direct'))] : []),
    ...(webAppWindows && web ? [action('open-as-app', t('menu.ouvrir-comme-application'))] : [])
  ]
}

/** "Nouvelle note" and "Ouvrir les notes": offered when typed, while the quick notes are on. A private window keeps none, so it gets nothing. */
export function notesActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow || !state.settings.notes) return []
  return [
    { kind: 'action', id: 'action:new-note', label: t('command-bar.nouvelle-note'), detail: t('cmd.action'), action: 'new-note' },
    { kind: 'action', id: 'action:notes', label: t('command-bar.ouvrir-les-notes'), detail: t('cmd.action'), action: 'notes' }
  ]
}

/**
 * "note acheter du pain": the row that makes the note "acheter du pain" at once, tied to the page on screen (else to the space), as a new note of
 * the panel is. The keyword is a word of the language, so the row never leads: Enter on "note de frais" still searches the web, and the row is the
 * first command, the one Enter runs in "Commandes" (`> note …`). Nothing while the notes are off, in a private window, or without a text.
 */
export function jotCandidate(query: string, state: SidebarState, inPrivateWindow: boolean): Candidate | null {
  if (inPrivateWindow || !state.settings.notes) return null
  const match = /^(\S+)\s+([\s\S]+)$/.exec(query.trim())
  if (!match || fold(match[1]!) !== fold(t('command-bar.mot-cle-note'))) return null
  const text = cleanNoteText(match[2]!)
  if (text === '') return null
  const link = defaultNoteLink(notesContext(state.activeSpaceId, activeTab(state)))
  const space = link?.kind === 'space' ? state.spaces.find((each) => each.id === link.spaceId) : undefined
  const detail = link?.kind === 'page' ? t('notes.page-host', { host: hostOf(link.url) || link.url }) : space ? t('notes.espace-name', { name: space.name }) : t('notes.sans-lien')
  return { kind: 'action', id: 'action:jot-note', label: t('command-bar.nouvelle-note-texte', { text }), detail, action: 'jot-note', text }
}

/** The bookmarks the query names (every word, in the title, address, note or tags; a "#word" is a tag), the best title first. Only while the library is on, never in a private window. */
export function bookmarkCandidates(q: string, state: SidebarState, inPrivateWindow: boolean, limit = MAX_BOOKMARKS): Candidate[] {
  if (inPrivateWindow || !state.settings.bookmarkManager) return []
  return filterBookmarks(state.bookmarks, q)
    .map((b) => ({ b, score: Math.max(matchScore(b.title, q), matchScore(b.url, q)) }))
    .sort(byScore)
    .slice(0, limit)
    .map(({ b }): Candidate => ({ kind: 'bookmark', id: `bookmark:${b.id}`, label: b.title, detail: `${t('cmd.signet-host', { host: hostOf(b.url) })}${b.tags.length > 0 ? ` · ${b.tags.map((tag) => `#${tag}`).join(' ')}` : ''}`, bookmarkId: b.id, ...(b.faviconUrl ? { faviconUrl: b.faviconUrl } : {}) }))
}

/** The saved pages the query names (as a substring of the title or address, not by loose letters), best first: they come after the archive. */
export function readLaterCandidates(q: string, state: SidebarState): Candidate[] {
  return state.readLater
    .map((item) => ({ item, score: Math.max(matchScore(item.title, q), matchScore(item.url, q)) }))
    .filter((m) => m.score >= 50)
    .sort(byScore)
    .slice(0, MAX_READ_LATER)
    .map(({ item }): Candidate => ({ kind: 'readlater', id: `readlater:${item.id}`, label: item.title, detail: t('cmd.read-later-host', { host: hostOf(item.url) }), readLaterId: item.id, ...(item.faviconUrl ? { faviconUrl: item.faviconUrl } : {}) }))
}

/** The split view a tab belongs to, unless it is the one already on screen (then the tab is just a pane to focus). */
function otherSplit(state: SidebarState, tabId: string) {
  const split = splitFor(state, tabId)
  const shown = activeTab(state)
  return split && !(shown && split.tabIds.includes(shown.id)) ? split : undefined
}

export function tabCandidate(t: TabItem, state: SidebarState): Candidate {
  return {
    kind: 'tab',
    id: `tab:${t.id}`,
    label: tabName(t),
    detail: hostOf(t.url) || t.url,
    tabId: t.id,
    url: t.url,
    faviconUrl: t.faviconUrl,
    ...(otherSplit(state, t.id) ? { split: true } : {})
  }
}

/**
 * `otherSplit` for many tabs: the tab on screen and the split view of each tab are found once, not once per tab (the list before anything is
 * typed holds every tab, and looking for the one on screen at each of them made the bar slow to open with thousands of tabs).
 */
function otherSplitLookup(state: SidebarState): (tabId: string) => SplitView | undefined {
  const shown = activeTab(state)
  // The first split view that holds the tab, as `splitFor` finds it.
  const splitOf = new Map<string, SplitView>()
  for (const split of state.splits) for (const id of split.tabIds) if (!splitOf.has(id)) splitOf.set(id, split)
  return (tabId) => {
    const split = splitOf.get(tabId)
    return split && !(shown && split.tabIds.includes(shown.id)) ? split : undefined
  }
}

/** A split view is one place to go to, however many of its tabs match: only the best ranked one stays. */
export function onePerSplit<T>(items: T[], tabOf: (item: T) => TabItem, state: SidebarState): T[] {
  const seen = new Set<string>()
  const otherSplitOf = otherSplitLookup(state)
  return items.filter((item) => {
    const split = otherSplitOf(tabOf(item).id)
    if (!split) return true
    if (seen.has(split.id)) return false
    seen.add(split.id)
    return true
  })
}

/** "Focus on <space>": the spaces other than the current one whose name answers the query, best first. */
export function spaceCandidates(q: string, state: SidebarState): Array<Extract<Candidate, { kind: 'space' }>> {
  return state.spaces
    .filter((sp) => sp.id !== state.activeSpaceId)
    .map((sp) => ({ sp, score: nameScore(sp.name, q) }))
    .filter((m) => m.score > 0)
    .sort(byScore)
    .slice(0, MAX_SPACES)
    .map(({ sp }) => ({ kind: 'space', id: `space:${sp.id}`, label: t('cmd.go-to-space', { name: sp.name }), detail: '', spaceId: sp.id, emoji: sp.emoji }))
}

/**
 * The work views of the profile on screen that the query names, by their own name or by what they are (« vue de travail » lists them all): choosing one
 * opens it, or shows it again. None while the function is off, nor in a private window, which keeps none.
 */
export function workViewCandidates(q: string, state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow) return []
  const kind = t('work-view.vue-de-travail')
  return shownWorkViews(state, state.activeSpaceId)
    .map((view) => ({ view, score: Math.max(nameScore(view.name, q), nameScore(kind, q)) }))
    .filter((m) => m.score > 0)
    .sort(byScore)
    .slice(0, MAX_WORK_VIEWS)
    .map(({ view }): Candidate => ({ kind: 'workview', id: `workview:${view.id}`, label: view.name, detail: t('work-view.detail-commande', { sites: tp('work-view.sites', view.panes.length) }), viewId: view.id, emoji: view.emoji }))
}

/** "Move to Today/Pinned in <space>" for the current tab, towards the other spaces only: "déplacer…" lists them, a space name narrows to it. */
export function moveCandidates(q: string, state: SidebarState): Candidate[] {
  const tab = activeTab(state)
  if (!tab) return []
  const rows: Array<{ score: number; candidate: Candidate }> = []
  for (const sp of state.spaces) {
    if (sp.id === tab.spaceId) continue
    for (const pinned of [false, true]) {
      const label = pinned ? t('cmd.move-pinned', { space: sp.name }) : t('cmd.move-today', { space: sp.name })
      // The label alone cannot tell spaces apart when the query is "déplacer": the space's own name puts its rows first.
      const [onLabel, onName] = [nameScore(label, q), nameScore(sp.name, q)]
      if (onLabel > 0 || onName > 0) {
        const score = onLabel + onName
        rows.push({ score, candidate: { kind: 'move', id: `move:${tab.id}:${sp.id}:${pinned ? 'pinned' : 'today'}`, label, detail: tabName(tab), tabId: tab.id, spaceId: sp.id, pinned, emoji: sp.emoji } })
      }
    }
  }
  return rows.sort(byScore).slice(0, MAX_MOVES).map((r) => r.candidate)
}

/** Saving a session and showing the list, offered when typed like the other commands of ours. A private window keeps no session, so it gets neither. */
export function sessionActions(inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow) return []
  return [
    { kind: 'action', id: 'action:save-session', label: t('cmd.enregistrer-la-session'), detail: t('cmd.action'), action: 'save-session' },
    { kind: 'action', id: 'action:sessions', label: t('cmd.afficher-les-sessions'), detail: t('cmd.action'), action: 'sessions' }
  ]
}

/**
 * "Restaurer la session <nom>" for the saved sessions the query names (by that label or by the session's own name), newest first among
 * equals. A space put aside is offered as "Rouvrir l’espace <nom>": choosing it brings the space back as it was.
 */
export function sessionCandidates(q: string, state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow) return []
  return state.sessions
    .map((session) => {
      const label = session.space ? t('cmd.reopen-space', { name: session.name }) : t('cmd.restore-session', { name: session.name })
      return { session, label, score: nameScore(label, q) + nameScore(session.name, q) }
    })
    .filter((m) => m.score > 0)
    .sort(byScore)
    .slice(0, MAX_SESSIONS)
    .map(({ session, label }): Candidate => ({
      kind: 'session',
      id: `session:${session.id}`,
      label,
      detail: session.space ? tp('cmd.aside-tabs', session.space.tabs.length) : tp('cmd.session-tabs', session.tabs.length),
      sessionId: session.id,
      ...(session.space ? { aside: true as const } : {})
    }))
}

/** "Mettre l’espace de côté": offered when typed, for a space that can be (not the only one, not past the limit). A private window has a single space and keeps nothing. */
export function asideActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow || asideRefusal(state, state.activeSpaceId) !== null) return []
  return [{ kind: 'action', id: 'action:aside-space', label: t('cmd.mettre-l-espace-de-cote'), detail: t('cmd.action'), action: 'aside-space' }]
}

/** "Verrouiller maintenant": offered when typed, while the lock is on (Réglages › Vie privée et sécurité › Verrouillage). A private window has no lock of its own. */
export function lockActions(state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow || !state.settings.lockEnabled) return []
  return [{ kind: 'action', id: 'action:lock-now', label: t('cmd.verrouiller-maintenant'), detail: t('cmd.action'), action: 'lock-now' }]
}

const MAX_WEB_PANELS = 5

/**
 * The web panels of the space on screen, offered when typed ("Ouvrir <site> en volet", "Ajouter la page en volet web", "Fermer le volet web").
 * Nothing while the function is off and in a private window, which keeps no list.
 */
export function webPanelCandidates(q: string, state: SidebarState, inPrivateWindow: boolean): Candidate[] {
  if (inPrivateWindow || !state.settings.webPanels) return []
  const space = state.spaces.find((s) => s.id === state.activeSpaceId)
  if (!space) return []
  const opens = (space.webPanels ?? [])
    .map((panel) => ({ panel, label: t('cmd.open-panel', { title: panel.title }), score: 0 }))
    .map((m) => ({ ...m, score: nameScore(m.label, q) + nameScore(m.panel.title, q) }))
    .filter((m) => m.score > 0)
    .sort(byScore)
    .slice(0, MAX_WEB_PANELS)
    .map(({ panel, label }): Candidate => ({ kind: 'webpanel', id: `webpanel:${panel.id}`, label, detail: t('cmd.web-panel-host', { host: hostOf(panel.url) }), panelId: panel.id }))
  const tab = activeTab(state)
  const actions: Candidate[] = []
  if (tab && webPanelRefusal(space.webPanels, tab.url) === null) actions.push({ kind: 'action', id: 'action:web-panel-add', label: t('cmd.ajouter-la-page-en-volet-web'), detail: t('cmd.action'), action: 'web-panel-add' })
  actions.push({ kind: 'action', id: 'action:web-panel-close', label: t('cmd.fermer-le-volet-web'), detail: t('cmd.action'), action: 'web-panel-close' })
  return [...opens, ...actions.filter((c) => nameScore(c.label, q) > 0)]
}

/**
 * "Réglages › <pane>" when the query names a category, and "Réglages › <group>" when it names one of the groups a link can lead to (the shortcuts, the
 * lock, the extensions…: the old categories that became groups). "réglages" alone is the plain Settings command's business.
 */
export function paneCandidates(q: string): Candidate[] {
  const panes = SETTINGS_PAGES.filter((pane) => nameScore(settingsPaneLabel(pane), q) > 0).map(
    (pane): Candidate => ({ kind: 'pane', id: `pane:${pane}`, label: t('cmd.settings-pane', { pane: settingsPaneLabel(pane) }), detail: '', pane })
  )
  const anchors = SETTINGS_ANCHORS.filter((anchor) => nameScore(settingsAnchorLabel(anchor), q) > 0).map(
    (anchor): Candidate => ({ kind: 'pane', id: `pane:${ANCHOR_PANE[anchor]}/${anchor}`, label: t('cmd.settings-pane', { pane: settingsAnchorLabel(anchor) }), detail: '', pane: ANCHOR_PANE[anchor], anchor })
  )
  return [...panes, ...anchors]
}

/**
 * The extensions whose action can be used from the bar: those that run in the profile of the space the user is in (a folder's
 * extension is loaded into every profile and listed for each, one from the Web Store only in its own; one switched off in the
 * profile has no icon to click). Named by the query, or all of them when the query is the word "extension".
 */
export function extensionCandidates(q: string, extensions: readonly ExtensionInfo[], profileId: string): Candidate[] {
  const word = fold(q).replace(/s$/, '')
  const all = word.length >= 3 && 'extension'.startsWith(word)
  return [...new Map(extensions.filter((e) => e.enabled && e.profileId === profileId).map((e) => [e.id, e])).values()]
    .map((e) => ({ e, score: all ? 1 : nameScore(e.name, q) }))
    .filter((m) => m.score > 0)
    .sort(byScore)
    .slice(0, MAX_EXTENSIONS)
    .map(({ e }): Candidate => ({ kind: 'extension', id: `extension:${e.id}`, label: e.name, detail: t('cmd.extension'), extensionId: e.id }))
}

/**
 * Windows with a name: "Nommer la fenêtre…" (an action, offered when typed) and "Aller à la fenêtre « nom »" for each of the others. `windows` is
 * undefined while windows cannot be named (a setting): then the bar offers nothing of the kind.
 */
export function windowCandidates(q: string, windows: readonly NamedWindow[] | undefined): Candidate[] {
  if (windows === undefined) return []
  const actions: Candidate[] = [{ kind: 'action', id: 'action:name-window', label: t('cmd.nommer-la-fenetre'), detail: t('cmd.action'), action: 'name-window' }]
  const named = windows
    .map((w) => ({ w, score: Math.max(nameScore(w.name, q), nameScore(t('cmd.go-to-window', { name: w.name }), q)) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_WINDOWS)
    .map(({ w }): Candidate => ({ kind: 'window', id: `window:${w.id}`, label: t('cmd.go-to-window-quoted', { name: w.name }), detail: t('cmd.fenetre'), windowId: w.id }))
  return [...actions.filter((c) => nameScore(c.label, q) > 0), ...named]
}
