// Where the command bar of the page annotation stands (docs/design/annotation-partage-fenetre.md, « Position de la barre »). The bar is a window of its own
// over the page; this file is pure: the position the user chose (an edge, or a place of its own), how it is cleaned when it is read, which edge a drag
// lands on, the size of the bar in each layout, where it goes inside the window and the screen, and the entries of the menu of the positions.
// main/shell/page-annotate.ts puts the window there, renderer/page-annotate-command.ts draws the layout.

import { t, type MessageKey } from './i18n'
import { clamp } from './clamp'
import { BAR_EDGES, cleanBarPosition, layoutOf, type BarEdge, type BarLayout, type BarPosition } from './annotate-bar-position'
import { PAGE_TOOLS, type ScreenRect } from './page-annotate'
import { DRAW_COLORS } from './window-share-draw'

export { BAR_EDGES, BAR_LAYOUTS, DEFAULT_BAR_POSITION, cleanBarPosition, layoutOf } from './annotate-bar-position'
export type { BarEdge, BarLayout, BarPosition } from './annotate-bar-position'

/** The pointer within this many points of an edge of the window, while the grip is dragged, lands the bar on that edge. */
export const BAR_SNAP_DISTANCE = 24
/** The pointer has to move this far from where it went down before the grip drags the bar: a click on the grip does not move it. */
export const BAR_DRAG_THRESHOLD = 4
/** The bar stands this far from the edge it is on. */
export const BAR_INSET = 12
/** An arrow key moves a floating bar by this much, with Shift by the second. */
export const BAR_NUDGE = 10
export const BAR_NUDGE_LARGE = 50
/** The smallest window of Lucium (main/index.ts): the row is laid out for at least that width, and so is never narrower than at the narrowest window. */
export const MIN_WINDOW_WIDTH = 720

/**
 * The sizes of the bar, in points. The window is made this size and the page lays itself out with the same numbers (`barMetricVars`): one source, so that
 * the window is never smaller than what it holds. The column is the one it has always been (84 wide, 72 × 42 buttons); the row has narrower tools.
 */
export const BAR_METRICS = {
  /**
   * The column: the width of the window, and the height it asks for (a shorter window scrolls it). `head` is the height of the strip of the grip and the Position
   * button at its top, and `hintHeight` the one of the first-use hint (« Astuce »), which takes room above the strip while it is shown.
   */
  column: { width: 84, height: 1000, noteHeight: 84, head: 28, hintHeight: 128 },
  /** The height of a button, in both layouts. */
  button: 42,
  row: {
    /** Padding and border of the bar (the rows are centred inside). */
    padX: 10,
    padY: 6,
    border: 1,
    /** The space between two groups on a line, and between two lines. */
    groupGap: 10,
    lineGap: 4,
    /**
     * The grip and the Position button (both as high as a button), the Cursor key (which keeps its width: its label is a word and a shortcut), a tool (and the
     * timer of the automatic clearing, as wide as one), a text button (Annuler, Rétablir, Page, Tout, Quitter). The text buttons were 58 wide: the timer took
     * the 40 points they gave up, so that the row keeps its width (the longest label, « Rétablir », stays whole in 50).
     */
    grip: 28,
    position: 28,
    /** The space between the grip and the Position button, in both layouts. */
    handleGap: 2,
    key: 72,
    tool: 40,
    toolGap: 2,
    swatch: 20,
    swatchGap: 6,
    text: 50,
    /** The three looks of the laser, with the name of the one chosen under them. */
    styles: 78,
    /** The note under the buttons: two lines of 10 points, with the space above them. */
    noteHeight: 28,
    /** The first-use hint above the buttons: a line of its own (two when the row is narrow), and the space under it. */
    hintHeight: 44
  }
} as const

/** A point and a size, in points. */
export interface BarPoint {
  x: number
  y: number
}
export interface BarSize {
  width: number
  height: number
}

/** What changes the size of the bar while it runs: the laser has its looks to show, a refused page its note, and the first use its hint (absent: none). */
export interface BarContent {
  laser: boolean
  note: boolean
  hint?: boolean
}

/**
 * The edge the pointer lands the bar on while the grip is dragged: the nearest edge of the window the pointer is within `distance` of (a pointer past an edge
 * is near it), or null. The pointer decides, not the bar: a tall column is always near the top and the bottom of a window, and the grip is where the
 * hand is. Equal distances go to the left, right, top, bottom in that order.
 */
