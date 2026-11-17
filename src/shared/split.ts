import type { GridSpan, SplitGrid, SplitOrientation, SplitView } from './model'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Space between split panes: the same 10 px as around the page card. */
export const SPLIT_GAP = 10
/**
 * The focused pane's ring: 2 px of blue on the pane card's own edge, over the bar and over the page's left, right and bottom
 * edges (measured: the blue is at x = 1002 → 1003 and the white page starts at 1004). The page view is inset by it.
 */
export const SPLIT_RING = 2
/** The corners of a page's card (8 px). */
export const PAGE_RADIUS = 8
/** The page of the focused pane of a split view sits inside the ring, so its own corners are rounder by the ring's width: 6 px, the ring's inner edge. */
export function pageRadius(ringed: boolean, ring = SPLIT_RING): number {
  return ringed ? Math.max(0, PAGE_RADIUS - ring) : PAGE_RADIUS
}
export const SPLIT_MIN_RATIO = 0.12
export const SPLIT_MAX_PANES = 4

/**
 * The layout bar of a split view of two panes: a 36 px pill under the panes, 8 px below them, drawn by the window's UI. The
 * native pages never go under it (a native view is above everything the UI draws): the panes' stage is shortened by both numbers.
 */
export const SPLIT_BAR_HEIGHT = 36
export const SPLIT_BAR_GAP = 8

/** Only a split view of two panes has the bar: its ratios (30 / 70…) and its swap speak of "the two pages". */
export const hasSplitBar = (split: Pick<SplitView, 'tabIds'>): boolean => split.tabIds.length === 2

/** The room the panes share: the stage, less the bar's strip when the split view has one. The shell and the UI both lay the panes out in it. */
export function splitPaneStage<T extends { width: number; height: number }>(stage: T, split: Pick<SplitView, 'tabIds'>): T {
  return hasSplitBar(split) ? { ...stage, height: Math.max(0, stage.height - SPLIT_BAR_HEIGHT - SPLIT_BAR_GAP) } : stage
}

/** The strip of the bar, at the foot of the stage (the pill is centred in it); null for a split view that has none. */
export function splitBarRect(stage: { width: number; height: number }, split: Pick<SplitView, 'tabIds'>): Rect | null {
  return hasSplitBar(split) ? { x: 0, y: Math.max(0, stage.height - SPLIT_BAR_HEIGHT), width: stage.width, height: Math.min(SPLIT_BAR_HEIGHT, stage.height) } : null
}

/**
 * Pane rectangles (the pages) inside a stage of the given size, origin (0, 0), with a gap between panes. Every pane has its own
 * toolbar above its page: side by side they all sit in the one row above the stage, but stacked, the bar of each pane after the
 * first needs room between the pages, `header` px on top of the gap.
 */
export function splitLayout(
  stage: { width: number; height: number },
  split: Pick<SplitView, 'orientation' | 'ratios' | 'grid'>,
  gap = SPLIT_GAP,
  header = 0
): Rect[] {
  const n = split.ratios.length
  if (split.grid && isGridCount(n)) return gridLayout(stage, split.grid, n, gap, header)
  const horizontal = split.orientation === 'horizontal'
  const between = horizontal ? gap : gap + header
  const total = Math.max(0, (horizontal ? stage.width : stage.height) - between * (n - 1))
  let offset = 0
  return split.ratios.map((ratio) => {
    const size = Math.round(total * ratio)
    const rect: Rect = horizontal
      ? { x: offset, y: 0, width: size, height: stage.height }
      : { x: 0, y: offset, width: stage.width, height: size }
    offset += size + between
    return rect
  })
}

/** The page's rectangle inside a pane's: the focused pane leaves room for its ring on the sides and at the bottom, not under the bar. */
export function paneContent(pane: Rect, focused: boolean, ring = SPLIT_RING): Rect {
  return focused ? { x: pane.x + ring, y: pane.y, width: Math.max(0, pane.width - ring * 2), height: Math.max(0, pane.height - ring) } : pane
}

/** The gaps between consecutive panes: where the user grabs to resize. */
export function splitDividers(panes: Rect[], orientation: SplitOrientation, gap = SPLIT_GAP): Rect[] {
  return panes.slice(0, -1).map((pane) => {
    return orientation === 'horizontal'
      ? { x: pane.x + pane.width, y: pane.y, width: gap, height: pane.height }
      : { x: pane.x, y: pane.y + pane.height, width: pane.width, height: gap }
  })
}

// ---- the grid: two columns and two rows, for three or four panes ----

/** A grid holds three panes (one of them along a whole side) or four (2 × 2). */
export const isGridCount = (count: number): boolean => count === 3 || count === 4

/** The side one pane of a grid of `count` panes takes whole, or `none` for 2 × 2. A grid of three that says none is read as two on top, one under them. */
export function gridSpanOf(grid: Pick<SplitGrid, 'span'>, count: number): GridSpan | 'none' {
  return count === 3 ? (grid.span ?? 'bottom') : 'none'
}

