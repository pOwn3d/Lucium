import type { SidebarState } from './model'
import { activeTab, splitFor } from './sidebar'
import { isDeveloperUrl } from './developer-mode'
import { siteReadableOf } from './readable-mode'
import { isAutoReloadable } from './auto-reload'
import { spaceGlyph } from './space-icon'
import { asideRefusal, asideSessions } from './sessions'
import { summaryAvailable, summaryGreyed } from './ollama'

/** What the menu greys out depending on the page on screen (it is not in the saved state). */
export interface MenuFacts {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** A search in the page is under way (Find Next and Previous have something to step through). */
  finding: boolean
  /** The split view the page is in scrolls its panes together (View › Défilement synchronisé is checked). Absent: no. */
  scrollSynced?: boolean
  /** The battery saver was asked for by hand and is on (View › Mode économie de batterie is checked). Absent: no. */
  saverAsked?: boolean
  /** The page on screen makes sound (the tab can be muted), is muted (it can be given its sound back), or is silent (the entry is greyed out). */
  sound: 'silent' | 'audible' | 'muted'
  /**
   * The sidebar of this window as it is on screen (shared/window-sidebar.ts): View › Coller la barre dans cette fenêtre and › Barre à droite dans cette
   * fenêtre are checked from it. Absent: the full sidebar at the left.
   */
  sidebar?: 'left-docked' | 'right' | 'right-docked'
  /**
   * The page on screen is in another language than the target, or is translated (shared/translate-quick.ts `translateOffer`): File offers « Traduire en
   * <to> », or « Afficher l'original ». Absent for every other page, so that the key of a page in the target language is unchanged.
   */
  translate?: { state: 'offered' | 'working' | 'translated'; to: string }
}

export const NO_FACTS: MenuFacts = { canGoBack: false, canGoForward: false, loading: false, finding: false, sound: 'silent' }

/** What the sound entry of the Tabs menu does for a tab: a muted tab gets its sound back, a tab that plays can be muted, a silent one has nothing to mute. */
export function soundFact(info: { audible?: boolean; muted?: boolean; awake?: boolean } | undefined): MenuFacts['sound'] {
  if (!info || info.awake === false) return 'silent'
  if (info.muted === true) return 'muted'
  return info.audible === true ? 'audible' : 'silent'
}

/**
 * Whether the newest archived tab was archived in this session: the Edit menu then offers to undo it ("Annuler l’archivage de
 * l’onglet"). An archive from an earlier session is not an action to undo.
 */
export function undoableArchive(state: SidebarState, sessionStart: number): boolean {
  const newest = state.archive[0]
  return newest !== undefined && newest.archivedAt >= sessionStart && newest.source !== 'auto'
}

/**
 * Everything the application menu displays that comes from the state. The menu is rebuilt only when this changes:
 * rebuilding on every title update or tab move would be wasteful and would close a menu the user has open.
 */