export function snapEdge(pointer: BarPoint, reference: ScreenRect, distance: number = BAR_SNAP_DISTANCE): BarEdge | null {
  const gaps: Array<[BarEdge, number]> = [
    ['left', pointer.x - reference.x],
    ['right', reference.x + reference.width - pointer.x],
    ['top', pointer.y - reference.y],
    ['bottom', reference.y + reference.height - pointer.y]
  ]
  let best: BarEdge | null = null
  let nearest = Infinity
  for (const [edge, gap] of gaps) {
    if (gap <= distance && gap < nearest) {
      best = edge
      nearest = gap
    }
  }
  return best
}

/**
 * The four bands along the edges of the window that a drag shows while it goes on (the drop zones): the places where `snapEdge` lands the bar, `distance` wide
 * and as long as the edge. The pointer within a band is the pointer `snapEdge` gives that edge to (a corner belongs to two bands: the nearest edge wins, as
 * in `snapEdge`, and the one that is highlighted is the one it gives). Coordinates of the screen, like `reference`.
 */
export function dropZones(reference: ScreenRect, distance: number = BAR_SNAP_DISTANCE): Record<BarEdge, ScreenRect> {
  const { x, y, width, height } = reference
  const band = { horizontal: Math.min(distance, width), vertical: Math.min(distance, height) }
  return {
    left: { x, y, width: band.horizontal, height },
    right: { x: x + width - band.horizontal, y, width: band.horizontal, height },
    top: { x, y, width, height: band.vertical },
    bottom: { x, y: y + height - band.vertical, width, height: band.vertical }
  }
}

/** Whether the pointer has gone far enough from where it went down for the grip to start a drag. */
export function dragStarted(from: BarPoint, to: BarPoint): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= BAR_DRAG_THRESHOLD
}

/**
 * The groups of the row, in order, with their widths: the head (grip, Position button and Cursor key), the tools, the looks of the laser (only with the laser), the
 * colours, the edits (the timer of the automatic clearing, then Annuler, Rétablir, Page, Tout), Quit.
 */
export function rowGroups(content: Pick<BarContent, 'laser'>): number[] {
  const { grip, position, handleGap, key, tool, toolGap, swatch, swatchGap, text, styles } = BAR_METRICS.row
  const tools = PAGE_TOOLS.length * tool + (PAGE_TOOLS.length - 1) * toolGap
  const colors = DRAW_COLORS.length * swatch + (DRAW_COLORS.length - 1) * swatchGap
  return [grip + handleGap + position + key, tools, ...(content.laser ? [styles] : []), colors, tool + 4 * text, text]
}

/**
 * The groups on each line when `widths` are put one after the other and the line is broken before the group that no longer fits (as `flex-wrap` does). A group
 * wider than the line stands alone on its line.
 */
export function wrapGroups(widths: readonly number[], gap: number, room: number): number[][] {
  const lines: number[][] = []
  let used = 0
  for (const width of widths) {
    const line = lines[lines.length - 1]
    if (line && used + gap + width <= room) {
      line.push(width)
      used += gap + width
    } else {
      lines.push([width])
      used = width
    }
  }
  return lines
}

/** The width of a line of groups: the groups, and the space between them. */
export function lineWidth(line: readonly number[], gap: number): number {
  return line.reduce((sum, width) => sum + width, 0) + Math.max(0, line.length - 1) * gap
}

/** How much room the bar has: the window it stands in, kept inside the screen, less its inset on both sides. The row is laid out for a window of 720 at the narrowest. */
export function barBudget(reference: ScreenRect, area: ScreenRect): BarSize {
  return {
    width: Math.max(0, Math.min(area.width, Math.max(reference.width, MIN_WINDOW_WIDTH)) - BAR_INSET * 2),
    height: Math.max(0, Math.min(area.height, reference.height) - BAR_INSET * 2)
  }
}

/**
 * The size of the bar in a layout. The column is `BAR_METRICS.column` wide and as high as it asks for, less when the window is shorter (it scrolls). The row
 * is as wide as its longest line: all on one line when `budget.width` allows, else in as many lines as the groups need, and no wider than the budget (unless
 * one group is: the row has no scrollbar, and the narrowest window is wider than any group, so nothing is ever cut). A note adds its lines under the buttons,
 * and the first-use hint a block above them.
 */
