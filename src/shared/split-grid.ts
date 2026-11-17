// The arrangements of a split view as a structure: a row, a column, or a grid of two columns and two rows (three or four panes). Where a tab that
// joins a split view goes (a side or a corner), what is left when a pane goes, and what « Disposition » in the menu of a split view switches.
// Pure; the geometry of the grid (rectangles, dividers) is in split.ts, the veil of a drop in split-drop.ts.
//
// A grid is read as four cells: top left, top right, bottom left, bottom right. Four panes fill one each, in reading order. Three panes leave one of
// them two cells along a whole side (`SplitGrid.span`). A split view of two panes is two cells each: side by side, a column each; stacked, a row each.

import type { GridSpan, SplitArrangement, SplitGrid, SplitView } from './model'
import { SPLIT_MAX_PANES, SPLIT_MIN_RATIO, equalRatios, gridSpanOf, isGridCount } from './split'
import { t, type MessageKey } from './i18n'

/** A side of a split view. */
export type PaneSide = 'left' | 'right' | 'top' | 'bottom'
export type GridCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const GRID_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const satisfies readonly GridCorner[]
/** Where a tab joins a split view: at a side (one more pane in the row or the column, or along a whole side of a grid) or in a corner (a grid). */
export type JoinZone = PaneSide | GridCorner

const SIDES = ['left', 'right', 'top', 'bottom'] as const satisfies readonly PaneSide[]
export const isPaneSide = (value: unknown): value is PaneSide => (SIDES as readonly unknown[]).includes(value)
export const isGridCorner = (value: unknown): value is GridCorner => (GRID_CORNERS as readonly unknown[]).includes(value)
export const isJoinZone = (value: unknown): value is JoinZone => isPaneSide(value) || isGridCorner(value)

/** What the layout of a split view is made of. */
export type SplitShape = Pick<SplitView, 'tabIds' | 'orientation' | 'ratios' | 'grid'>

/** Whether a split view is laid out as a grid: one with a grid and three or four panes (anything else is read as its row or column). */
const inGrid = (split: Pick<SplitView, 'tabIds' | 'grid'>): split is Pick<SplitView, 'tabIds'> & { grid: SplitGrid } => split.grid !== undefined && isGridCount(split.tabIds.length)

/** The arrangement a split view is in: the one « Disposition » checks. */
export const splitArrangement = (split: Pick<SplitView, 'tabIds' | 'orientation' | 'grid'>): SplitArrangement => (inGrid(split) ? 'grid' : split.orientation)

// ---- the cells ----

type Cell = 0 | 1 | 2 | 3
const CELLS: readonly Cell[] = [0, 1, 2, 3]
const CORNER_CELL: Record<GridCorner, Cell> = { 'top-left': 0, 'top-right': 1, 'bottom-left': 2, 'bottom-right': 3 }
const SIDE_CELLS: Record<PaneSide, readonly [Cell, Cell]> = { top: [0, 1], bottom: [2, 3], left: [0, 2], right: [1, 3] }
const adjacent = (a: Cell, b: Cell): boolean => a !== b && ((a >> 1) === (b >> 1) || (a & 1) === (b & 1))

/** The pane of each cell: a grid, or a split view of two; null for a row or a column of three or four (no 2 × 2 reading). */
function cellsOf(split: SplitShape): string[] | null {
  const [a, b, c, d] = split.tabIds
  if (inGrid(split)) {
    if (split.tabIds.length === 4) return [a!, b!, c!, d!]
    const span = gridSpanOf(split.grid, 3)
    if (span === 'top') return [a!, a!, b!, c!]
    if (span === 'bottom') return [a!, b!, c!, c!]
    if (span === 'left') return [a!, b!, a!, c!]
    return [a!, b!, c!, b!]
  }
  if (split.tabIds.length !== 2) return null
  return split.orientation === 'horizontal' ? [a!, b!, a!, b!] : [a!, a!, b!, b!]
}

/** The grid that a filling of the cells makes: four panes, or three with the one in two cells along their side. Null for any other filling. */
function fromCells(cells: readonly string[]): { tabIds: string[]; span?: GridSpan } | null {
  const tabIds = [...new Set(cells)]
  if (tabIds.length === 4) return { tabIds }
  if (tabIds.length !== 3) return null
  const [c0, c1, c2, c3] = cells
  if (c0 === c1) return { tabIds, span: 'top' }
  if (c2 === c3) return { tabIds, span: 'bottom' }
  if (c0 === c2) return { tabIds, span: 'left' }
  if (c1 === c3) return { tabIds, span: 'right' }
  return null
}

const clampShare = (share: number): number => Math.min(1 - SPLIT_MIN_RATIO, Math.max(SPLIT_MIN_RATIO, share))

/** The split view in a grid of `tabIds`: its panes share equally the row or column it would go back to. */
function withGrid<T extends SplitShape>(split: T, tabIds: string[], grid: SplitGrid): T {
  return { ...split, tabIds, ratios: equalRatios(tabIds.length), grid }
}

