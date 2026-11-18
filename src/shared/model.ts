// Persistent browser state. Pure data: no Electron imports, safe to use in main and renderer.

import type { SpaceTheme } from './theme'
import type { LiveFolder } from './live-folders'
import type { SpaceBackground } from './space-media'
import type { PermissionDecision, Settings } from './model-settings'

// Moved to modules of their own, still importable from here.
export { type SiteSearch, type PermissionDecision, type SleepMode, type UpdateChannel, type BlockMode, type WebStoreUpdates, WEB_STORE_UPDATES, type LinkRoute, type BoostScriptImport, type ProtectionBaseline, type Settings, type PageWatch, type WindowVibrancy, WINDOW_VIBRANCIES, SIDEBAR_OPACITY_MIN, SIDEBAR_OPACITY_DEFAULT, WINDOW_BORDER_MAX, WINDOW_BORDER_DEFAULT, type CommandBarSize, COMMAND_BAR_SIZES, type CommandBarShape, COMMAND_BAR_SHAPES, COMMAND_BAR_SIZE_DEFAULT, COMMAND_BAR_SHAPE_DEFAULT, SEARCH_DISCOVERY_SEEN_MAX } from './model-settings'
export { DEFAULT_SEARCH_URL, SEARCH_ENGINES, SIDE_PANEL_WIDTH_MIN, SIDE_PANEL_WIDTH_MAX, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_LEGACY, DEFAULT_SITE_SEARCHES, defaultSettings } from './model-defaults'

export const STATE_VERSION = 1
/**
 * The revision of the format within its version: it moves when a migration is added, never with an added field (a new field only needs its default). It
 * tells a file a migration was already applied to (a width of 264 px the user chose stays 264), and an older build that reads the file still reads it:
 * the version, which it compares, does not change. A file without one was written before revisions existed.
 */
export const STATE_REVISION = 2

/** What stands for a space in the sidebar. */
export type SpaceIconKind = 'emoji' | 'letter' | 'image'

export interface Space {
  id: string
  name: string
  emoji: string
  /** Colours and texture of the sidebar and window background (see theme.ts). */
  theme: SpaceTheme
  /** Chromium profile: spaces sharing a profileId share cookies and storage. */
  profileId: string
  /** Hide the space header. The header is the space's name above its tabs. */
  hideHeader?: boolean
  /** A picture the user chose for the space, shown in place of its emoji: the name of a file in the data folder (see space-image.ts). Absent = the emoji. */
  image?: string
  /** Which of the three icons shows: the emoji, the coloured letters or the picture (see space-icon.ts). Absent = the picture if there is one, else the emoji. */
  iconKind?: SpaceIconKind
  /** The letters (one or two, in capitals) of the coloured-letter icon. */
  iconLetter?: string
  /** The colour behind the letters: `#rrggbb`. Absent = the first colour of the picker. */
  iconColor?: string
  /** The letter icon is a circle rather than a rounded square. */
  iconRound?: boolean
  /** Sites kept beside the page, opened one at a time in a panel (see web-panels.ts). Absent = none. */
  webPanels?: WebPanel[]
  /** Background for the space sidebar: color, image, GIF, or video (see space-media.ts). Absent = color from theme. */
  background?: SpaceBackground
}

/** One site of a space's side panels: what the menu lists and the address the panel loads. */
export interface WebPanel {
  id: string
  /** An http(s) address. */
  url: string
  /** The name the menu shows: the page's title when it was added, else the site's name. */
  title: string
}

/** A tab's automatic reload: the page is reloaded every `seconds` (whole seconds, within the bounds of auto-reload.ts). */
export interface AutoReload {
  seconds: number
}

