// The state of a window of the browser (every field of the class Browser, and its constructor), and what the layers of browser-*.ts call
// in one another. The class is cut into layers by responsibility (docs/architecture.md): each layer extends the one below it and adds
// methods only, so every field is set up here, in the order it always was.

import type { LittleOrigin } from '@shared/little'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import { InternalPages } from './internal-pages'
import type { ScreenWatch } from './screen-notice'
import type { OnDemandView } from './on-demand-view'
import type { OverlayRequest, PassphraseRequest, SettingsAnchor, SettingsPane, ToastProgress, ToastState, UiSnapshot } from '@shared/ipc'
import type { DeadTabEntry, LoadFailure } from '@shared/dead-tabs'
import type { ReloadPace, ReloadPhase } from '@shared/reload-all'
import type { ReleaseOutcome } from '@shared/resources'
import type { DownloadInfo, FindState, HistoryEntry, PermissionRequest, RuntimeState, SplitView, TabItem } from '@shared/model'
import type { AuthRequest, Credentials } from '@shared/http-auth'
import type { DialogRequest, PromptAnswer } from '@shared/page-dialog'
import { AutoPipMemory } from '@shared/auto-pip'
import { NoticeLog } from '@shared/notice-log'
import { BlankTabWatch } from './blank-tab-watch'
import { UnreadWatch } from './unread-watch'
import type { NamedWindow } from '@shared/window-names'
import { NO_WINDOW_SIDEBAR, sidebarPlacement, type SidebarPlacement, type WindowSidebar } from '@shared/window-sidebar'
import { SidebarTrace, sidebarFacts, type SidebarFacts } from './sidebar-trace'
import { blockingService } from '../blocking'
import { BlockerCss } from './blocker-css'
import type { ExtensionReviewRequest } from '@shared/extension-review'
import { ExtensionActions } from './extension-actions'
import type { ExtensionFolderSync } from './extension-folders'
import { visibleTabIds } from '@shared/window-selection'
import { TabDragLedger } from '@shared/tab-drag'
import type { DropWithNewTab } from '@shared/split-drop'
import { decideCycleKey, type CycleCard } from '@shared/tab-cycle'
import { effectiveAccelerator, physicalKey } from '@shared/keybindings'
import { keyboardLayout } from './keyboard-layout'
import { DEFAULT_WINDOW_LOOK_KEY } from '@shared/window-look'
import type { PanelConfig } from '@shared/sidepanel'
import type { Action } from '@shared/sidebar'
import { CaptureShelf } from './capture-shelf'
import { SearchDiscovery } from './search-discovery'
import type { Bounds, EphemeralEngine, Engine, ExtensionTabHooks, Page, PageEvents, PageKey, RequestBlocker } from '../engine/types'
import { AutoReloader } from './auto-reload'
import { TooltipWindow } from './tooltip'
import type { AutoplayMode } from '@shared/autoplay'
import { PageGuard, SiteSeeds, type GuardEngine } from './page-guard'
import { PublishQueue } from './publish-queue'
import type { WindowChoice } from '@shared/window-move'
import { PAGE_WATCH_GAP_MS, PageWatcher } from './page-watch'
import { FaviconService } from './favicon-service'
import { LiveFolderService } from './live-folders'
import type { ResourceWatch } from './resource-watch'
import { LIVE_GAP_MS } from '@shared/live-folders'
import { FeatureGates } from './feature-gate'
import type { ThumbnailSource } from './thumbnails'
import type { FloatingVideo } from './floating-video'
import type { StateStore } from '../store'
import type { PasswordWindow } from './password-service'
import { ReopenLedger } from './reopen-ledger'
import { SleptHistory } from './slept-history'
import { ToastClock } from '@shared/toast'
import type { Browser } from './browser'

/** The colour behind an opaque window (the one the windows are created with, in index.ts). */
export const WINDOW_BACKGROUND = '#17171c'

/** The two panels that search the page: Find, and Find and Replace. */
export const isFindPanel = (panel: OverlayRequest['panel'] | undefined): boolean => panel === 'find' || panel === 'findreplace'

export const SLEEP_SWEEP_MS = 60_000
/** How long the answer of a page that holds what a sleep would lose keeps it out of the cap: three sweeps, then it is asked again. */
export const SLEEP_KEPT_MS = 3 * SLEEP_SWEEP_MS
/** A track change pauses the media and starts it again within a few milliseconds: the player asks the page once things settle. */
export const MEDIA_SETTLE_MS = 150
/** When a page's markup is read for the generic hide rules: at once, then for what scripts add. */
export const BLOCKER_SCAN_DELAYS_MS = [0, 1500, 5000]
/** Profile ids name a storage partition on disk: nothing but plain characters. */
export const PROFILE_ID = /^[A-Za-z0-9_-]{1,32}$/
/** How long a question put to a page (is a field being edited?) is waited for. */
export const PAGE_ASK_TIMEOUT_MS = 3000
/** How long after "Actualiser tous les onglets" the pages are given to load before the ones that do not answer are offered for closing; and how long the offer stays. */
export const DEAD_TABS_SETTLE_MS = 15_000
export const DEAD_TABS_OFFER_MS = 12_000
/** Pause between two pages of "reload all tabs": a long list does not reach the network in one burst. */
export const RELOAD_ALL_STAGGER_MS = 150
/**
 * How long a sleeping tab that "reload all tabs" woke is given to finish loading before it is put back to sleep all the same (a page that never ends):
 * 10 s. Its title and its icon have come by then, and a site that is gone says so sooner (an address not found, a connection refused: under a second);
 * one that lets the connection time out takes longer than any wait a run can afford. 0.2.1 waited 15 s, which a few heavy pages took every time.
 */
