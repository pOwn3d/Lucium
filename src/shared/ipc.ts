import type { TabCloseAction } from './tab-close'
import type { DownloadInfo, FindState, PeekState, SidePanelState, WebPanelState, PermissionRequest, RuntimeState, SidebarState } from './model'
import type { BlockingStatus } from './filter-lists'
import type { PlusAnchor } from './plus-menu'
import type { AuthRequest } from './http-auth'
import type { DialogRequest } from './page-dialog'
import type { LeaveRequest } from './leave-sheet'
import type { ArcImported } from './arc-guide'
import type { WhatsNewSheet } from './whats-new'
import type { NoticeEntry } from './notice-log'
import type { ExtensionReviewRequest } from './extension-review'
import type { NamedWindow } from './window-names'
import type { WindowSidebar } from './window-sidebar'
import type { LockView } from './lock'
import type { DropHost } from './split-drop'
import type { WindowTab } from './dnd'
import type { CycleCard } from './tab-cycle'
import type { DeadTabEntry } from './dead-tabs'
import type { ReloadRunView } from './reload-all'
import type { ExtensionsTarget } from './extension-page'
import type { MemoryGauge } from './resources'

// Moved to modules of their own, still importable from here.
export { Channel, InternalChannel } from './ipc-channels'
export { LITTLE_HEADER_HEIGHT, LITTLE_STRIP_HEIGHT, WEB_APP_HEADER_HEIGHT, PAGE_MARGIN, FLOAT_LEAVE_MS, TRAFFIC_LIGHTS, FLOATING_INSET, TOOLBAR_BAR_HEIGHT, TOOLBAR_HEIGHT, SIDE_PANEL_HEADER_HEIGHT, PEEK_HEADER_HEIGHT, FIND_PANEL, FIND_REPLACE_PANEL, FIND_HIGHLIGHT_CSS, REGEX_HIGHLIGHT_CSS, TOOLTIP } from './ipc-layout'
export { type InternalPageApi, type LuciumApi, type PageSummaryReply } from './ipc-api'

/** Query parameter that marks the UI surfaces of a private window: the preload and the renderer read it. */
export const PRIVATE_QUERY = 'private'
export const isPrivateSurface = (search: string): boolean => new URLSearchParams(search).has(PRIVATE_QUERY)
/** The surfaces of a guest window carry this next to PRIVATE_QUERY (a guest window is private underneath): the renderer then skips the private window's look. */
export const GUEST_QUERY = 'guest'
export const isGuestSurface = (search: string): boolean => new URLSearchParams(search).has(GUEST_QUERY) && isPrivateSurface(search)

/** What "Personnaliser l'espace" puts the cursor on when it opens (the context menu has an entry for the name and one for the new profile; the icon and the colours are sections of the panel). */
export const SPACE_EDITOR_FOCUS = ['name', 'icon', 'profile', 'color'] as const
export type SpaceEditorFocus = (typeof SPACE_EDITOR_FOCUS)[number]

/**
 * The pages of the Settings window, in the order of its sidebar: « Pour commencer », the 8 categories named by what one wants to do, then « Fonctions en
 * option » and « À propos et mises à jour ». The 16 categories of an earlier layout are gone as identifiers: `windows` and `sleep` (now in `tabs`),
 * `search`, `commandbar` and `links` (now in `navigation`), `history`, `lock` and `network` (now in `protection`). `privacy` and the other old addresses
 * are still led to their page by `resolveSettingsTarget` (settings-catalog.ts), with the group they name when there is one.
 */
export const SETTINGS_PAGES = ['home', 'appearance', 'tabs', 'navigation', 'protection', 'files', 'tools', 'keyboard', 'profiles', 'features', 'about'] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]

/**
 * The names a request may give a place of the Settings: a page, or `general`, the category of the previous layout, kept so that its addresses and the
 * questions of the guide that name it still lead somewhere (« Pour commencer », or « À propos » for its anchors).
 */
