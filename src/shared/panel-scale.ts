// Size of the windows and panels of the interface (Settings › Apparence › Taille des fenêtres et des panneaux). The panels that open over the window
// (Notes, Traduire, Nouveautés, the confirmation sheets…) and the windows of their own (Réglages, Extensions, the task manager, À propos) are drawn
// in CSS pixels, so on a 3440 × 1440 screen they are small and on a small laptop they can be large. One factor scales them all: the zoom of the
// interface page that draws them (Electron's `setZoomFactor`, which also scales the text, like the zoom of the interface and never the zoom of web
// pages) and, in the main process, the size of the windows of their own. The factor is chosen per screen: « Automatique » computes it from the
// size of the screen, a choice (a notch or the slider of the preview) replaces it. Pure: nothing here reads a window or a screen.

import type { OverlayRequest } from './ipc'
import { clamp } from './clamp'

/** The slider of the preview, in percent: 100 is the size the panels have always had and does nothing. */
export const PANEL_PERCENT_MIN = 80
export const PANEL_PERCENT_MAX = 160
export const PANEL_PERCENT_STEP = 5

/** The notches of the control, next to « Automatique ». */
export const PANEL_PRESETS = [
  { id: 'compact', percent: 90 },
  { id: 'normal', percent: 100 },
  { id: 'large', percent: 125 },
  { id: 'xlarge', percent: 150 }
] as const
export type PanelPreset = (typeof PANEL_PRESETS)[number]['id']

/** The most screens the settings remember: the one that was set last wins the place of the oldest. */
export const PANEL_SCREENS_MAX = 12

/** What the settings keep of a screen. `percent` null is « Automatique »; `noticed` says the notice « Les panneaux vous semblent trop petits ? » was shown for it. */
export interface PanelScreenChoice {
  percent: number | null
  noticed: boolean
  label: string
  internal: boolean
  width: number
  height: number
  scaleFactor: number
  /** When it was last set or noticed (milliseconds): the oldest leaves first when there are too many. */
  used: number
}

/** By screen key (`screenKey`). */
export type PanelSizes = Record<string, PanelScreenChoice>

// ---------- the screens ----------

/** What the interface needs to know of a screen. The key is the memory of the screen: see `screenKey`. */
export interface ScreenInfo {
  key: string
  /** The name the system gives the monitor ('' when it gives none); the built-in screen has none worth keeping (`internal`). */
  label: string
  internal: boolean
  /** The size in logical pixels (points), what a window is laid out in. */
  width: number
  height: number
  scaleFactor: number
}

/** The part of Electron's `Display` that identifies a screen. */
export interface DisplayLike {
  label?: string
  internal?: boolean
  scaleFactor: number
  size: { width: number; height: number }
}

const LABEL_MAX = 80
const SIZE_MAX = 20000
const SCALE_MIN = 0.5
const SCALE_MAX = 8

const cleanLabel = (raw: unknown): string => (typeof raw === 'string' ? raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim() : '')
const cleanSize = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) && Math.round(raw) >= 1 && Math.round(raw) <= SIZE_MAX ? Math.round(raw) : null)
const cleanScale = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? Math.round(clamp(raw, SCALE_MIN, SCALE_MAX) * 100) / 100 : 1)

/**
 * The key a screen is remembered by. Electron's `Display.id` is not it: the system hands out another id when a monitor is unplugged and plugged in
 * again, so a choice kept by id would be lost at every reconnection. What stays the same is the model of the monitor (its name), its size and its
 * density: `LG UltraWide|3440x1440@1`. The built-in screen of a laptop is named by what it is, not by the name the system gives it in its language
 * (`built-in|1512x982@2`). Two identical monitors share one key, and so one choice: they have the same size, so the same choice suits both.
 */
export function screenKey(screen: { label: string; internal: boolean; width: number; height: number; scaleFactor: number }): string {
  return `${screen.internal ? 'built-in' : screen.label}|${screen.width}x${screen.height}@${screen.scaleFactor}`
}

/** A screen as the interface knows it, or null for a display that says nothing usable of its size. */
export function screenOf(display: DisplayLike): ScreenInfo | null {
  const width = cleanSize(display.size?.width)
  const height = cleanSize(display.size?.height)
  if (width === null || height === null) return null
  const internal = display.internal === true
  const label = internal ? '' : cleanLabel(display.label)
  const scaleFactor = cleanScale(display.scaleFactor)
  return { key: screenKey({ label, internal, width, height, scaleFactor }), label, internal, width, height, scaleFactor }
}