export interface TabItem {
  id: string
  spaceId: string
  url: string
  title: string
  faviconUrl?: string
  /** A name the user gave the tab: it replaces the page title in the sidebar and survives navigation. */
  customTitle?: string
  /** An emoji the user chose for the tab: it replaces the favicon. */
  icon?: string
  /** A picture the user chose for the tab (the name of its stored copy, shared/space-image.ts): it replaces the emoji and the favicon. */
  image?: string
  pinned: boolean
  /** URL a pinned tab returns to ("Back to Pinned URL"). */
  anchorUrl?: string
  /** The user chose "never put this tab to sleep": the delay leaves it alone. */
  keepAwake?: boolean
  /**
   * The user kept this tab when it was offered as a tab whose site no longer answers (shared/dead-tabs.ts): for the address it had then, and since
   * when. It is not offered again for that address for a while (`DEAD_KEPT_MS`).
   */
  deadKept?: { url: string; at: number }
  /** The tab reloads itself at this interval while its page is awake (see auto-reload.ts). Absent = off. */
  autoReload?: AutoReload
  folderId?: string
  /**
   * A private tab of a normal window (File › Nouvel onglet privé): its page lives in a throw-away session kept in memory, and the tab is
   * never written anywhere: not to the state file, the archive, the history, a session, a copy or an export (see `persistableState`).
   */
  private?: boolean
  /**
   * The container the tab lives in (setting `tabContainers`): its page has the cookies, storage and permissions of that container, apart from
   * the profile of its space. Absent = the profile's. A private tab has none (see containers.ts, `containerOfTab`).
   */
  container?: string
  /**
   * The window the tab belongs to (setting `independentWindows`): `window-1`… for a window opened after the first; absent for the first window's
   * tabs. It lasts as long as the windows do and is never saved (see window-tabs.ts, `withoutWindowKeys`).
   */
  windowKey?: string
  /**
   * The tab this one was opened from (a link, `window.open`, a ⌘-click). Kept only while this tab is still on its first page: Back then closes
   * it and returns there (Settings › Général › Onglets). Forgotten at the first navigation, and when the tab it names goes.
   */
  openerId?: string
  /**
   * The tab this one hangs under in the sidebar's tab tree (setting `tabTree`): the tab it was opened from, or the one it was dropped on. Unlike
   * `openerId` it survives navigation. Only a Today tab can hang under another Today tab of its space; the settings off, there is none
   * (see tab-tree.ts, which keeps the list in the order of the tree).
   */
  parentId?: string
  /** The tab's children are folded away in the sidebar. Only kept while the tab has children. */
  treeCollapsed?: true
  /**
   * The favourite this tab is the page of. A favourite opens as a tab of the space that no list shows: its tile in the sidebar stands for it (it is lit
   * while the tab is selected). Forgotten when the favourite goes or the tab is pinned (see `pruneFavoriteTabs`).
   */
  favoriteId?: string
  createdAt: number
  lastActiveAt: number
}

/** Whether the sidebar lists the tab: the page of a favourite is not a row, its tile stands for it. */
export const isListedTab = (tab: Pick<TabItem, 'favoriteId'>): boolean => tab.favoriteId === undefined

/** What the sidebar and the command bar call a tab: the user's name for it, else the page's title. */
export const tabName = (tab: Pick<TabItem, 'title' | 'customTitle'>): string => tab.customTitle?.trim() || tab.title

export const TAB_NAME_MAX = 120

export interface Folder {
  id: string
  spaceId: string
  name: string
  collapsed: boolean
  /** The folder this one sits in. Absent for a folder at the root of the pinned list (files saved before sub-folders have none). */
  parentId?: string
  /** A live folder (setting `liveFolders`): it fills itself with the latest items of a feed or a repository. Absent for an ordinary folder. */
  live?: LiveFolder
  /**
   * The folder stands under the loose Today tabs instead of above them. Only a folder at the root of the list has a side (one inside another is placed
   * with its parent, see `normalizeFolders`); absent is the place folders have always had, on top.
   */
  atBottom?: true
  /**
   * The folder stands at the start of Today: under its header (and its "New tab" row), before the Today tabs. Never together with `atBottom` (the file's
   * `atBottom` wins, `cleanFolders`), and like it only for a root folder. The side is the folder's own, not a place among the Today tabs: a new tab
   * lands where it always did, after the others.
   */
  atTodayStart?: true
  /**
   * Its tabs, and those of the folders inside it, are never woken by themselves: not by « Actualiser tous les onglets », not at the launch. They stay
   * asleep until the user opens one. For the old sites kept to take a project up again, unused for months. Absent for an ordinary folder.
   */
  noWake?: true
  /**
   * One emoji the user chose for the folder: it shows in the row in place of the folder drawing (open or closed). Absent is the drawing, which is what a folder
   * has always had, so a file saved before the choice existed needs no migration (`cleanFolders` keeps it only when it is exactly one emoji).
   */
  icon?: string
}

