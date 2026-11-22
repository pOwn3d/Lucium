import type { LittleOrigin } from '@shared/little'
import { BrowserWindow, ipcMain, screen, type WebContentsView } from 'electron'
import type { OnDemandView } from './on-demand-view'
import type { SettingsAnchor, SettingsPane } from '@shared/ipc'
import { createPrivateState, scrubPrivateState } from '@shared/private-window'
import { createGuestState, guestLabel } from '@shared/guest-window'
import { cascadePosition, type Rect } from '@shared/window-layout'
import { activeTab } from '@shared/sidebar'
import { blankSelection, release, selectionOf, visibleTabIds, type Selection } from '@shared/window-selection'
import { fitToDisplays, sessionOf, type SavedSession } from '@shared/window-session'
import { canReopen, mayRemember, remember, takeLast, type ClosedWindow, type LockFacts } from '@shared/closed-windows'
import { cleanWindowName, namedWindows, tabWindowTitle, windowNamesKey, type NamedWindow, type WindowEntry } from '@shared/window-names'
import { windowChoices } from '@shared/window-move'
import type { WindowSidebar } from '@shared/window-sidebar'
import type { Engine } from '../engine/types'
import { liveCtx, StateStore, WindowView } from '../store'
import { Browser, NO_HISTORY, type HistoryLog } from './browser'
import { CloseGuard } from './close-guard'
import { registerIpc } from './ipc'
import { setWindowManager } from './window-manager-holder'
import { releaseIpcScope } from './ipc-scope'
import { t } from '@shared/i18n'
import { getLockService } from '../lock-service'
import { shownState } from './lock-state'
import { mainCloseStep } from '../window-lifecycle'

export const MAIN_WINDOW_ID = 'main'

/** One window of the application that shows a browser: the main one, another one over the same tabs, or a private one. */
export interface WindowRecord {
  id: string
  kind: 'main' | 'window' | 'private'
  /** A guest window (profil invité): `kind` is 'private' (every private rule holds), this says it wears its own look and name. */
  guest?: true
  win: BrowserWindow
  browser: Browser
  store: StateStore
  /** The name the user gave the window (Fenêtre › Nommer la fenêtre…); windows.json remembers it. */
  name?: string
}

/** The title a window has when it carries no name of ours (the page of its interface gives it). */
const DEFAULT_TITLE = 'Lucium'

/** The window and the two views every window of the application is made of. */
export interface Chrome {
  win: BrowserWindow
  overlay: WebContentsView
  /** The floating sidebar, made only while the sidebar is hidden (see on-demand-view.ts). */
  floating: OnDemandView<WebContentsView>
}

export interface WindowManagerDeps {
  engine: Engine
  /** The shared state (tabs, spaces, settings): every normal window is a view of it; a private window copies its settings. */
  mainStore: StateStore
  /** The views of the shared state, one per normal window (the main window's included). */
  views: Set<WindowView>
  history: HistoryLog
  /** Windows by id, shared with the engine so pages can attach to them. */
  windows: Map<string, BrowserWindow>
  /** Creates a window and its two views (UI loaded, not shown yet) at `bounds`; `privateWindow` loads the private look, `guest` (with it) the guest's instead. */
  createChrome: (id: string, bounds: Rect, privateWindow: boolean, guest?: boolean) => Chrome
  openSettings: (pane?: SettingsPane, anchor?: SettingsAnchor) => void
  openLittle: (url: string, origin?: LittleOrigin) => void
  systemDark: () => boolean
  /** The system the application runs on (`process.platform`): on macOS the main window is put away instead of closed (window-lifecycle.ts). */
  platform?: string
}

// Held in a module of its own (window-manager-holder.ts), still importable from here.
export { getWindowManager } from './window-manager-holder'