export function barSize(layout: BarLayout, content: BarContent, budget: BarSize): BarSize {
  const { column, button, row } = BAR_METRICS
  if (layout === 'column') return { width: column.width, height: Math.max(0, Math.min(column.height + (content.note ? column.noteHeight : 0) + (content.hint ? column.hintHeight : 0), budget.height)) }
  const frame = (row.padX + row.border) * 2
  const lines = wrapGroups(rowGroups(content), row.groupGap, Math.max(0, budget.width - frame))
  const widest = Math.max(...lines.map((line) => lineWidth(line, row.groupGap)))
  const height = lines.length * button + (lines.length - 1) * row.lineGap + (row.padY + row.border) * 2 + (content.note ? row.noteHeight : 0) + (content.hint ? row.hintHeight : 0)
  return { width: Math.round(widest + frame), height }
}

/** `rect` moved, without being resized, to lie inside `outer`; when it is larger than `outer`, its top left corner is the one that stays in. */
function within(rect: ScreenRect, outer: ScreenRect): ScreenRect {
  return { ...rect, x: clamp(rect.x, outer.x, outer.x + outer.width - rect.width), y: clamp(rect.y, outer.y, outer.y + outer.height - rect.height) }
}

/** A rectangle brought inside the window, then inside the screen: where a floating bar goes. The screen wins, so that the bar is always within reach. */
export function keepInside(rect: ScreenRect, reference: ScreenRect, area: ScreenRect): ScreenRect {
  const kept = within(within(rect, reference), area)
  return { ...kept, x: Math.round(kept.x), y: Math.round(kept.y) }
}

/**
 * Where the bar goes, in the coordinates of the screen: the position the user chose, in the window `reference` (the window, or the pane of the page when it
 * is in a split view), kept inside `area` (the work area of the screen the window is on). On an edge it stands `BAR_INSET` in from it, centred along it. Floating,
 * it is where it was left, and kept inside the window and the screen.
 */
export function barBounds(position: BarPosition, content: BarContent, reference: ScreenRect, area: ScreenRect): ScreenRect {
  const size = barSize(layoutOf(position), content, barBudget(reference, area))
  const centredX = reference.x + (reference.width - size.width) / 2
  const centredY = reference.y + (reference.height - size.height) / 2
  let x: number
  let y: number
  if (position.kind === 'floating') {
    x = reference.x + position.x
    y = reference.y + position.y
  } else if (position.edge === 'left') {
    x = reference.x + BAR_INSET
    y = centredY
  } else if (position.edge === 'right') {
    x = reference.x + reference.width - size.width - BAR_INSET
    y = centredY
  } else if (position.edge === 'top') {
    x = centredX
    y = reference.y + BAR_INSET
  } else {
    x = centredX
    y = reference.y + reference.height - size.height - BAR_INSET
  }
  // On an edge the bar stands where the window puts it, even when that is out of the screen: only the screen holds it back. Floating, the window holds it too.
  const placed = { x, y, ...size }
  if (position.kind === 'floating') return keepInside(placed, reference, area)
  const kept = within(placed, area)
  return { ...kept, x: Math.round(kept.x), y: Math.round(kept.y) }
}

/**
 * The floating position of a bar that stands at `bounds` (the coordinates of the screen) in the window `reference`, with the layout it has: what dropping it
 * there keeps. Cleaned like any position read from the file.
 */
export function floatingAt(bounds: ScreenRect, reference: ScreenRect, layout: BarLayout): BarPosition {
  return cleanBarPosition({ kind: 'floating', x: bounds.x - reference.x, y: bounds.y - reference.y, layout })
}

/** The bar while it is dragged: its top left corner is where the pointer is, less where the hand took it (`grab`), kept inside the window and the screen. */
export function dragBounds(pointer: BarPoint, grab: BarPoint, size: BarSize, reference: ScreenRect, area: ScreenRect): ScreenRect {
  return keepInside({ x: pointer.x - grab.x, y: pointer.y - grab.y, ...size }, reference, area)
}

/** The arrow keys of the grip: one step of a floating bar. */
export const NUDGE_DIRECTIONS = ['left', 'right', 'up', 'down'] as const
export type NudgeDirection = (typeof NUDGE_DIRECTIONS)[number]
export const isNudgeDirection = (raw: unknown): raw is NudgeDirection => (NUDGE_DIRECTIONS as readonly unknown[]).includes(raw)