/** The columns and the rows each pane of a grid covers, in reading order: [first column, last column, first row, last row]. */
type Cover = readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1]
const GRID_COVERS: Record<GridSpan | 'none', readonly Cover[]> = {
  none: [[0, 0, 0, 0], [1, 1, 0, 0], [0, 0, 1, 1], [1, 1, 1, 1]],
  top: [[0, 1, 0, 0], [0, 0, 1, 1], [1, 1, 1, 1]],
  bottom: [[0, 0, 0, 0], [1, 1, 0, 0], [0, 1, 1, 1]],
  left: [[0, 0, 0, 1], [1, 1, 0, 0], [1, 1, 1, 1]],
  right: [[0, 0, 0, 0], [1, 1, 0, 1], [0, 0, 1, 1]]
}

/** The columns and the rows the pane at `index` of a grid of `count` panes covers: [first column, last column, first row, last row] (0 or 1). */
export function gridCover(grid: Pick<SplitGrid, 'span'>, count: number, index: number): Cover | undefined {
  return GRID_COVERS[gridSpanOf(grid, count)][index]
}

/**
 * The two columns and the two rows of a grid in a stage: the left column and the top row take their shares of what the gaps leave. As in a stack, the
 * bar of each pane of the bottom row needs room between the rows, `header` px on top of the gap; the bars of the top row sit in the row above the stage.
 */
function gridTracks(stage: { width: number; height: number }, grid: Pick<SplitGrid, 'column' | 'row'>, gap: number, header: number) {
  const width = Math.max(0, stage.width - gap)
  const height = Math.max(0, stage.height - gap - header)
  const left = Math.round(width * grid.column)
  const top = Math.round(height * grid.row)
  return { left, right: width - left, rightX: left + gap, top, bottom: height - top, bottomY: top + gap + header }
}

/** The pane rectangles of a grid of `count` panes (3 or 4), in reading order. A pane along a whole side covers both of its cells and the gap between them. */
export function gridLayout(stage: { width: number; height: number }, grid: SplitGrid, count: number, gap = SPLIT_GAP, header = 0): Rect[] {
  const t = gridTracks(stage, grid, gap, header)
  return GRID_COVERS[gridSpanOf(grid, count)].map(([c0, c1, r0, r1]) => {
    const x = c0 === 0 ? 0 : t.rightX
    const y = r0 === 0 ? 0 : t.bottomY
    const xEnd = c1 === 0 ? t.left : t.rightX + t.right
    const yEnd = r1 === 0 ? t.top : t.bottomY + t.bottom
    return { x, y, width: xEnd - x, height: yEnd - y }
  })
}

/** The divider between the columns of a grid, or between its rows. */
export type GridAxis = 'column' | 'row'

export interface GridDivider {
  axis: GridAxis
  rect: Rect
  /** Where its grip sits along it, from its start: its middle, or the middle of its first stretch when it crosses the other divider (2 × 2). */
  grip: number
}

/**
 * The two dividers of a grid: the column one in the gap between the columns, the row one in the gap between the rows (not over the bars of the bottom
 * row). Each runs only where there are two panes to share: beside a pane along a whole side it stops at the other gap. In 2 × 2 they cross.
 */
export function gridDividers(stage: { width: number; height: number }, grid: SplitGrid, count: number, gap = SPLIT_GAP, header = 0): GridDivider[] {
  const t = gridTracks(stage, grid, gap, header)
  const span = gridSpanOf(grid, count)
  const height = Math.max(0, stage.height)
  const width = Math.max(0, stage.width)
  const column: Rect =
    span === 'bottom' ? { x: t.left, y: 0, width: gap, height: t.top } : span === 'top' ? { x: t.left, y: t.bottomY, width: gap, height: t.bottom } : { x: t.left, y: 0, width: gap, height }
  const row: Rect =
    span === 'right' ? { x: 0, y: t.top, width: t.left, height: gap } : span === 'left' ? { x: t.rightX, y: t.top, width: t.right, height: gap } : { x: 0, y: t.top, width, height: gap }
  const crossing = span === 'none'
  return [
    { axis: 'column', rect: column, grip: crossing ? t.top / 2 : column.height / 2 },
    { axis: 'row', rect: row, grip: crossing ? t.left / 2 : row.width / 2 }
  ]
}

/** The room a divider of a grid shares out, in px: the stage's width less the gap (column), or its height less the gap and a bar (row). */
export function gridRoom(stage: { width: number; height: number }, axis: GridAxis, gap = SPLIT_GAP, header = 0): number {
  return axis === 'column' ? Math.max(0, stage.width - gap) : Math.max(0, stage.height - gap - header)
}

/** A divider of a grid moved by `delta` (a share of its room): the share it ends with, never leaving a pane under the minimum. */
export function resizeShare(share: number, delta: number): number {
  return Math.min(1 - SPLIT_MIN_RATIO, Math.max(SPLIT_MIN_RATIO, share + delta))
}

