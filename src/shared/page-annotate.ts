// Annotation directly on the page of a tab (docs/design/annotation-partage-fenetre.md, section « Annotation directe dans la page »). The page itself
// carries a transparent layer (shared/page-annotate-layer.ts): when the browser window is shared, the layer is in the picture. This file is pure:
// the names the channels use, the checks of what the command window sends, and the rule of which addresses take a layer.
// On by default, like the window share: the development variable LUCIUM_ANNOTATE=0 turns it off, from the sources or in a smoke run only (main/index.ts,
// main/runtime.ts `dropDevelopmentEnv`).

import type { AutoClear } from './annotate-auto-clear'
import type { BarLayout, NudgeDirection } from './annotate-bar'
import { annotateShareEnabled } from './window-share'
import { DRAW_COLORS, DRAW_WIDTHS, type Brush } from './window-share-draw'

/** The shortcut that switches between drawing and passing through the page (⌥⌘P), held while a page is annotated. */
export const PAGE_SHORTCUT = 'Alt+CmdOrCtrl+P'
/**
 * The shortcut that starts and stops the annotation of the page (⌥⌘M). It is the accelerator of File › Annoter cette page, heard while Lucium is
 * in front (a system-wide ⌥⌘M took « Réduire toutes les fenêtres » from every application). Only with the
 * setting `annotateGlobalShortcut` on is it held system-wide (main/shell/page-annotate.ts), and the menu then shows it without binding it, so
 * that one press never starts the annotation twice. Not ⌥⌘P, which switches the mode of a running annotation.
 */
export const PAGE_TOGGLE_SHORTCUT = 'Alt+CmdOrCtrl+M'

/**
 * The tools of the layer. The selection of the window share is not one of them: a page layer only draws, erases and writes. The laser and the
 * pointer are for the audience: they show a place and keep nothing (no element, no history, gone with the pointer or after a moment).
 */
export const PAGE_TOOLS = ['pen', 'highlighter', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'eraser', 'laser', 'pointer'] as const
export type PageTool = (typeof PAGE_TOOLS)[number]

/** `draw`: the layer takes the pointer and the drawing goes on the page. `pass`: the layer lets every click through to the page. */
export const PAGE_MODES = ['draw', 'pass'] as const
export type PageMode = (typeof PAGE_MODES)[number]

/** The brush of the page layer: the same colours and thicknesses as the window share, and the tools above. */
export type PageBrush = Omit<Brush, 'tool'> & { tool: PageTool }
export const DEFAULT_PAGE_BRUSH: PageBrush = { tool: 'pen', color: '#e53935', width: 5 }

/** The commands the command window sends to main, and the edits of the page it may ask for. */
/** `clear`: the marks of the page on screen. `clear-all`: the marks of every page of the session. Both are undone page by page (⌘Z on a page). */
export const PAGE_EDITS = ['undo', 'redo', 'clear', 'clear-all'] as const
export type PageEdit = (typeof PAGE_EDITS)[number]

/** Why the layer is not on the page on screen: the address takes none, or the page refused it, or the shortcut is held by another application. */
export type PageNote = 'refused' | 'shortcut' | 'shortcut-own' | null

/** What the command window shows: whether the annotation is on, the mode, the brush, and the note. */
export interface PageAnnotateState {
  on: boolean
  mode: PageMode
  brush: PageBrush
  note: PageNote
  /** The look of the laser, kept for the session (the bar shows its choice while the laser is the tool). */
  laser: LaserStyle
  /** How the bar is laid out where it stands: a column on a side edge, a row on the top or bottom one, the layout it was dropped with when floating (shared/annotate-bar.ts). */
  layout: BarLayout
  /** The first-use hint (« Astuce : glissez la poignée… ») is shown above the grip: until « OK », Escape, or the first use of the grip or of its menu (see `annotateBarHintSeen`). */
  hint: boolean
  /** The hue of the space on screen in the annotated window (0..359): the bar takes it as its `--hue`, so its accent is the one of that space, as in the window itself. */
  hue: number
  /** The automatic clearing (shared/annotate-auto-clear.ts): 0 while it is off, else its delay in seconds. The bar's timer button shows it and changes it. */
  autoClear: AutoClear
  /**
   * The keys of one letter (the tools, E and X) act: the setting `annotateLetterKeys`, on by default. Off, the bar does not name them and the page keeps
   * them (the keys with ⌘ or ⌥, and Escape, stay).
   */
  letterKeys: boolean
}