/** A screen read from what crosses a channel (the interface names the screen it sets): rebuilt, so that its key is the one its fields give. */
export function readScreen(raw: unknown): ScreenInfo | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  return screenOf({ label: typeof value['label'] === 'string' ? value['label'] : '', internal: value['internal'] === true, scaleFactor: value['scaleFactor'] as number, size: { width: value['width'] as number, height: value['height'] as number } })
}

// ---------- the saved choices ----------

const KEY_MAX = 160

/** The saved screens of a file or of a patch: only well-formed entries whose key is the one their fields give, at most `PANEL_SCREENS_MAX`, the most recent kept. */
export function cleanPanelSizes(raw: unknown): PanelSizes {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const kept: Array<[string, PanelScreenChoice]> = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length > KEY_MAX || typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const screen = screenOf({ label: typeof entry['label'] === 'string' ? entry['label'] : '', internal: entry['internal'] === true, scaleFactor: entry['scaleFactor'] as number, size: { width: entry['width'] as number, height: entry['height'] as number } })
    if (screen === null || screen.key !== key) continue
    const percent = typeof entry['percent'] === 'number' && Number.isFinite(entry['percent']) ? Math.round(clamp(entry['percent'], PANEL_PERCENT_MIN, PANEL_PERCENT_MAX)) : null
    const noticed = entry['noticed'] === true
    // A screen with no choice and no notice says nothing: it is not kept.
    if (percent === null && !noticed) continue
    const used = typeof entry['used'] === 'number' && Number.isFinite(entry['used']) && entry['used'] >= 0 ? Math.floor(entry['used']) : 0
    kept.push([key, { percent, noticed, label: screen.label, internal: screen.internal, width: screen.width, height: screen.height, scaleFactor: screen.scaleFactor, used }])
  }
  return Object.fromEntries(newest(kept))
}

/** The most recent `PANEL_SCREENS_MAX` entries, in the order they were given. */
function newest(entries: Array<[string, PanelScreenChoice]>): Array<[string, PanelScreenChoice]> {
  if (entries.length <= PANEL_SCREENS_MAX) return entries
  const keep = new Set(
    [...entries]
      .map(([key, entry], index) => ({ key, used: entry.used, index }))
      .sort((a, b) => b.used - a.used || b.index - a.index)
      .slice(0, PANEL_SCREENS_MAX)
      .map((one) => one.key)
  )
  return entries.filter(([key]) => keep.has(key))
}

const entryOf = (screen: ScreenInfo, percent: number | null, noticed: boolean, now: number): PanelScreenChoice => ({ percent, noticed, label: screen.label, internal: screen.internal, width: screen.width, height: screen.height, scaleFactor: screen.scaleFactor, used: now })

/**
 * The choice of a screen: `percent` between `PANEL_PERCENT_MIN` and `PANEL_PERCENT_MAX` (anything else is brought there), or null for « Automatique »,
 * which keeps no entry unless the notice was shown for this screen (it must not come back).
 */
export function withPanelSize(sizes: PanelSizes, screen: ScreenInfo, percent: number | null, now: number): PanelSizes {
  const before = sizes[screen.key]
  const chosen = percent === null || !Number.isFinite(percent) ? null : Math.round(clamp(percent, PANEL_PERCENT_MIN, PANEL_PERCENT_MAX))
  if (chosen === null && !before?.noticed) return withoutScreen(sizes, screen.key)
  // The same choice again is no change (and does not touch the date the oldest screen is dropped by).
  if (before !== undefined && before.percent === chosen) return sizes
  const rest = Object.entries(sizes).filter(([key]) => key !== screen.key)
  return Object.fromEntries(newest([...rest, [screen.key, entryOf(screen, chosen, before?.noticed === true, now)]]))
}

/** The notice was shown for this screen: it is not shown again, whatever becomes of its choice. */
export function withNoticed(sizes: PanelSizes, screen: ScreenInfo, now: number): PanelSizes {
  const before = sizes[screen.key]
  if (before?.noticed) return sizes
  const rest = Object.entries(sizes).filter(([key]) => key !== screen.key)
  return Object.fromEntries(newest([...rest, [screen.key, entryOf(screen, before?.percent ?? null, true, now)]]))
}

function withoutScreen(sizes: PanelSizes, key: string): PanelSizes {
  return Object.hasOwn(sizes, key) ? Object.fromEntries(Object.entries(sizes).filter(([other]) => other !== key)) : sizes
}

// ---------- « Automatique » ----------

