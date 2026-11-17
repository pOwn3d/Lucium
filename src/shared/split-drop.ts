// Dragging a tab from the sidebar onto the page: the veil that shows where the split view would put it, and what a drop does.
// Over a single page the drop makes a split view of two; over a split view of two or three panes it adds one more pane where the veil
// shows it, at a side or in a corner (a corner makes a grid: split-grid.ts); over a split view of four the veil says that it takes no more.
// Measured values over a single page. Pure rules; the veil is drawn by the overlay (renderer/SplitDrop.tsx) and the drop is carried out by
// the browser (shell/browser-overlay.ts).

import { SPLIT_GAP, SPLIT_MAX_PANES, splitLayout, splitPaneStage, type Rect } from './split'
import { GRID_CORNERS, canJoinAt, isGridCorner, isJoinZone, isPaneSide, joined, type GridCorner, type JoinZone, type PaneSide } from './split-grid'
import type { SidebarState, SplitGrid, SplitOrientation, SplitView } from './model'
import { activeTab, splitFor } from './sidebar'

/** Where the dragged tab would go. `ring` is the middle of the page: no split. `none`: the pointer is too near the sidebar. Corners: over a split view only. */
export type DropZone = 'none' | PaneSide | GridCorner | 'ring'
/** The zones a drop can name: a drop on `none` is no drop, and the interface never sends it. */
export const SPLIT_DROP_ZONES = ['left', 'right', 'top', 'bottom', ...GRID_CORNERS, 'ring'] as const satisfies readonly DropZone[]
export type SplitDropZone = (typeof SPLIT_DROP_ZONES)[number]
export const isSplitDropZone = (value: unknown): value is SplitDropZone => (SPLIT_DROP_ZONES as readonly unknown[]).includes(value)

/** The four sides where the empty box can sit. */
export type BoxSide = PaneSide
export const isBoxSide = (zone: DropZone): zone is BoxSide => isPaneSide(zone)

/** What the veil is drawn with, as measured: the box (fill, 2 px outline, 5 px corners), the ring (3 px) and the move (0.2 s, ease-out). */
export const DROP_VEIL = {
  boxFill: '#0e0f14',
  boxOutline: '#7d7e89',
  boxOutlineWidth: 2,
  boxRadius: 5,
  ringColor: '#2f39ff',
  ringWidth: 3,
  /** The reduced page keeps its own 8 px corners (PAGE_RADIUS). */
  gap: SPLIT_GAP,
  moveMs: 200,
  easing: 'ease-out'
} as const

/**
 * The first pane of a stack is 5 px shorter than the second (424 and 434 in a 868 px card, so 10 px of gap and not 10 + 0).
 * Side by side the first one is the wider by the rounding only (669 and 668 of 1347).
 */
export const STACK_SKEW = 5

/** Hysteresis thresholds, as a share of the page's width (x) and height (y). See `nextZone`. */
export const DROP_THRESHOLDS = {
  /** Under it the pointer is too near the sidebar to mean anything. Not measured as a pair: nothing shows at 277 px of 1347 and a box does at 377. */
  none: 0.24,
  /** The ring starts here when the pointer comes from the middle; the left box is left when it passes `left + holdX`. */
  left: 0.41,
  right: 0.6,
  /** The zone the pointer was in is kept for about 100 px more: a box does not flicker at its edge. */
  holdX: 0.095,
  /** The top edge zone starts at a tenth of the page's height and is left at 42 % of it (measured going down from the top). */
  top: 0.1,
  topLeaves: 0.42,
  /** The bottom edge zone starts only at the very bottom (840 px of 868), and is left at 58 % (not measured, mirrors the top). */
  bottom: 0.955,
  bottomLeaves: 0.58
} as const

type Horizontal = 'none' | 'left' | 'ring' | 'right'
type Vertical = 'top' | 'middle' | 'bottom'

/** What an edge zone and the sideways zones remember between two moves of the pointer. */
export interface DropState {
  zone: DropZone
  horizontal: Horizontal
  vertical: Vertical
}

export const NO_DROP_STATE: DropState = { zone: 'none', horizontal: 'none', vertical: 'middle' }