export const SETTINGS_PANES = ['general', ...SETTINGS_PAGES] as const
export type SettingsPane = (typeof SETTINGS_PANES)[number]

/**
 * The places inside a category that a link can scroll to (a group of its rows, `<section id="…">`): "#privacy/permissions". One per old category
 * that became a group of a larger one (the icon, "À propos", the search engine, the mini window, the shortcuts, the lock, the extensions), and the
 * two groups the panels have always linked to (the permissions, the downloads). `status` is « État de Lucium », in the fold of « À propos et mises à
 * jour » (Aide › État de Lucium…, the notice of an internal error). `guide` is no group: it opens the complete configuration
 * (« Régler en quelques questions » for every category, shared/settings-guide.ts), so that the menu and the sheets reach it the way they reach a group.
 */
export const SETTINGS_ANCHORS = ['icon', 'about', 'status', 'engine', 'links', 'shortcuts', 'permissions', 'sitedata', 'lock', 'downloads', 'extensions', 'guide', 'panelsize'] as const

/**
 * The subpages of the Settings (shared/settings-subpages.ts): a list or an editor on a page of its own, opened by a row of its category that says its
 * state, with a way back. Each name is an anchor too: "#protection/filterlists" opens it. `shortcuts` and `permissions`, the anchors of two groups, now
 * open the subpage that holds the group.
 */
export const SETTINGS_SUBPAGES = [
  'contrast', 'awake', 'containers', 'sitesearches', 'linkroutes', 'exceptions', 'clearonclose', 'permissions', 'lockoptions', 'filterlists', 'network',
  'extensionfolders', 'translatelists', 'userscripts', 'pagewatches', 'focus', 'shortcuts', 'siteexclusions', 'sync', 'securitycheck'
] as const
export type SettingsSubpage = (typeof SETTINGS_SUBPAGES)[number]

/** What an address may name after the page: a group of `SETTINGS_ANCHORS`, or a subpage. */
export type SettingsAnchor = (typeof SETTINGS_ANCHORS)[number] | SettingsSubpage

/** Whether a value is a name an address of the Settings may give after the page (what the main process accepts from a request). */
export const isSettingsAnchor = (value: unknown): value is SettingsAnchor => (SETTINGS_ANCHORS as readonly unknown[]).includes(value) || (SETTINGS_SUBPAGES as readonly unknown[]).includes(value)

/** What a mini window shows in its header. */
export interface LittleState {
  id: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  spaces: Array<{ id: string; name: string; emoji: string }>
  /** True while the window only holds the command bar (the first state, 490 x 329): no page yet, no header. */
  bar: boolean
  /** Set for a site opened as an application (setting `webAppWindows`): the header shows this name and icon instead of the address. */
  app?: { name: string; icon?: string }
  /** When the address was last copied (by the shortcut, from the window itself): the header shows its tick for a moment. */
  copiedAt?: number
  /** The files this window's page downloaded, newest first: the tray at the bottom of the window lists them. */
  downloads: DownloadInfo[]
  /** The id of the finished download the action bubble above the tray is about (Settings › Navigation › Plus de réglages; absent when no bubble is up). */
  bubble?: string
  /** The icon the page declares, for the header (absent: the initial of its address). */
  faviconUrl?: string
  /** The pin "Garder ouvert" is on: the window is left out of the archiving of the forgotten ones. Absent is off (an application window has no pin). */
  kept?: boolean
}

/**
 * `move-menu` opens the space picker over the window, `picker-close` puts it away, and `open-in:<space id>` (see
 * shared/little-picker.ts) promotes the page into that space.
 */