/**
 * The share after a key pressed on a divider of a grid, or null for a key it does not use: the keys of a divider between two panes (`dividerKeyRatios`),
 * ← → for the column divider, ↑ ↓ for the row divider.
 */
export function gridKeyShare(share: number, key: string, axis: GridAxis, modified = false): number | null {
  const next = dividerKeyRatios([share, 1 - share], 0, key, axis === 'column' ? 'horizontal' : 'vertical', modified)
  return next ? next[0]! : null
}

/** What a screen reader says of a divider of a grid: the percentage of the left column (or top row) and of the other, and the bounds of the first. */
export function gridDividerValues(share: number): { now: number; min: number; max: number; first: number; second: number } {
  return dividerValues([share, 1 - share], 0)!
}

/** Moves the divider after pane `index` by `delta` ratio units, never shrinking a pane under the minimum. */
export function resizeRatios(ratios: number[], index: number, delta: number): number[] {
  const a = ratios[index]
  const b = ratios[index + 1]
  if (a === undefined || b === undefined) return ratios
  const pair = a + b
  const nextA = Math.min(pair - SPLIT_MIN_RATIO, Math.max(SPLIT_MIN_RATIO, a + delta))
  const next = [...ratios]
  next[index] = nextA
  next[index + 1] = pair - nextA
  return next
}

/** Double-click on a divider: the two panes it separates share what they have equally (all of the stage, for a split view of two). */
export function balancePair(ratios: number[], index: number): number[] {
  const a = ratios[index]
  const b = ratios[index + 1]
  if (a === undefined || b === undefined) return ratios
  const next = [...ratios]
  next[index] = (a + b) / 2
  next[index + 1] = (a + b) / 2
  return next
}

/** The step of ← → on a divider: 5 % of the stage. */
export const SPLIT_KEY_STEP = 0.05

/**
 * The shares after a key pressed on the divider after pane `index`, or null for a key the divider does not use (it is left to the browser).
 * Side by side the divider answers ← → ; stacked, ↑ ↓. Home and End push it to the smallest a pane may have; Enter shares equally. A key pressed
 * with ⌘, ⌃ or ⌥ (`modified`) belongs to the menu bar and to the system, not to the divider.
 */
export function dividerKeyRatios(ratios: number[], index: number, key: string, orientation: SplitOrientation, modified = false): number[] | null {
  if (modified) return null
  const [less, more] = orientation === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  if (key === less) return resizeRatios(ratios, index, -SPLIT_KEY_STEP)
  if (key === more) return resizeRatios(ratios, index, SPLIT_KEY_STEP)
  if (key === 'Home') return resizeRatios(ratios, index, -1)
  if (key === 'End') return resizeRatios(ratios, index, 1)
  if (key === 'Enter') return balancePair(ratios, index)
  return null
}

/** What a screen reader says of a divider: the whole percentage of the pane before it and of the one after, and the bounds of the first one. */
export function dividerValues(ratios: number[], index: number): { now: number; min: number; max: number; first: number; second: number } | null {
  const a = ratios[index]
  const b = ratios[index + 1]
  if (a === undefined || b === undefined) return null
  const percent = (r: number) => Math.round(r * 100)
  const first = percent(a)
  // Two panes fill the stage: the second is what the first leaves, so that the two numbers read out add up to 100.
  const second = ratios.length === 2 ? 100 - first : percent(b)
  return { now: first, min: percent(SPLIT_MIN_RATIO), max: percent(a + b - SPLIT_MIN_RATIO), first, second }
}

export function equalRatios(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count)
}

/**
 * Whether a press of the user (a click, a key) in the page of `tabId` makes it the focused pane: it is another pane of the split view of the selected tab
 * (`panes`, undefined when the selected tab is in none). A page that is not in that split view (a tab behind, a page on its own) leaves the selection alone.
 */
export function paneTakesFocus(activeId: string | undefined, panes: readonly string[] | undefined, tabId: string): boolean {
  return activeId !== undefined && activeId !== tabId && panes !== undefined && panes.includes(activeId) && panes.includes(tabId)
}

/**
 * The pane the commands of the page act on (⌘+ ⌘− ⌘0, the find, print, the reader, a capture…): in a split view on screen (`panes`, the tabs on screen), the
 * one whose page has the keyboard (`hasFocus`, asked of the engine: a click in a frame of another site gives a pane the keyboard without telling the shell), and
 * the selected tab when none has it (the focus is in the sidebar, a toolbar or a panel). The selected pane is asked first; the others only when it does not have
 * the keyboard. A single page on screen is no split view: nothing is asked, it is the selected tab.
 */
export function commandPane(activeId: string | undefined, panes: readonly string[], hasFocus: (tabId: string) => boolean): string | undefined {
  if (activeId === undefined || panes.length < 2 || !panes.includes(activeId) || hasFocus(activeId)) return activeId
  return panes.find((id) => id !== activeId && hasFocus(id)) ?? activeId
}
