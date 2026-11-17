import { copyableUrl } from '@shared/copy-url'
import { BrowserWindow, clipboard, dialog, ipcMain, screen, type WebContents, type WebContentsView } from 'electron'
import { Channel, LITTLE_HEADER_HEIGHT, LITTLE_STRIP_HEIGHT, type LittleCommand, type LittleState } from '@shared/ipc'
import { littleArcExpired } from '@shared/little'
import { littleExpandedBounds, littleKeyCommand, type KeyInput } from '@shared/little-bar'
import { devToolsRequestForKey, type DevToolsRequest } from '@shared/devtools-request'
import { runDevTools } from './devtools-command'
import { gotoTabTarget, openInTarget } from '@shared/little-picker'
import { littleWindowBounds } from '@shared/little-window'
import { trayBounds, trayRows, withDownload } from '@shared/little-tray'
import { LITTLE_BUBBLE, bubbleAfter, bubbleDownload, bubbleExtra } from '@shared/little-bubble'
import { activeProfileId, profileSearch } from '@shared/profiles'
import { isNavigableUrl, resolveInput } from '@shared/url'
import { isPageOpenUrl } from '@shared/external-links'
import { isMainFrameSender } from '@shared/surface-guard'
import { shutByLock } from './lock-gate'
import type { Engine, Page, PageUpdate } from '../engine/types'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import type { HistoryLog } from './browser-base'
import { currentPlatform } from '../platform'
import { FeatureGates, type Gate } from './feature-gate'
import { getLockService } from '../lock-service'
import { t } from '@shared/i18n'

// The page of the mini window runs edge to edge below the header (x 0 → W), unlike the main window's inset card.
const MARGIN = 0

interface LittleWindow {
  id: string
  win: BrowserWindow
  /** Read at creation: a closed window no longer lets us reach its webContents. */
  webContentsId: number
  /** None while the window only holds the command bar: the page is made when the first address is chosen. */
  page?: Page
  state: LittleState
  /** When the window was last used (opened, brought to the front, went to another page): the archiving counts its delay from there. */
  activeAt: number
  /** The space picker, a transparent view over the whole window while it is open. */
  picker?: WebContentsView
  /** The downloads tray: a view of its own at the bottom of the window, over the page, while the page has downloaded something. */
  tray?: WebContentsView
  /** The space the window comes from (`LittleOrigin`): its profile makes the page, and the page is archived there or opened there as a tab. */
  spaceId?: string
}

const SWEEP_MS = 60_000

const appLocked = (): boolean => getLockService()?.isAppLocked() === true

export interface LittleDeps {
  engine: Engine
  store: StateStore
  browser: Browser
  /** The history of the profiles: the pages of a mini window join it like a tab's (the window is never a private one). */
  history: HistoryLog
  /** Windows by id, shared with the engine so pages can attach to them. */
  windows: Map<string, BrowserWindow>
  /** Webcontents allowed to call the privileged IPC. */
  trusted: Set<number>
  /** Creates the BrowserWindow for a mini window (preload, frame style) and loads its UI; `bar` is the first state, the command bar alone. */
  createWindow: (id: string, bar: boolean) => BrowserWindow
  /** Creates the view of the space picker (the same UI, loaded with `picker=1`); main places and shows it. */
  createPicker: (id: string) => WebContentsView
  /** Creates the view of the downloads tray (the same UI, loaded with `tray=1`); main places and shows it. */
  createTray: (id: string) => WebContentsView
  focusMain: () => void
}

/**
 * The mini window: a small window for a single page, used for links from other apps. Closing it archives the page;
 * "Open in main window" promotes it to a tab of the chosen space. The page lives in the profile of the space it comes from (the tab whose link
 * opened it, the window whose command bar did: `LittleOrigin`), else of the current space, so logins carry over; it is archived there, and its pages
 * join that profile's history like a tab's do (never a private window's: a mini window is not opened from one).
 */
export class LittleArc {
  private readonly windows = new Map<string, LittleWindow>()
  private readonly gates: FeatureGates
  /** The action bubble above the tray (Settings › Navigation › Plus de réglages); a bubble is only raised while its gate runs. */
  private readonly bubbles: Gate
  /** One timer per window with a bubble up: the bubble goes when it fires, or earlier when the window or the setting does. */
  private readonly bubbleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private counter = 0
  /** Told when a window opens or closes (the Dock menu enables its two entries by whether there is one). */
  private readonly countListeners = new Set<() => void>()