export type LittleCommand =
  | 'back'
  | 'forward'
  | 'reload'
  | 'copy-url'
  /** A view of the window (its header, its tray) listens now: the window sends its state again, which may have come before it listened. */
  | 'ready'
  | 'open-in-main'
  | 'close'
  | 'move-menu'
  | 'picker-close'
  | 'bubble-close'
  | 'bubble-hold'
  | 'bubble-release'
  /** The pin of the header: the window is kept, or is left to the archiving of the forgotten ones again. */
  | 'keep:on'
  | 'keep:off'
  /** The link of the banner: opens Settings › Liens, where the delay is. */
  | 'archive-delay'
  | `open-in:${string}`
  | `go:${string}`
  /** A row "Onglets ouverts" of the bar: the main window goes to that tab and this window closes. */
  | `goto-tab:${string}`
  | `dismiss-download:${string}`

export type NavCommand = 'back' | 'forward' | 'reload' | 'stop'

/**
 * A tooltip the UI asks the shell to show: a navy capsule, drawn in a small window of its own so that it can overlap the page
 * (the page is a native view above the UI). `x` and `y` are the pointer in window coordinates; `keys` are the shortcut's keycaps.
 */
export interface TooltipRequest {
  text: string
  keys?: string[]
  x: number
  y: number
  /** `media`: the bubble of the media player (its own colours, a longer wait on the UI side, and it opens nearer the pointer). */
  variant?: 'media'
  /** `left`: it opens to the left of the point (a tile of the sidebar docked at the right: the bubble falls on the page, not off the window). */
  side?: 'left'
}

/**
 * What the Glance header can ask for: close, promote the page to a tab or to a split view beside the current tab, drive the previewed page, or
 * copy its address (`copy-address`: the main process writes the clipboard, so the address is cleaned like every other copied address).
 */
export const PEEK_ACTIONS = ['open-in-tab', 'open-in-split', 'close', 'back', 'forward', 'reload', 'stop', 'copy-address'] as const
export type PeekAction = (typeof PEEK_ACTIONS)[number]
/**
 * Where the command bar's result goes: a new tab, the current tab, a mini window, or a new tab beside the current one (split view).
 * `tabs` (⌘⇧A, setting `tabSearch`) is not a place to go to but a search among the open tabs of every space: it opens none.
 */
export const COMMAND_BAR_MODES = ['new', 'current', 'little', 'split', 'tabs'] as const
export type CommandBarMode = (typeof COMMAND_BAR_MODES)[number]