/**
 * Shown as an icon row on top of the sidebar, in every space of one profile and in none of another (the favourites of each profile are kept apart): a window on
 * a space of the "work" profile never lists, renames or reorders those of "perso" (see favorite-scope.ts).
 */
export interface Favorite {
  id: string
  url: string
  title: string
  faviconUrl?: string
  /**
   * The profile whose spaces list it. Absent only in what has not been through `normalize` yet (a file from before the favourites were kept per profile,
   * the output of an importer): it then means the default profile, and `normalize` gives each profile in use its own copy of such a favourite.
   */
  profileId?: string
}

/** `sync`: the open tabs of a space that another device deleted, kept when the synchronisation removed the space (docs/synchronisation.md §8.5). */
export type ArchiveSource = 'auto' | 'manual' | 'little' | 'sync'

/** One page of a closed tab's Back / Forward list. */
export interface ClosedPage {
  url: string
  title: string
}

/** The pages a tab went through (oldest first) and the one it was on, kept with its archive entry while the setting `reopenHistory` is on (see closed-history.ts). */
export interface ClosedHistory {
  entries: ClosedPage[]
  index: number
}

export interface ArchivedTab {
  id: string
  spaceId: string
  url: string
  title: string
  archivedAt: number
  /** Why it is in the archive: left idle, archived by hand, a closed mini window, or kept when another device deleted its space. */
  source?: ArchiveSource
  /** The pages before this one, when the setting asked for them to be kept: reopening the tab brings its Back list back. */
  history?: ClosedHistory
  /** The container the tab was in: reopening it opens it there again. */
  container?: string
  /** The tab was pinned: reopening it pins it again, at its anchor address, in its folder while that folder still exists (else at the root of the pinned ones). */
  pinned?: true
  anchorUrl?: string
  folderId?: string
}

/** A page kept to be read later (File › Lire plus tard): what the list shows, and the address it opens. Shared by all spaces. */
export interface ReadLaterItem {
  id: string
  /** An http(s) address: the only kind of page worth coming back to (see read-later.ts). */
  url: string
  title: string
  /** The page's icon as the tab had it: a web address, or a `data:image/…` small enough to keep with the state. Absent when the page had none. */
  faviconUrl?: string
  savedAt: number
  /** The folder the page was put in (Settings › Téléchargements et fichiers › Plus de réglages); absent: loose in the list. */
  folderId?: string
}

/** A named folder of the read-later list. Pages are in at most one; the list shows the folders first, then the loose pages. */
export interface ReadLaterFolder {
  id: string
  name: string
  collapsed?: boolean
}

/**
 * A bookmark of the library (setting `bookmarkManager`): a page kept for good, with the tags its owner gave it. It is another thing than
 * the favourites of the sidebar (a row of icons) and than the pinned tabs: those are untouched by the library.
 */
export interface Bookmark {
  id: string
  /** An http(s) address (see bookmarks.ts). */
  url: string
  title: string
  /** Free labels, each once (compared without case or accents), at most `BOOKMARK_TAGS_MAX`. */
  tags: string[]
  note?: string
  /** The icon of the page as the tab had it: a web address or a small `data:image/…` (see state-clean.ts). */
  faviconUrl?: string
  addedAt: number
}

/** The library keeps this many bookmarks; the one past it is refused, and a file that holds more is read up to it. */
export const BOOKMARKS_LIMIT = 5000
export const BOOKMARK_TITLE_MAX = 300
export const BOOKMARK_URL_MAX = 4096
export const BOOKMARK_NOTE_MAX = 1000
export const BOOKMARK_TAGS_MAX = 12
export const BOOKMARK_TAG_MAX = 40