export const RELOAD_ALL_LOAD_LIMIT_MS = 10_000
/**
 * The whole turn of a tab "reload all tabs" woke: thawed or given a page, loaded (10 s at most), asked (3 s at most), then frozen or freed. Past this
 * its place goes to the next tab: only a page whose protocol never answers the thaw or the freeze gets there, and it is left as it is.
 */
export const RELOAD_ALL_TAB_LIMIT_MS = 30_000
/** The pages just reloaded are looked at after this at the soonest: a load asked a moment ago has not said yet that it started. */
export const DEAD_TABS_FIRST_LOOK_MS = 1000
/** At launch every tab loads at once ("Charger tous les onglets au lancement"): they are given longer to settle before the dead ones are offered. */
export const DEAD_TABS_LAUNCH_SETTLE_MS = 30_000
/** The tabs that wake with the application get their page by batches of this many, this long apart: dozens made at once came out black. */
export const LAUNCH_WAKE_BATCH = 6
export const LAUNCH_WAKE_GAP_MS = 2_000
/** The theme panel sits beside the sidebar so the sidebar shows the theme live while it is edited (420 px, a list of themes and the drawing of the sidebar). */
export const THEME_WIDTH = 420
// Room for the list, the colours, the sliders and the foot; the advanced controls (the pad alone is 340) scroll inside the panel.
export const THEME_MAX_HEIGHT = 680
/** The floating sidebar hides as soon as the pointer leaves it; this is only the margin that keeps it from flickering at its edge. */
export const FLOAT_HIDE_DELAY_MS = 60
export const MAX_DOWNLOADS_KEPT = 50
/** How many tabs' last autoplay rebuild, and how many downloads already opened, are remembered: the oldest are forgotten past this. */
export const MEMORY_MAX = 500
/** How long a page in full screen is given to leave it when its tab goes away. */
export const FULLSCREEN_LEAVE_TIMEOUT_MS = 1000
/** The page card slides to its new place in about 0.1 s, ease-out, when the sidebar goes or comes. */
export const SIDEBAR_SLIDE_MS = 110
export const SIDEBAR_SLIDE_STEP_MS = 16
/** After the drag of a tab ends, the drop (reported by the veil, a process apart) may still be on its way: the veil waits this long for it. */
export const SPLIT_DRAG_GRACE_MS = 150
/** The picture of the page the veil reduces: a JPEG, so that the message to the overlay stays light. */
export const VEIL_JPEG_QUALITY = 78

/** What a tab being dragged from the sidebar is doing to the page (see `beginSplitDrag`). */
export interface SplitDrag {
  tabId: string
  token: number
  /** Set once the drag has ended: the veil goes when it fires, unless a drop came first. */
  endTimer?: NodeJS.Timeout
}

/** ⌃Tab while ⌃ is held: the entries of the panel, the one selected, and the modifiers whose release ends it. */
export interface TabCycle {
  cards: CycleCard[]
  index: number
  hold: Array<'control' | 'alt' | 'meta'>
}

/** The visit history of one profile, as the browser uses it. */
export interface ProfileHistoryLog {
  record(url: string, title: string): void
  /** The page just recorded takes the title it ended up with (not a visit). */
  retitle(url: string, title: string): boolean
  search(query: string, limit?: number): HistoryEntry[]
  /** The page at this address, if the history holds it. */
  get(url: string): HistoryEntry | undefined
  /** The pages last visited from `from` (included) to `to` (excluded), most recent first. */
  between(from: number, to: number): HistoryEntry[]
  remove(url: string): boolean
  /** Forgets a page and keeps it aside for a moment, so that `putBack` can undo it. */
  removeKept(url: string): boolean
  /** Puts back, as it was, a page `removeKept` just forgot; answers whether it is back. */
  putBack(url: string): boolean
  /** Forgets the pages last visited from `from` (included) to `to` (excluded); returns how many. */
  removeBetween(from: number, to: number): number
  /** Forgets the pages of one site (and of its subdomains when asked); returns how many. */
  removeSite(host: string, subdomains: boolean): number
  /** The hosts of the pages it holds. */
  hosts(): string[]
  /** How many pages it holds. */
  size(): number
}

/**
 * What the browser needs of the visit history: the real book (one history per profile), or a stand-in that remembers nothing. A tab, a
 * suggestion, a search or an erasure only ever reaches the history of the profile of the space it is about.
 */
export interface HistoryLog {
  /**
   * The history of a profile. With `spaceId`, the same history as a visit of that space records it: each page remembers the spaces it was visited in,
   * so that a locked space keeps its pages to itself (history.ts `HistoryVeil`).
   */
  of(profileId: string, spaceId?: string): ProfileHistoryLog
  /** Forgets the whole history of a profile and its file; answers whether nothing of it is left on disk. */
  erase(profileId: string): boolean
  /** The profiles that have a history. */
  profiles(): string[]
}

export const NO_PROFILE_HISTORY: ProfileHistoryLog = { record: () => {}, retitle: () => false, search: () => [], get: () => undefined, between: () => [], remove: () => false, removeKept: () => false, putBack: () => false, removeBetween: () => 0, removeSite: () => 0, hosts: () => [], size: () => 0 }

/** The history of a window that keeps none. */
export const NO_HISTORY: HistoryLog = { of: () => NO_PROFILE_HISTORY, erase: () => true, profiles: () => [] }

/** Where the tabs of a window can be sent from their menu (Déplacer vers la fenêtre): the window manager knows the other windows (shell/windows.ts). */
export interface WindowMoves {
  /** The other normal windows, named as the Window menu names them, in the order they were opened. */
  targets(): WindowChoice[]
  /** The browser of one of them; undefined once it is gone (or for a private window, which takes no tab from a normal one). */
  browserOf(id: string): Browser | undefined
  /** Opens a new normal window over the same tabs, on the space of the window in front, with no tab selected: its browser. */
  open(): Browser
}