/** The split view as a row or a column, without its grid. */
function asLine<T extends SplitShape>(split: T, fields: Pick<SplitView, 'tabIds' | 'orientation' | 'ratios'>): T {
  const { grid: _grid, ...line } = split
  return { ...line, ...fields } as T
}

// ---- joining ----

/** The end of a row or a column that a side is: its start (left, top), its end (right, bottom), or null for a side across it. */
function lineEnd(split: Pick<SplitView, 'orientation'>, side: PaneSide): 'start' | 'end' | null {
  if (split.orientation === 'horizontal') return side === 'left' ? 'start' : side === 'right' ? 'end' : null
  return side === 'top' ? 'start' : side === 'bottom' ? 'end' : null
}

/**
 * Where a tab can join this split view. A row grows at its left or right end and a column at its top or bottom end (four panes at most); a split view of
 * two also takes a tab along a whole side across it (two side by side and one under them, or one beside two stacked) and in any corner, which makes a grid
 * of three; one of three takes a tab in any corner, which makes a grid of 2 × 2. A grid of three takes a tab in its corners only. A full one takes none.
 */
export function joinZones(host: Pick<SplitView, 'tabIds' | 'orientation' | 'grid'>): JoinZone[] {
  const count = host.tabIds.length
  if (count < 2 || count >= SPLIT_MAX_PANES) return []
  if (inGrid(host)) return [...GRID_CORNERS]
  const ends: PaneSide[] = host.orientation === 'horizontal' ? ['left', 'right'] : ['top', 'bottom']
  if (count === 3) return [...ends, ...GRID_CORNERS]
  const across: PaneSide[] = host.orientation === 'horizontal' ? ['top', 'bottom'] : ['left', 'right']
  return [...ends, ...across, ...GRID_CORNERS]
}

export const canJoinAt = (host: Pick<SplitView, 'tabIds' | 'orientation' | 'grid'>, zone: JoinZone): boolean => joinZones(host).includes(zone)

/**
 * Where a tab joins when nothing says where (the menu « Ajouter un onglet à la vue scindée », the command bar, Glance's « Ouvrir en vue scindée »): the
 * end of a row or a column, as before grids; in a grid of three, the second cell of the pane along a whole side, which gives it up.
 */
export function defaultJoinZone(host: Pick<SplitView, 'tabIds' | 'orientation' | 'grid'>): JoinZone {
  if (inGrid(host) && host.tabIds.length === 3) {
    const span = gridSpanOf(host.grid, 3)
    return span === 'top' ? 'top-right' : span === 'left' ? 'bottom-left' : 'bottom-right'
  }
  return host.orientation === 'horizontal' ? 'right' : 'bottom'
}

/**
 * The split view once `tabId` has joined it at `zone`, or null when it cannot take it there (the zone is not one of `joinZones`, it is full, or the tab
 * already is one of its panes).
 * - An end of a row or a column: one more pane there, all of them sharing equally (as before grids).
 * - A side across a split view of two: the tab along that whole side, the two others keeping their order and their shares in the other row or column.
 * - A corner of a split view of two: the tab in that corner, the pane that held it keeps its other cell, the other pane runs along its whole side.
 * - A corner of a row or a column of three: a grid of 2 × 2, the panes in their order, the tab taking the corner's place in it.
 * - A corner of a grid of three: the pane along a whole side gives up the cell next to the corner; a pane of its own in the corner slides into it first.
 */
export function joined<T extends SplitShape>(host: T, tabId: string, zone: JoinZone = defaultJoinZone(host)): T | null {
  if (host.tabIds.includes(tabId) || !canJoinAt(host, zone)) return null
  const grid = inGrid(host) ? host.grid : null
  if (!grid && isPaneSide(zone)) {
    const end = lineEnd(host, zone)
    if (end !== null) {
      const tabIds = end === 'start' ? [tabId, ...host.tabIds] : [...host.tabIds, tabId]
      return { ...host, tabIds, ratios: equalRatios(tabIds.length) }
    }
  }
  if (!grid && host.tabIds.length === 3) {
    const at = CORNER_CELL[zone as GridCorner]
    return withGrid(host, [...host.tabIds.slice(0, at), tabId, ...host.tabIds.slice(at)], { column: 0.5, row: 0.5 })
  }
  const cells = cellsOf(host)
  if (!cells) return null
  if (isPaneSide(zone)) for (const cell of SIDE_CELLS[zone]) cells[cell] = tabId
  else {
    const at = CORNER_CELL[zone]
    const there = cells[at]!
    if (cells.indexOf(there) === cells.lastIndexOf(there)) {
      const long = cells.find((id) => cells.indexOf(id) !== cells.lastIndexOf(id))
      const beside = CELLS.find((cell) => cells[cell] === long && adjacent(cell, at))
      if (beside === undefined) return null
      cells[beside] = there
    }
    cells[at] = tabId
  }
  const made = fromCells(cells)
  if (!made) return null
  // A split view of two keeps the share of its first pane on the axis it had; a grid keeps both of its shares.
  const shares = grid ?? (host.orientation === 'horizontal' ? { column: clampShare(host.ratios[0] ?? 0.5), row: 0.5 } : { column: 0.5, row: clampShare(host.ratios[0] ?? 0.5) })
  return withGrid(host, made.tabIds, { column: shares.column, row: shares.row, ...(made.span ? { span: made.span } : {}) })
}