/** The screen the sizes of the panels were drawn for: a 14-inch laptop, 1512 × 982 points. Automatique gives it 100 %. */
const REFERENCE_SIDE = Math.sqrt(1512 * 982)
export const AUTO_PERCENT_MIN = 90
export const AUTO_PERCENT_MAX = 140

/**
 * The size « Automatique » gives the panels of a screen, in percent, to the nearest 5: more as the screen is larger, less as it is smaller (the panels take the
 * same share of it), whatever its density: a size in points is what a window is laid out in. The measure is the geometric mean of the sides, so that an
 * ultra-wide screen counts for its width without counting for what it lacks in height. 1512 × 982 is 100 %; 1920 × 1080 105 %; 2560 × 1440 120 %;
 * 3440 × 1440 125 %; 5120 × 1440 130 %; 1280 × 800 95 %. This is before the window is looked at (`panelFactor` brings it back to what the window holds).
 */
export function autoPercent(screen: { width: number; height: number }): number {
  const side = Math.sqrt(Math.max(1, screen.width) * Math.max(1, screen.height))
  const raw = 100 * (1 + 0.4 * Math.log(side / REFERENCE_SIDE))
  return clamp(Math.round(raw / PANEL_PERCENT_STEP) * PANEL_PERCENT_STEP, AUTO_PERCENT_MIN, AUTO_PERCENT_MAX)
}

/** The size the settings give the panels of a screen, in percent: its choice, or Automatique. */
export function chosenPercent(sizes: PanelSizes, screen: { key: string; width: number; height: number }): number {
  return sizes[screen.key]?.percent ?? autoPercent(screen)
}

// ---------- never larger than the room ----------

/** What the panels of a window need, in CSS pixels, before they look cramped: the widest of them (640 and its margins) and the list panels (480). */
export const PANEL_NEED = { width: 700, height: 520 } as const

export interface Room {
  width: number
  height: number
}

/**
 * The most the panels may be enlarged in `room` (the content of the window, or the work area of the screen for a window of its own): the factor at which
 * `need` — what they need in CSS pixels — still fits, to the nearest 5 % downwards, and never below 1: a size of 100 % is what the panels have always
 * had in a small window (they shrink to the window, `max-width: calc(100% - …)`), so a window is never made worse than it was. `ui` is the zoom of the
 * interface the factor comes on top of (Taille de l'interface).
 */
export function fitLimit(room: Room, need: Room, ui = 1): number {
  const fit = Math.min(room.width / (ui * need.width), room.height / (ui * need.height))
  return Math.max(1, Math.floor((Number.isFinite(fit) ? fit : 1) * 20) / 20)
}

export interface FactorInput {
  sizes: PanelSizes
  screen: { key: string; width: number; height: number }
  room: Room
  need: Room
  ui?: number
}

/** The zoom factor of the panels of a window: the size the settings give, brought back to what the window holds when it is above 100 %. */
export function panelFactor({ sizes, screen, room, need, ui = 1 }: FactorInput): number {
  const wanted = chosenPercent(sizes, screen) / 100
  return wanted <= 1 ? wanted : Math.min(wanted, fitLimit(room, need, ui))
}

/**
 * What letting go of the slider chooses: the value it was dragged to, when that is not the size already shown (a click on the thumb, or a drag back to where it
 * was, chooses nothing, and « Automatique » stays « Automatique »); null otherwise.
 */
export function committedPercent(dragged: number | null, shown: number): number | null {
  return dragged !== null && Number.isFinite(dragged) && dragged !== shown ? Math.round(clamp(dragged, PANEL_PERCENT_MIN, PANEL_PERCENT_MAX)) : null
}

// ---------- which panels ----------

/**
 * Where each panel of the layer lives. `centred`: a sheet or a list in the middle of the window, laid out by its CSS: scaled with the factor. `placed`: hung
 * from something in the window (the sidebar, the toolbar, the page card) at a place the main process works out in the CSS pixels of the interface, or sized
 * by its own setting (the command bar, `commandBarSize`): it keeps the zoom of the interface, and so its place. A panel added to `OverlayRequest` is in this
 * table or the code does not compile.
 */