export function menuKey(state: SidebarState, extensionIds: readonly string[], facts: MenuFacts = NO_FACTS, sessionStart = 0, extra = ''): string {
  const tab = activeTab(state)
  return JSON.stringify({
    keys: state.settings.keyBindings,
    // The language the labels are written in (shared/i18n.ts): a change of it rebuilds the menu.
    language: [state.settings.interfaceTranslated, state.settings.language],
    // View › Appearance: the appearance of Lucium and the one asked of the sites, two groups of radio items.
    appearance: [state.settings.interfaceAppearance, state.settings.websiteAppearance],
    toolbar: state.settings.showToolbar,
    // Extensions › Ouvrir le Chrome Web Store is greyed out while installing from it is switched off.
    webStore: state.settings.webStoreInstall,
    // File › Enregistrer en PDF avec l’adresse… exists only with its setting on.
    pdfSource: state.settings.pdfWithSource,
    // Onglets › Rechercher un onglet (⇧⌘A) and Aide › Raccourcis (⌘/) exist only with their function on: a change rebuilds the menu at once.
    tabSearch: state.settings.tabSearch,
    tabGrid: state.settings.tabGrid,
    shortcutHelp: state.settings.shortcutHelp,
    sidebar: state.settings.sidebarVisible,
    // View › Pour les nouvelles fenêtres: the side of the new windows (the side of this window is in the facts).
    sidebarRight: state.settings.sidebarRight,
    profiles: state.settings.profileNames,
    // The glyph, not the emoji: a space that wears letters is listed by its letters.
    spaces: state.spaces.map((s) => [s.id, spaceGlyph(s), s.name, s.profileId]),
    active: state.activeSpaceId,
    // Espaces › Mettre l’espace de côté… (greyed out for the only space, or past the limit) and the spaces that are waiting to be reopened.
    aside: [asideRefusal(state, state.activeSpaceId), asideSessions(state).map((s) => [s.id, s.name, spaceGlyph(s.space!.space)])],
    // File › Nouvel onglet dans un conteneur: the containers it lists. Only while the function is on, so that the key of a browser that never uses it is unchanged.
    ...(state.settings.tabContainers ? { containers: state.settings.containers.map((c) => [c.id, c.name]) } : {}),
    // Espaces › Volets web: the sites listed for the space on screen. Only while the function is on, so that the key of a browser that never uses it is unchanged.
    ...(state.settings.webPanels ? { webPanels: (state.spaces.find((s) => s.id === state.activeSpaceId)?.webPanels ?? []).map((p) => [p.id, p.title]) } : {}),
    canRestore: state.archive.length > 0,
    undo: undoableArchive(state, sessionStart),
    // Entries enabled only in some situations: rebuilt when the situation flips, not on every tab change.
    hasTabs: state.tabs.length > 0,
    inSplit: tab ? splitFor(state, tab.id) !== undefined : false,
    pinned: tab?.pinned === true,
    // Tabs › Replier / déplier le dossier de l’onglet: the folder the tab sits in, and whether it is folded.
    folder: tab?.folderId ? [tab.folderId, state.folders.find((f) => f.id === tab.folderId)?.collapsed === true] : null,
    // Fenêtre › Nommer la fenêtre… exists only while the setting is on.
    windowNames: state.settings.nameWindows,
    // View › Passer en mode compact: present only with the function on, and says which of its two wordings (the bars it hides are in the key already).
    ...(state.settings.compactMode ? { compact: true } : {}),
    // Tabs › Replier / déplier les onglets enfants and Sortir l’onglet de son parent: present with the tab tree, enabled by what the tab on screen has.
    ...(state.settings.tabTree ? { tree: tab ? [tab.parentId !== undefined, state.tabs.some((t) => t.parentId === tab.id), tab.treeCollapsed === true] : null } : {}),
    // View › Recharger automatiquement: greyed out for a page that cannot be reloaded, checks the interval of the tab on screen.
    autoReload: tab ? [tab.autoReload?.seconds ?? null, isAutoReloadable(tab.url)] : null,
    // A private tab on screen: what would keep or send its page (watching it, a summary that leaves the Mac) is greyed out or hidden.
    ...(tab?.private === true ? { privateTab: true } : {}),
    // The page: shareable (a web page), and in Developer Mode (the entry says which of the two it does).
    web: tab ? /^https?:\/\//i.test(tab.url) : false,
    developer: tab ? isDeveloperUrl(tab.url, state.settings.developerHosts) : false,
    // View › Appearance › Page Contrast for This Site: which entry is checked (the site's own choice, or "default" when it has none); null with no web page, where the entry is greyed out.
    readable: tab && /^https?:\/\//i.test(tab.url) ? (siteReadableOf(state.settings.siteReadableMode, tab.url) ?? 'default') : null,
    facts,
    // File › Nouvelle fenêtre invité is shown only while the profil invité is on; absent while it is off, so that the key of a browser that never uses it is unchanged.
    ...(state.settings.guestProfile ? { guest: true } : {}),
    // File › Nouvel onglet privé and View › Cookies par site… come and go with their switches. Both are on by default, so the key says so only when one is off.
    ...(state.settings.privateTabs ? {} : { noPrivateTabs: true }),
    ...(state.settings.cookieManager ? {} : { noCookieManager: true }),
    // The web tools that add menu entries: their entries come and go with their switches.
    tools: [state.settings.qrCode, state.settings.pageWatch, state.settings.scrollSync, state.settings.batterySaver, state.settings.translateLocal],
    // File › Mots de passe… and › Remplir…: visible only while the password manager is on. Absent otherwise, so the key of a browser that never uses it is unchanged.
    ...(state.settings.passwordManager ? { passwordManager: true } : {}),
    // The library functions (bookmarks, live folders, sites as applications): their entries come and go with their switches.
    library: [state.settings.bookmarkManager, state.settings.liveFolders, state.settings.webAppWindows],
    // File › Rappels d’onglets lists what waits (the ids stand for their titles and times, which never change); absent with the function off or nothing waiting.
    ...(state.settings.tabReminders && state.tabReminders.length > 0 ? { reminders: state.tabReminders.map((r) => r.id) } : {}),
    ...(state.settings.tabReminders ? {} : { noReminders: true }),
    // File › Notes… comes and goes with its switch. On by default, so the key says so only when it is off.
    ...(state.settings.notes ? {} : { noNotes: true }),
    // File › Résumer la page… comes once the local model is ready; File › Annoter cette page binds ⌥⌘M in the menu unless the shortcut is system-wide.
    // With Ollama on another computer they are greyed out while a private tab is on screen: the key says so only then.
    ...(summaryAvailable(state.settings) ? { summary: true } : {}),
    ...(summaryGreyed(state.settings, tab?.private === true) ? { summaryGreyed: true } : {}),
    ...(state.settings.annotateGlobalShortcut ? { annotateGlobal: true } : {}),
    extensions: extensionIds,
    extra
  })
}