// ---- leaving ----

/**
 * The split view without the pane of `tabId` (the same object when it is not one of them). A row or a column closes up and shares equally, as before
 * grids. A grid of four becomes one of three: the pane beside it in its row takes its cell, and so runs along that whole side. A grid of three becomes two
 * panes as they were placed: the pane along a whole side gone, the two of the other row (or column) stay side by side (or stacked); one of those gone, the
 * other and the long pane are stacked (or side by side). They keep the share of the divider between them.
 */
export function withoutPane<T extends SplitShape>(split: T, tabId: string): T {
  const at = split.tabIds.indexOf(tabId)
  if (at < 0) return split
  if (inGrid(split)) {
    const cells = cellsOf(split)!
    if (split.tabIds.length === 4) {
      cells[at] = cells[at ^ 1]!
      const made = fromCells(cells)!
      return withGrid(split, made.tabIds, { column: split.grid.column, row: split.grid.row, span: made.span! })
    }
    const span = gridSpanOf(split.grid, 3)
    const long = cells.find((id) => cells.indexOf(id) !== cells.lastIndexOf(id))
    const longIsRow = span === 'top' || span === 'bottom'
    const sideBySide = (tabId === long) === longIsRow
    // Left first side by side, top first stacked, whatever their reading order was.
    const first = (id: string) => (sideBySide ? cells[0] === id || cells[2] === id : cells[0] === id || cells[1] === id)
    const tabIds = split.tabIds.filter((id) => id !== tabId).sort((a, b) => Number(first(b)) - Number(first(a)))
    const share = sideBySide ? split.grid.column : split.grid.row
    return asLine(split, { tabIds, orientation: sideBySide ? 'horizontal' : 'vertical', ratios: [share, 1 - share] })
  }
  const tabIds = split.tabIds.filter((id) => id !== tabId)
  return asLine(split, { tabIds, orientation: split.orientation, ratios: equalRatios(tabIds.length) })
}

/** The split view with only the panes of `keep` (in its own order of removal): what is left of it when some of its tabs are gone. */
export function keepPanes<T extends SplitShape>(split: T, keep: readonly string[]): T {
  return split.tabIds.filter((id) => !keep.includes(id)).reduce<T>((left, id) => withoutPane(left, id), split)
}

// ---- « Disposition » ----

export const SPLIT_ARRANGEMENTS = ['horizontal', 'vertical', 'grid'] as const satisfies readonly SplitArrangement[]
export const isSplitArrangement = (value: unknown): value is SplitArrangement => (SPLIT_ARRANGEMENTS as readonly unknown[]).includes(value)

/** A grid needs three or four panes; a row and a column take any split view. */
export const canArrange = (split: Pick<SplitView, 'tabIds'>, arrangement: SplitArrangement): boolean => arrangement !== 'grid' || isGridCount(split.tabIds.length)

/**
 * The split view in `arrangement`, the same object when it already is (or cannot be: a grid of two). The panes keep their order, which is the reading
 * order of a grid. A row of three goes to two on top and one under them, a column of three to one on the left and two stacked at its right; both share
 * equally. Back to a row or a column, the panes take again the shares they had in it.
 */
export function arranged<T extends SplitShape>(split: T, arrangement: SplitArrangement): T {
  if (arrangement === 'grid') {
    if (inGrid(split) || !canArrange(split, 'grid')) return split
    const span: GridSpan | null = split.tabIds.length === 3 ? (split.orientation === 'vertical' ? 'left' : 'bottom') : null
    return { ...split, grid: { column: 0.5, row: 0.5, ...(span ? { span } : {}) } }
  }
  if (!inGrid(split) && split.grid === undefined && split.orientation === arrangement) return split
  return asLine(split, { tabIds: split.tabIds, orientation: arrangement, ratios: split.ratios })
}

const ARRANGEMENT_LABELS: Record<SplitArrangement, MessageKey> = {
  horizontal: 'ctx.disposition-cote-a-cote',
  vertical: 'ctx.disposition-en-colonne',
  grid: 'ctx.disposition-grille'
}

/** An entry of « Disposition »: checked for the arrangement the split view is in, greyed out for a grid of two panes. */
export interface ArrangementChoice {
  arrangement: SplitArrangement
  label: string
  checked: boolean
  enabled: boolean
}

export function arrangementChoices(split: Pick<SplitView, 'tabIds' | 'orientation' | 'grid'>): ArrangementChoice[] {
  const now = splitArrangement(split)
  return SPLIT_ARRANGEMENTS.map((arrangement) => ({ arrangement, label: t(ARRANGEMENT_LABELS[arrangement]), checked: arrangement === now, enabled: canArrange(split, arrangement) }))
}