  constructor(private readonly deps: LittleDeps) {
    // A mini window is for a quick look: one left open past the delay of the settings is closed (and archived). With the delay at
    // "Jamais" there is no timer at all.
    this.gates = new FeatureGates(deps.store)
    this.gates.gate('little-archive', {
      start: () => {
        // Named: the engine test of the optional features recognises the timer of this feature by the name of its callback.
        const owner = this
        const sweep = setInterval(function littleArcSweep() {
          owner.sweep()
        }, SWEEP_MS)
        sweep.unref()
        return () => clearInterval(sweep)
      }
    })
    // Nothing runs for the bubble until a download finishes; switching the setting off takes down the bubbles that are up, with their timers.
    this.bubbles = this.gates.gate('little-download-bubble', { start: () => () => this.dropAllBubbles() })
    ipcMain.on(Channel.littleAction, (event, id: string, command: LittleCommand) => {
      const little = typeof id === 'string' ? this.windows.get(id) : undefined
      // Only the window's own UI, its space picker and its downloads tray may drive it, and only through their top frame.
      const from = event.sender.id
      if (!isMainFrameSender(event)) return console.warn('[little] ignored a command from a subframe')
      if (shutByLock(Channel.littleAction)) return
      if (!little || typeof command !== 'string' || (little.webContentsId !== from && little.picker?.webContents.id !== from && little.tray?.webContents.id !== from)) return
      this.act(little, command)
    })
    // What the page of a window downloads shows in that window's tray (the main window's list has it too).
    this.deps.engine.onDownload((download, sourcePageId) => {
      const little = sourcePageId ? this.windows.get(sourcePageId) : undefined
      if (!little) return
      const previous = little.state.downloads.find((d) => d.id === download.id)
      little.state = { ...little.state, downloads: withDownload(little.state.downloads, download) }
      if (this.bubbles.running() && bubbleAfter(previous, download)) this.raiseBubble(little, download.id)
      this.push(little)
      this.layoutTray(little)
    })
  }

  /** The application is quitting: what runs for the mini windows stops. */
  stop(): void {
    this.gates.disposeAll()
  }

  /**
   * Closes, and so archives, every window left without activity past the delay of the settings (Liens › Archiver les mini-fenêtres après), except
   * the ones the pin "Garder ouvert" keeps. The timer calls it every minute; `now` lets the engine test age a window without waiting. Answers how many
   * windows it closed.
   */
  sweep(now: number = Date.now()): number {
    const hours = this.deps.store.get().settings.littleArcArchiveHours
    let closed = 0
    for (const little of [...this.windows.values()]) {
      if (!littleArcExpired(little.activeAt, now, hours, little.state.kept === true) || little.win.isDestroyed()) continue
      little.win.close()
      closed++
    }
    return closed
  }

  /** Whether the bubble feature is running now (the engine test reads it). */
  bubbleRunning(): boolean {
    return this.bubbles.running()
  }

  /** Whether any bubble timer is armed now (the engine test reads it: a switched-off feature owns none). */
  bubbleTimerCount(): number {
    return this.bubbleTimers.size
  }

  count(): number {
    return this.windows.size
  }

  onCountChange(listener: () => void): void {
    this.countListeners.add(listener)
  }

  private countChanged(): void {
    for (const listener of this.countListeners) listener()
  }

  /** "Afficher les mini-fenêtres" (menu of the Dock): brings every open window to the front. Answers how many. */
  showAll(): number {
    let shown = 0
    for (const little of this.windows.values()) {
      if (little.win.isDestroyed()) continue
      if (little.win.isMinimized()) little.win.restore()
      little.win.show()
      shown++
    }
    return shown
  }

  /** "Fermer les mini-fenêtres" (menu of the Dock): closes them as their close button does, so each page is archived. Answers how many. */
  closeAll(): number {
    let closed = 0
    for (const little of [...this.windows.values()]) {
      if (little.win.isDestroyed()) continue
      little.win.close()
      closed++
    }
    return closed
  }

  /** States of the open windows, for the engine smoke test. */
  states(): LittleState[] {
    return [...this.windows.values()].map((w) => w.state)
  }