/**
 * A floating bar moved by an arrow key: `BAR_NUDGE` points (`BAR_NUDGE_LARGE` with Shift), the result kept in the window and the screen so that what is
 * saved is where the bar really is. A bar on an edge does not move with the keys (the menu moves it from edge to edge): the position comes back as it was.
 */
export function nudgedPosition(position: BarPosition, direction: NudgeDirection, large: boolean, content: BarContent, reference: ScreenRect, area: ScreenRect): BarPosition {
  if (position.kind !== 'floating') return position
  const step = large ? BAR_NUDGE_LARGE : BAR_NUDGE
  const moved: BarPosition = {
    ...position,
    x: position.x + (direction === 'left' ? -step : direction === 'right' ? step : 0),
    y: position.y + (direction === 'up' ? -step : direction === 'down' ? step : 0)
  }
  // The bounds of the moved position are kept inside the window and the screen; the saved position is read back from them.
  return floatingAt(barBounds(moved, content, reference, area), reference, position.layout)
}

/** The name of each edge in the menu of the positions (the order is the one of `BAR_EDGES`). */
const EDGE_LABEL: Readonly<Record<BarEdge, MessageKey>> = {
  right: 'page-annotate.position-droite',
  left: 'page-annotate.position-gauche',
  top: 'page-annotate.position-haut',
  bottom: 'page-annotate.position-bas'
}

/** What the menu of the positions offers: the four edges, then « Flottante ». */
export type BarChoice = BarEdge | 'floating'
export type BarMenuEntry = { kind: 'title'; label: string } | { kind: 'item'; choice: BarChoice; label: string; checked: boolean } | { kind: 'separator' }

/**
 * The entries of the menu « Position de la barre » (right click on the grip, the menu key): a title, À droite, À gauche, En haut, En bas, a line, Flottante.
 * The position of the bar is the one checked. Labels in the language of the interface.
 */
export function barMenuEntries(position: BarPosition): BarMenuEntry[] {
  return [
    { kind: 'title', label: t('page-annotate.position-titre') },
    ...BAR_EDGES.map((choice): BarMenuEntry => ({ kind: 'item', choice, label: t(EDGE_LABEL[choice]), checked: position.kind === 'edge' && position.edge === choice })),
    { kind: 'separator' },
    { kind: 'item', choice: 'floating', label: t('page-annotate.position-flottante'), checked: position.kind === 'floating' }
  ]
}

/**
 * The position a choice of the menu gives. An edge: that edge. « Flottante »: the place the bar is at now, with the layout it has (so that it does not
 * jump), or the position as it was when it already floats.
 */
export function positionForChoice(choice: BarChoice, current: BarPosition, bounds: ScreenRect, reference: ScreenRect): BarPosition {
  if (choice !== 'floating') return { kind: 'edge', edge: choice }
  if (current.kind === 'floating') return current
  return floatingAt(bounds, reference, layoutOf(current))
}

/**
 * The sizes the page lays the bar out with, as the values of CSS custom properties on the root of the page: the column and the buttons, and the row. The page's
 * styles take every width of the bar from these, so that it is what `barSize` counted.
 */
export function barMetricVars(): Record<string, string> {
  const { column, button, row } = BAR_METRICS
  return {
    '--pa-column-w': `${column.width}px`,
    '--pa-button-h': `${button}px`,
    '--pa-key-w': `${row.key}px`,
    '--pa-grip-w': `${row.grip}px`,
    '--pa-position-w': `${row.position}px`,
    '--pa-handle-gap': `${row.handleGap}px`,
    '--pa-head-h': `${column.head}px`,
    '--pa-tool-w': `${row.tool}px`,
    '--pa-tool-gap': `${row.toolGap}px`,
    '--pa-swatch': `${row.swatch}px`,
    '--pa-swatch-gap': `${row.swatchGap}px`,
    '--pa-text-w': `${row.text}px`,
    '--pa-styles-w': `${row.styles}px`,
    '--pa-group-gap': `${row.groupGap}px`,
    '--pa-line-gap': `${row.lineGap}px`,
    '--pa-pad-x': `${row.padX}px`,
    '--pa-pad-y': `${row.padY}px`,
    '--pa-note-h': `${row.noteHeight}px`,
    '--pa-hint-col-h': `${column.hintHeight}px`,
    '--pa-hint-row-h': `${row.hintHeight}px`
  }
}