export interface BrowserOptions {
  /** A private window: it keeps no history, no archive and no pinned tabs, runs no extension, and refuses what would persist something. */
  private?: boolean
  /** A guest window: private underneath (this flag comes with `private`), but with its own look, name and settings (shared/guest-window.ts). */
  guest?: boolean
  /**
   * A window opened after the main one (File › New Window) shows the same tabs through its own `Browser`. The engine hooks
   * (extensions, permission prompts, downloads, request filter) stay the main window's; this id places its pages in its window.
   */
  windowId?: string
}

export interface OpenSidePanel {
  extensionId: string
  name: string
  path: string
  page: Page
  /** The profile of the tab the panel was opened for (its page runs in that profile's session). */
  profileId: string
}

/** The web panel docked beside the page (Volets web): one of the sites of a space's list, with its own view. */
export interface OpenWebPanel {
  spaceId: string
  /** The profile the page was made with: the panel goes when its space is given another one (its page would keep the session of the old one). */
  profileId: string
  panelId: string
  title: string
  url: string
  /** The address the page is at now, once it said so: what the name over the panel is completed with when it left its site. */
  shownUrl?: string
  page: Page
}

/** Actions after which a picture of a space may have lost the last thing that referred to it. */
export const IMAGE_SWEEP_ACTIONS: ReadonlySet<string> = new Set(['space/delete', 'space/image', 'session/delete', 'state/restore', 'backup/restore'])

/** What a notice may carry besides its words: a second line, and the bar of a job that goes on (in place of its time line). */
export interface ToastMore {
  detail?: string
  progress?: ToastProgress
}

/** A run of "Actualiser tous les onglets" under way (browser-sleep.ts): how far it is, what ended it, and the notice that tells it. */
export interface ReloadRun {
  /** The tabs it covers (awake ones to reload, sleeping ones to wake), and how many it has dealt with. */
  total: number
  done: number
  /** « Arrêter » (`stopped`), or the bound of the whole run (`timeout`): no tab is started after it. */
  end: 'stopped' | 'timeout' | null
  /** The notice of its progress while it is the one showing (null once closed or replaced), when it last changed, and the change it waits to make. */
  toastId: number | null
  toldAt: number
  soon?: ReturnType<typeof setTimeout> | null
  /** The space of the button of one space: its notices name it, and its button is the one that turns. */
  spaceName?: string
  spaceId?: string
  /** The awake tabs first, then the sleeping ones (shared/reload-all.ts); `afterAwake`: awake tabs were done before the sleeping ones. */
  phase: ReloadPhase
  afterAwake: boolean
  /** When the phase of the sleeping tabs began, how many of its tabs are done, of how many: the estimate of the time left. */
  pace: ReloadPace
  /** The marks of the rows: the tabs whose turn is to come, those under way, and when each of the others was reloaded (`reloadMarks`). */
  pending: Set<string>
  running: Set<string>
  reloadedAt: Map<string, number>
  /** How the load of each tab looked at ended (the tabs whose site no longer answers are offered from it, before the end of a long run). */
  outcomes: Map<string, LoadFailure | null>
}

export interface Peek {
  page: Page
  /** The preview of a page of a private tab lives in the private context too, and what it opens is private. */
  private?: boolean
  /** The preview of a page of a container's tab lives in the container's context, and what it opens is in the container. */
  container?: string
  url: string
  title: string
  canGoBack?: boolean
  canGoForward?: boolean
  /** The previewed page is loading (its header draws the progress line and offers "Arrêter"), and the icon it declared. */
  loading?: boolean
  faviconUrl?: string
}

/** How the events of a page are handed to the browser of another window, when the page goes there as it is (see `Browser.adoptPage`). */
export const pageRelays = new WeakMap<Page, (events: PageEvents) => void>()