/** The list keeps this many pages; the one past it is refused rather than pushing an older one out. */
export const READ_LATER_LIMIT = 500
export const READ_LATER_TITLE_MAX = 300
export const READ_LATER_URL_MAX = 4096
export const READ_LATER_FOLDERS_LIMIT = 50
export const READ_LATER_FOLDER_NAME_MAX = 100
/** In characters of the `data:` URL: a typical favicon is a few thousand, and the list is saved with the state at every change. */
export const READ_LATER_FAVICON_MAX = 16_384
/** A tab's icon is a web address in a normal window (the engine only inlines it as data in a private one). */
export const READ_LATER_FAVICON_URL_MAX = 2048

/** One page of a saved session. `folder` is the name of the folder a pinned tab sat in: an id would mean nothing in another space. */
export interface SessionTab {
  url: string
  title: string
  pinned?: boolean
  folder?: string
  /** The folder (named by `folder`) stood under the loose Today tabs: restoring makes it again where it was, when it has to make it. */
  folderBottom?: true
  /** The container the tab was in; restoring opens it there when the container still exists. */
  container?: string
}

/**
 * A space put aside (Espaces › Mettre l’espace de côté…): everything that makes it the space it was, kept inside the session it became.
 * The space is gone from the sidebar meanwhile, so nothing else refers to it but the link rules and the profile it browses with.
 */
export interface AsideSpace {
  /** The space as it was (name, icon, theme, profile, header). Its id comes back with it, so that the link rules naming it work again. */
  space: Space
  /** Its place among the spaces. */
  index: number
  folders: Folder[]
  /** Every tab of the space in the state's order (a page a session would not keep, an extension page for instance, included). */
  tabs: TabItem[]
  /** The split views among those tabs. */
  splits: SplitView[]
  /** The tab that was on screen in it. */
  selected: string | null
  /** What it had in the archive. */
  archive: ArchivedTab[]
}

/**
 * Tabs saved under a name to be opened again later (File › Sessions…); shared by all spaces, newest first.
 * A session with a `space` is a space put aside: `tabs` is its pages as an ordinary session would keep them (possibly none), `space` is the rest.
 */
export interface Session {
  id: string
  name: string
  createdAt: number
  tabs: SessionTab[]
  space?: AsideSpace
}

export type SplitOrientation = 'horizontal' | 'vertical'

/** How a split view lays its panes out (« Disposition » in its menu): in a row, in a column, or in a grid of two columns and two rows (three or four panes). */
export type SplitArrangement = SplitOrientation | 'grid'

/**
 * In a grid of three panes, the side one pane takes whole: `bottom` is two panes on top and one under them the whole width, `left` is one pane the
 * whole height and two stacked at its right.
 */
export type GridSpan = 'top' | 'bottom' | 'left' | 'right'

/** The grid of a split view: one column divider and one row divider, each with its share. */
export interface SplitGrid {
  /** Share of the width given to the left column, between SPLIT_MIN_RATIO and 1 − SPLIT_MIN_RATIO. */
  column: number
  /** Share of the height given to the top row, within the same bounds. */
  row: number
  /** Three panes: the side one of them runs along. Four panes (2 × 2) have none. */
  span?: GridSpan
}

/** 2 to 4 tabs of one space shown side by side (horizontal), stacked (vertical), or 3 or 4 of them in a grid. */
export interface SplitView {
  id: string
  spaceId: string
  /** The panes in reading order: left to right, then top to bottom (a grid's pane that spans two cells comes at its first one). */
  tabIds: string[]
  orientation: SplitOrientation
  /** Share of the stage given to each pane, sums to 1. */
  ratios: number[]
  /**
   * Set, the panes are in a grid; `orientation` and `ratios` are then kept for the row or column it goes back to (« Disposition » in the menu).
   * Absent in a file written before grids existed: its split views open as the rows and columns they were.
   */
  grid?: SplitGrid
  /**
   * The work view this split view was opened from (or saved as): its tile is lit while one of these panes is on screen, and a click on the tile shows
   * this split view again instead of opening the sites a second time (see work-views.ts). Absent for every other split view.
   */
  viewId?: string
}

/** One site of a work view: the address its pane opens, and what the tile and the sheet show before the page has loaded. */
export interface WorkViewPane {
  /** A web address or a local file, as a session keeps one (sessions.ts `isSessionUrl`). */
  url: string
  title: string
  /** The icon of the page when it was saved: a web address only (a picture inlined as data would swell the file). Absent: the first letter of the site. */
  faviconUrl?: string
}

