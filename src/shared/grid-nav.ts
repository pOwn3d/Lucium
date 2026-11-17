// The arrow keys in a grid that is cut into groups (the emoji picker: one grid of `cols` columns per category, one title above each). Pure: the picker asks
// where a key goes and moves the focus there.

export interface GridPos {
  group: number
  index: number
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export const isGridKey = (key: string): key is GridKey => key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'

/**
 * Where a key takes the focus. `sizes` is the number of cells of each group, in the order they are shown (an empty group is skipped). Left and right go
 * cell to cell and cross into the next group; up and down keep the column, and from the last row of a group go to the first row of the next one (the
 * nearest cell when that row is shorter). Home and End go to the first and last cell of the whole grid. Null when the key goes nowhere (an end of the grid,
 * or a position that is not in it): the focus stays.
 */
export function gridMove(sizes: readonly number[], pos: GridPos, key: GridKey, cols: number): GridPos | null {
  // A width that is not a finite number is one column: NaN or Infinity would give positions (`index: NaN`) the picker cannot focus.
  const width = Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : 1
  const size = (group: number): number => Math.max(0, Math.floor(sizes[group] ?? 0))
  if (pos.group < 0 || pos.group >= sizes.length || pos.index < 0 || pos.index >= size(pos.group)) return null
  const firstGroup = sizes.findIndex((_, group) => size(group) > 0)
  const lastGroup = sizes.findLastIndex((_, group) => size(group) > 0)
  const nextGroup = (from: number): number => sizes.findIndex((_, group) => group > from && size(group) > 0)
  const previousGroup = (from: number): number => sizes.findLastIndex((_, group) => group < from && size(group) > 0)

  switch (key) {
    case 'Home':
      return { group: firstGroup, index: 0 }
    case 'End':
      return { group: lastGroup, index: size(lastGroup) - 1 }
    case 'ArrowRight': {
      if (pos.index + 1 < size(pos.group)) return { group: pos.group, index: pos.index + 1 }
      const next = nextGroup(pos.group)
      return next < 0 ? null : { group: next, index: 0 }
    }
    case 'ArrowLeft': {
      if (pos.index > 0) return { group: pos.group, index: pos.index - 1 }
      const before = previousGroup(pos.group)
      return before < 0 ? null : { group: before, index: size(before) - 1 }
    }
    case 'ArrowDown': {
      if (pos.index + width < size(pos.group)) return { group: pos.group, index: pos.index + width }
      const next = nextGroup(pos.group)
      return next < 0 ? null : { group: next, index: Math.min(pos.index % width, size(next) - 1) }
    }
    case 'ArrowUp': {
      if (pos.index - width >= 0) return { group: pos.group, index: pos.index - width }
      const before = previousGroup(pos.group)
      if (before < 0) return null
      const lastRow = Math.floor((size(before) - 1) / width) * width
      return { group: before, index: Math.min(lastRow + (pos.index % width), size(before) - 1) }
    }
  }
}