/** What the single overlay surface should display. Modal panels cover the window, small ones do not. */
export type OverlayRequest =
  | { panel: 'commandbar'; mode: CommandBarMode; initial: string }
  /** The sheet of the shortcuts by context (⌘/, setting `shortcutHelp`). */
  | { panel: 'shortcuts' }
  | { panel: 'find' }
  /** Find and Replace: the find field of `find` with a second field and the buttons that rewrite the page's text fields. */
  | { panel: 'findreplace' }
  /** "Import from Another Browser…": which browser, which profile, what to bring along. */
  | { panel: 'import' }
  /** First-launch guide: three-step setup for fresh profiles. */
  | { panel: 'firstlaunch' }
  | { panel: 'downloads' }
  | { panel: 'settings'; pane?: SettingsPane; anchor?: SettingsAnchor }
  /** The Extensions page (`chrome://extensions`): a window of its own, like Settings. `target` is the list, the page of one extension or the shortcuts. */
  | { panel: 'extensions'; target?: ExtensionsTarget }
  | { panel: 'archive' }
  | { panel: 'history' }
  | { panel: 'spaces' }
  | { panel: 'capture' }
  /** The sheet that follows a capture when "Annoter les captures" is on: `id` names the picture the main process holds (width and height are its size in pixels). Main-only: a page or the interface cannot ask for it. */
  | { panel: 'annotate'; id: string; width: number; height: number }
  | { panel: 'site'; anchor?: PlusAnchor }
  | { panel: 'space'; spaceId: string; focus?: SpaceEditorFocus }
  /** The name of a favourite (its menu's Renommer…). `anchor` (the favourite's tile) hangs the sheet from it as a bubble; without it the sheet is centred. */
  | { panel: 'favorite'; favoriteId: string; anchor?: PlusAnchor }
  /**
   * The sheet of a work view (setting `workViewsEnabled`): with `splitId`, « Enregistrer comme vue de travail… » of that split view (a name and an icon; the
   * sites and the layout are the ones on screen); with `viewId`, « Modifier… » of that view; with neither, « Nouvelle vue de travail… » from nothing.
   * `full` opens the whole sheet (sites, order, layout, proportions, where it opens) rather than the name and the icon. `anchor` hangs it from the tile.
   */
  | { panel: 'workview'; splitId?: string; viewId?: string; full?: true; anchor?: PlusAnchor }
  /** The sheet that creates a space in one go: name, icon, profile and theme colour. */
  | { panel: 'spacecreate' }
  /** The popover of the + at the foot of the sidebar (new space, folder, Tweak, split, tab); `anchor` is that button, in window coordinates. */
  | { panel: 'plus'; anchor: PlusAnchor }
  /** The menu of a space, hung from its header in the sidebar (rename, customise, new folder, empty Today, hide the header, manage the spaces); `anchor` is the header button. */
  | { panel: 'spacemenu'; spaceId: string; anchor: PlusAnchor }
  /** "Ranger les onglets…" (the button of the Today header): the folders proposed for the Today tabs of a space, to validate before anything moves (tab-grouping.ts). */
  | { panel: 'tidy'; spaceId: string }
  /** The tabs whose site no longer answers, after « Actualiser tous les onglets » or the load of every tab at launch (shared/dead-tabs.ts): opened by the main process only. */
  | { panel: 'deadtabs'; entries: DeadTabEntry[] }
  /** "Clear this site's data": cache, cookies, storage and history of one site, by type. */
  | { panel: 'sitedata' }
  /** "Cookies par site": the cookies of the profile of the space on screen, by site (names and sizes only), the sites to keep, and the clean-up. */
  | { panel: 'cookies' }
  /**
   * The saved sessions of tabs (File › Sessions…). `focus: 'save'` (File › Enregistrer la session…) starts the name field with the
   * automatic name, selected; `tabIds` is a multiple selection to save instead of the whole space.
   */
  | { panel: 'sessions'; focus?: 'save'; tabIds?: string[] }
  /** The list of pages kept to be read later (File › Liste de lecture…). */
  | { panel: 'readlater' }
  /** The bookmark library (File › Signets…, setting `bookmarkManager`): the list, search, tags, editing, import and export. */
  | { panel: 'bookmarks' }
  /** The sheet of a live folder (setting `liveFolders`): the source of a new one, or, with `folderId`, the source and name of one that exists. */
  | { panel: 'livefolder'; folderId?: string }
  /** « Icône… » of a folder's menu: the emoji of the folder, chosen in the picker of the spaces (emoji only). Centred; never in a private window. */
  | { panel: 'foldericon'; folderId: string }
  /** The name and icon of a tab. `anchor` (the tab's row) hangs the sheet from it as a bubble; without it the sheet is centred. */
  | { panel: 'tab'; tabId: string; focus?: 'name' | 'icon'; anchor?: PlusAnchor }
  /** Fenêtre › Nommer la fenêtre…: the name of the window the panel is in. Centred unless given an `anchor`. */
  | { panel: 'windowname'; anchor?: PlusAnchor }
  /** "Recharger automatiquement ▸ Personnalisé…": the interval of one tab's automatic reload, typed in. `anchor`: the tab's row, else centred. */
  | { panel: 'autoreload'; tabId: string; anchor?: PlusAnchor }
  /** The theme panel of a space. `from: 'space'` when "Personnaliser l'espace" opened it: the panel then offers the way back. */
  | { panel: 'theme'; spaceId: string; from?: 'space' }
  /** `zap`: the user is picking elements of the page; the layer shrinks to the editor panel and the page below can be clicked. */
  | { panel: 'boost'; host: string; id?: string; zap?: boolean }
  | { panel: 'shortcut'; url: string; title: string }
  /** `rect` is the Glance card (header included); `stage` is the page card it floats over and dims (window coordinates). */
  | { panel: 'peek'; rect: { x: number; y: number; width: number; height: number }; stage?: { x: number; y: number; width: number; height: number } }
  | { panel: 'permission'; request: PermissionRequest }
  /** A server (or a proxy) asks for a login: the panel answers with `answerAuth`, and closing it without answering cancels the request. */
  | { panel: 'auth'; request: AuthRequest }
  /** A page called `alert()`, `confirm()` or `prompt()` (`request.kind`): the panel answers with `answerDialog`, and closing it without answering cancels the box. */
  | { panel: 'dialog'; request: DialogRequest }
  /** "Quitter ce site ?": a page on screen holds the navigation the shell started (`beforeunload`). Main-only; the panel answers with `answerLeave`, and closing it without answering is staying. */
  | { panel: 'leave'; request: LeaveRequest }
  /** The sheet of the first launch: import, appearance, default browser. Main-only (the first launch, Aide › Premier lancement…). */
  | { panel: 'welcome' }
  /** The sheet of the first launch guide: three-step flow (data detection, appearance, protection summary). Opened on fresh profile or via Aide › Premier lancement…. */
  | { panel: 'firstlaunch' }
  /** What changed in this version, read from the changelog shipped with the application. Main-only (an update, Aide › Nouveautés). */
  | { panel: 'whatsnew'; sheet: WhatsNewSheet }
  /** « Vous venez d’Arc ? »: where the things known from Arc are in Lucium. Main-only (the end of an import from Arc, Aide › Vous venez d’Arc ?); `imported` is what that import brought. */
  | { panel: 'arcguide'; imported?: ArcImported }
  /** « Découvrir Lucium » (Aide, the command bar, the welcome sheets): what Lucium can do by task, with where to find it, its shortcut and a button that tries it (shared/discover.ts). The interface may ask for it. */
  | { panel: 'discover' }
  /** « Signaler un problème » (Aide): the report in plain text, read before anything leaves the Mac. Main-only (the menu); the sheet asks `problemReport` for the text. */
  | { panel: 'problemreport' }
  /** « Notifications récentes »: the interface asks with no list; the main process fills it (browser-overlay.ts). */
  | { panel: 'notices'; items?: NoticeEntry[] }
  /** The sheet that lists what an extension asks for before it is installed (or updated): `answerExtensionReview`; closing it is a refusal. */
  | { panel: 'extreview'; request: ExtensionReviewRequest }
  /** The main process asks for a passphrase (the encrypted export being restored): the panel answers with `answerPassphrase`; closing it without answering gives up. */
  | { panel: 'passphrase'; request: PassphraseRequest }
  /** The QR code of an address (File › Code QR de cette page, a link's menu); `text` is what the code holds. */
  | { panel: 'qr'; text: string }
  /** File › Traduire cette page… (only while the function is on): translates the text of the page on screen on this computer. */
  | { panel: 'translate' }
  /**
   * The popover of the toolbar button « Traduction de la page » (only while the function is on), hung from the button (`anchor`, window coordinates): translate
   * the page on screen or show its original, « Toujours traduire… », « Ne jamais traduire ce site », another language, the full panel.
   */
  | { panel: 'translatepop'; anchor: PlusAnchor }
  /** File › Mots de passe… (only while the password manager is on, never in a private window): the vault, the logins, the import and the export. No password is ever in it. */
  | { panel: 'passwords' }
  /**
   * A tab dragged from the sidebar is over the page (main only): the veil that shows where a split view would put it. It covers the page card
   * (`size`, in px) and draws `snapshot` (a picture of the page, or null) reduced beside the empty box; the real page is put away meanwhile.
   * `split`: the page on screen is a split view, which the tab would join (a picture of each pane, its pages put away) or which is full (its pages stay).
   */
  | { panel: 'splitdrop'; tabId: string; size: { width: number; height: number }; snapshot: string | null; sidebarRight: boolean; split?: DropHost }
  /** ⌃Tab (main only): the panel of pictures, kept while ⌃ is held. `index` is the entry the selection is on; it then moves through `Channel.cycleIndex`. */
  | { panel: 'tabcycle'; cards: CycleCard[]; index: number }
  /**
   * File › Notes… (setting `notes`, never in a private window): the notes of the page on screen, of the space, then all the others. Opened by the main
   * process (the menu, its shortcut, the command bar's `notes({ kind: 'open' })`). `compose` (File › Nouvelle note, its shortcut, the command bar): the
   * panel opens on a new note tied to the page on screen, the cursor in it. `scope` (the toolbar's « Toutes les notes »): the list opens on « Toutes »
   * even when the page on screen has notes; absent, the panel picks its own choice (`defaultNotesScope`).
   */
  | { panel: 'notes'; compose?: true; scope?: 'all' }