/** The hue the tokens start from (tokens.css `--hue`): the one of a bar that was told none. */
export const DEFAULT_BAR_HUE = 250

/** A hue as the tokens take it: a whole number from 0 to 359. Anything else is the hue the tokens start from. */
export function barHue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360 ? Math.round(value) % 360 : DEFAULT_BAR_HUE
}

/**
 * The three looks of the laser (docs/design/annotation-partage-fenetre.md, « Laser et pointeur »; the sizes are in
 * shared/page-annotate-layer.ts, which keeps the same names). `net`: a solid point with a white rim and a highlight, a 2-3 px trail, a fade of 0.9 s,
 * and the point stays where the pointer stopped; `discret`: a small point, no marked halo, a 1.2-1.5 px trail that fades fast (0.55 s); `lumiere`: a
 * white point in a coloured halo and a soft glow, for dark backgrounds (1 s).
 */
export const LASER_STYLES = ['net', 'discret', 'lumiere'] as const
export type LaserStyle = (typeof LASER_STYLES)[number]
export const DEFAULT_LASER_STYLE: LaserStyle = 'lumiere'
export function isLaserStyle(raw: unknown): raw is LaserStyle {
  return (LASER_STYLES as readonly unknown[]).includes(raw)
}

/** The channels between the command window (its preload) and the main process. */
export const PAGE_ANNOTATE_CHANNEL = {
  /** Main to the command window: the state, after each change. */
  state: 'page-annotate:state',
  /** Command window to main: the brush (checked against the palette in main). */
  brush: 'page-annotate:brush',
  /** Command window to main: the mode (checked). */
  mode: 'page-annotate:mode',
  /** Command window to main: an edit of the page's layer (checked). */
  edit: 'page-annotate:edit',
  /** Command window to main: end the annotation. */
  stop: 'page-annotate:stop',
  /** Command window to main: the look of the laser (checked against the list). */
  laser: 'page-annotate:laser',
  /** Command window to main: the grip is being dragged (the phase and the pointer on the screen, checked). */
  drag: 'page-annotate:drag',
  /** Command window to main: show the menu « Position de la barre » (the place it opens at, checked). */
  menu: 'page-annotate:menu',
  /** Command window to main: an arrow key on the grip (the direction and Shift, checked). */
  nudge: 'page-annotate:nudge',
  /** Command window to main: the first-use hint was dismissed (« OK » or Escape). */
  hint: 'page-annotate:hint',
  /** Command window to main: the automatic clearing, 0 (off) or a delay of the list (checked), from the timer button. */
  autoClear: 'page-annotate:auto-clear'
} as const

/** The phases of a drag of the grip: it goes down, moves, comes up (`end`: dropped where it is), or is taken away (`cancel`: the bar goes back). */
export const BAR_DRAG_PHASES = ['start', 'move', 'end', 'cancel'] as const
export type BarDragPhase = (typeof BAR_DRAG_PHASES)[number]
/** What the grip tells main while it is dragged: the phase, and the pointer in the coordinates of the screen. */
export interface BarDrag {
  phase: BarDragPhase
  x: number
  y: number
}
/** Where the menu opens, in the window of the bar; null: at the pointer (a right click). */
export type BarMenuAnchor = { x: number; y: number } | null

/** The API the command window's preload gives its page, and nothing more. */
export interface PageAnnotateApi {
  getState(): Promise<PageAnnotateState>
  onState(listener: (state: PageAnnotateState) => void): () => void
  setBrush(brush: PageBrush): Promise<void>
  setMode(mode: PageMode): Promise<void>
  edit(command: PageEdit): Promise<void>
  setLaser(style: LaserStyle): Promise<void>
  stop(): Promise<void>
  /** The grip is dragged: sent for each phase, without an answer. */
  dragBar(drag: BarDrag): void
  /** Shows the menu of the positions of the bar. */
  openBarMenu(anchor: BarMenuAnchor): Promise<void>
  /** An arrow key on the grip: moves a floating bar. */
  nudgeBar(direction: NudgeDirection, large: boolean): Promise<void>
  /** The first-use hint was dismissed: main remembers it was seen. */
  dismissHint(): Promise<void>
  /** The timer button: the automatic clearing off (0) or after this many seconds; main writes it in the settings. */
  setAutoClear(value: AutoClear): Promise<void>
}