  /**
   * A window that shows a page right away (links of other apps, extension popups). While the application is locked none opens, and the id
   * given back is '' (no window has it): the lock closes these windows when it starts, and a popup an extension asks for afterwards
   * (`chrome.windows.create`) must not bring a live page of the profile over the lock screen. The links of other applications wait for the
   * unlock on their own (`deferredLinks`).
   */
  open(url: string, profileId?: string, spaceId?: string): string {
    if (appLocked()) {
      console.warn('[little] refused to open a window while the application is locked')
      return ''
    }
    const little = this.create(false)
    if (spaceId !== undefined && this.deps.store.get().spaces.some((space) => space.id === spaceId)) little.spaceId = spaceId
    this.startPage(little, url, profileId)
    return little.id
  }

  /** "New Mini Window" (File menu): the first state of the mini window, the command bar alone. The page comes when an address is chosen. None while locked (''). */
  openBar(): string {
    if (appLocked()) return ''
    return this.create(true).id
  }

  private create(bar: boolean): LittleWindow {
    const id = `little-${++this.counter}`
    const state = this.deps.store.get()
    const win = this.deps.createWindow(id, bar)
    // The traffic lights belong to the header; the first state has a close button of its own.
    if (bar) currentPlatform().setWindowButtonVisibility(win, false)
    this.deps.windows.set(id, win)
    this.deps.trusted.add(win.webContents.id)
    const little: LittleWindow = {
      id,
      win,
      webContentsId: win.webContents.id,
      activeAt: Date.now(),
      state: { id, url: '', title: '', canGoBack: false, canGoForward: false, bar, downloads: [], kept: false, spaces: state.spaces.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji })) }
    }
    this.windows.set(id, little)
    this.countChanged()
    win.on('resize', () => this.layout(little))
    // Brought to the front: the window is in use, and the delay of the archiving starts again.
    win.on('focus', () => {
      little.activeAt = Date.now()
    })
    win.on('closed', () => this.cleanup(little, true))
    // Like every popover, the picker goes away when the window is left.
    win.on('blur', () => this.closePicker(little, false))
    // Keys of the header are the window's shortcuts too, before the menu bar can take them for the main window.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && this.shortcut(little, input)) event.preventDefault()
    })
    win.webContents.once('did-finish-load', () => this.push(little))
    win.show()
    return little
  }

  /** The key of a window whose page (or header) has the focus: ⌘O, ⇧⌘C, ⌘R, ⌘[ and ⌘] drive this window, not the main one. */
  private shortcut(little: LittleWindow, input: KeyInput): boolean {
    if (little.state.bar) return false
    // ⌥⌘I, ⌥⌘J, ⌥⌘C and F12 open the tools of this window's page: left to the menu bar they would open those of a tab of the main window.
    const tools = devToolsRequestForKey(input, this.deps.store.get().settings.keyBindings)
    if (tools) {
      this.openTools(little, tools)
      return true
    }
    const command = littleKeyCommand(input, this.deps.store.get().settings.keyBindings)
    if (!command) return false
    this.act(little, command)
    return true
  }

  /** The developer tools of the window's page. A window like this has no toast: what failed is said in a box on the window. */
  private openTools(little: LittleWindow, request: DevToolsRequest): void {
    void runDevTools(little.page, request, (message) => this.tellToolsFailed(little, message))
  }

  private tellToolsFailed(little: LittleWindow, message: string): void {
    if (!little.win.isDestroyed()) void dialog.showMessageBox(little.win, { type: 'warning', message })
  }

  /** `profileId`: the profile of an extension that opened this window (chrome.windows.create); otherwise the profile of the space it comes from, or of the space the user is in. */
  private startPage(little: LittleWindow, url: string, profileId?: string): void {
    const { id } = little
    const { store, engine } = this.deps
    const state = store.get()
    const space = state.spaces.find((s) => s.id === (little.spaceId ?? state.activeSpaceId))
    const pageProfile = profileId ?? space?.profileId ?? 'default'
    // The history of the profile the page is made with, with the space it comes from; a profile an extension named is not the space's, so no space is said.
    const history = () => this.deps.history.of(pageProfile, profileId === undefined || profileId === space?.profileId ? space?.id : undefined)
    const update = (patch: PageUpdate) => {
      const current = this.windows.get(id)
      if (!current || patch.url?.startsWith('chrome-error://')) return
      // Going to another page is activity too.
      if (patch.url !== undefined && patch.url !== current.state.url) current.activeAt = Date.now()
      current.state = {
        ...current.state,
        url: patch.url ?? current.state.url,
        title: patch.title ?? current.state.title,
        canGoBack: patch.canGoBack ?? current.state.canGoBack,
        canGoForward: patch.canGoForward ?? current.state.canGoForward
      }
      // '' is "no icon to show" (the one the page declares is refused): the icon of the page before goes.
      if (patch.faviconUrl) current.state.faviconUrl = patch.faviconUrl
      else if (patch.faviconUrl === '') delete current.state.faviconUrl
      // The same rules as a tab: a load that came to no page (a frame, a download, one of our error pages) is no visit, and the title the page ended with is kept.
      const showsError = current.page?.showsError() === true
      if (patch.loading === false && patch.visit !== false && !showsError) history().record(current.state.url, current.state.title)
      else if (patch.title !== undefined && patch.loading !== false && !showsError) history().retitle(current.state.url, current.state.title)
      this.push(current)
    }
    const noop = () => {}
    const page = engine.createPage(
      { id, profileId: pageProfile, windowId: id },
      {
        update,
        // Links inside a mini window stay in it: it is a single-page window. The address comes from a page: only a web one is loaded.
        openWindow: (target) => {
          if (isPageOpenUrl(target)) this.windows.get(id)?.page?.loadURL(target)
          else console.warn(`[little] ignored a link to a non-web address: ${String(target).split(':')[0]}:`)
        },
        focused: noop,
        // The page of this window hides ads and banners like a tab's does.
        domReady: () => this.deps.browser.hideAdsOn(id, page, () => this.windows.get(id)?.state.url, () => this.windows.get(id)?.page === page),
        found: noop,
        searchSelection: noop,
        copyLink: (target) => copyableUrl(target, this.deps.store.get().settings.stripCopiedLinks),
        // A page that closes itself takes its window with it.
        closed: () => this.windows.get(id)?.win.close(),
        devToolsFailed: (message) => this.tellToolsFailed(little, message),
        shortcut: (input) => this.shortcut(little, input)
      }
    )
    little.page = page
    little.state = { ...little.state, url, title: url }
    this.layout(little)
    page.loadURL(url)
    this.push(little)
  }

  /** What was typed in the bar of the first state: a web address or a search, as in the command bar. The window grows to hold its page. */
  private go(little: LittleWindow, input: string): void {
    const state = this.deps.store.get()
    // The window's UI is not trusted: resolve again here, so that only what the command bar itself would open is loaded (never javascript: and the like).
    const resolved = resolveInput(input, profileSearch(state.settings, activeProfileId(state)).url)
    if (!resolved) return
    // An address that cannot be read: said in a box on this window (it has no notice), never loaded (the page would throw).
    if (!isNavigableUrl(resolved.url)) return this.tellToolsFailed(little, t('browser.adresse-invalide'))
    if (little.page) return little.page.loadURL(resolved.url)
    this.startPage(little, resolved.url)
    this.expand(little)
  }

  /** The first state becomes the page window: top and right edge stay, the window grows to the size a page opens in. */
  private expand(little: LittleWindow): void {
    const { win } = little
    if (win.isDestroyed()) return
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    const size = littleWindowBounds(area)
    win.setResizable(true)
    win.setMinimumSize(480, 360)
    win.setBounds(littleExpandedBounds(win.getBounds(), size, area))
    currentPlatform().setWindowButtonVisibility(win, true)
    little.state = { ...little.state, bar: false }
    this.layout(little)
    this.push(little)
  }

  /** Closes a window (archiving its page) — used by the smoke test and by the "close" command. */
  close(id: string): void {
    this.windows.get(id)?.win.close()
  }

  /** Runs a header command on a window, exactly as its UI would. */
  command(id: string, command: LittleCommand): void {
    const little = this.windows.get(id)
    if (little) this.act(little, command)
  }

  private layout(little: LittleWindow): void {
    if (little.win.isDestroyed()) return
    if (little.page) {
      const { width, height } = little.win.getContentBounds()
      // The page starts under the header and the banner of the archiving delay, both drawn by the window's own UI.
      const top = LITTLE_HEADER_HEIGHT + LITTLE_STRIP_HEIGHT
      little.page.show({ x: MARGIN, y: top, width: Math.max(0, width - MARGIN * 2), height: Math.max(0, height - top - MARGIN) })
    }
    // Above the page: the tray, then the picker over everything.
    this.layoutTray(little)
    this.layoutPicker(little)
  }

  private openPicker(little: LittleWindow): void {
    if (little.picker || little.win.isDestroyed()) return
    const view = this.deps.createPicker(little.id)
    little.picker = view
    this.deps.trusted.add(view.webContents.id)
    this.layoutPicker(little)
    view.webContents.focus()
  }

  /** Covers the window: a click outside the popover lands on the picker, which closes itself. Re-added so it stays above the page. */
  private layoutPicker(little: LittleWindow): void {
    if (!little.picker || little.win.isDestroyed()) return
    const { width, height } = little.win.getContentBounds()
    little.picker.setBounds({ x: 0, y: 0, width, height })
    little.win.contentView.addChildView(little.picker)
  }

  /** The tray sits over the page, at the bottom of the window, while there are downloads to show; the picker, when open, stays above it. */
  private layoutTray(little: LittleWindow): void {
    if (little.win.isDestroyed()) return
    const { width, height } = little.win.getContentBounds()
    const bounds = trayBounds({ width, height }, trayRows(little.state.downloads).length, bubbleExtra(bubbleDownload(little.state.downloads, little.state.bubble) !== undefined))
    if (!bounds) {
      this.closeTray(little)
      return
    }
    if (!little.tray) {
      little.tray = this.deps.createTray(little.id)
      this.deps.trusted.add(little.tray.webContents.id)
      // The tray's page is new: it gets the state as soon as it can listen.
      little.tray.webContents.once('did-finish-load', () => this.push(little))
    }
    little.tray.setBounds(bounds)
    little.win.contentView.addChildView(little.tray)
    if (little.picker) little.win.contentView.addChildView(little.picker)
  }

  private closeTray(little: LittleWindow): void {
    const view = little.tray
    if (!view) return
    little.tray = undefined
    this.deps.trusted.delete(view.webContents.id)
    if (!little.win.isDestroyed()) little.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /** A finished download gets the bubble (a newer one takes it over from an older one); it stays for `shownMs` unless the pointer is on it. */
  private raiseBubble(little: LittleWindow, id: string): void {
    little.state = { ...little.state, bubble: id }
    this.armBubble(little, LITTLE_BUBBLE.shownMs)
  }

  private armBubble(little: LittleWindow, ms: number): void {
    this.clearBubbleTimer(little.id)
    const timer = setTimeout(() => this.dropBubble(little), ms)
    timer.unref()
    this.bubbleTimers.set(little.id, timer)
  }

  private clearBubbleTimer(windowId: string): void {
    const timer = this.bubbleTimers.get(windowId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.bubbleTimers.delete(windowId)
  }

  /** Takes the bubble down (its timer too) and gives the tray its height back. */
  private dropBubble(little: LittleWindow): void {
    this.clearBubbleTimer(little.id)
    if (little.state.bubble === undefined) return
    const { bubble: _gone, ...rest } = little.state
    little.state = rest
    if (little.win.isDestroyed()) return
    this.push(little)
    this.layoutTray(little)
  }

  private dropAllBubbles(): void {
    for (const little of this.windows.values()) this.dropBubble(little)
    for (const id of [...this.bubbleTimers.keys()]) this.clearBubbleTimer(id)
  }

  private closePicker(little: LittleWindow, refocus: boolean): void {
    const view = little.picker
    if (!view) return
    little.picker = undefined
    this.deps.trusted.delete(view.webContents.id)
    if (!little.win.isDestroyed()) little.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    if (refocus) little.page?.focus()
  }

  private push(little: LittleWindow): void {
    const wc: WebContents = little.win.webContents
    if (!little.win.isDestroyed() && !wc.isDestroyed()) wc.send(Channel.littleState, little.state)
    const tray = little.tray?.webContents
    if (tray && !tray.isDestroyed()) tray.send(Channel.littleState, little.state)
  }

  private act(little: LittleWindow, command: LittleCommand): void {
    switch (command) {
      case 'back':
        return little.page?.goBack()
      case 'forward':
        return little.page?.goForward()
      case 'reload':
        return little.page?.reload()
      case 'ready':
        return this.push(little)
      case 'copy-url':
        if (!little.state.url) return
        // Electron 45's clipboard is asynchronous: the tick only shows once the address is really there.
        return void clipboard.writeText(copyableUrl(little.state.url, this.deps.store.get().settings.stripCopiedLinks)).then(
          () => {
            little.state = { ...little.state, copiedAt: Date.now() }
            this.push(little)
          },
          (error: unknown) => console.error('[little] cannot copy the address:', error instanceof Error ? error.message : String(error))
        )
      case 'close':
        return little.win.close()
      case 'open-in-main':
        return this.promote(little, undefined)
      case 'move-menu':
        return this.openPicker(little)
      // The pin of the header: kept, the window is left out of the archiving of the forgotten ones; the banner says so.
      case 'keep:on':
      case 'keep:off':
        little.state = { ...little.state, kept: command === 'keep:on' }
        return this.push(little)
      // The link of the banner: the delay is in Réglages › Liens (the setting window opens, over this one if it has to).
      case 'archive-delay':
        return this.deps.browser.openOverlay({ panel: 'settings', pane: 'navigation', anchor: 'links' })
      case 'picker-close':
        return this.closePicker(little, true)
      case 'bubble-close':
        return this.dropBubble(little)
      // The pointer is on the bubble: it waits. When the pointer leaves, it stays a little longer for a last look.
      case 'bubble-hold':
        return little.state.bubble === undefined ? undefined : this.clearBubbleTimer(little.id)
      case 'bubble-release':
        return little.state.bubble === undefined ? undefined : this.armBubble(little, LITTLE_BUBBLE.leftMs)
      default: {
        // "dismiss-download:<id>", from the tray: the file leaves the tray (not the downloads list of the main window).
        if (command.startsWith('dismiss-download:')) {
          const gone = command.slice('dismiss-download:'.length)
          // A row taken out of the tray takes its bubble with it.
          if (little.state.bubble === gone) this.dropBubble(little)
          little.state = { ...little.state, downloads: little.state.downloads.filter((d) => d.id !== gone) }
          this.push(little)
          return this.layoutTray(little)
        }
        // "go:<text>", from the bar of the first state: what the user typed.
        if (command.startsWith('go:')) return little.state.bar || !little.page ? this.go(little, command.slice(3)) : undefined
        // "goto-tab:<tab id>", from the "Onglets ouverts" of the bar: only a tab that is there and is not a private one.
        const tab = gotoTabTarget(command)
        if (tab) return this.gotoTab(little, tab)
        // "open-in:<space id>", from the picker: only a space that exists.
        const target = openInTarget(command)
        if (target && this.deps.store.get().spaces.some((space) => space.id === target)) this.promote(little, target)
      }
    }
  }

  /** The bar of the first state chose an open tab: the main window goes to it and this window, which has no page, goes away without a trace in the archive. */
  private gotoTab(little: LittleWindow, tabId: string): void {
    const tab = this.deps.store.get().tabs.find((t) => t.id === tabId)
    // A private tab is never listed in this window, so a command that names one is not from the bar.
    if (!tab || tab.private === true || !little.state.bar) return
    this.deps.browser.dispatch({ type: 'tab/select', id: tab.id })
    this.cleanup(little, false)
    if (!little.win.isDestroyed()) little.win.close()
    this.deps.focusMain()
  }

  /** Turns the page of the mini window into a tab of the main window (in `spaceId`, or the space it comes from, or the current space). */
  private promote(little: LittleWindow, spaceId: string | undefined): void {
    this.deps.browser.dispatch({ type: 'tab/open', url: little.state.url, spaceId: spaceId ?? this.originSpace(little) })
    this.cleanup(little, false)
    if (!little.win.isDestroyed()) little.win.close()
    this.deps.focusMain()
  }

  /** The space the window comes from, while it still exists (a space deleted meanwhile leaves the current one). */
  private originSpace(little: LittleWindow): string | undefined {
    const { spaceId } = little
    return spaceId !== undefined && this.deps.store.get().spaces.some((space) => space.id === spaceId) ? spaceId : undefined
  }

  private cleanup(little: LittleWindow, archive: boolean): void {
    if (!this.windows.delete(little.id)) return
    this.countChanged()
    this.closePicker(little, false)
    this.closeTray(little)
    this.clearBubbleTimer(little.id)
    // Only a web page is worth keeping: a window an extension opened (one of its own pages, a blank one) leaves nothing in the archive.
    if (archive && /^https?:\/\//i.test(little.state.url)) {
      this.deps.browser.dispatch({ type: 'archive/add', url: little.state.url, title: little.state.title, source: 'little', spaceId: this.originSpace(little) })
    }
    this.deps.trusted.delete(little.webContentsId)
    this.deps.windows.delete(little.id)
    this.deps.browser.forgetBlockerCss(little.id)
    little.page?.destroy()
  }
}