/** The longest passphrase any field takes (the main process refuses a longer one). */
export const PASSPHRASE_MAX_LENGTH = 1024

/** What the passphrase panel shows. `id` ties the answer to the question; `problem` is the sentence about the last wrong passphrase. */
export interface PassphraseRequest {
  id: string
  title: string
  message: string
  problem?: string
}

/** What "Exporter les données" is asked to do: a passphrase seals the file (an empty or absent one writes the plain JSON). */
export interface ExportRequest {
  passphrase?: string
}

/** How an export went: `null` is a cancelled dialog. */
export type ExportReply = { ok: true; path: string; encrypted: boolean } | { ok: false; message: string } | null

export type MenuTarget =
  /**
   * `selection`: the tabs of a multiple selection the click landed in (two or more): the menu then acts on all of them.
   * `anchor` is the row that was clicked, in window coordinates: the sheets the menu opens (Renommer…, Recharger automatiquement ▸ Personnalisé…) hang from it.
   */
  | { kind: 'tab'; id: string; selection?: string[]; anchor?: PlusAnchor }
  /** `sidebar`: the right click was on the sidebar itself (or its docked column), not on a space's icon: the menu starts with « Barre de cette fenêtre ». */
  | { kind: 'space'; id: string; sidebar?: true }
  | { kind: 'folder'; id: string }
  | { kind: 'download'; id: string }
  /** `anchor`: the favourite's tile, in window coordinates, where the sheet of its name hangs from. */
  | { kind: 'favorite'; id: string; anchor?: PlusAnchor }
  /** The tile of a work view (`id`: the view's); `anchor`: the tile, where the sheet « Modifier… » hangs from. */
  | { kind: 'workview'; id: string; anchor?: PlusAnchor }
  /** The options button of a split pane; `id` is the pane's tab. */
  | { kind: 'split'; id: string }
  /** Long press on back or forward: the page history of the current tab. */
  | { kind: 'nav'; id: 'back' | 'forward' }
  /** The « button of the toolbar: `hidden` are the extensions it holds (the ones that did not fit, and the ones unpinned). */
  | { kind: 'extensions'; id: 'overflow'; hidden: string[] }
  /** A right click on the button « Contraste de la page » of the toolbar: every mode a site can have, for the tab `id` the button is on (the same entries as View › Appearance › Contraste de la page pour ce site). A click only switches dark or light and back (`toggleReadable`). */
  | { kind: 'readable'; id: string }

