// The annotated window share (docs/design/annotation-partage-fenetre.md, « Fenêtre annotée »). The command window lists the windows that can
// be captured and starts or stops the share of one of them; the view window shows that window's picture. The drawing goes on the picture; the
// passage mode sends the clicks of the view to the shared window (Accessibility, see window-share-native.ts). The frames stay in memory: nothing
// is recorded, written to disk or sent. Built by default; LUCIUM_ANNOTATE=0 turns it off, from the sources or in a smoke run only (main/index.ts).

import { BrowserWindow, app, desktopCapturer, globalShortcut, ipcMain, session, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  WINDOW_SHARE_CHANNEL,
  capturableWindows,
  listingRefusedForPermission,
  nativeWindowId,
  refusalOf,
  shareNoticeOf,
  type ShareList,
  type ShareNotice,
  type ShareSource,
  type ShareStart,
  type ShareState,
  type WindowExclusions
} from '@shared/window-share'
import { DEFAULT_BRUSH, isBrush, isEditCommand, type Brush, type DrawAction } from '@shared/window-share-draw'
import { PASS_SHORTCUT, isPassClick, sourcePoint, type PassClick, type PassNote } from '@shared/window-share-pass'
import type { NativeAccess } from './window-share-native'
import { t } from '@shared/i18n'
import { isFromSurface, sourceForView } from '@shared/surface-guard'
import { shutByLock } from './lock-gate'

/** The session of the view window: in memory (no `persist:` prefix), and used by that window alone. */
const VIEW_PARTITION = 'window-share-view'
/** How often the shared window is looked for in the list of the windows, to tell the command window that it was closed. */
const PRESENCE_INTERVAL_MS = 2000
/** The pause between the activation of the shared window and the click: the window must be in front before the click reaches it. */
const ACTIVATE_DELAY_MS = 80
/**
 * No click is taken for this long after one was sent. When the shared window is not in front, the click sent lands on the view, which is
 * in the passage mode too: it must not be sent back to the window again.
 */
const CLICK_QUIET_MS = 300

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type MediaStatus = ReturnType<typeof systemPreferences.getMediaAccessStatus>

export interface WindowShareDeps {
  /** Loads one of our pages (the same checks as every interface surface, see index.ts `load`). */
  load(target: WebContents, page: 'window-share-view' | 'window-share-command', query?: Record<string, string>): void
  /** The private windows of Lucium. Read each time they are needed. */
  privateWindows(): BrowserWindow[]
  /** The preload of the command window: the only one that talks to this module. */
  preload: string
  /** The preload of the view window: it only sends a click in the passage mode, and receives the drawing actions. */
  viewPreload: string
  /** The language of the interface, given to the command window. */
  language(): string
  /** The native calls of the passage mode, loaded at its first use (koffi, macOS only; see window-share-native.ts). */
  native(): Promise<NativeAccess>
  /** The system this runs on (`process.platform` when left out): only macOS has a screen permission to read. */
  platform?: NodeJS.Platform
}

/** The native numbers of the windows that are alive. */
function nativeIds(windows: ReadonlyArray<BrowserWindow | null>): Set<string> {
  const ids = new Set<string>()
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue
    const native = nativeWindowId(win.getMediaSourceId())
    if (native !== null) ids.add(native)
  }
  return ids
}