/** The tools that draw nothing in the history: the laser (a trail that fades) and the pointer (a circle that follows the pointer). */
export const PAGE_EPHEMERAL_TOOLS: readonly PageTool[] = ['laser', 'pointer']

/**
 * The letter of each tool: the keys of the bar (in draw mode only). The eraser has no letter (it is a tool of the bar, without a shortcut).
 * ⌥⌘P and the edits are not letters of this list.
 */
export const PAGE_TOOL_KEYS: Readonly<Record<string, PageTool>> = { p: 'pen', h: 'highlighter', r: 'rectangle', d: 'diamond', o: 'ellipse', a: 'arrow', l: 'line', k: 'laser', q: 'pointer' }
/** E clears the page on screen (as the button « Page »), in draw mode. */
export const PAGE_CLEAR_KEY = 'e'
/** X clears every page of the session (as ⇧⌥⌘⌫), in draw mode. */
export const PAGE_CLEAR_ALL_KEY = 'x'

/** A key press in the page, as the shell reads it (the fields the rule needs). */
export interface PageKeyInput {
  type: 'keyDown' | 'keyUp'
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

/** What a key press asks for: a tool, an edit of the drawing, or the end of the annotation. */
export type PageKeyAction = { kind: 'tool'; tool: PageTool } | { kind: 'edit'; command: PageEdit } | { kind: 'stop' }

/**
 * The shortcuts of the page annotation: ⌘Z (undo), ⇧⌘Z (redo), ⌥⌘⌫ (clear this page), ⇧⌥⌘⌫ (clear all pages), Échap (end) act in both modes; a
 * letter alone picks a tool, or clears the page on E (and every page on X), and only does so in draw mode, and only while `letters` is on (the setting
 * `annotateLetterKeys`: a person who types fast, or with a screen reader, can have no key of one letter taken from the page). ⌥⌘P is held by the shell; ⌥⌘⌫ and ⇧⌥⌘⌫ are the only keys with ⌥ that are ours. Nothing else is taken: the rule does not
 * look at the target of the key (the layer does, see shared/page-annotate-layer.ts `editing`).
 */
export function pageKeyAction(input: PageKeyInput, mode: PageMode, letters = true): PageKeyAction | null {
  if (input.type !== 'keyDown') return null
  if (input.alt) {
    if (!input.meta || input.control || input.key !== 'Backspace') return null
    return { kind: 'edit', command: input.shift ? 'clear-all' : 'clear' }
  }
  const key = input.key.toLowerCase()
  if (input.meta || input.control) {
    if (key === 'z') return { kind: 'edit', command: input.shift ? 'redo' : 'undo' }
    return null
  }
  if (input.key === 'Escape' && !input.shift) return { kind: 'stop' }
  if (input.shift || mode !== 'draw' || !letters) return null
  if (key === PAGE_CLEAR_KEY) return { kind: 'edit', command: 'clear' }
  if (key === PAGE_CLEAR_ALL_KEY) return { kind: 'edit', command: 'clear-all' }
  const tool = Object.prototype.hasOwnProperty.call(PAGE_TOOL_KEYS, key) ? PAGE_TOOL_KEYS[key] : undefined
  return tool ? { kind: 'tool', tool } : null
}

/**
 * Whether the source a page picked for its screen sharing is the window of Lucium that the page is in (the id `desktopCapturer` gives,
 * compared with `BrowserWindow.getMediaSourceId()`). Another application's window, or no source, is not.
 */
export function sharesOwnWindow(chosen: string | null, own: string | null): boolean {
  const a = windowNumber(chosen)
  return a !== null && a === windowNumber(own)
}

/**
 * The number of a window in a source id: `window:N:0` (or `window:N`) gives N, as a plain number text (leading zeros and surrounding spaces do not
 * count). Another kind of source (a screen, a text that is not one) gives null. The number is what names the window (its CGWindowID).
 */
export function windowNumber(id: string | null): string | null {
  const match = id === null ? null : /^\s*window:0*(\d+)(?::\d+)?\s*$/.exec(id)
  return match ? match[1]! : null
}

/**
 * What the window state carries for the page annotation: `annotateEnabled` while it is on (by default; LUCIUM_ANNOTATE=0 turns it off), so that the
 * toolbar shows its button « Annoter » at all times. Nothing otherwise: the button does not exist then.
 */
export function annotateToolbarFlag(env: Readonly<Record<string, string | undefined>>): { annotateEnabled?: true } {
  return annotateShareEnabled(env) ? { annotateEnabled: true } : {}
}

/**
 * Whether the annotation may run in the window with this source (the media source id of the window, `BrowserWindow.getMediaSourceId()`).
 * Without a window of the share, any window of Lucium may start it; once a window is shared, only that window may: another window shows
 * neither the bar nor the layer, and an unknown window (no source) is refused.
 */
export function canAnnotateHere(own: string | null, shared: string | null): boolean {
  return own !== null && own !== '' && (shared === null || sameWindow(own, shared))
}

/** Whether two source ids name the same window: the same text, or the same window number (an id without a number is compared as text only). */
export function sameWindow(a: string, b: string): boolean {
  if (a === b) return true
  const number = windowNumber(a)
  return number !== null && number === windowNumber(b)
}

const COORDINATE_MAX = 1_000_000
/** A number the screen can have: the bound refuses NaN and the infinities as well as a number past any screen (they are not within it). */
const isCoordinate = (raw: unknown): raw is number => typeof raw === 'number' && Math.abs(raw) <= COORDINATE_MAX

/** Whether a value is what the grip may send while it is dragged: a phase of the list and a pointer with finite coordinates of a sane size. */
export function isBarDrag(raw: unknown): raw is BarDrag {
  if (typeof raw !== 'object' || raw === null) return false
  const { phase, x, y } = raw as Record<string, unknown>
  return (BAR_DRAG_PHASES as readonly unknown[]).includes(phase) && isCoordinate(x) && isCoordinate(y)
}

/** Whether a value is a place the menu may open at: null (the pointer), or a point of the window with finite, non-negative coordinates. */
export function isBarMenuAnchor(raw: unknown): raw is BarMenuAnchor {
  if (raw === null) return true
  if (typeof raw !== 'object') return false
  const { x, y } = raw as Record<string, unknown>
  return isCoordinate(x) && isCoordinate(y) && x >= 0 && y >= 0
}

export function isPageTool(raw: unknown): raw is PageTool {
  return (PAGE_TOOLS as readonly unknown[]).includes(raw)
}

export function isPageMode(raw: unknown): raw is PageMode {
  return (PAGE_MODES as readonly unknown[]).includes(raw)
}

export function isPageEdit(raw: unknown): raw is PageEdit {
  return (PAGE_EDITS as readonly unknown[]).includes(raw)
}

/** Whether a value is a brush the layer may take: its tool, colour and thickness must each be in their list. */
export function isPageBrush(raw: unknown): raw is PageBrush {
  if (typeof raw !== 'object' || raw === null) return false
  const { tool, color, width } = raw as Record<string, unknown>
  return isPageTool(tool) && (DRAW_COLORS as readonly unknown[]).includes(color) && (DRAW_WIDTHS as readonly unknown[]).includes(width)
}

/**
 * Whether a layer may be put on a page of this address: a web page only. The pages of Lucium (its error pages, its own surfaces), the pages
 * of an extension, the internal pages and the files on disk take none: the layer says so instead of failing without a word.
 */
export function injectableUrl(url: string): boolean {
  return /^https?:\/\/[^/?#\s]/i.test(url)
}

/** A rectangle in points. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the pane of a page in a split view is on the screen, for the bar of the annotation (it goes on the left edge of the page it annotates, not of the
 * whole stage). A pane is laid out inside the stage, the stage inside the content area of the window, and the content area is placed on the screen.
 * `index` is the place of the page in the split view; null when the layout has no pane there.
 */
export function paneOnScreen(content: ScreenRect, stage: ScreenRect, panes: readonly ScreenRect[], index: number): ScreenRect | null {
  const pane = panes[index]
  return pane ? { x: content.x + stage.x + pane.x, y: content.y + stage.y + pane.y, width: pane.width, height: pane.height } : null
}