/** `pause` and `resume` need the setting `downloadPause`; `open-with` the setting `openWithMemory`. */
export type DownloadCommand = 'open' | 'reveal' | 'cancel' | 'clear' | 'pause' | 'resume' | 'open-with'

export interface FindOptions {
  forward?: boolean
  /** True when continuing the same search (Enter), false when the text changed. */
  next?: boolean
  matchCase?: boolean
  /** Read the text as a regular expression (only honoured when the `findRegex` setting is on; see shared/regex-find.ts). */
  regex?: boolean
}

export interface EngineInfo {
  name: string
  version: string
  chromium: string
}

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  /** The profile this copy lives in: an extension of a folder is loaded in every profile, one from the Web Store only in the profile it was installed in. */
  profileId: string
  source: 'store' | 'unpacked'
  /** False while it is switched off in this profile: it is listed so that it can be switched on again, but it is not loaded. */
  enabled: boolean
  /** A newer version waits for the user because it asks for more than the installed one (the sheet shows the difference). */
  update?: { version: string }
  /** `side_panel.default_path` from the manifest, when declared. */
  sidePanelPath?: string
  /** The commands of the manifest with the shortcut each gets here (see `readCommands`). */
  commands?: Array<{ name: string; description: string; accelerator: string | null; label: string }>
  /** `omnibox.keyword` from the manifest, when declared and usable (see omnibox.ts). */
  omniboxKeyword?: string
  /** How many permissions and sites the person granted it in this profile on its request, when there are some: the Extensions page reads them again when the number changes. */
  grantedCount?: number
}