export const PANEL_PLACEMENT: Record<OverlayRequest['panel'], 'centred' | 'placed'> = {
  commandbar: 'placed',
  shortcuts: 'centred',
  find: 'placed',
  findreplace: 'placed',
  import: 'centred',
  firstlaunch: 'centred',
  downloads: 'placed',
  settings: 'placed',
  extensions: 'placed',
  archive: 'centred',
  history: 'centred',
  spaces: 'centred',
  capture: 'placed',
  annotate: 'placed',
  site: 'placed',
  space: 'centred',
  favorite: 'centred',
  workview: 'centred',
  spacecreate: 'centred',
  plus: 'placed',
  spacemenu: 'placed',
  tidy: 'centred',
  deadtabs: 'centred',
  sitedata: 'centred',
  cookies: 'centred',
  sessions: 'centred',
  readlater: 'centred',
  bookmarks: 'centred',
  livefolder: 'centred',
  foldericon: 'centred',
  tab: 'centred',
  windowname: 'centred',
  autoreload: 'centred',
  theme: 'placed',
  boost: 'placed',
  shortcut: 'centred',
  peek: 'placed',
  permission: 'placed',
  auth: 'centred',
  dialog: 'centred',
  leave: 'centred',
  welcome: 'centred',
  whatsnew: 'centred',
  arcguide: 'centred',
  discover: 'centred',
  problemreport: 'centred',
  notices: 'centred',
  extreview: 'centred',
  passphrase: 'centred',
  qr: 'centred',
  translate: 'centred',
  translatepop: 'placed',
  passwords: 'centred',
  splitdrop: 'placed',
  tabcycle: 'placed',
  tabgrid: 'centred',
  notes: 'centred'
}

/**
 * Whether a request of the layer is drawn at the zoom of the panels. A small editor that hangs from the row or the tile that opened it (`anchor`) is placed
 * in the CSS pixels of the sidebar it hangs from, so it keeps their zoom; the same editor with no anchor is centred like the others.
 */
export function panelIsScaled(request: OverlayRequest): boolean {
  if (PANEL_PLACEMENT[request.panel] !== 'centred') return false
  return !('anchor' in request && request.anchor !== undefined)
}

// ---------- the windows of their own ----------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The size of a window of its own at the factor 1, and the least it can be made. */
export interface WindowSizes {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
}

/**
 * The size of a window of its own at `factor`: what it has at 100 %, multiplied, and never more than the work area `area` it opens in; its minimum is
 * multiplied the same way and never goes above its size, so that the window can always be made as small as it opens.
 */
export function scaledWindow(base: WindowSizes, factor: number, area: Room): Required<WindowSizes> {
  const fit = (value: number, limit: number) => Math.max(1, Math.min(Math.round(value * factor), Math.floor(limit)))
  const width = fit(base.width, area.width)
  const height = fit(base.height, area.height)
  return { width, height, minWidth: Math.min(fit(base.minWidth ?? base.width, area.width), width), minHeight: Math.min(fit(base.minHeight ?? base.height, area.height), height) }
}

/** `size` placed in the middle of `area`. */
export function centredIn(area: Rect, size: Room): { x: number; y: number } {
  return { x: area.x + Math.round((area.width - size.width) / 2), y: area.y + Math.round((area.height - size.height) / 2) }
}

/**
 * The size a window that is open takes when its factor goes from `from` to `to` (the choice changed, or it moved to another screen): its content keeps its
 * size in CSS pixels, so the size in points follows the factor, within its minimum and the work area.
 */
export function rescaledContent(content: Room, from: number, to: number, base: WindowSizes, area: Room): Room {
  const sizes = scaledWindow(base, to, area)
  const ratio = from > 0 ? to / from : 1
  return { width: clamp(Math.round(content.width * ratio), sizes.minWidth, Math.max(sizes.minWidth, Math.floor(area.width))), height: clamp(Math.round(content.height * ratio), sizes.minHeight, Math.max(sizes.minHeight, Math.floor(area.height))) }
}

// ---------- the notice ----------

/** Wider than this, in points, or flatter than this ratio: the panels are small on it. Narrower than `SMALL_WIDTH`: they are large. */
export const WIDE_WIDTH = 2560
export const WIDE_ASPECT = 2.2
export const SMALL_WIDTH = 1366

export type ScreenKind = 'wide' | 'small'

/** What the notice is about: `wide` for a very wide screen (« trop petits »), `small` for a very small one (« trop grands »), null for any other. */
export function screenKind(screen: { width: number; height: number }): ScreenKind | null {
  if (screen.width >= WIDE_WIDTH || screen.width / Math.max(1, screen.height) >= WIDE_ASPECT) return 'wide'
  return screen.width < SMALL_WIDTH ? 'small' : null
}