/**
 * Every window that shows a browser, and which of them has the focus: the application menu acts on that one.
 *
 * - A **window** opened with File › New Window is a second `Browser` over the same tabs: it has its own current space and
 *   selected tab (a view of the shared state), and a tab lives in one window at a time.
 * - A **private window** is a window of its own: its own `Browser`, its own in-memory state, its own throw-away engine
 *   session. Closing it erases all three.
 *
 * The first window is special: it answers the engine hooks of the session (extensions, downloads, request filter), and
 * closing it ends the others.
 */
export class WindowManager {
  private readonly records = new Map<string, WindowRecord>()
  private focusedId = MAIN_WINDOW_ID
  private privateCounter = 0
  private guestCounter = 0
  private windowCounter = 0
  private readonly listeners = new Set<() => void>()
  /** Erasures of closed private windows that are still running. */
  private readonly pending = new Set<Promise<void>>()
  /** The browsers of the normal windows: they show the same tabs. */
  private readonly group = new Set<Browser>()
  /** The application is quitting, or the main window (which takes the others with it) is closed: no window is asked about any more. */
  private quitting = false
  /** The windows whose title is a name we gave: the others keep the one their page gives them. */
  private readonly titled = new Set<WindowRecord>()
  /** macOS: the main window was closed while the application goes on. It is hidden and holds no page until something brings it back (`revealMain`). */
  private mainAway = false
  /** The windows closed in this session, in memory only (shared/closed-windows.ts): File › Rouvrir la dernière fenêtre fermée. */
  private closedWindows: ClosedWindow[] = []
  /** The question before closing a window of several tabs (Settings › Général); its listeners exist only while that setting is on. */
  readonly closeGuard: CloseGuard

  constructor(private readonly deps: WindowManagerDeps) {
    setWindowManager(this)
    this.closeGuard = new CloseGuard({
      windowCount: () => this.records.size,
      quitting: () => this.quitting,
      stopAsking: () => deps.mainStore.dispatch({ type: 'settings/update', patch: { warnBeforeClosingWindow: false } })
    })
  }

  /** The application is going to quit: its windows close without a question. Called once the quit is decided (nothing cancels it any more). */
  markQuitting(): void {
    this.quitting = true
  }

  /** Whether the quit is decided: the windows that close from now on are the end of the session, not a choice of the user (the memory of the windows leaves its list alone). */
  isQuitting(): boolean {
    return this.quitting
  }

  registerMain(win: BrowserWindow, browser: Browser, store: StateStore): void {
    const record: WindowRecord = { id: MAIN_WINDOW_ID, kind: 'main', win, browser, store }
    this.records.set(MAIN_WINDOW_ID, record)
    this.closeGuard.watch(record)
    this.syncGuard()
    this.hookNames(record)
    this.hookMoves(record)
    // After the question of the close guard (it is put before this listener, close-guard.ts): a close it holds is no close yet.
    win.on('close', (event) => {
      if (event.defaultPrevented || mainCloseStep(this.deps.platform ?? process.platform, this.quitting) !== 'put-away') return
      event.preventDefault()
      this.putAwayMain(record)
    })
    browser.joinGroup(this.group, browser)
    // The menu greys entries out by what the page can do (Back, Stop, Find Next): it follows the page of the focused window.
    browser.onPublish(() => this.notify())
    browser.onPublish(() => this.followPage(record))
    win.on('focus', () => this.focus(MAIN_WINDOW_ID))
    // The bar of the page annotation sits on the shared window: its place follows the moves and the resizes of the window.
    win.on('move', () => this.notify())
    win.on('resize', () => this.notify())
  }

  /** The window the user is working in: the last one that had the focus (the Settings window is not one of them), or the main one. */
  focused(): WindowRecord {
    const record = this.records.get(this.focusedId)
    return record && !record.win.isDestroyed() ? record : this.records.get(MAIN_WINDOW_ID)!
  }

  /** Whether the main window is put away (macOS, closed while the application goes on): hidden, without a page, until `revealMain`. */
  isMainAway(): boolean {
    return this.mainAway
  }

