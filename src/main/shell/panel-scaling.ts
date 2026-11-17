// The size of the windows of their own (Réglages, Extensions, the task manager, À propos) on the screen they are on: the factor of the choice of that
// screen (shared/panel-scale.ts) gives the zoom of their page and multiplies their size, at their creation and again when the choice changes or
// when the window is moved to another screen. The panels that open over a window are scaled by the window itself (`Browser.overlayZoom`).
// Without Electron: the screens and the windows come in through the small interfaces below, so that the rules are tested on stand-ins.

import { centredIn, panelFactor, rescaledContent, scaledWindow, screenOf, type DisplayLike, type PanelSizes, type Rect, type ScreenInfo, type WindowSizes } from '@shared/panel-scale'
import type { StateStore } from '../store'

/** A screen as the main process sees it: what identifies it for the settings, and the part of it a window may use. */
export interface ScreenSide {
  screen: ScreenInfo
  /** The whole screen, and the part of it a window may use (the menu bar and the Dock are outside it). */
  bounds: Rect
  area: Rect
}

/** The part of Electron's `Display` the rules read. */
export interface DisplayData extends DisplayLike {
  bounds: Rect
  workArea: Rect
}

/** The part of Electron's `screen` the rules use. */
export interface ScreenApi {
  getDisplayMatching(bounds: Rect): DisplayData
  getPrimaryDisplay(): DisplayData
  getAllDisplays(): DisplayData[]
  on(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): unknown
  removeListener(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): unknown
}

/** What the rules need to ask of the screens: the screen a window is on, where a new one opens, and whether the screens changed. */
export interface Displays {
  matching(bounds: Rect): ScreenSide | null
  primary(): ScreenSide | null
  all(): ScreenSide[]
  /** Calls `listener` when a screen is added, removed or changes its size; the function it returns stops it. */
  onChange(listener: () => void): () => void
}

const sideOf = (display: DisplayData): ScreenSide | null => {
  const screen = screenOf(display)
  const rect = (r: Rect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height })
  return screen === null ? null : { screen, bounds: rect(display.bounds), area: rect(display.workArea) }
}

/** Electron's `screen` as `Displays`. */
export function electronDisplays(screen: ScreenApi): Displays {
  const events = ['display-added', 'display-removed', 'display-metrics-changed'] as const
  return {
    matching: (bounds) => sideOf(screen.getDisplayMatching(bounds)),
    primary: () => sideOf(screen.getPrimaryDisplay()),
    all: () => screen.getAllDisplays().flatMap((display) => sideOf(display) ?? []),
    onChange: (listener) => {
      for (const event of events) screen.on(event, listener)
      return () => {
        for (const event of events) screen.removeListener(event, listener)
      }
    }
  }
}

/** The part of a `BrowserWindow` the rules use. */
export interface PanelWindow {
  isDestroyed(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  getBounds(): Rect
  getContentBounds(): Rect
  setContentSize(width: number, height: number): void
  setMinimumSize(width: number, height: number): void
  on(event: 'move' | 'closed', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    getZoomFactor(): number
    setZoomFactor(factor: number): void
    on(event: 'did-navigate' | 'did-navigate-in-page' | 'did-finish-load', listener: () => void): unknown
  }
}

export interface PanelScalingDeps {
  /** The state the choices are read from, and followed while a window is open. */
  store: Pick<StateStore, 'get' | 'subscribe'>
  displays: Displays
  /** The bounds of the window the user works in, where a window made now opens; null when there is none (the primary screen then). */
  around: () => Rect | null
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
}

/** How long after a navigation the zoom of a window is looked at once more. */
export const NAVIGATED_SETTLE_MS = 100

/** How long a window that is being dragged must rest before it is looked at again (a drag across two screens would resize it twice on the way). */
export const MOVE_SETTLE_MS = 400

interface Tracked {
  win: PanelWindow
  /** What the window is at 100 %. */
  base: WindowSizes
  /** The factor its page is zoomed at and its size was multiplied by. */
  factor: number
}

/** The windows of their own, scaled. Nothing is listened to while none is open. */
export class PanelScaling {
  private readonly tracked = new Set<Tracked>()
  private release: (() => void) | null = null
  private sizes: PanelSizes | null = null

  constructor(private readonly deps: PanelScalingDeps) {}

  /** How many windows are being followed (the engine test and the unit tests read it). */
  count(): number {
    return this.tracked.size
  }