/**
 * The notice to show for a screen that is being used: once per screen, for a very wide or very small one, and not when its owner has already chosen a size
 * for it (they found the setting).
 */
export function screenNotice(screen: ScreenInfo, sizes: PanelSizes): ScreenKind | null {
  const entry = sizes[screen.key]
  if (entry?.noticed || entry?.percent != null) return null
  return screenKind(screen)
}

// ---------- the list of the screens, the preview ----------

export interface ScreenView extends ScreenInfo {
  /** The screen the window that asks is on. */
  current: boolean
  /** The main window of the application on this screen, in the screen's own coordinates, or null when there is none. */
  window: Rect | null
}

export interface ScreenRow {
  screen: ScreenInfo
  /** The choice, null for Automatique. */
  percent: number | null
  connected: boolean
  current: boolean
}

/** The screens the settings list: the ones that are connected, then the others that have a choice, the most recent first. A choice can be removed, so a screen with none is not kept. */
export function knownScreens(sizes: PanelSizes, connected: readonly ScreenView[]): ScreenRow[] {
  const rows: ScreenRow[] = []
  for (const screen of connected) {
    const existing = rows.find((row) => row.screen.key === screen.key)
    if (existing) {
      existing.current ||= screen.current
      continue
    }
    rows.push({ screen, percent: sizes[screen.key]?.percent ?? null, connected: true, current: screen.current })
  }
  rows.sort((a, b) => Number(b.current) - Number(a.current))
  const away = Object.entries(sizes)
    .filter(([key, entry]) => entry.percent !== null && !rows.some((row) => row.screen.key === key))
    .sort(([, a], [, b]) => b.used - a.used)
  for (const [key, entry] of away) rows.push({ screen: { key, label: entry.label, internal: entry.internal, width: entry.width, height: entry.height, scaleFactor: entry.scaleFactor }, percent: entry.percent, connected: false, current: false })
  return rows
}

/** The Notes panel at 100 %: its size is the one of every list panel (`.lp` in templates/list-panel.css). */
export const PANEL_SAMPLE: Room = { width: 560, height: 480 }
/** The window the preview draws when none is known: the size the main window opens at. */
export const DEFAULT_WINDOW: Room = { width: 1360, height: 860 }
/** The margin a panel keeps from the edge of the window (`--sp-4`) and where it stands from the top (`padding-top: 12vh` of the backdrop). */
const PANEL_MARGIN = 16
const PANEL_TOP = 0.12

export interface PreviewInput {
  screen: { width: number; height: number }
  window: Rect | null
  /** The size shown, in percent: what the slider says. */
  percent: number
  /** The width of the stage the screen is drawn in. */
  stageWidth: number
}

export interface Preview {
  /** The screen, the window on it and the Notes panel in it, in pixels of the stage. */
  screen: Room
  window: Rect
  panel: Rect
  /** The factor the panel is really drawn at (the slider's, brought back to what the window holds). */
  factor: number
}

/** The picture of the Notes panel in a window of the screen at the size shown: to the scale of the screen, so that it looks as it will. */
export function previewOf({ screen, window, percent, stageWidth }: PreviewInput): Preview {
  const scale = stageWidth / Math.max(1, screen.width)
  const frame = window ?? defaultWindow(screen)
  const wanted = clamp(percent, PANEL_PERCENT_MIN, PANEL_PERCENT_MAX) / 100
  const factor = wanted <= 1 ? wanted : Math.min(wanted, fitLimit(frame, PANEL_NEED))
  const width = Math.min(PANEL_SAMPLE.width * factor, frame.width - 2 * PANEL_MARGIN * factor)
  const top = frame.height * PANEL_TOP
  const height = Math.min(PANEL_SAMPLE.height * factor, frame.height - top - PANEL_MARGIN * factor)
  const px = (value: number) => Math.round(value * scale * 10) / 10
  return {
    screen: { width: px(screen.width), height: px(screen.height) },
    window: { x: px(frame.x), y: px(frame.y), width: px(frame.width), height: px(frame.height) },
    panel: { x: px(frame.x + (frame.width - width) / 2), y: px(frame.y + top), width: px(width), height: px(height) },
    factor
  }
}

/** The window the application opens at, centred on the screen and never more than nine tenths of it. */
function defaultWindow(screen: Room): Rect {
  const size = { width: Math.min(DEFAULT_WINDOW.width, screen.width * 0.9), height: Math.min(DEFAULT_WINDOW.height, screen.height * 0.9) }
  return { ...centredIn({ x: 0, y: 0, ...screen }, size), ...size }
}