  /**
   * The main window was closed on macOS: it is hidden instead of destroyed (see `mainCloseStep`), and goes on answering for the session. The other
   * windows close with it, as the question before closing it says; its pages go, as with a closed window, and come back when it is shown again.
   */
  private putAwayMain(record: WindowRecord): void {
    this.mainAway = true
    this.closeOtherWindows()
    record.browser.putAway(true)
    const { win } = record
    // A window hidden in full screen leaves an empty space of its own on macOS: it leaves full screen first.
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => {
        if (this.mainAway && !win.isDestroyed()) win.hide()
      })
      win.setFullScreen(false)
    } else win.hide()
    this.focusedId = MAIN_WINDOW_ID
    this.notify()
  }

  /**
   * Brings the main window to the front: back from being put away (its tab gets its page again), restored if minimized, shown and focused. What
   * reopens a window goes through here: the Dock, ⌘N, a link of another application, a second launch, a menu entry. Null once it is gone (the
   * application is quitting).
   */
  revealMain(): WindowRecord | null {
    const main = this.records.get(MAIN_WINDOW_ID)
    if (!main || main.win.isDestroyed()) return null
    if (this.mainAway) {
      this.mainAway = false
      main.browser.putAway(false)
    }
    if (main.win.isMinimized()) main.win.restore()
    main.win.show()
    main.win.focus()
    this.focusedId = MAIN_WINDOW_ID
    this.notify()
    return main
  }

  /**
   * File › New Window or Blank Window, the Dock's « Nouvelle fenêtre », a second launch: the main window comes back when it was put away (it is the
   * window of the session; another one beside a hidden main window would leave the main one hidden for good), a new window opens otherwise. Null
   * once the main window is gone (the application is quitting).
   */
  newWindow(options: { commandBar: boolean }): WindowRecord | null {
    const main = this.records.get(MAIN_WINDOW_ID)
    if (!main || main.win.isDestroyed()) return null
    if (!this.mainAway) return this.openWindow(options)
    this.revealMain()
    if (options.commandBar) main.browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
    return main
  }

  /** What the lock says now: the application locked, and the spaces that are (shared/closed-windows.ts keeps nothing it must not show). */
  private lockFacts(): LockFacts {
    const lock = getLockService()
    return { appLocked: lock?.isAppLocked() === true, lockedSpaces: lock?.lockedSpaces() ?? [] }
  }

  /** Whether File › Rouvrir la dernière fenêtre fermée has a window to bring back. */
  canReopenClosed(): boolean {
    return canReopen(this.closedWindows, this.lockFacts())
  }

  /** How many closed windows are kept (the menu is rebuilt when it changes). */
  closedCount(): number {
    return this.closedWindows.length
  }

  /**
   * File › Rouvrir la dernière fenêtre fermée: the latest closed window comes back where it was (on the screens there are now), with its name, its sidebar and the tab it
   * showed in each space; a tab another window shows meanwhile stays where it is. Null when there is none to reopen (none closed, the application or the space locked).
   */
  reopenClosed(): WindowRecord | null {
    const { entry, rest } = takeLast(this.closedWindows, this.lockFacts())
    this.closedWindows = rest
    this.notify()
    if (entry === null) return null
    const bounds = fitToDisplays(entry.bounds, screen.getAllDisplays().map((display) => display.workArea)) ?? entry.bounds
    return this.openWindow({ commandBar: false, restore: { bounds, selection: entry.selection, ...(entry.name !== undefined ? { name: entry.name } : {}), ...(entry.sidebar ? { sidebar: entry.sidebar } : {}) } })
  }

  list(): WindowRecord[] {
    return [...this.records.values()]
  }

  privateWindows(): WindowRecord[] {
    return this.list().filter((r) => r.kind === 'private')
  }

  /** The windows opened after the main one, over the same tabs. */
  extraWindows(): WindowRecord[] {
    return this.list().filter((r) => r.kind === 'window')
  }

  /** Called when the focused window changes or a window opens or closes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Resolves once every closed private window has been erased. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  /**
   * File › New Window (the command bar opens on a new tab) or Blank Window: another window on the focused window's space with no
   * tab selected. The tabs are the same; selecting one here takes it from the window that showed it.
   */
  openWindow(options: { commandBar: boolean; restore?: { bounds: Rect; selection: Selection; name?: string; sidebar?: WindowSidebar } }): WindowRecord {
    const { deps } = this
    const id = `window-${++this.windowCounter}`
    const anchor = this.focused()
    const chrome = this.createChrome(id, anchor, false, options.restore?.bounds)
    const { win, overlay, floating } = chrome
    // A restored window shows what it showed, except a tab another window already shows: a tab lives in one window at a time.
    const selection = options.restore
      ? release(options.restore.selection, deps.mainStore.get(), new Set(this.list().flatMap((record) => visibleTabIds(record.store.get()))), id)
      : blankSelection(deps.mainStore.get(), anchor.store.get().activeSpaceId)
    // With the setting `independentWindows`, the window lists the tabs that carry its id (window-tabs.ts); closing it hands them to the first window.
    const view = new WindowView(deps.mainStore, selection, deps.views, false, id)
    const browser = new Browser(win, overlay, floating, deps.engine, view, deps.history, { windowId: id })
    // A restored window gets back the sidebar it chose (its side, docked) before it starts; a new one follows the setting, the full sidebar.
    if (options.restore?.sidebar) browser.setWindowSidebar(options.restore.sidebar)
    browser.joinGroup(this.group, this.records.get(MAIN_WINDOW_ID)!.browser)
    browser.setLittleOpener(deps.openLittle)
    const name = cleanWindowName(options.restore?.name)
    this.track({ id, kind: 'window', win, browser, store: view, ...(name !== undefined ? { name } : {}) }, chrome, () => view.dispose())
    if (options.commandBar) this.openCommandBarWhenReady(win, overlay, browser)
    return this.records.get(id)!
  }

  /** The overlay is a page of its own: it can only show the panel once it has loaded and mounted. */
  private openCommandBarWhenReady(win: BrowserWindow, overlay: WebContentsView, browser: Browser): void {
    overlay.webContents.once('did-finish-load', () =>
      setTimeout(() => {
        if (!win.isDestroyed()) browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
      }, 250)
    )
  }

  /** A private window; it opens, like a new window, with the command bar already open (`commandBar`). */
  openPrivate(options: { commandBar?: boolean } = {}): WindowRecord {
    return this.openEphemeral(options, false)
  }

  /**
   * A guest window (Settings › Fonctions en option): a private window underneath (own in-memory state, own throw-away session, erased with the
   * window, no extension), with its own look and name and none of the owner's settings (shared/guest-window.ts). Refused while the setting is off.
   */
  openGuest(options: { commandBar?: boolean } = {}): WindowRecord | null {
    if (!this.deps.mainStore.get().settings.guestProfile) return null
    return this.openEphemeral(options, true)
  }

  guestWindows(): WindowRecord[] {
    return this.list().filter((r) => r.guest === true)
  }

  private openEphemeral(options: { commandBar?: boolean }, guest: boolean): WindowRecord {
    const { deps } = this
    const id = guest ? `guest-${++this.guestCounter}` : `private-${++this.privateCounter}`
    const chrome = this.createChrome(id, this.focused(), true, undefined, guest)
    const { win, overlay, floating } = chrome
    const scope = deps.engine.openEphemeral(id)
    const store = new StateStore(guest ? createGuestState(deps.mainStore.get(), liveCtx()) : createPrivateState(deps.mainStore.get(), liveCtx()), null, scrubPrivateState)
    const browser = new Browser(win, overlay, floating, scope, store, NO_HISTORY, { private: true, ...(guest ? { guest: true } : {}) })

    // The search engine, blocking options and shortcuts are the main window's (a guest follows only a few of them): a change there reaches this window.
    let seen = deps.mainStore.get().settings
    const unfollow = deps.mainStore.subscribe((state) => {
      if (state.settings === seen) return
      seen = state.settings
      browser.inheritSettings(state.settings)
    })

    this.track({ id, kind: 'private', ...(guest ? { guest: true as const } : {}), win, browser, store }, chrome, () => {
      unfollow()
      // The session is not erased with the window: that is explicit.
      const erasing = scope.dispose().catch((error: unknown) => console.error(`[windows] cannot erase ${id}:`, error))
      this.pending.add(erasing)
      void erasing.finally(() => this.pending.delete(erasing))
    })
    if (guest) this.keepGuestTitle(win)
    if (options.commandBar) this.openCommandBarWhenReady(win, overlay, browser)
    return this.records.get(id)!
  }

  /** The title of a guest window is its label: the page of the interface would put its own (`Lucium`) there as soon as it loads. */
  private keepGuestTitle(win: BrowserWindow): void {
    win.setTitle(guestLabel())
    win.on('page-title-updated', (event) => event.preventDefault())
  }

  /** Closes every window but the main one (the main window is going away). */
  closeOtherWindows(): void {
    // The main window is gone and takes the application with it: the others are not asked. Only for this call: a window closing runs the
    // `close` listeners at once, and a caller that goes on afterwards (the engine test does) must find the question back.
    const before = this.quitting
    this.quitting = true
    try {
      for (const record of this.list()) if (record.kind !== 'main' && !record.win.isDestroyed()) record.win.close()
    } finally {
      this.quitting = before
    }
  }

  /**
   * What to remember of the windows for the next launch (Settings › Onglets et fenêtres: restore windows): the first window's place and the others, each with the
   * sidebar it chose for itself. A window that was closed is not in the list any more, and its choice goes with it.
   */
  sessionSnapshot(): SavedSession {
    const main = this.records.get(MAIN_WINDOW_ID)
    if (!main || main.win.isDestroyed()) return { main: null, windows: [] }
    return sessionOf(
      main.win.getBounds(),
      this.extraWindows()
        .filter((record) => !record.win.isDestroyed())
        .map((record) => ({ bounds: record.win.getBounds(), selection: selectionOf(record.store.get()), ...(record.name !== undefined ? { name: record.name } : {}), sidebar: record.browser.windowSidebar() })),
      main.name,
      main.browser.windowSidebar()
    )
  }

  /** Creates the window of a new record at `place`, or one step down and to the right of `anchor`, the same size (centred on the main screen when the anchor is gone). */
  private createChrome(id: string, anchor: WindowRecord, privateWindow: boolean, place?: Rect, guest = false): Chrome {
    const bounds = place ?? (anchor.win.isDestroyed() ? centredWindow(screen.getPrimaryDisplay().workArea) : cascadeFrom(anchor.win.getBounds()))
    const chrome = this.deps.createChrome(id, bounds, privateWindow, guest)
    // The engine finds the window of a page by this id.
    this.deps.windows.set(id, chrome.win)
    return chrome
  }

  /** Starts a window's browser, registers it, and tears everything down when the window closes. */
  private track(record: WindowRecord, chrome: Chrome, onClosed: () => void): void {
    const { deps } = this
    const { id, win, browser, store } = record
    const trusted = new Set([win.webContents.id, chrome.overlay.webContents.id])
    chrome.floating.trust(trusted)
    const releaseIpc = registerIpc(browser, store, win, trusted)
    browser.onPublish(() => this.notify())
    browser.onPublish(() => this.followPage(record))
    // The Settings window shows the owner's data (profiles, folders of extensions, permissions): a guest window does not open it.
    browser.setSettingsOpener(record.guest === true ? () => browser.showToast(t('windows.les-reglages-ne-sont-pas-disponibles-dans-une')) : deps.openSettings)
    browser.setSystemDark(deps.systemDark())
    browser.start()
    // The menu shows state of the focused window (split view, tabs…): it follows this one too.
    const unsubscribe = store.subscribe(() => this.notify())
    this.records.set(id, record)
    this.closeGuard.watch(record)
    this.syncGuard()
    this.hookNames(record)
    this.hookMoves(record)
    win.on('focus', () => this.focus(id))
    win.on('move', () => this.notify())
    win.on('resize', () => this.notify())
    win.once('ready-to-show', () => win.show())
    // What the window looked like when it was asked to close: its bounds and its view are gone once it is closed. A close the guard holds back leaves a snapshot that
    // the next close replaces.
    let lastLook: ClosedWindow | null = null
    win.on('close', () => {
      if (win.isDestroyed()) return
      lastLook = { bounds: win.getBounds(), selection: selectionOf(store.get()), ...(record.name !== undefined ? { name: record.name } : {}), sidebar: browser.windowSidebar() }
    })
    win.on('closed', () => {
      if (lastLook !== null && mayRemember({ kind: record.kind, ...(record.guest ? { guest: true } : {}), quitting: this.quitting, selection: lastLook.selection }, this.lockFacts())) {
        this.closedWindows = remember(this.closedWindows, lastLook)
      }
      this.closeGuard.unwatch(record)
      this.titled.delete(record)
      unsubscribe()
      browser.stop()
      onClosed()
      releaseIpcScope(ipcMain, trusted)
      releaseIpc()
      this.records.delete(id)
      deps.windows.delete(id)
      // A view that is not attached to the window (the overlay, the floating sidebar) is not closed with it.
      if (!chrome.overlay.webContents.isDestroyed()) chrome.overlay.webContents.close()
      chrome.floating.release()
      if (this.focusedId === id) this.focusedId = MAIN_WINDOW_ID
      this.notify()
    })
    this.notify()
  }

  private focus(id: string): void {
    if (this.focusedId === id) return
    this.focusedId = id
    this.notify()
  }

  // ---- a tab sent to another window from its menu (Déplacer vers la fenêtre) ----

  /**
   * What a normal window's browser is told of the windows its tabs can go to: the other normal windows, named as the Window menu names them (with the
   * title each one shows under its name), and a new one. A private or guest window is told nothing: its tabs never leave it, and none comes in.
   */
  private hookMoves(record: WindowRecord): void {
    if (record.kind === 'private') return record.browser.setWindowMoves(null)
    record.browser.setWindowMoves({
      targets: () => windowChoices(this.entries(), record.id, this.namesEnabled(), (id) => this.titleOf(id)),
      browserOf: (id) => {
        const other = this.records.get(id)
        return other && other.kind !== 'private' && !other.win.isDestroyed() ? other.browser : undefined
      },
      open: () => this.openWindow({ commandBar: false }).browser
    })
  }

  /** The title a window shows (its page, or its name), unless it is the plain one that says nothing about it. */
  private titleOf(id: string): string | undefined {
    const record = this.records.get(id)
    const title = record && !record.win.isDestroyed() ? record.win.getTitle() : undefined
    return title === DEFAULT_TITLE ? undefined : title
  }

  // ---- names of the windows (Fenêtre › Nommer la fenêtre…) ----

  private namesEnabled(): boolean {
    return this.deps.mainStore.get().settings.nameWindows
  }

  /** What this window's browser is told of the names; the page of the interface loads after this, so the title is put again once it is ready. */
  private hookNames(record: WindowRecord): void {
    record.browser.setWindowNames({
      own: () => this.records.get(record.id)?.name,
      others: () => namedWindows(this.entries(), record.id)
    })
    record.win.once('ready-to-show', () => {
      this.titled.delete(record)
      this.syncTitles()
    })
  }

  /** The browser windows as the Window menu lists them, in the order they were opened. */
  entries(): WindowEntry[] {
    const focusedId = this.focused().id
    return this.list().map((record, index) => ({
      id: record.id,
      kind: record.kind,
      ...(record.guest === true ? { guest: true as const } : {}),
      position: index + 1,
      focused: record.id === focusedId,
      ...(record.name !== undefined ? { name: record.name } : {})
    }))
  }

  /** What the application menu draws of the names: part of the key it is rebuilt on. Empty while windows cannot be named. */
  namesKey(): string {
    return this.namesEnabled() ? windowNamesKey(this.entries()) : ''
  }

  /** The named windows other than `id`. */
  othersNamed(id: string): NamedWindow[] {
    return namedWindows(this.entries(), id)
  }

  recordOf(win: BrowserWindow): WindowRecord | undefined {
    return this.list().find((record) => record.win === win)
  }

  /** Gives a window a name, or takes it away (empty or not text). Answers false for a window that does not exist. */
  setName(id: string, raw: unknown): boolean {
    const record = this.records.get(id)
    if (!record) return false
    const name = cleanWindowName(raw)
    if (record.name === name) return true
    if (name === undefined) delete record.name
    else record.name = name
    this.syncTitles()
    for (const each of this.records.values()) each.browser.republish()
    this.notify()
    return true
  }

  /** Brings a window to the front (the main one back, when it was put away). */
  focusWindow(id: string): boolean {
    if (id === MAIN_WINDOW_ID) return this.revealMain() !== null
    const record = this.records.get(id)
    if (!record || record.win.isDestroyed()) return false
    if (record.win.isMinimized()) record.win.restore()
    record.win.show()
    record.win.focus()
    return true
  }

  /**
   * The title of a window that carries no name is the page it shows, as in every browser: the system's list of windows (the Dock menu, Mission Control)
   * is how one tells three windows apart. A private or guest window keeps a title that tells nothing about what it shows.
   */
  private followPage(record: WindowRecord): void {
    if (record.win.isDestroyed() || record.kind === 'private' || (record.name !== undefined && this.namesEnabled())) return
    // The title is the page of the tab on screen, unless the lock hides it: the system's lists of windows (Mission Control, the Dock) would show it over the lock screen.
    const wanted = tabWindowTitle(activeTab(shownState(record.store.get(), getLockService()?.view())), DEFAULT_TITLE)
    if (record.win.getTitle() !== wanted) record.win.setTitle(wanted)
  }

  /** The title of a named window is its name (the system's own list of windows shows it); a window that lost its name, or all of them when the setting goes off, get the usual title back. */
  private syncTitles(): void {
    const enabled = this.namesEnabled()
    if (!enabled && this.titled.size === 0) return
    for (const record of this.records.values()) {
      if (record.win.isDestroyed()) continue
      const wanted = enabled ? record.name : undefined
      if (wanted !== undefined) {
        if (!this.titled.has(record) || record.win.getTitle() !== wanted) record.win.setTitle(wanted)
        this.titled.add(record)
      } else if (this.titled.delete(record)) {
        record.win.setTitle(record.guest === true ? guestLabel() : DEFAULT_TITLE)
      }
    }
  }

  private syncGuard(): void {
    this.closeGuard.sync(this.deps.mainStore.get().settings.warnBeforeClosingWindow)
  }

  private notify(): void {
    // Every change of a window's state and of the settings comes through here: the guard and the titles follow their settings without a listener of their own.
    this.syncGuard()
    this.syncTitles()
    for (const listener of this.listeners) listener()
  }
}

/** The size of a new first window (main/index.ts), centred in `area`, as a window opened with nothing to follow. */
function centredWindow(area: Rect): Rect {
  const width = Math.min(1360, area.width)
  const height = Math.min(860, area.height)
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
}

/** One step down and to the right of a window, the same size. */
function cascadeFrom(from: Rect): Rect {
  return { ...from, ...cascadePosition(from, screen.getDisplayMatching(from).workArea) }
}