/** What the card of a tab says of the process that renders its page. */
export interface TabResources {
  /** Resident memory of the process, in megabytes. */
  memoryMb: number
  /** The share of one processor the process used since the previous measure, in percent. */
  cpu: number
  /** Another tab renders in the same process: the figures are the process's, not this tab's alone. */
  shared: boolean
}

/** One line of the task manager. */
export interface ProcessRow {
  pid: number
  /**
   * What the process is: a tab (named after its page), the interface of Lucium, an extension, the frames of other sites of a tab, a
   * service worker, a page that is not a tab (Glance, a web panel…), the browser, the GPU, a utility…
   */
  kind: 'tab' | 'interface' | 'extension' | 'subframe' | 'worker' | 'page' | 'browser' | 'gpu' | 'utility' | 'other'
  name: string
  /** In % of one core, as Activity Monitor counts it: the total of the processes may pass 100 %. */
  cpu: number
  /** Resident memory in megabytes. */
  memoryMb: number
  /** The space the tab of this process is in (tabs only). */
  space?: string
  /** The tab this row is for (tabs, sleeping ones included, and the frames of other sites of a single tab: "Mettre en veille" puts it to sleep). */
  tabId?: string
  /** A tab with no process: put to sleep, its memory is free. Its row has no pid of its own. */
  asleep?: boolean
  /** What "Fermer l’onglet" does to this tab, the rule of the sidebar's cross (shared/tab-close.ts): a pinned tab is not archived. */
  closeAction?: TabCloseAction
}

export interface ToastState {
  id: number
  message: string
  action?: string
  /** A second button, after the first ("Ouvrir la liste" beside "Annuler"). */
  secondAction?: string
  /** How long the notice stays, in ms (shared/toast.ts): the time line under it runs this long, and stops while the pointer or the focus is on it. */
  durationMs: number
  /** A second line, under the message (the phase of « Actualiser tous les onglets »). */
  detail?: string
  /** A job that goes on: the bar under the notice says how far it is, in place of the time line. */
  progress?: ToastProgress
}

/** How far the job of a notice is: `done` of `total`. */
export interface ToastProgress {
  done: number
  total: number
}