export abstract class BrowserBase {
  protected readonly pages = new Map<string, Page>()
  protected readonly idleSince = new Map<string, number>()
  /** Tabs whose page is frozen (sleep mode "freeze"): kept in memory, running nothing. They are in `pages` but shown asleep. */
  protected readonly frozen = new Set<string>()
  /** The frozen tabs the sweep froze on the way to freeing them (setting `sleepFreezeAfterMinutes`): freed at the delay. Read only with `frozen`. */
  protected readonly autoFrozen = new Set<string>()
  /**
   * When the page of a tab last told the sweep it holds what a sleep would lose (Picture in Picture, text not sent): the cap does not count it
   * meanwhile (see `planSweep`). Kept by the leader, for the whole group.
   */
  protected readonly sleepKept = new Map<string, number>()
  /** The "reload all tabs" run going on (browser-sleep.ts): another request does not start a second one, it says how far this one is. */
  protected reloadRun: ReloadRun | null = null
  /** The run that just ended, for as long as its last rows keep their mark « Actualisé » (`RELOAD_ALL_DONE_MARK_MS`). */
  protected reloadEnded: ReloadRun | null = null
  /** The tabs whose site no longer answers that the last run (or the load at launch) found, so far: the list open meanwhile adds them. */
  protected deadFound: DeadTabEntry[] = []
  /** Called when the page of a tab next finishes loading (`untilLoaded`, for the tabs "reload all tabs" woke). */
  protected readonly loadEnds = new Map<string, () => void>()
  /** Running downloads by id, with the tab that started them: such a tab is not put to sleep. Kept by the leader, for the whole group. */
  protected readonly downloadSources = new Map<string, string>()
  protected sweeping: Promise<string[]> | null = null
  /** The run of « Libérer maintenant » going on (browser-sleep.ts, `releaseLevel`): another request does not start a second one. Kept by the leader. */
  protected releasing: Promise<ReleaseOutcome> | null = null
  /**
   * The tabs the last run of « Libérer maintenant » put to sleep, each with the window that held its page: what « Annuler » wakes again. Volatile,
   * kept by the leader, replaced by the next run that frees a tab and emptied by « Annuler ».
   */
  protected releaseBatch: Array<{ id: string; window: BrowserBase }> = []
  /** The countdowns of the tabs that reload themselves (made at `start`). */
  protected autoReloader: AutoReloader | null = null
  /** Set while pages are made for tabs that are not on screen (`wakeInBackground`, `wakeAndReload`): the extension runtime calls each new page "active", which must not select its tab. */
  protected quietPages = false
  /** The window is put away (macOS: the main window closed while the application goes on, see `Browser.putAway`): it shows nothing and holds no page. */
  protected away = false
  /** Tabs whose page is being created. The extension runtime calls back synchronously during creation. */
  protected readonly creating = new Set<string>()
  /** Tabs that have shown at least one page. A tab that never did and starts a download is just a download link. */
  protected readonly committed = new Set<string>()
  /** The autoplay mode each live page was made with (Electron fixes it at creation), and when a tab's page was last rebuilt for another one. */
  protected readonly pageAutoplay = new Map<string, AutoplayMode>()
  protected readonly autoplayRebuiltAt = new Map<string, number>()
  /** The history of a page being rebuilt, handed to the page that replaces it (consumed by `ensurePage`, at once). */
  protected readonly carriedHistory = new Map<string, ReturnType<Page['navigationEntries']>>()
  /** Tabs currently attached to the window: the active tab, or every pane of its split view. */
  protected visible = new Set<string>()
  /** Tabs whose page finished loading off screen: the colour it declares is read when it comes on screen (`refreshPageColor`). */
  protected readonly colorUnread = new Set<string>()
  /** The summary tabs: they stay on about:blank while their text is written, and are never closed as empty tabs. */
  protected readonly summaryTabs = new Set<string>()
  /** The Extensions page in the tabs of this window (shell/internal-pages.ts): which tabs have it, what the gate is told of them, what the page is sent, the console it needs. */
  protected readonly internalPages = new InternalPages({
    tabs: () => this.store.get().tabs,
    livePageIds: () => this.pages.keys(),
    isPrivate: () => this.isPrivate(),
    contentsIdOf: (pageId) => this.engine.tabNumberOf(pageId),
    inProfileSession: (contentsId) => this.engine.profileOfTab(contentsId) !== undefined,
    send: (tabId, channel, payload) => this.pages.get(tabId)?.sendToDocument(channel, payload) ?? false,
    watchConsoles: () => this.engine.extensionTools.watchConsoles()
  })
  /** The empty tabs the user or a page opened, closed once left unused (shell/blank-tab-watch.ts, rules in shared/blank-tabs.ts). */
  protected readonly blankTabs = new BlankTabWatch({
    store: { get: () => this.store.get() },
    dispatch: (action) => this.dispatch(action),
    displayed: (id) => this.visible.has(id),
    overlayOpen: () => this.overlayRequest !== null,
    isSummary: (id) => this.summaryTabs.has(id),
    shownElsewhere: () => new Set([...this.group].filter((b) => b !== this).flatMap((b) => visibleTabIds(b.store.get())))
  })
  /** The unread messages the titles of the tabs say, held through a title that blinks (shell/unread-watch.ts, rules in shared/tab-messages.ts). */
  protected readonly unread: UnreadWatch = new UnreadWatch({
    now: () => Date.now(),
    attended: (id) => this.visible.has(id) && !this.win.isDestroyed() && this.win.isFocused(),
    changed: (id) => this.refreshUnread(id)
  })
  /** The tab whose page is in HTML full screen and fills the window (shared/html-fullscreen.ts), or null. */
  protected fullscreenTab: string | null = null
  protected runtime: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }
  protected downloads: DownloadInfo[] = []
  /** The files opened without keeping that were already handed to their application: a download reports its end once, but the guard is cheap. */
  protected readonly openedTemporary = new Set<string>()
  /** The rows the user removed while their download was alive (an interrupted one that is cancelled for it): the last word of such a download does not bring the row back. */
  protected readonly dismissedDownloads = new Set<string>()
  protected find: FindState | null = null
  protected readonly publishListeners = new Set<() => void>()
  /** How many events of pages that are not on screen are being handled (held by the leader): what they publish waits a moment (see `publish`). */
  protected backgroundEvents = 0
  /** The state goes to the interface once per turn of the event loop however many changes there were in it (see publish-queue.ts). */
  protected readonly publishQueue = new PublishQueue(() => {
    if (!this.win.isDestroyed()) this.publishHere()
  })
  protected peek: Peek | null = null
  protected sidePanel: OpenSidePanel | null = null
  protected webPanel: OpenWebPanel | null = null
  protected webPanelCounter = 0
  protected extensionWindows: { create: (details: Parameters<ExtensionTabHooks['createWindow']>[0]) => Promise<number>; remove: (windowId: number) => void } | null = null
  protected readonly panelConfigs = new Map<string, PanelConfig>()
  protected peekCounter = 0
  protected overlayRequest: OverlayRequest | null = null
  /** The capture the annotation sheet is open for: one at a time, dropped when the sheet goes (see `holdCapture`). */
  protected readonly shelf = new CaptureShelf(
    () => this.store.get().settings.annotateCapture,
    () => this.overlayRequest
  )
  protected littleBarOpener: ((from?: Bounds) => void) | null = null
  /** Where this window sits on the desktop, for a mini window to open on the same screen; none once the window is gone. */
  protected windowBounds(): Bounds | undefined {
    return this.win.isDestroyed() ? undefined : this.win.getBounds()
  }
  /** The page the user is erasing elements from (Tweak editor, Eraser mode), while the mode lasts. */
  protected zapping: { page: Page; stop: string } | null = null
  /** The sites whose script a draft of the Tweak editor switched off: their pages are reloaded when the editor closes (browser-site.ts, `boostsChanged`). */
  protected stoppedByDrafts: string[] = []
  /**
   * The questions of the tabs that are not on screen (a box of `prompt()`, a login a server asks for, a permission): each waits here until its tab
   * is shown (`whenOnScreen`, browser-dialogs.ts). A question put over another tab would be read as that tab's.
   */
  protected readonly offScreenQuestions = new Map<string, Array<() => void>>()
  protected readonly permissionQueue: PermissionRequest[] = []
  protected readonly permissionAnswers = new Map<string, (allow: boolean) => void>()
  /** The page each permission question is about (when a tab's page asked): a question about a page that is gone is withdrawn. */
  protected readonly permissionPages = new Map<string, string>()
  protected permissionCounter = 0
  /** The permission question on screen and when it was put there: a click on « Autoriser » that comes too soon after is not an answer (browser-dialogs.ts). */
  protected permissionShown: { id: string; at: number } | null = null
  /** Sign-in prompts (a server or a proxy asks for a login): shown one at a time, after what is on screen, each tied to the page that waits. */
  protected readonly authQueue: AuthRequest[] = []
  protected readonly authAnswers = new Map<string, { pageId: string; resolve: (credentials: Credentials | null) => void }>()
  protected readonly authPages = new Map<string, { tail: Promise<void>; pending: number; refused: AuthRequest[] }>()
  protected authCounter = 0
  /** Extension sheets (before an install or an update from the Web Store): shown one at a time, after what is on screen. */
  protected readonly reviewQueue: ExtensionReviewRequest[] = []
  protected readonly reviewAnswers = new Map<string, (allow: boolean) => void>()
  protected reviewCounter = 0
  protected extensionsKey = ''
  /** The folders of Settings › Extensions followed by the engine (extension-folders.ts): made by the main window's browser on its first look at the settings. */
  protected extensionFolders: ExtensionFolderSync | null = null
  /** What the user can do with an extension (menu of its icon, Settings). Only the main window's browser has it; the others go through it. */
  protected extensionActions: ExtensionActions | null = null
  /** The boxes of the pages' `prompt()`: one on screen at a time, the others wait their turn. Each is tied to the page that is blocked on it. */
  protected readonly dialogQueue: DialogRequest[] = []
  protected readonly dialogAnswers = new Map<string, { pageId: string; resolve: (answer: PromptAnswer) => void }>()
  protected dialogCounter = 0
  protected floatVisible = false
  /** `in` while the floating sidebar slides in, `out` for the short while it takes to leave (the surface plays the animation). */
  protected floatPhase: 'in' | 'out' | null = null
  protected floatTimer: NodeJS.Timeout | null = null
  /** The look at the screen of the window for the notice about the size of the panels (null in a private window and in the engine test), and the wait after a move. */
  protected screenWatch: ScreenWatch | null = null
  protected screenMoveTimer: NodeJS.Timeout | null = null
  /** The page card's left edge while it slides after the sidebar was hidden or shown; null when it is still. */
  protected slide: { from: number; to: number; start: number } | null = null
  protected slideTimer: NodeJS.Timeout | null = null
  /** The last state of the sidebar the card was laid out for, and where its left edge was then. */
  protected slideSeen: { visible: boolean; left: number } | null = null
  /** Off in the engine test (it reads bounds right after changing the sidebar); the sidebar checks turn it on for the one that looks at the slide. */
  slideEnabled = !process.argv.includes('--smoke')
  protected shownTabId: string | null = null
  /** The icon address each tab is measured against for its dot (shared/icon-mark.ts). Kept in memory only, and pruned with the tabs. */
  protected iconBase = new Map<string, string>()
  protected unsubscribe: (() => void) | null = null
  protected littleOpener: ((url: string, origin?: LittleOrigin) => void) | null = null
  /** The factor last given to the surfaces of the interface (null before the first time): at 100 % they are left as they are. */
  protected uiZoom: number | null = null
  /** The factor last given to the layer of panels, which is the one above times the factor of the panels while a sheet in the middle of the window is open (null before the first time). */
  protected layerZoom: number | null = null
  /** What this window knows of the names of the windows (set by the window manager); absent in a mini window or a test. */
  protected windowNames: { own(): string | undefined; others(): NamedWindow[] } | null = null
  /**
   * The sidebar this window chose for itself (« Barre de cette fenêtre »: its side, docked to a column of icons; shared/window-sidebar.ts). Empty: as the
   * new windows. Kept here for as long as the window is open; the window manager writes it to windows.json with the window and gives it back at launch.
   */
  protected sidebarChoice: WindowSidebar = NO_WINDOW_SIDEBAR
  /** Where the tabs of this window can be sent from their menu (set by the window manager for a normal window); absent in a private window or a test. */
  protected windowMoves: WindowMoves | null = null
  protected systemDark = true
  protected toast: (ToastState & { run?: () => void; runSecond?: () => void }) | null = null
  protected toastCounter = 0
  protected toastTimer: ReturnType<typeof setTimeout> | null = null
  /** The time the notice on screen has left: it stops while the pointer or the focus holds it. */
  protected readonly toastClock = new ToastClock()
  /** The questions "Quitter ce site ?" waiting for an answer, by id, with the page that asked (see `askLeave`). */
  protected readonly leaveAnswers = new Map<string, { pageId: string; resolve: (leave: boolean) => void }>()
  protected leaveCounter = 0
  protected settingsOpener: ((pane?: SettingsPane, anchor?: SettingsAnchor) => void) | null = null
  /** Extra UI windows (Settings) that receive the same snapshots as the main window. */
  protected readonly surfaces = new Map<number, WebContents>()
  protected extraBlockedHosts: string[] = []
  /** Which blocker options the engine was last configured with, so it is only reconfigured when they change. */
  protected blockerKey = ''
  /** Which privacy options the engine was last given (see `configurePrivacy`). */
  protected privacyKey = ''
  /** The zoom of a page that has no host to remember it under (a file): it lasts until the page is left. */
  protected readonly volatileZoom = new Map<string, number>()
  protected unsubscribeBlocking: (() => void) | null = null
  /** The stylesheet that hides ads and banners: what each page was last given (a new document starts clean) and the generation of its markup scans. */
  protected readonly blockerCss = new BlockerCss({
    settings: () => this.store.get().settings,
    blocker: { cosmeticCss: (url, settings, dom) => blockingService().cosmeticCss(url, settings, dom) },
    delays: BLOCKER_SCAN_DELAYS_MS,
    skipped: (key, reason) => console.debug(`[blocker] cosmetic scan skipped for ${key}:`, reason)
  })
  /** The theme stylesheet last given to each page, so a page is only touched when its palette changes. */
  protected readonly appliedTheme = new Map<string, string>()
  /** What the readable mode last gave each page (`readableKey` of dark-sites.ts; a new document starts clean), and the generation of its colour probes. */
  protected readonly appliedDark = new Map<string, string>()
  protected readonly darkScans = new Map<string, number>()
  /** What the window itself was last made to look like (see `applyWindowLook`): the opaque window until a setting says otherwise. */
  protected windowLook = DEFAULT_WINDOW_LOOK_KEY
  /** The browsers of the windows that show the same tabs (this one included). A private window is on its own. */
  protected group = new Set<this>([this])
  /** The browser of the main window: it keeps the downloads, and answers the engine hooks, for the whole group. */
  protected leader: this = this
  /** The tooltip capsule, in a small window of its own so that it can overlap the page (made at the first tooltip). */
  protected readonly tooltipWindow: TooltipWindow
  /** The tabs that have a media player at the foot of the sidebar, oldest first. Volatile: a player belongs to the moment a tab was left. */
  protected mediaPlayers: readonly string[] = []
  /** The media questions due, by tab: the events of a track change come in bursts and one answer is enough. */
  protected readonly mediaDue = new Map<string, NodeJS.Timeout>()
  /** The floating windows the automatic Picture in Picture opened, and the sites where the user closed them (shared/auto-pip.ts). Held by the leader, for the whole group. */
  protected readonly autoPip = new AutoPipMemory()
  /** Lucium's floating video window (shell/floating-video.ts): one video floats at a time, for the whole group. Held by the leader; absent in a test. */
  protected floatingVideo: FloatingVideo | null = null
  /** The notices of this window, kept for « Notifications récentes » (shared/notice-log.ts). */
  protected readonly noticeLog = new NoticeLog()
  /** The pages a reopened tab goes back through when its page is made (see `restoreClosedHistory`); lost with the tab, or with the application. */
  protected readonly reopened = new ReopenLedger()
  /** The Back / Forward lists of the tabs whose page was let go for a sleep, given back to their next page (slept-history.ts). Held by the leader, for the whole group; in memory only. */
  protected readonly slept = new SleptHistory()
  /** The tabs whose page already went back to its remembered scroll position (scroll-memory): once per page, whatever the document it loads after. Dropped with the page (`dropPageState`). */
  protected readonly scrollRestored = new Set<string>()
  /** Unsubscribes from the lock (only while the lock is on). */
  protected unsubscribeLock: (() => void) | null = null
  /** Passphrases the main process asked for (the encrypted export being restored): one at a time, after what is on screen. */
  protected readonly passphraseQueue: PassphraseRequest[] = []
  protected readonly passphraseAnswers = new Map<string, (passphrase: string | null) => void>()
  protected passphraseCounter = 0
  /** ⌃Tab: the panel on screen while ⌃ is held, null otherwise. */
  protected cycle: TabCycle | null = null
  /** When this window left each tab, for the order of use of ⌃Tab. Kept only while the setting is on; never saved. */
  protected readonly usedAt = new Map<string, number>()
  /** Whether the pages and the interface of this window are being listened to for ⌃Tab (only with the setting on). */
  protected cycleWatching = false
  protected cycleBlur: (() => void) | null = null
  /** The last picture of each tab (the hover card's), asked for by the panel. */
  protected thumbnailSource: ThumbnailSource | null = null
  /** A tab dragged from the sidebar over the page, while the veil is (about to be) shown. */
  protected splitDrag: SplitDrag | null = null
  protected splitDragCounter = 0
  /** A tab dropped on itself: the command bar picks the page of the other pane, which then takes this side. */
  protected pendingSplit: DropWithNewTab | null = null
  /** The tabs being dragged out of a window of the group, for the other windows to take a drop of them (held by the leader, see `beginTabDrag`). */
  protected readonly tabDrags = new TabDragLedger()
  protected tabDragExpiry: NodeJS.Timeout | null = null
  /** Finds the site icon of the favourites and tabs that have none. Only the main window runs it: a private or second window shows the same state. */
  protected faviconService: FaviconService | null = null
  /**
   * The throw-away context the private tabs of every normal window share (cookies, storage and logins kept in memory only), opened with the
   * first of them and erased when the last one is gone. Held by the leader.
   */
  protected privateScope: EphemeralEngine | null = null
  /** The pages of this window that live in the private context (tabs and previews): it is erased once none is left anywhere. */
  protected readonly privatePages = new Set<string>()
  /**
   * The browsing contexts of the tab containers that have a page open (setting `tabContainers`), by container id. Held by the leader, like the private
   * one; a container's context stays open for the run (its data is on disk) and is erased when the container is deleted.
   */
  protected readonly containerScopes = new Map<string, EphemeralEngine>()
  /** The container each page of this window was made in (a page keeps the session it was made in): a tab whose container changed gets a new page. */
  protected readonly pageContainer = new Map<string, string>()
  /** The session each page of this window was made in (`sessionKeyOf`): a page goes to another window as it is only into the same one. */
  protected readonly pageSession = new Map<string, string>()
  /** Erasures of deleted containers that are still running (the leader's; quitting waits for them). */
  protected readonly containerErasures = new Set<Promise<void>>()
  /** What the engine was last given as encrypted DNS and proxies (see `configureNetwork`); the starting values are "nothing configured". */
  protected dnsKey = JSON.stringify({ kind: 'default' })
  protected proxyKey = 'null'
  /** The split views whose panes scroll together (File › Affichage; volatile: it lasts as long as the window). */
  protected readonly syncedSplits = new Set<string>()
  protected unsubscribeSaver: (() => void) | null = null
  protected unsubscribeScrollBars: (() => void) | null = null
  /** Looks at the watched pages now and then (only the main window runs it, and nothing runs while no page is watched). */
  protected pageWatcher: PageWatcher | null = null
  protected pageWatchGapMs = PAGE_WATCH_GAP_MS
  /** Reads the live folders now and then: made while the setting `liveFolders` is on, by the main window only (see the gate in the constructor). */
  protected liveFolderService: LiveFolderService | null = null
  /** The figures of the resource gauge at the foot of the sidebar, for the whole group: made while 'resource-gauge' is on, by the main window only (see the gate in `start`). */
  protected resourceWatch: ResourceWatch | null = null
  protected liveGapMs = LIVE_GAP_MS
  protected liveAllowHost: ((host: string) => boolean) | null = null
  protected liveStartDelay: number | null = null
  /** Some in-page tool has been on since the pages were last told: the pages are visited when the settings change only then, so that nothing is done while all are off. */
  protected pageToolsOn = false
  /** What costs something while it runs (the lookup of site icons, the sleep sweep) runs only while its setting is on: see feature-gate.ts. */
  protected readonly gates: FeatureGates
  /** The scriptlets of the blocker and the fingerprint protection for this window's pages; the private context of the window group has its own (see `configurePrivateContext`). */
  protected readonly guard: PageGuard
  /** The guards of the other contexts the leader holds (the private one, and one for each open container), by context. */
  protected readonly scopeGuards = new Map<EphemeralEngine, PageGuard>()
  // ---- the password manager: this window as the service sees it ----

  protected passwordView: PasswordWindow | null = null
  protected readonly interfaceKey = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return
    const key: PageKey = { type: input.type, code: physicalKey(input), key: input.key, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift, isAutoRepeat: input.isAutoRepeat }
    if (this.cycleKey(key)) event.preventDefault()
  }
  /** A key press in a page or in the interface. Answers true when ⌃Tab took it (neither the page nor the menu bar sees it). Rules: `decideCycleKey`. */
  protected readonly cycleKey = (key: PageKey): boolean => {
    const settings = this.store.get().settings
    const decision = decideCycleKey(
      {
        enabled: settings.tabCycleRecent,
        holding: this.cycle?.hold ?? null,
        otherPanelOpen: this.overlayRequest !== null,
        forward: effectiveAccelerator('recentTab', settings.keyBindings),
        back: effectiveAccelerator('recentTabBack', settings.keyBindings),
        layout: keyboardLayout()
      },
      key
    )
    switch (decision.kind) {
      case 'start':
        return this.startCycle(decision.direction, decision.accelerator)
      case 'step':
        return this.stepCycle(decision.direction)
      case 'commit':
        this.endCycle(true)
        return false
      case 'cancel':
        this.endCycle(false)
        return true
      case 'swallow':
        return true
      case 'ignore':
        return false
    }
  }
  // ---- search engines a site declares (see shared/opensearch.ts) ----

  protected searchDiscovery: SearchDiscovery | null = null
  protected clearTail: Promise<void> = Promise.resolve()
  /** Whether the floating sidebar was sent a snapshot showing it at the last publish (see floatingNeedsSnapshot). */
  protected floatingShown = false
  /** The traffic lights last given to the window (`syncTrafficLights`): visibility and position, as one key. */
  protected trafficLightsGiven = ''
  /** The buttons laid over the window's right end last given to it (`syncControlsOverlay`, Windows), as one key. */
  protected controlsOverlayGiven = ''
  /** A snapshot was published while the layer of panels was closed, and not sent to it (`publishHere`): it gets the state when a panel opens. */
  protected overlayMissed = false

  constructor(
    protected readonly win: BrowserWindow,
    protected readonly overlay: WebContentsView,
    /** The floating sidebar, made only while the sidebar is hidden (see on-demand-view.ts). */
    protected readonly floating: OnDemandView<WebContentsView>,
    protected readonly engine: Engine,
    protected readonly store: StateStore,
    protected readonly history: HistoryLog,
    protected readonly options: BrowserOptions = {}
  ) {
    this.tooltipWindow = new TooltipWindow(win)
    this.gates = new FeatureGates(store)
    this.guard = this.makeGuard(engine, () => [...this.pages].filter(([id]) => !this.privatePages.has(id) && !this.pageContainer.has(id)).map(([id, page]) => ({ id, page, url: this.store.get().tabs.find((t) => t.id === id)?.url })))
  }

  protected makeGuard(engine: GuardEngine, pages: ConstructorParameters<typeof PageGuard>[0]['pages']): PageGuard {
    return new PageGuard({ settings: () => this.store.get().settings, engine, blocker: () => blockingService(), seeds: new SiteSeeds(), pages })
  }

  /** The guard that serves a tab's page: its context's for a private tab of a normal window or a tab in a container, else this window's. */
  protected guardOfPage(tabId: string): PageGuard | null {
    // The private context and the containers' belong to the leader of the window group, whichever window the tab is in.
    const leader = this.leader
    if (this.privatePages.has(tabId)) return leader.privateScope ? (leader.scopeGuards.get(leader.privateScope) ?? null) : null
    const container = this.pageContainer.get(tabId)
    if (container === undefined) return this.guard
    const scope = leader.containerScopes.get(container)
    return scope ? (leader.scopeGuards.get(scope) ?? null) : null
  }

  protected guardPage(tabId: string): void {
    const page = this.pages.get(tabId)
    if (page) this.guardOfPage(tabId)?.applyToPage(tabId, page, this.store.get().tabs.find((t) => t.id === tabId)?.url)
  }

  /** The site-icon lookup of this window, if it runs one (only the main window does). */
  faviconLookup(): FaviconService | null {
    return this.faviconService
  }

  /** Whether this is a private window (see `BrowserOptions`). */
  isPrivate(): boolean {
    return this.options.private === true
  }

  /** Whether this window was opened after the main one, over the same tabs. */
  protected isSecondary(): boolean {
    return this.options.windowId !== undefined && !this.isPrivate()
  }

  /** Ids of pages that are not tabs ("peek-1") are made unique by window, so two windows' previews do not clash in the engine. */
  protected pageId(id: string): string {
    return this.options.windowId ? `${this.options.windowId}/${id}` : id
  }

  /** Where this window's sidebar is and in which shape: its own choice over the setting `sidebarRight` (every layout of the window reads this, not the setting). */
  protected placement(): SidebarPlacement {
    return sidebarPlacement(this.store.get().settings, this.sidebarChoice)
  }

  /** The journal of the changes of this window's sidebar and of the touches of its edge (sidebar-trace.ts: the report « Signaler un problème » carries it). */
  private traceKept: SidebarTrace | null = null
  protected get sidebarTrace(): SidebarTrace {
    return (this.traceKept ??= new SidebarTrace(() => (this.isPrivate() ? 'private' : (this.options.windowId ?? 'main'))))
  }

  /** What the journal says of this window's sidebar now. */
  protected sidebarFacts(): SidebarFacts {
    return sidebarFacts(this.store.get().settings, this.sidebarChoice)
  }

  /** Puts this browser in the group of the windows that show the same tabs. */
  joinGroup(group: Set<this>, leader: this): void {
    this.group = group
    this.leader = leader
    group.add(this)
  }

  /**
   * The window the user is working in, among those that show the same tabs: where what an extension's menu or the Web Store has to say goes (a notice, a
   * confirmation box). The main window answers for the whole group but is not always the one in front: with three profiles in three windows the notice of a
   * switch made from the icon of the second window would appear in the first.
   */
  protected noticeWindow(): this {
    return [...this.group].find((b) => !b.win.isDestroyed() && b.win.isFocused()) ?? this
  }

  /** The browser of the group that holds the live page of a tab, if any. */
  protected ownerOf(pageId: string): this | undefined {
    return [...this.group].find((b) => b.ownsPage(pageId))
  }

  ownsPage(pageId: string): boolean {
    // A page being created is already the window's: the extension runtime calls back before the engine has returned it.
    return this.pages.has(pageId) || this.creating.has(pageId) || this.peek?.page.id === pageId || this.sidePanel?.page.id === pageId || this.webPanel?.page.id === pageId
  }

  // ---- what the lower layers call in the higher ones (implemented there; see docs/architecture.md, « browser.ts ») ----
  protected abstract activePage(): Page | undefined
  abstract followPaneFocus(): void
  abstract closeOverlay(): void
  /** Docks the extension's panel (browser-panels.ts); throws when it has no panel to show. */
  abstract openSidePanel(extensionId: string, tabKey: string | undefined): void
  protected abstract destroyPage(id: string, forSleep?: boolean): void
  protected abstract destroyPeek(): void
  abstract dispatch(action: Action): void
  protected abstract endCycle(commit: boolean): void
  protected abstract ensurePage(tab: TabItem): Page
  abstract evaluateInPage(js: string): Promise<unknown>
  protected abstract fromCss(b: Bounds): Bounds
  abstract isTabLocked(tab: Pick<TabItem, 'spaceId'>): boolean
  /** Whether this window is covered by its own lock (a private window left alone, shell/private-lock.ts). */
  abstract isWindowLocked(): boolean
  protected abstract k(): number
  protected abstract layout(): void
  /** Loads a folder of extension in every profile (browser-downloads.ts); the sentence of the first failure, or null when it loaded. */
  protected abstract loadExtensionFolder(folder: string): Promise<string | null>
  protected abstract noteDownload(download: DownloadInfo, sourcePageId: string | undefined): void
  protected abstract noteProfileUsed(profileId: string | undefined): void
  abstract openOverlay(request: OverlayRequest): void
  protected abstract openedBy(origin: string, open: () => void): void
  protected abstract publish(): void
  protected abstract publishHere(): void
  protected abstract refreshUnread(id: string): void
  protected abstract sendMissedSnapshot(): void
  protected abstract requestFilter(): RequestBlocker | null
  abstract showToast(message: string, action?: { label: string; run: () => void; second?: { label: string; run: () => void } }, durationMs?: number, more?: ToastMore): void
  abstract reviseToast(id: number, message: string, more?: ToastMore & { second?: { label: string; run: () => void } }): boolean
  abstract snapshot(): UiSnapshot
  protected abstract splitPanes(stage: Bounds, split: SplitView): Bounds[]
  protected abstract stageRect(): Bounds
  abstract start(): void
  protected abstract startCycle(direction: 1 | -1, accelerator: string): boolean
  protected abstract stepCycle(direction: 1 | -1): boolean
  abstract stop(): void
  protected abstract sync(): void
  protected abstract toCss(b: Bounds): Bounds
  protected abstract toolbarLine(): boolean
  protected abstract treeParent(openerId: string | undefined): { parentId?: string }
  protected abstract visibleIds(): string[]
  abstract windowId(): number
}