function nextHorizontal(prev: Horizontal, u: number): Horizontal {
  const t = DROP_THRESHOLDS
  if (u < t.none) return 'none'
  // Coming from the sidebar or from the left box, the left box is kept until the middle (+ the hold); the right box likewise from the right.
  if (prev === 'none' || prev === 'left') return u < t.left + t.holdX ? 'left' : u < t.right ? 'ring' : 'right'
  if (prev === 'right') return u > t.right - t.holdX ? 'right' : u > t.left ? 'ring' : 'left'
  return u < t.left ? 'left' : u > t.right ? 'right' : 'ring'
}

function nextVertical(prev: Vertical, v: number): Vertical {
  const t = DROP_THRESHOLDS
  if (prev === 'top') return v < t.topLeaves ? 'top' : v > t.bottom ? 'bottom' : 'middle'
  if (prev === 'bottom') return v > t.bottomLeaves ? 'bottom' : v < t.top ? 'top' : 'middle'
  return v < t.top ? 'top' : v > t.bottom ? 'bottom' : 'middle'
}

/**
 * The bands of the height over a split view the tab would join: the top quarter and the bottom quarter, each kept a little longer on the way out
 * (5 % of the height). Not measured: a deliberate addition, so that the corners are as easy to reach as the sides.
 */
export const JOIN_BANDS = { top: 0.25, bottom: 0.75, hold: 0.05 } as const

function nextBand(prev: Vertical, v: number): Vertical {
  const b = JOIN_BANDS
  if (prev === 'top' && v < b.top + b.hold) return 'top'
  if (prev === 'bottom' && v > b.bottom - b.hold) return 'bottom'
  return v < b.top ? 'top' : v > b.bottom ? 'bottom' : 'middle'
}

/** The split view the veil is over, as far as its zones go: its arrangement, and how many panes it has (one share each). */
export type JoinHost = Pick<SplitView, 'orientation' | 'grid'> & { ratios: readonly unknown[] }

/** A zone over a split view of `host`: the zone itself when the split view takes a tab there, the ring otherwise. */
function joinable(zone: DropZone, host: JoinHost): DropZone {
  if (!isJoinZone(zone)) return zone
  const shape = { tabIds: host.ratios.map((_, i) => String(i)), orientation: host.orientation, ...(host.grid ? { grid: host.grid } : {}) }
  return canJoinAt(shape, zone) ? zone : 'ring'
}

/**
 * The zone under the pointer, given where it was: `x` and `y` are in the page's own box (0 to `size`). Each axis has its own memory
 * (a zone is kept for about 100 px on the way out), and the top or bottom edge wins over the sides.
 * `mirrored`: the sidebar is at the right, so "near the sidebar" is the right edge (`horizontal` stays in the sidebar's frame of reference).
 * `join`: the page on screen is that split view, which the tab would join. The page is then read as three columns by three rows: the columns are
 * those of a single page (past the sidebar's side: the side, the middle, the far side, with the same memory), the rows are its top quarter, its middle
 * and its bottom quarter (`JOIN_BANDS`). A corner of that grid is a corner (the tab makes a grid), the middle of a side is that side (one more pane in
 * the row or the column, or along that whole side), the centre is the ring. A zone the split view does not take (split-grid.ts `joinZones`) is the
 * ring; the sidebar's side of the page still arms nothing.
 */