export class WindowShare {
  private command: BrowserWindow | null = null
  private view: BrowserWindow | null = null
  /** The window the view shows; the display-media handler grants this one and nothing else. */
  private source: ShareSource | null = null
  /** The brush of the drawing. Kept here so that a view made again (a new share) draws with the brush chosen last. */
  private brush: Brush = DEFAULT_BRUSH
  /** The check of the shared window's presence, while a window is shared. */
  private presence: ReturnType<typeof setInterval> | null = null
  private checking = false
  /** The shared window is gone from the list (see ShareState.missing). */
  private missing = false
  /** The shared window is listed but not on the screen (see ShareState.hidden), and the view's picture is black (ShareState.blank). */
  private hidden = false
  private blank = false
  /** What the view shows about its source, as last sent to it (see shareNoticeOf). */
  private notice: ShareNotice = null
  /** The passage mode: the clicks of the view go to the shared window. Only while a window is shared. */
  private pass = false
  private passNote: PassNote | null = null
  /** The shortcut ⌥⌘P is wanted (the command window's switch); it is held only while a window is shared. */
  private shortcutWanted = true
  private shortcutHeld = false
  /** ⌥⌘P is not held because the annotation of a page, which has the same shortcut, holds it. */
  private shortcutOwn = false
  /** A click is being sent: the next one waits for it (and for CLICK_QUIET_MS after it). */
  private clicking = false
  private quietUntil = 0
  private nativeAccess: Promise<NativeAccess | null> | null = null

  constructor(private readonly deps: WindowShareDeps) {
    // Only the page of the view is given the window that was chosen: not a frame inside it, nor another page that would live in its partition.
    session.fromPartition(VIEW_PARTITION).setDisplayMediaRequestHandler((request, callback) => {
      const source = sourceForView(this.source, request.frame, this.view !== null && !this.view.isDestroyed() ? this.view.webContents.mainFrame : null)
      callback(source ? { video: { id: source.id, name: source.name } } : null)
    })
    ipcMain.handle(WINDOW_SHARE_CHANNEL.list, (event: IpcMainInvokeEvent): Promise<ShareList> | ShareList => (this.fromCommand(event) ? this.list() : { ok: false, reason: 'failed' }))
    ipcMain.handle(WINDOW_SHARE_CHANNEL.start, (event: IpcMainInvokeEvent, id: unknown): Promise<ShareStart> | ShareStart => (this.fromCommand(event) ? this.start(id) : { ok: false, reason: 'failed' }))
    ipcMain.handle(WINDOW_SHARE_CHANNEL.stop, (event: IpcMainInvokeEvent): void => {
      if (this.fromCommand(event)) this.stop()
    })
    // The brush is checked against the palette before it goes anywhere: a value outside it is dropped.
    ipcMain.handle(WINDOW_SHARE_CHANNEL.brush, (event: IpcMainInvokeEvent, brush: unknown): void => {
      if (this.fromCommand(event) && isBrush(brush)) this.setBrush(brush)
    })
    // Undo, redo and clear: only the names of the list reach the view.
    ipcMain.handle(WINDOW_SHARE_CHANNEL.edit, (event: IpcMainInvokeEvent, command: unknown): void => {
      if (this.fromCommand(event) && isEditCommand(command)) this.sendToView({ type: command })
    })
    ipcMain.handle(WINDOW_SHARE_CHANNEL.pass, (event: IpcMainInvokeEvent, on: unknown): Promise<void> | void => {
      if (this.fromCommand(event) && typeof on === 'boolean') return this.setPass(on)
    })
    ipcMain.handle(WINDOW_SHARE_CHANNEL.shortcut, (event: IpcMainInvokeEvent, on: unknown): void => {
      if (this.fromCommand(event) && typeof on === 'boolean') this.setShortcut(on)
    })
    // A click of the view, checked here: it must come from the view, be well formed, and be in the passage mode (clickSource checks the rest).
    ipcMain.on(WINDOW_SHARE_CHANNEL.click, (event: IpcMainEvent, raw: unknown): void => {
      if (this.fromView(event) && isPassClick(raw)) void this.clickSource(raw)
    })
    // The view tells whether its picture is black for a while: only a boolean from the view counts.
    ipcMain.on(WINDOW_SHARE_CHANNEL.picture, (event: IpcMainEvent, raw: unknown): void => {
      if (this.fromView(event) && typeof raw === 'boolean') this.setBlank(raw)
    })
  }

  /** Whether a window is being shared now (the notice of an update waits for the end of the share: auto-update.ts). */
  isSharing(): boolean {
    return this.source !== null
  }