/** Where a work view opens. Absent: in the space on screen. */
export type WorkViewTarget =
  /** Always in this space, one of the profile of the view. */
  | { kind: 'space'; spaceId: string }
  /** In a space of its own, made at the first opening and then reused: it becomes `space` with the id of the space made. */
  | { kind: 'new-space' }
  /** In a new window, unless a window already shows it. */
  | { kind: 'window' }

/**
 * « Vue de travail »: 2 to 4 sites chosen ahead, opened with one click as a split view, in their places and proportions. A tile after the favourites
 * stands for it, in every space of its profile and in none of another. It keeps addresses only: the pages it opens are ordinary tabs of Today.
 */
export interface WorkView {
  id: string
  name: string
  /** One emoji, shown before the name (the tile itself draws the layout with the icons of the sites). */
  emoji: string
  /** The profile whose spaces list it and open it: its pages have the cookies of that profile. */
  profileId: string
  /** The panes in reading order, as a split view keeps them (`SplitView.tabIds`): 2 to `SPLIT_MAX_PANES`. */
  panes: WorkViewPane[]
  orientation: SplitOrientation
  /** One share per pane, summing to 1, none under `SPLIT_MIN_RATIO`. */
  ratios: number[]
  /** Set for 3 or 4 panes in a grid, as for a split view. */
  grid?: SplitGrid
  target?: WorkViewTarget
}

/** Page-wide colour adjustment (a CSS filter): neutral values change nothing. */
export interface BoostTint {
  /** Hue rotation in degrees, -180..180. */
  hue: number
  /** 0 = greyscale, 1 = unchanged, 2 = twice as vivid. */
  saturation: number
  brightness: number
  contrast: number
}

export const NEUTRAL_TINT: BoostTint = { hue: 0, saturation: 1, brightness: 1, contrast: 1 }

/** How a Tweak changes the case of the text of a page (no entry = the page's own case). */
export type BoostTextCase = 'upper' | 'lower' | 'capitalize'

/** CSS, JavaScript, zoom, hidden elements and colours applied to every page of a site. A site can have several. */
export interface Boost {
  id: string
  name: string
  /** Matches this host and its subdomains. */
  host: string
  enabled: boolean
  css: string
  js: string
  /**
   * `false` keeps the script but never runs it: how a Tweak that came from a file or a link is stored until its owner has read the code
   * and switches it on in the editor. Absent means on (a Tweak written here, or saved before this field existed).
   */
  jsEnabled?: boolean
  /**
   * The script as it is being typed in the editor, while it differs from `js`: kept so that nothing typed is lost when the application
   * closes, and never run by a page on its own. Only the person makes it `js` (the editor's "Enregistrer le script") or runs it once (its preview).
   */
  jsDraft?: string
  /** Text zoom for the whole site, 1 = 100 %. */
  zoom: number
  /** CSS selectors of elements hidden with the Eraser. */
  zap: string[]
  tint: BoostTint
  /** Id of one of the font families of `BOOST_FONTS` (shared/boost.ts); unknown ids are ignored. */
  fontFamily?: string
  textCase?: BoostTextCase
  /** Invert the lightness of the page (a dark mode), images and videos excepted. */
  invert?: boolean
}

/** What the UI sends to save a Tweak: everything but the host is optional (a missing id creates one). */
export type BoostInput = Pick<Boost, 'host'> & Partial<Omit<Boost, 'host'>>

export const BOOST_ZOOM_MIN = 0.5
export const BOOST_ZOOM_MAX = 3
export const BOOST_ZAP_MAX = 100
/** The longest script (in characters) a Tweak keeps: a Tweak is a few lines; more is a mistake or a state made to weigh on every snapshot. */
export const BOOST_JS_MAX = 1_000_000