  /**
   * Makes a window of its own: `make` is given the options of the window with its size multiplied by the factor of the screen it opens on and placed in
   * the middle of that screen's work area, then the window is followed (its page zoomed, its size kept in step with the choice and with the screen it is on).
   * `base` is the window at 100 %.
   */
  open<O extends WindowSizes, W extends PanelWindow>(base: O, make: (options: O & Partial<Rect>) => W): W {
    const around = this.deps.around()
    const where = (around === null ? null : this.deps.displays.matching(around)) ?? this.deps.displays.primary()
    // No usable screen: the window opens as it always did, at 100 %.
    const factor = where === null ? 1 : this.factorOn(where, base)
    const options = where === null ? base : { ...base, ...scaledWindow(base, factor, where.area), ...centredIn(where.area, scaledWindow(base, factor, where.area)) }
    const win = make(options)
    this.follow(win, base, factor)
    return win
  }

  private factorOn(where: ScreenSide, base: WindowSizes): number {
    // What a window needs, in CSS pixels, is its smallest size: the factor is the most that still lets it be made that small in the work area.
    return panelFactor({ sizes: this.deps.store.get().settings.panelSizes, screen: where.screen, room: where.area, need: { width: base.minWidth ?? base.width, height: base.minHeight ?? base.height } })
  }

  private follow(win: PanelWindow, base: WindowSizes, factor: number): void {
    const entry: Tracked = { win, base, factor }
    this.tracked.add(entry)
    this.arm()
    // The page is zoomed once it has a document (before that there is nothing to zoom), and again at every navigation: Chromium remembers a zoom per page
    // address, so a page that moves to another (a pane chosen in Settings changes the hash) may be given the zoom of that address. The order in which Chromium's
    // observers hear of a navigation is not fixed, so it is looked at again a moment later, once they all have.
    const apply = () => this.zoom(entry)
    const navigated = () => {
      apply()
      this.deps.setTimer(apply, NAVIGATED_SETTLE_MS)
    }
    win.webContents.on('did-navigate', navigated)
    win.webContents.on('did-navigate-in-page', navigated)
    win.webContents.on('did-finish-load', apply)
    apply()
    let timer: unknown = null
    win.on('move', () => {
      if (timer !== null) this.deps.clearTimer(timer)
      timer = this.deps.setTimer(() => {
        timer = null
        this.refresh(entry)
      }, MOVE_SETTLE_MS)
    })
    win.on('closed', () => {
      if (timer !== null) this.deps.clearTimer(timer)
      this.tracked.delete(entry)
      if (this.tracked.size === 0) this.disarm()
    })
  }

  /** Listens to the choices and the screens while a window is open, and to nothing otherwise. */
  private arm(): void {
    if (this.release !== null) return
    this.sizes = this.deps.store.get().settings.panelSizes
    const stopState = this.deps.store.subscribe((state) => {
      // The choices are a small record that the reducer replaces when one changes: a change of anything else is passed over with one comparison.
      if (state.settings.panelSizes === this.sizes) return
      this.sizes = state.settings.panelSizes
      this.refreshAll()
    })
    const stopScreens = this.deps.displays.onChange(() => this.refreshAll())
    this.release = () => {
      stopState()
      stopScreens()
    }
  }

  private disarm(): void {
    this.release?.()
    this.release = null
    this.sizes = null
  }

  /** Brings every window to the factor its screen gives it now. */
  refreshAll(): void {
    for (const entry of [...this.tracked]) this.refresh(entry)
  }

  private alive(entry: Tracked): boolean {
    if (!entry.win.isDestroyed() && !entry.win.webContents.isDestroyed()) return true
    this.tracked.delete(entry)
    if (this.tracked.size === 0) this.disarm()
    return false
  }

  /** The zoom of the page: the factor, set when it is not already (a zoom set before the first document is lost, so it is set again at each load). */
  private zoom(entry: Tracked): void {
    if (!this.alive(entry)) return
    if (Math.abs(entry.win.webContents.getZoomFactor() - entry.factor) > 0.001) entry.win.webContents.setZoomFactor(entry.factor)
  }

  /** The window may have been moved to another screen, or its screen may have another choice now: the zoom, the minimum and the size follow the factor. */
  private refresh(entry: Tracked): void {
    if (!this.alive(entry)) return
    const where = this.deps.displays.matching(entry.win.getBounds()) ?? this.deps.displays.primary()
    if (where === null) return
    const factor = this.factorOn(where, entry.base)
    if (factor === entry.factor) return this.zoom(entry)
    const from = entry.factor
    entry.factor = factor
    this.zoom(entry)
    const sizes = scaledWindow(entry.base, factor, where.area)
    entry.win.setMinimumSize(sizes.minWidth, sizes.minHeight)
    // A window that fills the screen, or the whole screen, keeps its size; any other keeps its content as large in CSS pixels as it was.
    if (entry.win.isMaximized() || entry.win.isFullScreen()) return
    const next = rescaledContent(entry.win.getContentBounds(), from, factor, entry.base, where.area)
    entry.win.setContentSize(next.width, next.height)
  }
}
