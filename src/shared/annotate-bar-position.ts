// The position of the command bar of the page annotation (docs/design/annotation-partage-fenetre.md, « Position de la barre »): an edge of the window, or a
// place of its own. It is what the settings keep (Settings.annotateBar, shared/model.ts), so this file depends on nothing but `clamp`: the geometry of the bar
// is in annotate-bar.ts.

import { clamp } from './clamp'

/** The four edges of the window the bar may stand on, in the order of the menu. */
export const BAR_EDGES = ['right', 'left', 'top', 'bottom'] as const
export type BarEdge = (typeof BAR_EDGES)[number]

/** `column`: the buttons one under the other (on the left or right edge); `row`: side by side, in as many lines as the window is wide enough for (top or bottom edge). */
export const BAR_LAYOUTS = ['column', 'row'] as const
export type BarLayout = (typeof BAR_LAYOUTS)[number]

/**
 * Where the bar stands. `edge`: against an edge of the window, centred along it. `floating`: where it was dropped, `x` and `y` being the place of its
 * top left corner from the top left corner of the window (kept in the window when this one is smaller), and `layout` the way it is laid out there.
 */
export type BarPosition = { kind: 'edge'; edge: BarEdge } | { kind: 'floating'; x: number; y: number; layout: BarLayout }

/**
 * The bar is on the left edge by default: it has always been there (`barBounds` put it on the left edge of the window before the position could be
 * chosen). One line to change if the default is to be the right edge.
 */
export const DEFAULT_BAR_POSITION: BarPosition = { kind: 'edge', edge: 'left' }

/** A floating bar is never saved farther than this from the corner of its window: a damaged file cannot park it out of reach. */
const FLOATING_MAX = 20_000

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw)
const isEdge = (raw: unknown): raw is BarEdge => (BAR_EDGES as readonly unknown[]).includes(raw)
const isLayout = (raw: unknown): raw is BarLayout => (BAR_LAYOUTS as readonly unknown[]).includes(raw)

/**
 * The position a file or a patch holds, cleaned: an edge of the list, or a floating place with finite coordinates (rounded, kept between 0 and
 * `FLOATING_MAX`) and a layout of the list. Anything else, a field missing or of another kind included, gives the default. Only the fields of the position are
 * kept. The state file is the one place the position is kept in (Settings.annotateBar): this is what every reader and every writer goes through.
 */
export function cleanBarPosition(raw: unknown): BarPosition {
  if (!isRecord(raw)) return DEFAULT_BAR_POSITION
  if (raw['kind'] === 'edge') return isEdge(raw['edge']) ? { kind: 'edge', edge: raw['edge'] } : DEFAULT_BAR_POSITION
  if (raw['kind'] !== 'floating') return DEFAULT_BAR_POSITION
  const { x, y, layout } = raw
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || !isLayout(layout)) return DEFAULT_BAR_POSITION
  return { kind: 'floating', x: Math.round(clamp(x, 0, FLOATING_MAX)), y: Math.round(clamp(y, 0, FLOATING_MAX)), layout }
}

/** The layout of the bar at a position: a column on the left and right edges, a row on the top and bottom ones, and the one it was dropped with when floating. */
export function layoutOf(position: BarPosition): BarLayout {
  if (position.kind === 'floating') return position.layout
  return position.edge === 'left' || position.edge === 'right' ? 'column' : 'row'
}

