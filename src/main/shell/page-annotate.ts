// The annotation directly on the page (docs/design/annotation-partage-fenetre.md, section « Annotation directe dans la page »). A
// transparent layer is put on the page on screen (the active tab of the window the user works in); when the browser window is shared, the layer
// is in the picture. The command window (a window of its own, outside the browser window) holds the tools and the mode: it is not shared when
// the browser window is. Nothing is recorded, written to disk or sent. Built by default; LUCIUM_ANNOTATE=0 turns it off, from the sources or in a
// smoke run only (main/index.ts). ⌥⌘M is the File menu's shortcut; it is held system-wide only when the user asks for it (`annotateGlobalShortcut`).
// The command window stands where the user put it (an edge of the window, or floating): its grip drags it (the page of the bar only tells where the
// pointer is, this module moves the window), and the place is kept in the settings (`annotateBar`). While it is dragged, the drop zones show along the edges of the
// window. The first time the bar opens, a hint above the grip says so (`annotateBarHintSeen`). The geometry is pure, in shared/annotate-bar.ts.

import { BrowserWindow, globalShortcut, ipcMain, Menu, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { Bounds, Page, PageKey } from '../engine/types'
import { t } from '@shared/i18n'
import { isFromSurface } from '@shared/surface-guard'
import { shutByLock } from './lock-gate'
import {
  BAR_METRICS,
  barBounds,
  barMenuEntries,
  dragBounds,
  dragStarted,
  dropZones,
  floatingAt,
  isNudgeDirection,
  nudgedPosition,
  positionForChoice,
  snapEdge,
  type BarChoice,
  type BarContent,
  type BarPoint,
  type BarSize,
  type NudgeDirection
} from '@shared/annotate-bar'
import { layoutOf, type BarEdge, type BarLayout, type BarPosition } from '@shared/annotate-bar-position'
import {
  DEFAULT_LASER_STYLE,
  DEFAULT_PAGE_BRUSH,
  PAGE_ANNOTATE_CHANNEL,
  barHue,
  canAnnotateHere,
  PAGE_SHORTCUT,
  PAGE_TOGGLE_SHORTCUT,
  injectableUrl,
  isBarDrag,
  isBarMenuAnchor,
  isPageBrush,
  isPageEdit,
  isLaserStyle,
  isPageMode,
  pageKeyAction,
  type BarDrag,
  type BarMenuAnchor,
  type LaserStyle,
  type PageAnnotateState,
  type PageBrush,
  type PageEdit,
  type PageMode,
  type PageNote
} from '@shared/page-annotate'
import { pageLayerCall, type PageLayerConfig } from '@shared/page-annotate-layer'
import { isAutoClear, type AutoClear } from '@shared/annotate-auto-clear'
import { BarGhost } from './annotate-bar-ghost'

/** The page on screen of a window, as the window shows it: its tab, the page, its address, and the media source id of the window. */
export interface PageAnnotateTarget {
  tabId: string
  page: Page
  url: string
  source: string | null
}

export interface PageAnnotateDeps {
  /** The page on screen of the window with this media source id (null: the focused window), or null when that window shows none. Read each time. */
  target(window: string | null): PageAnnotateTarget | null
  /** The media source id of the focused window of Lucium, or null. */
  focusedSource(): string | null
  /** Says a short message to the user (a refused start). */
  notice(message: string): void
  /** Calls the listener when what is on screen may have changed (a tab, a window, the focus). Returns the way to stop listening. */
  watch(listener: () => void): () => void
  /** Loads our command page (the same checks as every interface surface, see index.ts `load`). */
  load(target: WebContents, query: Record<string, string>): void
  /** The preload of the command window: the only one that talks to this module. */
  preload: string
  /** The language of the interface, given to the command window. */
  language(): string
  /** The annotation started or ended: the menu's checkmark follows it. */
  changed(): void
  /**
   * The window with this media source id (null: the focused one), and the work area of the screen it is on, in the coordinates of the screen.
   * The bar goes where its position says (an edge of that window, or a place of its own), inside that screen. Null when the window shows no page.
   */
  placement(window: string | null): { window: Bounds; area: Bounds } | null
  /** Where the user put the bar: read from the settings each time (Settings.annotateBar), so that the settings stay the one place it is kept in. */
  position(): BarPosition
  /** Remembers where the bar was put (it goes to the settings, which clean it and keep it across restarts). */
  setPosition(position: BarPosition): void
  /**
   * Whether the first-use hint above the grip was seen (Settings.annotateBarHintSeen), read when the annotation starts. Absent: the hint is never shown (a caller that
   * keeps no such memory would show it at every start).
   */
  hintSeen?(): boolean
  /** The hint was dismissed: remembers it (it goes to the settings), so that it is shown once. */
  setHintSeen?(): void
  /**
   * ⌥⌘M is to be held system-wide (Réglages › Outils web, off by default): read each time `syncToggleShortcut` runs. Absent or false, the shortcut
   * is the File menu's only (main/shell/menu.ts), and no other application loses it.
   */
  globalToggle?(): boolean
  /** Whether a window of Lucium with this media source id still exists: a shared window that was closed no longer holds the annotation to itself. */
  windowOpen?(window: string): boolean
  /**
   * The hue of the space on screen in the window with this media source id (null: the focused one), read each time the bar is told its state. The bar and the
   * preview of its drop zones take the accent of that hue. Absent or null: the hue the tokens start from.
   */
  hue?(window: string | null): number | null
  /**
   * The automatic clearing as the settings hold it (shared/annotate-auto-clear.ts `autoClearOf`): 0 while it is off, else its delay in seconds. Read each
   * time a layer is told its config and the bar its state, so that the settings stay the one place it is kept in. Absent: off.
   */
  autoClear?(): AutoClear
  /** The timer button of the bar chose a value: it goes to the settings (`autoClearPatch`), where the Settings window reads it too. */
  setAutoClear?(value: AutoClear): void
  /**
   * Whether the keys of one letter (the tools, E and X) act: the setting `annotateLetterKeys`, read each time a key is pressed and the bar is told its state,
   * so that the settings stay the one place it is kept in. Absent: they act, as they did before the setting.
   */
  letterKeys?(): boolean
  /** Lucium's « Réduire les animations » (Settings.forceReduceMotion): the marks of the automatic clearing go without a fade. Absent: as the system says. */
  reduceMotion?(): boolean
}

/** The bounds of what a layer may ask main's clock to wait (`expire`): not a busy loop, and no longer than a timer can wait. */
const CLOCK_MIN_MS = 50
const CLOCK_MAX_MS = 3_600_000

const listeners = new Set<(tabId: string, page: Page) => void>()
const shareListeners = new Set<(tabId: string, page: Page, source: string) => void>()
const requestListeners = new Set<(source: string) => void>()

/** The toolbar's button of the window with this media source id asked for the annotation (shell/ipc.ts). */
export function notifyAnnotateRequest(source: string): void {
  for (const listener of [...requestListeners]) listener(source)
}

/**
 * The page asked for the screen and the source it got is the window of Lucium it is in (engine: `sharesOwnWindow`). Electron does not say when
 * the sharing ends: the annotation started here ends on the navigation of the page, or with its Quit button, and not with the sharing.
 */
export function notifyOwnWindowShare(tabId: string, page: Page, source: string): void {
  for (const listener of [...shareListeners]) listener(tabId, page, source)
}

/**
 * The browser tells here that a page has a new document or a new address: the layer on it (if any) was made on the document before, and its
 * drawing goes with it. Every window's browser calls it; a listener that is not annotating does nothing.
 */
export function notifyPageDocument(tabId: string, page: Page): void {
  for (const listener of [...listeners]) listener(tabId, page)
}

/** A drag of the grip while it goes on: where the pointer went down, where it took the bar, the bar's size, the window and screen it is dragged in, and the edge it would land on. */
interface BarDragState {
  from: BarPoint
  grab: BarPoint
  size: BarSize
  reference: Bounds
  area: Bounds
  /** The layout the bar has when it goes down: the one it keeps when it is dropped away from the edges. */
  layout: BarLayout
  started: boolean
  target: BarEdge | null
}

export class PageAnnotate {
  private command: BrowserWindow | null = null
  private on = false
  private mode: PageMode = 'draw'
  private brush: PageBrush = DEFAULT_PAGE_BRUSH
  /** The look of the laser: kept for the session (the controller lives as long as the application). */
  private laser: LaserStyle = DEFAULT_LASER_STYLE
  /** The page on screen: the layer the command window's edits go to (the other layers keep their drawing). */
  private shown: PageAnnotateTarget | null = null
  /** The pages that hold a layer (on screen or not): a page that leaves the screen keeps its layer, and its drawing, until the document changes. */
  private layered = new Map<string, Page>()
  /** The page on screen takes no layer (its address, or the page refused it). */
  private refused = false
  /** ⌥⌘P is taken by another application: it is not held. */
  /** ⌥⌘P could not be held: `own` when the annotated share of a window, which has the same shortcut, holds it; `other` for another application. */
  private shortcutTaken: 'own' | 'other' | null = null
  private shortcutHeld = false
  /** ⌥⌘M starts and stops the annotation from any application: held only while the setting asks for it (`syncToggleShortcut`). */
  private toggleHeld = false
  /** What the setting asked for at the last `syncToggleShortcut`. */
  private toggleWanted = false
  private stopWatching: (() => void) | null = null
  private stopDocuments: (() => void) | null = null
  /** The tab whose sharing started the annotation: its navigation ends the annotation. Null when a person started it. */
  private autoTab: string | null = null
  /** The page whose keys the bar listens to (the page on screen), and how to stop listening. */
  private keysPage: Page | null = null
  private stopKeys: (() => void) | null = null
  private stopShares: () => void
  private stopRequests: () => void
  /** The window the session belongs to (its media source id): the bar and the layer are that window's. Null when no session runs. */
  private window: string | null = null
  /**
   * The window that was shared (the source of the last sharing of a page of Lucium), or null: then any window may start the annotation. Forgotten
   * when the sharing is over (the page that shared has a new document) or the window is closed.
   */
  private sharedWindow: string | null = null
  /** The tab whose page shared `sharedWindow`: its next document ends that sharing (Electron does not say when a capture stops). */
  private sharedTab: string | null = null
  private stopShareDocuments: () => void
  /** The bar is hidden because the focus is in another window. */
  private barHidden = false
  /** Where the command window stands now (the last bounds given to it): null before it is placed. A drag starts from here. */
  private bounds: Bounds | null = null
  /** The position `place` last used (its JSON): a change of the settings that is not a move of the bar does not place it again. */
  private placedPosition = ''
  /** A drag of the grip that is going on, and what it shows over the window: the drop zones, the one the pointer is in, and the outline of where the bar lands. */
  private drag: BarDragState | null = null
  private ghost: BarGhost | null = null
  /** The first-use hint is shown above the grip: set when the annotation starts and the hint was not seen yet, until it is dismissed or the annotation ends. */
  private hint = false
  /** The automatic clearing the layers were last told (its delay and whether it fades): a change of the settings that is not this one tells them nothing. */
  private autoClearTold = ''
  /** Whether the bar was last told that the letter keys act: a change of the settings that is not this one tells it nothing. */
  private lettersTold = true
  /**
   * The clocks of the automatic clearing, one per page that holds a layer, while the clearing is on: when each asks its layer whether the delay ran out
   * (`expire`). They are main's, out of reach of the pages: the layer only keeps the time of the last activity, which it alone sees.
   */
  private clocks = new Map<Page, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: PageAnnotateDeps) {
    this.stopShares = addShareListener((tabId, page, source) => this.ownWindowShared(tabId, page, source))
    this.stopRequests = addRequestListener((source) => this.requested(source))
    // The page that shared a window navigated or reloaded: its capture is over with its document, and any window may annotate again.
    this.stopShareDocuments = addDocumentListener((tabId) => {
      if (this.sharedTab !== null && tabId === this.sharedTab) this.forgetShare('the page that shared it has a new document')
    })
    this.syncToggleShortcut()
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.state, (event: IpcMainInvokeEvent): PageAnnotateState | null => (this.fromCommand(event) ? this.snapshot() : null))
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.brush, (event: IpcMainInvokeEvent, brush: unknown): void => {
      if (this.fromCommand(event) && isPageBrush(brush)) this.setBrush(brush)
    })
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.mode, (event: IpcMainInvokeEvent, mode: unknown): void => {
      if (this.fromCommand(event) && isPageMode(mode)) this.setMode(mode)
    })
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.edit, (event: IpcMainInvokeEvent, command: unknown): void => {
      if (this.fromCommand(event) && isPageEdit(command)) this.edit(command)
    })
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.laser, (event: IpcMainInvokeEvent, style: unknown): void => {
      if (this.fromCommand(event) && isLaserStyle(style)) this.setLaser(style)
    })
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.stop, (event: IpcMainInvokeEvent): void => {
      if (this.fromCommand(event)) this.stop()
    })
    // The grip of the bar: its drag (a stream of pointer positions, sent not asked), the menu of the positions, and the arrow keys.
    ipcMain.on(PAGE_ANNOTATE_CHANNEL.drag, (event: IpcMainEvent, drag: unknown): void => {
      if (this.fromCommand(event) && isBarDrag(drag)) this.dragged(drag)
    })
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.menu, (event: IpcMainInvokeEvent, anchor: unknown): void => {
      if (this.fromCommand(event) && isBarMenuAnchor(anchor)) this.showPositionMenu(anchor)
    })
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.nudge, (event: IpcMainInvokeEvent, direction: unknown, large: unknown): void => {
      if (this.fromCommand(event) && isNudgeDirection(direction) && typeof large === 'boolean') this.nudge(direction, large)
    })
    // « OK » or Escape on the first-use hint.
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.hint, (event: IpcMainInvokeEvent): void => {
      if (this.fromCommand(event)) this.dismissHint()
    })
    // The timer button: off, or one of the delays of the list, and nothing else.
    ipcMain.handle(PAGE_ANNOTATE_CHANNEL.autoClear, (event: IpcMainInvokeEvent, value: unknown): void => {
      if (this.fromCommand(event) && isAutoClear(value)) this.setAutoClear(value)
    })
  }

  isOn(): boolean {
    return this.on
  }

  /**
   * Whether the annotation runs, or a page of Lucium shares one of its windows: as far as it can be known, since Electron does not say when a capture
   * stops (until that page has a new document, `sharedWindow`). The notice of an update waits meanwhile (auto-update.ts).
   */
  isPresenting(): boolean {
    return this.on || this.sharedWindow !== null
  }

  /** Ends the annotation and stops listening to the sharings: the controller is not used afterwards (the tests make one per case). */
  dispose(): void {
    this.stop()
    this.stopShares()
    this.stopRequests()
    this.stopShareDocuments()
    if (this.toggleHeld) globalShortcut.unregister(PAGE_TOGGLE_SHORTCUT)
    this.toggleHeld = false
  }

  /**
   * Holds ⌥⌘M system-wide while the setting asks for it, and releases it as soon as it does not: called at the
   * start and on every change of the settings. Taken by another application: the File menu and the bar still work.
   */
  syncToggleShortcut(): void {
    const wanted = this.deps.globalToggle?.() === true
    // Asked once per change of the setting: a shortcut another application holds is not asked for again at every change of the state.
    if (wanted === this.toggleWanted) return
    this.toggleWanted = wanted
    if (!wanted) {
      if (this.toggleHeld) globalShortcut.unregister(PAGE_TOGGLE_SHORTCUT)
      this.toggleHeld = false
      return
    }
    this.toggleHeld = globalShortcut.register(PAGE_TOGGLE_SHORTCUT, () => this.toggle())
    if (!this.toggleHeld) console.warn(`[page-annotate] ${PAGE_TOGGLE_SHORTCUT} is taken by another application: the annotation starts from the File menu only.`)
  }

  /** The sharing of `sharedWindow` is over: any window may start the annotation again. */
  private forgetShare(why: string): void {
    if (this.sharedWindow === null) return
    console.info(`[annotate-share] partage termine (${why}) : fenetre=${this.sharedWindow}`)
    this.sharedWindow = null
    this.sharedTab = null
  }

  /** A shared window that was closed holds the annotation to itself no longer. */
  private dropClosedShare(): void {
    if (this.sharedWindow !== null && this.deps.windowOpen && !this.deps.windowOpen(this.sharedWindow)) this.forgetShare('its window was closed')
  }

  /** The File menu entry: starts the annotation, or ends it when it runs. */
  toggle(): void {
    if (this.on) this.stop()
    else this.start()
  }

  /**
   * Starts the annotation in the focused window (⌥⌘M, the bar's button, the File menu). Refused, with a notice, when a window is shared and the
   * focused one is not that window.
   */
  start(): void {
    if (this.on) return
    const source = this.deps.focusedSource()
    this.dropClosedShare()
    if (!canAnnotateHere(source, this.sharedWindow)) {
      this.deps.notice(t('page-annotate.partager-cette-fenetre'))
      return
    }
    this.begin(source)
  }

  /**
   * The toolbar's button of a window: it ends the annotation when one runs (as ⌥⌘M), else it starts it in that window, under the same rule as
   * `start` (the shared window, or any window when none is shared).
   */
  private requested(source: string): void {
    if (this.on) {
      this.stop()
      return
    }
    this.dropClosedShare()
    if (!canAnnotateHere(source, this.sharedWindow)) {
      this.deps.notice(t('page-annotate.partager-cette-fenetre'))
      return
    }
    this.begin(source)
  }

  private begin(source: string | null): void {
    this.on = true
    this.window = source
    this.autoClearTold = this.autoClearKey()
    this.lettersTold = this.letterKeys()
    // The first time the bar opens (the hint was not dismissed yet), a bubble above the grip says where to take it.
    this.hint = this.deps.hintSeen ? !this.deps.hintSeen() : false
    this.stopWatching = this.deps.watch(() => this.sync())
    this.stopDocuments = addDocumentListener((tabId, page) => this.documentChanged(tabId, page))
    this.holdShortcut()
    this.openCommand()
    this.sync()
    this.deps.changed()
  }

  /**
   * The page of the tab that asked for the sharing of a window is on screen in that window: the annotation starts on it, in that window. A
   * session that runs in another window moves to the shared one. A page not on screen is not drawn on.
   */
  private ownWindowShared(tabId: string, page: Page, source: string): void {
    this.sharedWindow = source
    this.sharedTab = tabId
    console.info(`[annotate-share] fenetre partagee: onglet=${tabId} fenetre=${source} annotation=${this.on ? 'en cours' : 'arretee'}`)
    if (this.on) {
      if (this.window === source) return
      this.stop()
    }
    const current = this.deps.target(source)
    if (!current || current.tabId !== tabId || current.page !== page) {
      console.info(`[annotate-share] la page partagee n'est pas affichee dans sa fenetre : pas d'annotation lancee, le bouton reste visible`)
      return
    }
    this.autoTab = tabId
    this.begin(source)
  }

  /** Ends the annotation: every layer is taken off its page, the shortcut is released, and the command window closes. Also called at the lock. */
  stop(): void {
    if (!this.on) return
    this.on = false
    this.autoTab = null
    this.stopKeys?.()
    this.stopKeys = null
    this.keysPage = null
    this.window = null
    this.abortDrag()
    this.bounds = null
    for (const page of this.layered.values()) this.tell(page, pageLayerCall('remove'))
    this.layered.clear()
    this.stopClocks()
    this.shown = null
    this.refused = false
    this.shortcutTaken = null
    this.stopWatching?.()
    this.stopWatching = null
    this.stopDocuments?.()
    this.stopDocuments = null
    if (this.shortcutHeld) globalShortcut.unregister(PAGE_SHORTCUT)
    this.shortcutHeld = false
    const command = this.command
    this.command = null
    if (command && !command.isDestroyed()) command.close()
    this.deps.changed()
  }

  /** Brings the layer on screen to the page now shown, and hides the one that left the screen. Called when the window, the tab or the focus changes. */
  sync(): void {
    if (!this.on) return
    // The page on screen of the session's window: the layer stays on it while another window has the focus (the bar does not).
    const next = this.deps.target(this.window)
    const wanted = next && injectableUrl(next.url) ? next : null
    // A page with an address that takes no layer is said so now; a page that takes one is judged when its layer is made (keep, mount).
    this.refused = next !== null && wanted === null
    if (this.shown && (!wanted || this.shown.page !== wanted.page)) {
      this.tell(this.shown.page, pageLayerCall('hide'))
      this.shown = null
    }
    if (wanted && this.shown?.page !== wanted.page) void this.show(wanted)
    this.listenKeys(this.shown?.page ?? null)
    // The bar follows the window: publishing places it (a change of the buttons it shows changes its size as well).
    this.publish()
  }

  /** The bar listens to the keys of the page on screen only: a page left takes its keys with it. */
  private listenKeys(page: Page | null): void {
    if (this.keysPage === page) return
    this.stopKeys?.()
    this.keysPage = page
    this.stopKeys = page?.watchInput?.((key) => this.key(key)) ?? null
  }

  /**
   * A key pressed in the page on screen. The tool letters are taken in draw mode only, and not while the page has a field or a text box has the
   * focus: then the key is the typing of that field. The page still gets the key (it cannot be stopped here, the answer comes after): see the docs.
   */
  private key(key: PageKey): void {
    if (!this.on) return
    const action = pageKeyAction(key, this.mode, this.letterKeys())
    const page = this.shown?.page
    if (!action || !page) return
    void this.editing(page).then((editing) => {
      if (!this.on || editing) return
      if (action.kind === 'tool') this.setBrush({ ...this.brush, tool: action.tool })
      else if (action.kind === 'edit') this.edit(action.command)
      // Escape closes the hint first, when it is shown: the annotation ends with the next one.
      else if (this.hint) this.dismissHint()
      else this.stop()
    })
  }

  /**
   * Whether the keys belong to a field now (the layer's `editing`). A page that cannot say (it went away, it has no world for the layer) counts
   * as yes: the key is left alone, and the failure is logged.
   */
  private async editing(page: Page): Promise<boolean> {
    try {
      return page.runAnnotateLayer ? (await page.runAnnotateLayer(pageLayerCall('editing'))) === true : true
    } catch (error) {
      console.warn('[page-annotate] the layer could not say whether a field has the keys:', error)
      return true
    }
  }

  /** What changes the size of the bar: the looks of the laser while it is the tool, the note of a page that takes no layer, and the first-use hint. */
  private content(): BarContent {
    return { laser: this.brush.tool === 'laser', note: this.currentNote() !== null, hint: this.hint }
  }

  /**
   * The hint is gone and remembered as seen: without telling the bar, which the caller does (it places the window for what it shows, so it is the one `publish`
   * that follows). False when there was none.
   */
  private forgetHint(): boolean {
    if (!this.hint) return false
    this.hint = false
    this.deps.setHintSeen?.()
    return true
  }

  /** « OK », Escape: the hint closes, the bar is made the size it has without it. */
  private dismissHint(): void {
    if (this.forgetHint()) this.publish()
  }

  /**
   * The bar goes where its position says (`Deps.position`): an edge of the page on screen, or a place of its own in it. It follows the window on each
   * change that reaches here, and is made the size its layout asks for.
   */
  private place(): void {
    const command = this.command
    if (!command || command.isDestroyed()) return
    // The bar stays above the shared window for the whole session, whatever has the focus (it is a floating window of its own, outside the
    // shared content). It is hidden only when the window shows no page to annotate, and shown again when one is back.
    const at = this.deps.placement(this.window)
    if (!at) {
      this.abortDrag()
      if (!this.barHidden) {
        command.hide()
        this.barHidden = true
        console.info(`[annotate-share] barre: masquee (fenetre ${this.window ?? 'au premier plan'} sans page affichee)`)
      }
      return
    }
    // While the grip is dragged the bar is where the pointer takes it; it goes back to its position when the drag ends.
    if (this.drag?.started) return
    const position = this.deps.position()
    this.placedPosition = JSON.stringify(position)
    const bounds = barBounds(position, this.content(), at.window, at.area)
    if (!this.bounds || this.bounds.x !== bounds.x || this.bounds.y !== bounds.y || this.bounds.width !== bounds.width || this.bounds.height !== bounds.height) {
      command.setBounds(bounds)
      this.bounds = bounds
    }
    if (this.barHidden) {
      command.show()
      this.barHidden = false
      console.info(`[annotate-share] barre: affichee fenetre=${this.window ?? 'au premier plan'} x=${bounds.x} y=${bounds.y} largeur=${bounds.width} hauteur=${bounds.height} ecran=${at.area.x},${at.area.y} ${at.area.width}x${at.area.height}`)
    }
  }

  /**
   * The settings changed: when the automatic clearing is no longer the one the layers were told (the timer button, the Settings window, a restore), every
   * layer takes the new delay and the bar shows it. Any other change tells them nothing: an `apply` is activity on the page on screen.
   */
  refreshAutoClear(): void {
    if (!this.on) return
    const now = this.autoClearKey()
    if (now === this.autoClearTold) return
    this.autoClearTold = now
    this.applyToLayers()
    this.publish()
    // Each layer is asked at once: it alone knows how much of the new delay is left.
    this.stopClocks()
    for (const page of this.layered.values()) this.wind(page, 0)
  }

  /** Starts the clock of a page (again): it asks the layer after `wait` milliseconds. Nothing while the clearing is off or the session is over. */
  private wind(page: Page, wait: number): void {
    this.dropClock(page)
    if (!this.on || this.autoClear() === 0) return
    this.clocks.set(page, setTimeout(() => void this.tick(page), wait))
  }

  private dropClock(page: Page): void {
    const running = this.clocks.get(page)
    if (running !== undefined) clearTimeout(running)
    this.clocks.delete(page)
  }

  private stopClocks(): void {
    for (const running of this.clocks.values()) clearTimeout(running)
    this.clocks.clear()
  }

  /**
   * The clock of a page ran out: its layer clears the marks if the delay has passed since the last activity (or fades them first), and says when to ask
   * again. A layer that is gone (the page went away, its document changed) ends the clock; one that comes back starts it again (`keep`). The answer is
   * the layer's, run in its own world, and is bounded all the same.
   */
  private async tick(page: Page): Promise<void> {
    this.clocks.delete(page)
    if (!this.on || ![...this.layered.values()].includes(page)) return
    let wait: unknown
    try {
      wait = page.runAnnotateLayer ? await page.runAnnotateLayer(pageLayerCall('expire')) : false
    } catch (error) {
      console.warn('[page-annotate] the layer could not say whether its marks are to be cleared; its clock stops:', error)
      return
    }
    // A clock started again meanwhile (a new delay, the page back on screen) has the last word.
    if (this.clocks.has(page) || !this.on || ![...this.layered.values()].includes(page)) return
    if (typeof wait === 'number' && Number.isFinite(wait) && wait > 0) this.wind(page, Math.min(Math.max(wait, CLOCK_MIN_MS), CLOCK_MAX_MS))
  }

  /** The timer button chose a value: the settings keep it, and the layers and the bar follow (here, should the settings say nothing back). */
  private setAutoClear(value: AutoClear): void {
    this.deps.setAutoClear?.(value)
    this.refreshAutoClear()
  }

  private autoClear(): AutoClear {
    return this.deps.autoClear?.() ?? 0
  }

  private letterKeys(): boolean {
    return this.deps.letterKeys?.() !== false
  }

  /** The settings changed: the bar names the letters of its tools again (or no longer) when the setting of the letter keys was changed. */
  refreshLetterKeys(): void {
    if (!this.on || this.letterKeys() === this.lettersTold) return
    this.lettersTold = this.letterKeys()
    this.publish()
  }

  private autoClearKey(): string {
    return `${this.autoClear()}:${this.deps.reduceMotion?.() === true}`
  }

  /** The settings changed: the bar moves when its position is no longer the one it was placed with (the settings are restored, or changed elsewhere). */
  refreshPosition(): void {
    if (!this.on || JSON.stringify(this.deps.position()) === this.placedPosition) return
    this.publish()
  }

  /** The grip told where the pointer is: the drag it starts, follows, and ends. */
  private dragged(drag: BarDrag): void {
    const pointer = { x: drag.x, y: drag.y }
    if (drag.phase === 'start') this.beginDrag(pointer)
    else if (drag.phase === 'move') this.moveDrag(pointer)
    else this.endDrag(drag.phase === 'end' ? pointer : null)
  }

  private beginDrag(pointer: BarPoint): void {
    if (!this.on || !this.bounds) return
    const at = this.deps.placement(this.window)
    if (!at) return
    this.endDrag(null)
    const { x, y, width, height } = this.bounds
    this.drag = { from: pointer, grab: { x: pointer.x - x, y: pointer.y - y }, size: { width, height }, reference: at.window, area: at.area, layout: layoutOf(this.deps.position()), started: false, target: null }
  }

  /**
   * The bar follows the pointer, kept inside the window and the screen. Over the window the four drop zones show along its edges, faint; the one the pointer is
   * in is lit, with the outline of where the bar would land.
   */
  private moveDrag(pointer: BarPoint): void {
    const drag = this.drag
    const command = this.command
    if (!drag || !command || command.isDestroyed()) return
    // A click on the grip moves nothing: the drag starts once the pointer has gone a few points away, and the zones show.
    if (!drag.started) {
      if (!dragStarted(drag.from, pointer)) return
      drag.started = true
      this.ghost = new BarGhost()
      this.ghost.open(drag.reference, dropZones(drag.reference), this.hue())
      // The overlay is shown in front of the bar's window, which is brought back above it.
      command.moveTop()
    }
    const bounds = dragBounds(pointer, drag.grab, drag.size, drag.reference, drag.area)
    command.setBounds(bounds)
    this.bounds = bounds
    const target = snapEdge(pointer, drag.reference)
    if (target === drag.target) return
    drag.target = target
    // The outline is where the bar lands, so without the hint: it is dismissed with the drop (`endDrag`).
    this.ghost?.target(target, target === null ? null : barBounds({ kind: 'edge', edge: target }, { ...this.content(), hint: false }, drag.reference, drag.area))
  }

  /** Forgets the drag and its outline, and puts nothing anywhere. */
  private abortDrag(): void {
    this.drag = null
    this.ghost?.dispose()
    this.ghost = null
  }

  /**
   * The end of a drag. `drop` is the pointer when the grip was let go: near an edge the bar goes on that edge, elsewhere it floats where it is.
   * Null: the drag is abandoned (the pointer was taken away), and the bar goes back to where its position says. A click on the
   * grip (a drag that never started) changes nothing.
   */
  private endDrag(drop: BarPoint | null): void {
    const drag = this.drag
    this.abortDrag()
    if (!drag) return
    // A click on the grip (the pointer never went far) moved nothing. A drag taken away put the window under the pointer: it goes back to its position.
    if (!drag.started) return
    // The bar was taken where it was meant to be taken: the hint, if it was shown, has done its work (and the window is made for what it shows from now on).
    const hinted = this.forgetHint()
    if (drop === null) {
      if (hinted) this.publish()
      else this.place()
      return
    }
    const edge = snapEdge(drop, drag.reference)
    this.commit(edge ? { kind: 'edge', edge } : floatingAt(dragBounds(drop, drag.grab, drag.size, drag.reference, drag.area), drag.reference, drag.layout))
  }

  /** Keeps a position the user chose: the settings remember it (what they are given is already clean, and they clean it again), and the bar goes there. */
  private commit(position: BarPosition): void {
    this.deps.setPosition(position)
    this.publish()
  }

  /** The menu « Position de la barre »: the edges and « Flottante », the current one checked. */
  private showPositionMenu(anchor: BarMenuAnchor): void {
    const command = this.command
    if (!command || command.isDestroyed() || this.drag?.started) return
    // The hint stays while the menu is open: closing it would change the size of the window, and the place the menu opens at, under the pointer.
    const template: MenuItemConstructorOptions[] = barMenuEntries(this.deps.position()).map((entry): MenuItemConstructorOptions => {
      if (entry.kind === 'separator') return { type: 'separator' }
      if (entry.kind === 'title') return { label: entry.label, enabled: false }
      return { label: entry.label, type: 'checkbox', checked: entry.checked, click: () => this.chose(entry.choice) }
    })
    Menu.buildFromTemplate(template).popup({ window: command, ...(anchor ? { x: Math.round(anchor.x), y: Math.round(anchor.y) } : {}) })
  }

  /** A choice of the menu: an edge, or « Flottante » where the bar is now. */
  private chose(choice: BarChoice): void {
    const at = this.on ? this.deps.placement(this.window) : null
    if (!at || !this.bounds) return
    // A position chosen in the menu is the bar placed by the user: the hint is done with.
    const hinted = this.forgetHint()
    const current = this.deps.position()
    const next = positionForChoice(choice, current, this.bounds, at.window)
    if (JSON.stringify(next) !== JSON.stringify(current)) this.commit(next)
    else if (hinted) this.publish()
  }

  /** An arrow key on the grip: a floating bar moves a step (the key does nothing to a bar on an edge). */
  private nudge(direction: NudgeDirection, large: boolean): void {
    const at = this.on && !this.drag?.started ? this.deps.placement(this.window) : null
    if (!at) return
    // The grip is used by the keyboard: the hint is done with, whether or not the bar moves.
    const hinted = this.forgetHint()
    const current = this.deps.position()
    const next = nudgedPosition(current, direction, large, this.content(), at.window, at.area)
    if (JSON.stringify(next) !== JSON.stringify(current)) this.commit(next)
    else if (hinted) this.publish()
  }

  setMode(mode: PageMode): void {
    this.mode = mode
    this.applyToLayers()
    this.publish()
  }

  setBrush(brush: PageBrush): void {
    this.brush = brush
    this.applyToLayers()
    this.publish()
  }

  /**
   * An edit of the drawing: undo, redo or clear act on the page on screen; the other pages keep their drawing. `clear-all` clears every page
   * of the session (each page keeps its own history, so ⌘Z restores a page only when it is on screen).
   */
  edit(command: PageEdit): void {
    if (command === 'clear-all') {
      for (const page of this.layered.values()) this.tell(page, pageLayerCall('clear'))
      return
    }
    if (this.shown) this.tell(this.shown.page, pageLayerCall(command))
  }

  /**
   * The document of a page changed (a navigation, a reload, a new page): its layer, if it has one, was made on the old document and is erased.
   * The page on screen gets an empty layer at once; another page loses its layer, and gets one again when it comes on screen.
   */
  private documentChanged(tabId: string, page: Page): void {
    if (!this.on) return
    // A page that started the annotation by sharing leaves it when it navigates: the sharing it was for is over with its page.
    if (this.autoTab === tabId) {
      this.stop()
      return
    }
    if (this.shown?.page === page) {
      void this.mount(this.shown)
    } else if (this.layered.get(tabId) === page) {
      this.layered.delete(tabId)
      this.dropClock(page)
      this.tell(page, pageLayerCall('remove'))
    }
  }

  /** Shows the layer of a page: the one it has (its drawing is kept), or a new one. A page that takes neither gets the note. */
  private async show(target: PageAnnotateTarget): Promise<void> {
    this.shown = target
    if (await this.ask(target.page, pageLayerCall('show', this.layerConfig()))) this.keep(target)
    else await this.mount(target)
  }

  /** A new layer on the page, empty: the page's document is new, or its layer is gone. */
  private async mount(target: PageAnnotateTarget): Promise<void> {
    if (await this.ask(target.page, pageLayerCall('mount', this.layerConfig()))) {
      this.keep(target)
      return
    }
    // The page on screen takes no layer: the note says so. Another page, left while its layer was made, has nothing to say.
    if (this.shown?.page === target.page) {
      this.shown = null
      this.refused = true
      this.publish()
    }
  }

  /**
   * A layer is on the page now. It is recorded, so that it is erased or taken away later, even when the page left the screen while it was made
   * (it is then hidden), or the annotation ended meanwhile (it is then taken away at once): no layer is left on a page without a session.
   */
  private keep(target: PageAnnotateTarget): void {
    if (!this.on) {
      this.tell(target.page, pageLayerCall('remove'))
      return
    }
    this.layered.set(target.tabId, target.page)
    // The clock of the page, asked at once: a layer just made has nothing to clear, one shown again knows what is left of its delay.
    if (!this.clocks.has(target.page)) this.wind(target.page, 0)
    if (this.shown?.page === target.page) {
      this.refused = false
      this.publish()
    } else {
      this.tell(target.page, pageLayerCall('hide'))
    }
  }

  /**
   * Runs a call of the layer in its own world of the page (`Page.runAnnotateLayer`), never in the page's: the scripts of the page read neither the
   * drawing nor what is typed in it. True when the layer did the action. A page that has no such world takes no layer; a call that fails (the
   * page went away, the script threw) is logged, and counts as not done.
   */
  private async ask(page: Page, call: string): Promise<boolean> {
    try {
      if (!page.runAnnotateLayer) return false
      return (await page.runAnnotateLayer(call)) === true
    } catch (error) {
      console.warn('[page-annotate] the layer could not run in its page:', error)
      return false
    }
  }

  /** Sends a call to the layer of a page whose answer nothing waits for (hide, remove, an edit, the brush): a failure is logged, as for `ask`. */
  private tell(page: Page, call: string): void {
    void this.ask(page, call)
  }

  private layerConfig(): PageLayerConfig {
    return { mode: this.mode, brush: this.brush, laser: this.laser, autoClear: this.autoClear() * 1000, still: this.deps.reduceMotion?.() === true }
  }

  /** The look of the laser: the layers take it at once, and the bar shows it. */
  setLaser(style: LaserStyle): void {
    this.laser = style
    this.applyToLayers()
    this.publish()
  }

  private applyToLayers(): void {
    for (const page of this.layered.values()) this.tell(page, pageLayerCall('apply', this.layerConfig()))
  }

  /**
   * ⌥⌘P switches between drawing and passing through, while the annotation runs. It may not be held, and the state says by whom:
   * `isRegistered` only knows the shortcuts of this application, so a yes is the annotated share of a window (the same shortcut), and a
   * registration that fails is another application.
   */
  private holdShortcut(): void {
    if (globalShortcut.isRegistered(PAGE_SHORTCUT)) {
      this.shortcutTaken = 'own'
      return
    }
    this.shortcutHeld = globalShortcut.register(PAGE_SHORTCUT, () => this.setMode(this.mode === 'draw' ? 'pass' : 'draw'))
    this.shortcutTaken = this.shortcutHeld ? null : 'other'
  }

  private openCommand(): void {
    const win = new BrowserWindow({
      // The size of a column: `place` gives the bar the size of its layout, right after (before the window is shown).
      width: BAR_METRICS.column.width,
      height: BAR_METRICS.column.height,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      show: false,
      title: t('page-annotate.titre-commande'),
      // The first click on the bar works while the window is not active: on macOS it would otherwise only activate the window.
      acceptFirstMouse: true,
      webPreferences: { preload: this.deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
    })
    // Floating: the bar stays over the page when the browser window is clicked (it is not in the browser window's picture, see the design).
    win.setAlwaysOnTop(true, 'floating')
    this.command = win
    this.bounds = null
    win.once('ready-to-show', () => win.show())
    // Closing the command window ends the annotation: nothing is left drawn without its controls.
    win.on('closed', () => {
      this.command = null
      this.stop()
    })
    this.deps.load(win.webContents, { lang: this.deps.language() })
  }

  private fromCommand(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): boolean {
    return isFromSurface(event, this.command) && !shutByLock('the annotation bar')
  }

  /** The note the bar shows: the shortcut that is not held first (and by whom), then a page that takes no layer. */
  private currentNote(): PageNote {
    return this.shortcutTaken === 'own' ? 'shortcut-own' : this.shortcutTaken === 'other' ? 'shortcut' : this.refused ? 'refused' : null
  }

  private snapshot(): PageAnnotateState {
    return { on: this.on, mode: this.mode, brush: this.brush, note: this.currentNote(), laser: this.laser, layout: this.layout(), hint: this.hint, hue: this.hue(), autoClear: this.autoClear(), letterKeys: this.letterKeys() }
  }

  /** The hue of the space on screen in the annotated window: the accent of the bar and of its drop zones. */
  private hue(): number {
    return barHue(this.deps.hue?.(this.window))
  }

  /** How the bar is laid out where it stands (the page draws the layout, main sizes the window for it). */
  private layout(): BarLayout {
    return layoutOf(this.deps.position())
  }

  private publish(): void {
    const command = this.command
    if (!command || command.isDestroyed()) return
    // What the bar shows sets its size and where it stands (the looks of the laser, the note, the layout): the window is placed before the page is told.
    this.place()
    command.webContents.send(PAGE_ANNOTATE_CHANNEL.state, this.snapshot())
  }
}

function addDocumentListener(listener: (tabId: string, page: Page) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function addRequestListener(listener: (source: string) => void): () => void {
  requestListeners.add(listener)
  return () => void requestListeners.delete(listener)
}

function addShareListener(listener: (tabId: string, page: Page, source: string) => void): () => void {
  shareListeners.add(listener)
  return () => void shareListeners.delete(listener)
}
