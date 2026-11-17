// View › Expand Current Split. The name of the command is all there is to go on, so the reading is: the focused pane takes as much of the
// split view as the others' minimum width allows, and choosing it again gives every pane the same share back.

import type { SplitGrid } from './model'
import { SPLIT_MIN_RATIO, equalRatios, gridCover } from './split'

/** The shares when pane `index` is expanded: the others keep the minimum, the focused one takes the rest. */
export function expandedRatios(count: number, index: number): number[] {
  if (count < 2 || index < 0 || index >= count) return equalRatios(Math.max(count, 1))
  const others = SPLIT_MIN_RATIO
  const rest = 1 - others * (count - 1)
  return Array.from({ length: count }, (_, i) => (i === index ? rest : others))
}

export const isExpanded = (ratios: readonly number[], index: number): boolean => ratios.length > 1 && ratios[index] !== undefined && ratios[index]! >= expandedRatios(ratios.length, index)[index]! - 1e-6

/** The shares after choosing the menu entry: expanded, or equal again when the pane already was. */
export function toggledRatios(ratios: readonly number[], index: number): number[] {
  return isExpanded(ratios, index) ? equalRatios(ratios.length) : expandedRatios(ratios.length, index)
}

/**
 * The same command on a grid: the pane at `index` takes as much of the width and of the height as the others' minimum allows (a pane along a whole
 * side only grows across it), and choosing it again gives the columns and the rows equal shares back.
 */
export function toggledGrid(grid: SplitGrid, count: number, index: number): SplitGrid {
  const cover = gridCover(grid, count, index)
  if (!cover) return grid
  const [c0, c1, r0, r1] = cover
  const grown = (first: number, last: number, share: number) => (first !== last ? share : first === 0 ? 1 - SPLIT_MIN_RATIO : SPLIT_MIN_RATIO)
  const column = grown(c0, c1, grid.column)
  const row = grown(r0, r1, grid.row)
  const already = Math.abs(grid.column - column) < 1e-6 && Math.abs(grid.row - row) < 1e-6
  return already ? { ...grid, column: 0.5, row: 0.5 } : { ...grid, column, row }
}