/** Everything the UI surfaces need to render, pushed on every change. */
export interface UiSnapshot {
  state: SidebarState
  runtime: RuntimeState
  engine: EngineInfo
  extensions: ExtensionInfo[]
  downloads: DownloadInfo[]
  find: FindState | null
  peek: PeekState | null
  /** The split views whose panes scroll together now (the "Défilement synchronisé" button of their bar is pressed, and a badge sits on their divider). Absent when none. */
  scrollSyncedSplits?: string[]
  /** The page annotation is on (by default; LUCIUM_ANNOTATE=0 turns it off, from the sources or in a smoke run only): the toolbar shows its button « Annoter » at all times. Absent when off. */
  annotateEnabled?: true
  /** The battery saver is on (shared/battery-saver.ts): the video behind a space pauses meanwhile. Absent when it is off. */
  batterySaverOn?: true
  /** The system always shows the scroll bars (macOS: Réglages Système › Apparence, shared/scroll-bars.ts): the lists that hide theirs draw them. Absent otherwise. */
  scrollBarsAlways?: true
  /** This build carries a test update channel (a second address sealed into it, main/shell/update-source.ts): Settings › Général offers « Recevoir les versions de test » only then. Absent otherwise. */
  updateTestChannel?: true
  sidePanel: SidePanelState | null
  /** The web panel docked beside the page, when there is one (it takes the place of an extension's side panel: one at a time). Absent without one. */
  webPanel?: WebPanelState | null
  /** A short notice at the foot of the sidebar ("Onglet archivé"), with an optional action ("Annuler"). */
  toast: ToastState | null
  platform: string
  /** True in a private window: the UI surfaces of that window look the part, and nothing it shows is kept. */
  private?: boolean
  /** True in a guest window (which is `private` underneath): the interface keeps the private rules but not the private look. */
  guest?: boolean
  /**
   * The floating sidebar's own surface only: `in` while the panel slides over the page, `out` while it leaves (the surface plays
   * the animation of that phase; absent when it is not shown).
   */
  floating?: 'in' | 'out'
  /** True while the popover of the + is open: the button shows a cross instead of the plus. */
  plusOpen?: boolean
  /** The filter lists of the ad and tracker blocker: installed, updated when, failed how. Absent in a private window. */
  blocking?: BlockingStatus
  /** The lock, when it is on and has a phrase (absent otherwise: nothing about it reaches the interface). With `appLocked` the state above is a skeleton. */
  lock?: LockView
  /** The windows the command bar can go to by name (the named ones other than this). Only present while windows can be named (a setting). */
  windows?: NamedWindow[]
  /** The name of this window, when it has one. Only present while windows can be named. */
  windowName?: string
  /**
   * The sidebar this window chose for itself (its side, docked or not; window-sidebar.ts): the interface places it with `sidebarPlacement`. Absent when it chose
   * nothing (the setting's side, the full sidebar). `state.settings.sidebarRight` stays the setting, the side of the new windows.
   */
  windowSidebar?: WindowSidebar
  /**
   * With windows of their own (`independentWindows`), the tabs each space of `state` holds in every window, which this window does not all list:
   * « Gérer les espaces » counts them (deleting a space closes them all). Absent when the window lists every tab, and while a lock hides some.
   */
  spaceTabs?: Record<string, number>
  /** Tabs another window of the application is dragging right now: this window's list takes a drop of them. Absent when there is no such drag. */
  foreignDrag?: ForeignDrag
  /** The ring at the foot of the sidebar (shared/resources.ts): absent while the function is off, in a private window, before its first reading and while the application is locked. */
  memoryGauge?: MemoryGauge
  /** The run of « Actualiser tous les onglets » under way in this window: its button turns and says how far it is. Absent otherwise. */
  reloadRun?: ReloadRunView
  /**
   * The tabs whose site no longer answers that the run under way (or the last one) found so far: the sheet « Sites qui ne répondent plus », open
   * during the run, adds them as they come. Absent when there are none.
   */
  deadTabs?: DeadTabEntry[]
}

/** Tabs being dragged out of another window (see `TabDragLedger`): `token` tells one drag from the next. */
export interface ForeignDrag {
  token: number
  tabs: WindowTab[]
}