  /** Shows the command window (one at a time). */
  open(): void {
    const existing = this.command
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const win = new BrowserWindow({
      // Compact, and tall enough for every section of the panel (see renderer/window-share-command.html).
      width: 400,
      height: 560,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: t('window-share.titre-commande'),
      webPreferences: { preload: this.deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
    })
    this.command = win
    win.once('ready-to-show', () => win.show())
    // Closing the command window ends the share: nothing is left shared without its controls.
    win.on('closed', () => {
      this.command = null
      this.stop()
    })
    this.deps.load(win.webContents, 'window-share-command', { lang: this.deps.language() })
  }

  /** Ends the share and closes both windows (the application locks, or the command window closes). */
  close(): void {
    this.stop()
    if (this.command && !this.command.isDestroyed()) this.command.close()
  }

  private fromCommand(event: IpcMainInvokeEvent): boolean {
    return isFromSurface(event, this.command) && !shutByLock('the share window')
  }

  private fromView(event: IpcMainEvent): boolean {
    return isFromSurface(event, this.view) && !shutByLock('the view of the share')
  }

  /** The windows that can be captured now, or why the list is not available (the screen permission, a failed read). */
  private async list(): Promise<ShareList> {
    const fetched = await this.listSources()
    if ('reason' in fetched) return { ok: false, reason: fetched.reason }
    return { ok: true, windows: capturableWindows(fetched.sources, this.exclusions()) }
  }

  private async start(raw: unknown): Promise<ShareStart> {
    if (typeof raw !== 'string') return { ok: false, reason: 'unknown' }
    const fetched = await this.listSources()
    if ('reason' in fetched) return { ok: false, reason: fetched.reason }
    const refusal = refusalOf(raw, fetched.sources, this.exclusions())
    if (refusal) return { ok: false, reason: refusal }
    const source = fetched.sources.find((candidate) => candidate.id === raw)
    if (!source) return { ok: false, reason: 'unknown' }
    this.source = { id: source.id, name: source.name }
    this.missing = false
    this.hidden = false
    this.blank = false
    this.passNote = null
    this.watch()
    this.syncShortcut()
    this.syncNotice()
    this.showView()
    this.notify()
    // The state of the window (minimized or not) is read now, not two seconds later.
    void this.checkPresence()
    return { ok: true }
  }

  /** Ends the share: the passage mode goes with it, and the shortcut is released. */
  private stop(): void {
    this.source = null
    this.unwatch()
    this.missing = false
    this.hidden = false
    this.blank = false
    this.pass = false
    this.passNote = null
    this.syncShortcut()
    this.syncNotice()
    const view = this.view
    this.view = null
    if (view && !view.isDestroyed()) view.close()
    this.notify()
  }

  /**
   * Looks for the shared window every PRESENCE_INTERVAL_MS: whether it is still listed, and whether it is on the screen. Only a list that was read
   * counts: a failed read says nothing about the window.
   */
  private watch(): void {
    this.unwatch()
    this.presence = setInterval(() => void this.checkPresence(), PRESENCE_INTERVAL_MS)
  }

  private unwatch(): void {
    if (this.presence) clearInterval(this.presence)
    this.presence = null
  }

  private async checkPresence(): Promise<void> {
    const source = this.source
    if (!source || this.checking) return
    this.checking = true
    try {
      const fetched = await this.listSources()
      // The share may have stopped or moved to another window while the list was read.
      if (this.source !== source || 'reason' in fetched) return
      const missing = !fetched.sources.some((candidate) => candidate.id === source.id)
      // A window that is gone is not also hidden: only a listed window can be on the screen or not.
      const hidden = !missing && (await this.onScreen(source)) === false
      if (this.source !== source) return
      if (missing === this.missing && hidden === this.hidden) return
      this.missing = missing
      this.hidden = hidden
      this.syncNotice()
      this.notify()
    } finally {
      this.checking = false
    }
  }

  /** Whether the shared window is on the screen, as macOS tells it. Null when the system cannot tell (not macOS, the native calls not loaded). */
  private async onScreen(source: ShareSource): Promise<boolean | null> {
    const native = await this.access()
    const windowId = Number(nativeWindowId(source.id))
    return native && Number.isFinite(windowId) ? native.onScreen(windowId) : null
  }

  /** The picture of the view is black, or not (its own sampling, see window-share-picture.ts). Only a change is worth telling. */
  private setBlank(blank: boolean): void {
    if (!this.source || blank === this.blank) return
    this.blank = blank
    this.syncNotice()
    this.notify()
  }

  /** Tells the view what its notice is, when it changes: the window is closed, or it sends no picture, or nothing. */
  private syncNotice(): void {
    const notice = this.source ? shareNoticeOf({ missing: this.missing, hidden: this.hidden, blank: this.blank }) : null
    if (notice === this.notice) return
    this.notice = notice
    this.sendToView({ type: 'notice', notice })
  }

  private showView(): void {
    const existing = this.view
    if (existing && !existing.isDestroyed()) {
      // The same window stays (the video app shares it once): only its picture changes, to the window chosen now. The page, the drawing and
      // the window's identity are kept; the view asks the picture again (main grants the new source).
      this.sendToView({ type: 'source' })
      existing.show()
      return
    }
    const view = new BrowserWindow({
      width: 960,
      height: 600,
      minWidth: 320,
      minHeight: 200,
      show: false,
      title: t('window-share.fenetre-annotee'),
      backgroundColor: '#000000',
      webPreferences: { partition: VIEW_PARTITION, preload: this.deps.viewPreload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
    })
    this.view = view
    view.once('ready-to-show', () => view.show())
    // Each time the page loads (a new share reloads it), it gets the brush chosen so far, before any stroke.
    view.webContents.on('did-finish-load', () => {
      this.sendToView({ type: 'brush', brush: this.brush })
      this.sendToView({ type: 'pass', on: this.pass })
      this.sendToView({ type: 'notice', notice: this.notice })
    })
    view.on('closed', () => {
      if (this.view !== view) return
      this.view = null
      this.stop()
    })
    this.deps.load(view.webContents, 'window-share-view', { lang: this.deps.language() })
  }

  private setBrush(brush: Brush): void {
    this.brush = brush
    this.sendToView({ type: 'brush', brush })
  }

  /** Forwards a drawing action to the view window, and to no other window. */
  private sendToView(action: DrawAction): void {
    const view = this.view
    if (!view || view.isDestroyed()) return
    view.webContents.send(WINDOW_SHARE_CHANNEL.draw, action)
  }

  private notify(): void {
    const command = this.command
    if (!command || command.isDestroyed()) return
    const state: ShareState = {
      sharing: this.source,
      missing: this.missing,
      pass: this.pass,
      passNote: this.passNote,
      shortcut: this.shortcutState(),
      hidden: this.hidden,
      blank: this.blank
    }
    command.webContents.send(WINDOW_SHARE_CHANNEL.state, state)
  }

  private shortcutState(): ShareState['shortcut'] {
    if (!this.shortcutWanted) return 'off'
    if (this.shortcutHeld) return 'on'
    return this.source ? (this.shortcutOwn ? 'own' : 'taken') : 'off'
  }

  /**
   * ⌥⌘P is held while a window is shared and the switch is on. It may not be held, and the state says by whom: `isRegistered` only knows the
   * shortcuts of this application, so a yes (while this share does not hold it) is the annotation of a page, and a registration that fails
   * without it is another application.
   */
  private syncShortcut(): void {
    const wanted = this.source !== null && this.shortcutWanted
    if (wanted && !this.shortcutHeld) {
      this.shortcutOwn = globalShortcut.isRegistered(PASS_SHORTCUT)
      this.shortcutHeld = !this.shortcutOwn && globalShortcut.register(PASS_SHORTCUT, () => void this.setPass(!this.pass))
    } else if (!wanted && this.shortcutHeld) {
      globalShortcut.unregister(PASS_SHORTCUT)
      this.shortcutHeld = false
    }
  }

  private setShortcut(on: boolean): void {
    this.shortcutWanted = on
    this.syncShortcut()
    this.notify()
  }

  /**
   * Switches the passage mode. The permission is asked here, and only here: a mode that is switched on without it is refused, with the note that
   * says why. Nothing is sent to the shared window before the mode is on.
   */
  private async setPass(on: boolean): Promise<void> {
    if (!this.source) return
    if (!on) return this.switchPass(false, null)
    const native = await this.access()
    // The share may have ended while the permission was being read.
    if (!this.source) return
    if (!native) return this.switchPass(false, 'unavailable')
    if (!native.trusted(true)) return this.switchPass(false, 'accessibility')
    this.switchPass(true, null)
  }

  private switchPass(on: boolean, note: PassNote | null): void {
    this.pass = on
    this.passNote = note
    this.sendToView({ type: 'pass', on })
    this.notify()
  }

  /** The native calls, loaded once. A failure (not macOS, a framework missing) is kept: the passage mode is then unavailable. */
  private access(): Promise<NativeAccess | null> {
    this.nativeAccess ??= this.deps.native().catch((error: unknown) => {
      console.warn('[window-share] the passage mode is not available:', error)
      return null
    })
    return this.nativeAccess
  }

  /**
   * Sends a click of the view to the shared window, at the point of that window under the click. The window is brought to the front first, and
   * the view back in front after the click (see docs/design/annotation-partage-fenetre.md, « Mode passage »). Nothing is sent without the Accessibility
   * permission, nor for a click outside the window.
   */
  private async clickSource(click: PassClick): Promise<void> {
    const source = this.source
    if (!source || !this.pass || this.clicking || Date.now() < this.quietUntil) return
    this.clicking = true
    try {
      const native = await this.access()
      const windowId = Number(nativeWindowId(source.id))
      const found = native && Number.isFinite(windowId) ? native.window(windowId) : null
      if (this.source !== source) return
      if (!native || !found) return this.setNote('unavailable')
      const point = sourcePoint(click, found.bounds)
      // A click in the margin of the picture, or outside the window, is not sent.
      if (!point) return
      // The permission is checked before any event is made: without it, nothing is activated and nothing is sent.
      if (!native.trusted(false)) return this.switchPass(false, 'accessibility')
      native.activate(found.pid)
      await delay(ACTIVATE_DELAY_MS)
      if (this.source !== source || !this.pass) return
      this.quietUntil = Date.now() + CLICK_QUIET_MS
      this.setNote(native.click(point) ? null : 'unavailable')
      // The view comes back in front: the presenter sees it, and clicks on it again.
      app.focus({ steal: true })
      this.view?.focus()
    } finally {
      this.clicking = false
    }
  }

  private setNote(note: PassNote | null): void {
    this.passNote = note
    this.notify()
  }

  /**
   * The windows excluded from the list: the share's own windows, and every private window. A window of the main application is listed like any
   * other: sharing the browser itself is the point of the feature.
   */
  private exclusions(): WindowExclusions {
    return {
      privateWindows: nativeIds(this.deps.privateWindows()),
      ownWindows: nativeIds([this.command, this.view])
    }
  }

  /** The screen permission of macOS, read before the list and again after it (the listing is what makes the system ask). Elsewhere there is none to read. */
  private screenStatus(): MediaStatus {
    return (this.deps.platform ?? process.platform) === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  }

  private async listSources(): Promise<{ sources: ShareSource[] } | { reason: 'permission' | 'failed' }> {
    const status = this.screenStatus()
    if (listingRefusedForPermission(status, null)) return { reason: 'permission' }
    let found: Electron.DesktopCapturerSource[]
    try {
      // No thumbnails: the list needs names and ids only, and a thumbnail costs a capture of each window.
      found = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
    } catch (error) {
      // The command window shows this reason as a message: the share does not start, and nothing else is left in a half state.
      console.warn('[window-share] the windows could not be listed:', error)
      return { reason: 'failed' }
    }
    if (listingRefusedForPermission(status === 'granted' ? status : this.screenStatus(), found.length)) return { reason: 'permission' }
    return { sources: found.map((source) => ({ id: source.id, name: source.name })) }
  }
}