export interface SidebarState {
  version: typeof STATE_VERSION
  /** The migrations of the format up to this revision have been applied (STATE_REVISION). Absent only in a file written before revisions existed. */
  revision?: number
  spaces: Space[]
  /** Array order is the display order within a (space, pinned) group. */
  tabs: TabItem[]
  folders: Folder[]
  favorites: Favorite[]
  archive: ArchivedTab[]
  /** Pages saved to be read later, newest first (a private window keeps none). */
  readLater: ReadLaterItem[]
  /** The folders of the read-later list, in the order they are shown (empty until the setting `useReadLaterFolders` is used). */
  readLaterFolders: ReadLaterFolder[]
  /** The bookmark library, newest first (empty until the setting `bookmarkManager` is used; a private window keeps none). */
  bookmarks: Bookmark[]
  activeSpaceId: string
  activeTabBySpace: Record<string, string | null>
  /** Remembered answers to web permission prompts, by origin then permission name. */
  sitePermissions: Record<string, Record<string, PermissionDecision>>
  /** Extensions that asked for their side panel to open when their toolbar icon is clicked (chrome.sidePanel.setPanelBehavior). */
  sidePanelBehavior: Record<string, boolean>
  /** How often each page was picked in the command bar, a ranking bonus: by profile, then by page (command-bar-usage.ts). */
  commandBarUsage: Record<string, Record<string, number>>
  splits: SplitView[]
  boosts: Boost[]
  /** Named sets of tabs, newest first (a private window keeps none; see sessions.ts). */
  sessions: Session[]
  /**
   * The work views, in the order of their tiles; each profile reads its own slice (work-views.ts). A list of its own at the top of the state, not a
   * field of the favourites: a build that does not know it keeps it in the file as it is (store.ts, the foreign fields), where it would drop an unknown
   * field of a favourite. A private window keeps none.
   */
  workViews: WorkView[]
  settings: Settings
}

/** Volatile per-tab information, never persisted. */
export interface TabRuntime {
  loading: boolean
  audible: boolean
  muted: boolean
  /** False while a pinned tab is "asleep": persisted but without a live web view. */
  awake: boolean
  /** The page is kept in memory but stopped (sleep mode "freeze"): not awake either, but not asleep. Absent otherwise. */
  frozen?: true
  /** The last load did not come to a page: one of our error pages is on screen (the site does not answer, a refused certificate). Absent otherwise. */
  failed?: true
  /**
   * The page may have come over a certificate that was not valid: one was let through for its site in this session (« Continuer quand même », or a
   * site in Developer Mode). The address says « Non sécurisé », never a padlock (`connectionState`). Absent otherwise.
   */
  untrustedCertificate?: true
  /** The unread count the page shows in its own title, read before any tidying (a pinned tab shows a shorter title). Absent when the title shows none; held for a few seconds when a title stops showing it (shared/tab-messages.ts). */
  unread?: number
  /** Unread messages the title says without a number, by a mark in front of it (Slack: `!` a mention or a direct message, `*` any unread message). Absent with a count: the count says more. */
  unreadMark?: '!' | '*'
  /** The page's icon moved away from the one the tab had while the tab was in the background (the dot of the row, with `tabStateBadges`). Absent once the tab is shown. */
  changedIcon?: true
  /** The colour the page declares in `<meta name="theme-color">`, as hex: the toolbar takes it (a page that declares none keeps the default bar). */
  color?: string
  /** Whether this tab's own page can go back / forward: the toolbar of each pane of a split view shows its own page's state. */
  canGoBack?: boolean
  canGoForward?: boolean
  /** Back would close this tab and return to the one it was opened from (no page behind it, but an origin): the Back button and menu entry stay enabled. */
  backCloses?: boolean
  /** What the media player of the sidebar shows of this tab's page (see media-player.ts); absent until the page was asked. */
  playing?: boolean
  /** The level the user gave the tab with the player's slider, 0 to 1; absent is the page's own level. */
  volume?: number
  /** The site registered a handler for the previous / next track (MediaSession), so those buttons can act. */
  previous?: boolean
  next?: boolean
  /** The page has a media element at all, and a video that can float (false: the player has nothing left to drive). */
  media?: boolean
  video?: boolean
  /** When the countdown of the automatic reload ends (ms since the epoch); only for a tab that has the setting and a live page. The row counts down by itself between two publications. */
  reloadAt?: number
  /** The page of the tab is in Lucium's floating video window (« Image dans l'image »): its row has a mark, the place of its page says so. Absent otherwise. */
  floating?: true
  /** An extension is capturing the sound of this tab (shared/tab-capture.ts): its name, as the mark of the row and of the bar says it. Absent otherwise. */
  capturedBy?: string
  /**
   * The language of the page when it is not the one pages are translated into (a language code, read once per document while 'translate-local' is on): the
   * toolbar offers its translation. Absent for a page in that language, an unknown one, or with the function off (nothing is published for them).
   */
  pageLanguage?: string
  /** The page is being translated, or is translated, in one click or by itself (shared/translate-quick.ts). Absent otherwise, and gone with the document. */
  translation?: TabTranslation
}