export function nextZone(prev: DropState, point: { x: number; y: number }, size: { width: number; height: number }, mirrored = false, join?: JoinHost): DropState {
  if (!(size.width > 0 && size.height > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return NO_DROP_STATE
  // With the sidebar at the right the page is the usual layout seen in a mirror: the zones are read from the sidebar's side, then named by the side they are on.
  const along = mirrored ? size.width - point.x : point.x
  const horizontal = nextHorizontal(prev.horizontal, along / size.width)
  const v = point.y / size.height
  const vertical = join ? nextBand(prev.vertical, v) : nextVertical(prev.vertical, v)
  const side: Horizontal = mirrored ? (horizontal === 'left' ? 'right' : horizontal === 'right' ? 'left' : horizontal) : horizontal
  // Over the sidebar's side of the page nothing is armed, whatever the height.
  let zone: DropZone
  if (horizontal === 'none') zone = 'none'
  else if (join) {
    const raw: DropZone = vertical === 'middle' ? side : side === 'ring' ? vertical : (`${vertical}-${side}` as GridCorner)
    zone = joinable(raw, join)
  } else zone = vertical === 'top' ? 'top' : vertical === 'bottom' ? 'bottom' : side
  return { zone, horizontal, vertical }
}

/** The page and the box in a veil. `box` is where the dragged tab would go. */
export interface DropLayout {
  page: Rect
  box: Rect
}

/**
 * Where the reduced page and the empty box sit for a side zone, inside an area of `size` (origin 0, 0): two panes with a 10 px gap, the
 * whole height or width, the first pane of a stack 5 px shorter (1347 x 868 gives 669 + 10 + 668 and 424 + 10 + 434).
 */
export function dropLayout(side: BoxSide, size: { width: number; height: number }, gap: number = DROP_VEIL.gap): DropLayout {
  const { width, height } = size
  if (side === 'left' || side === 'right') {
    const first = Math.ceil((width - gap) / 2)
    const second = width - gap - first
    const firstRect: Rect = { x: 0, y: 0, width: first, height }
    const secondRect: Rect = { x: first + gap, y: 0, width: second, height }
    return side === 'left' ? { box: firstRect, page: secondRect } : { page: firstRect, box: secondRect }
  }
  const first = Math.max(0, Math.round((height - gap) / 2) - STACK_SKEW)
  const second = height - gap - first
  const firstRect: Rect = { x: 0, y: 0, width, height: first }
  const secondRect: Rect = { x: 0, y: first + gap, width, height: second }
  return side === 'top' ? { box: firstRect, page: secondRect } : { page: firstRect, box: secondRect }
}

/** The box as it is before it opens (and after it closes): flat against the edge it grows from, or a point in the corner it grows from. */
export function closedBox(side: BoxSide | GridCorner, size: { width: number; height: number }): Rect {
  const { width, height } = size
  if (isGridCorner(side)) return { x: side.endsWith('left') ? 0 : width, y: side.startsWith('top') ? 0 : height, width: 0, height: 0 }
  if (side === 'left') return { x: 0, y: 0, width: 0, height }
  if (side === 'right') return { x: width, y: 0, width: 0, height }
  if (side === 'top') return { x: 0, y: 0, width, height: 0 }
  return { x: 0, y: height, width, height: 0 }
}

/** The page in the veil for a zone: whole when no box is open, reduced beside the box otherwise. */
export function dropPage(zone: DropZone, size: { width: number; height: number }): Rect {
  return isBoxSide(zone) ? dropLayout(zone, size).page : { x: 0, y: 0, width: size.width, height: size.height }
}

/**
 * The split view on screen, as the veil over it draws it: its orientation, its panes' shares, its grid, and a picture of each pane (a `data:` URL, or
 * null for a plain card). `full`: it already has SPLIT_MAX_PANES panes; the veil then lets its pages show (no picture is taken), says that it takes no
 * more and takes no drop.
 */
export interface DropHost {
  orientation: SplitOrientation
  ratios: number[]
  grid?: SplitGrid
  snapshots: (string | null)[]
  full: boolean
}

/** The room `count` panes share in an area of `size`: the bar of a split view of two takes its strip off the foot (shared/split.ts). */
const paneStage = (size: { width: number; height: number }, count: number) => splitPaneStage(size, { tabIds: Array.from({ length: count }, () => '') })

/** The pictures of the panes and the box in a veil over a split view. `box` is where the dragged tab would go, null when no box is open. */
export interface JoinLayout {
  panes: Rect[]
  box: Rect | null
}

/** The id of the dragged tab in the veil's own reckoning, which names the panes by their place. */
const DRAGGED = 'dragged'

/**
 * Where the pictures of the panes and the box sit in a veil over a split view, inside an area of `size` (origin 0, 0). With no box open the panes are where
 * the split view has them (the shell's layout: the strip of the bar of two panes, `header` px above each pane of a lower row for its bar). With a box open,
 * the panes and the box are exactly where the split view will have them once the tab has joined it there (split-grid.ts `joined`): the box is the cell of
 * the new pane. A full split view never opens a box.
 */
export function joinLayout(zone: DropZone, size: { width: number; height: number }, host: Pick<DropHost, 'orientation' | 'ratios' | 'grid'>, header = 0, gap: number = DROP_VEIL.gap): JoinLayout {
  const count = host.ratios.length
  const ids = host.ratios.map((_, i) => String(i))
  const shape = { tabIds: ids, orientation: host.orientation, ratios: host.ratios, ...(host.grid ? { grid: host.grid } : {}) }
  const future = isJoinZone(zone) ? joined(shape, DRAGGED, zone) : null
  if (!future) return { panes: splitLayout(paneStage(size, count), host, gap, header), box: null }
  const all = splitLayout(paneStage(size, count + 1), future, gap, header)
  return { box: all[future.tabIds.indexOf(DRAGGED)]!, panes: ids.map((id) => all[future.tabIds.indexOf(id)]!) }
}

/** The split view a drop makes: the tabs in order (first = left or top), its orientation and which of the two is shown. */
export interface DropPlan {
  /** Both tabs already exist: `first` and `second` are tab ids. */
  kind: 'pair'
  first: string
  second: string
  orientation: SplitOrientation
  focus: 'first' | 'second'
}

/** A split view whose other pane is a new tab: the command bar opens to choose its page, and the new tab takes the side opposite to the box. */
export interface DropWithNewTab {
  kind: 'new-tab'
  /** The tab on screen, which stays where the box is. */
  tab: string
  /** Where the new tab goes relative to `tab`: before (left/top) or after (right/bottom). */
  newTab: 'before' | 'after'
  orientation: SplitOrientation
}

/** The dragged tab joins the split view of the page on screen as one more pane, where the zone says (`split/create` with `zone`). */
export interface DropJoin {
  kind: 'join'
  /** The dragged tab, which becomes the new pane and is the one shown. */
  tab: string
  /** The tab on screen, a pane of the split view. */
  with: string
  zone: JoinZone
}

/**
 * What dropping `dragged` on `zone` of the page `current` makes. A tab dragged onto itself (the press that starts a drag selects it) makes a
 * split view whose other pane is empty. Dropped on the ring, or on nothing, nothing happens.
 * `host`: the split view `current` is a pane of. The dragged tab joins it where the zone says (split-grid.ts `joinZones`: an end of a row or a column, a
 * side across a split view of two, a corner); nothing happens on a zone it does not take, when it is full, or when the dragged tab already is one of its panes.
 */
export function planDrop(zone: DropZone, dragged: string, current: string, host?: Pick<SplitView, 'tabIds' | 'orientation' | 'grid'>): DropPlan | DropWithNewTab | DropJoin | null {
  if (host) {
    if (!isJoinZone(zone) || host.tabIds.length >= SPLIT_MAX_PANES || !canJoinAt(host, zone) || host.tabIds.includes(dragged) || !host.tabIds.includes(current)) return null
    return { kind: 'join', tab: dragged, with: current, zone }
  }
  if (!isBoxSide(zone)) return null
  const orientation: SplitOrientation = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  const boxFirst = zone === 'left' || zone === 'top'
  if (dragged === current) return { kind: 'new-tab', tab: current, newTab: boxFirst ? 'after' : 'before', orientation }
  // The dragged tab is in the box; the page on screen is on the other side. The tab that was dragged is the one shown.
  return boxFirst
    ? { kind: 'pair', first: dragged, second: current, orientation, focus: 'first' }
    : { kind: 'pair', first: current, second: dragged, orientation, focus: 'second' }
}

/**
 * The veil a drag of a tab row opens: over a single page (`page`), over a split view the tab can join (`join`), or over a split view that is full
 * (`full`: it says so and takes no drop).
 */
export type Veil = { kind: 'page' } | { kind: 'join' | 'full'; split: SplitView }

/**
 * The veil the drag of this tab row opens, or null for none. Not with the setting off, not with the sidebar hidden (the floating sidebar lies over the
 * page's edge, a veil there would take the drag from its rows), not over a panel, not without a page on screen, not for a tab of another space, and not for
 * a tab that already is in a split view (two split views are never merged, and a pane of the one on screen is already there).
 */
export function veilFor(state: SidebarState, tabId: string, facts: { overlayOpen: boolean; hasPage: boolean }): Veil | null {
  if (!state.settings.dragToSplit || !state.settings.sidebarVisible || facts.overlayOpen || !facts.hasPage) return null
  const dragged = state.tabs.find((t) => t.id === tabId)
  const current = activeTab(state)
  if (!dragged || !current || dragged.spaceId !== current.spaceId || splitFor(state, dragged.id)) return null
  const host = splitFor(state, current.id)
  if (!host) return { kind: 'page' }
  return { kind: host.tabIds.length >= SPLIT_MAX_PANES ? 'full' : 'join', split: host }
}