/** The translation of a tab's page: under way (`working`) or done (`translated`), from a language to another. */
export interface TabTranslation {
  state: 'working' | 'translated'
  from: string
  to: string
}

export interface RuntimeState {
  tabs: Record<string, TabRuntime>
  canGoBack: boolean
  canGoForward: boolean
  /** Same as `TabRuntime.backCloses`, for the tab on screen. */
  backCloses?: boolean
  /** The tabs that have a media player at the foot of the sidebar, oldest first (the shell's own list; see media-player.ts). */
  media?: string[]
  /**
   * The rows a run of « Actualiser tous les onglets » covers (shared/reload-all.ts, `reloadMarks`): to come, under way, or reloaded a moment ago.
   * Absent outside a run. A tab never opened in this session has no entry in `tabs`, so the marks are kept apart.
   */
  reloadMarks?: Record<string, 'pending' | 'running' | 'reloaded'>
}

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisitAt: number
}

export interface DownloadInfo {
  id: string
  filename: string
  url: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  /** The download is paused (still `progressing`): it waits for the user to resume it. */
  paused?: boolean
  /** An interrupted download (`interrupted`) that the engine can carry on from where it stopped. */
  resumable?: boolean
  /** A record on disk can carry this download on even after a restart (setting `downloadResume`); the row's address is then only its host and path. */
  recorded?: boolean
  /** Opened without being kept: the file is in the application's temporary folder and goes when the application quits. */
  temporary?: boolean
  /** The type the server announced (a short line; the page's word, used only to refuse opening what could run). */
  mimeType?: string
  /** macOS: the finished file could not be marked as downloaded from the Internet, so the system will not check it when it is first opened. */
  unmarked?: boolean
  /** Why an interrupted download stopped, when it can be told (the disk is full); the engine does not say more. */
  reason?: 'disk-full'
}

export interface FindState {
  text: string
  matches: number
  ordinal: number
  /** The text is read as a regular expression (see regex-find.ts). */
  regex?: boolean
  /** Why a regular-expression search gave nothing to show (see `RegexFindError`). */
  error?: 'invalid' | 'too-long' | 'slow' | 'failed' | 'unsupported'
  /** There are more matches than the ones counted (the count stopped at a limit, or the page text was cut short). */
  more?: boolean
}

/** The extension side panel currently docked beside the page, if any. */
export interface SidePanelState {
  extensionId: string
  name: string
}

/** The web panel currently docked beside the page, if any (it shares the dock with an extension's side panel: one at a time). */
export interface WebPanelState {
  id: string
  title: string
  url: string
}

/** The Glance preview currently open, if any. */
export interface PeekState {
  url: string
  title: string
  /** Set by the engine when the previewed page has history: the Glance header then shows the back and forward buttons. */
  canGoBack?: boolean
  canGoForward?: boolean
  /** The previewed page is loading: the header draws its progress line and "Recharger" becomes "Arrêter". */
  loading?: boolean
  /** The icon the page declares, for the header (absent: a glyph). */
  faviconUrl?: string
}

export interface PermissionRequest {
  id: string
  origin: string
  permission: string
  /** What the permission is about when the name alone does not say it: the scheme an `openExternal` request wants to open. */
  detail?: string
  /** The question comes from a private tab: the answer is never remembered, whatever the panel sends back. */
  ephemeral?: boolean
  /** The question comes from a page of this container: an answer that is remembered is kept in the container, not in the profile. */
  container?: string
}
