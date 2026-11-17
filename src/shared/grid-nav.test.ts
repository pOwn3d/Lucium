import { describe, expect, it } from 'vitest'
import { gridMove, isGridKey, type GridKey, type GridPos } from './grid-nav'

// Three categories in a grid of 4 columns: 6 cells (a row of 4 and a row of 2), 4 cells (one row), 5 cells (a row of 4 and one alone).
const SIZES = [6, 4, 5]
const move = (pos: GridPos, key: GridKey, sizes = SIZES, cols = 4) => gridMove(sizes, pos, key, cols)

describe('left and right', () => {
  it('go cell to cell inside a category', () => {
    expect(move({ group: 0, index: 1 }, 'ArrowRight')).toEqual({ group: 0, index: 2 })
    expect(move({ group: 0, index: 2 }, 'ArrowLeft')).toEqual({ group: 0, index: 1 })
  })

  it('cross into the next category at the end of one, and back', () => {
    expect(move({ group: 0, index: 5 }, 'ArrowRight')).toEqual({ group: 1, index: 0 })
    expect(move({ group: 1, index: 0 }, 'ArrowLeft')).toEqual({ group: 0, index: 5 })
  })

  it('stop at the two ends of the whole grid', () => {
    expect(move({ group: 2, index: 4 }, 'ArrowRight')).toBeNull()
    expect(move({ group: 0, index: 0 }, 'ArrowLeft')).toBeNull()
  })

  it('skip a category with nothing in it', () => {
    expect(move({ group: 0, index: 5 }, 'ArrowRight', [6, 0, 5])).toEqual({ group: 2, index: 0 })
    expect(move({ group: 2, index: 0 }, 'ArrowLeft', [6, 0, 5])).toEqual({ group: 0, index: 5 })
  })
})

describe('up and down', () => {
  it('keep the column inside a category', () => {
    expect(move({ group: 0, index: 1 }, 'ArrowDown')).toEqual({ group: 0, index: 5 })
    expect(move({ group: 0, index: 5 }, 'ArrowUp')).toEqual({ group: 0, index: 1 })
  })

  it('go to the first row of the next category from the last row, in the same column (the nearest cell when that row is shorter)', () => {
    expect(move({ group: 0, index: 4 }, 'ArrowDown')).toEqual({ group: 1, index: 0 })
    expect(move({ group: 0, index: 5 }, 'ArrowDown')).toEqual({ group: 1, index: 1 })
    expect(move({ group: 1, index: 3 }, 'ArrowDown')).toEqual({ group: 2, index: 3 })
    // Below the last cell of the first row there is no cell (the second row has two): the next category, same column.
    expect(move({ group: 0, index: 3 }, 'ArrowDown')).toEqual({ group: 1, index: 3 })
  })

  it('go to the last row of the previous category from the first row, in the same column', () => {
    expect(move({ group: 2, index: 0 }, 'ArrowUp')).toEqual({ group: 1, index: 0 })
    expect(move({ group: 1, index: 1 }, 'ArrowUp')).toEqual({ group: 0, index: 5 })
    expect(move({ group: 1, index: 3 }, 'ArrowUp')).toEqual({ group: 0, index: 5 })
    expect(move({ group: 1, index: 0 }, 'ArrowUp')).toEqual({ group: 0, index: 4 })
  })

  it('stop at the top and bottom of the whole grid', () => {
    expect(move({ group: 0, index: 2 }, 'ArrowUp')).toBeNull()
    expect(move({ group: 2, index: 4 }, 'ArrowDown')).toBeNull()
  })
})

describe('home and end', () => {
  it('go to the first and last cell of the whole grid', () => {
    expect(move({ group: 1, index: 2 }, 'Home')).toEqual({ group: 0, index: 0 })
    expect(move({ group: 1, index: 2 }, 'End')).toEqual({ group: 2, index: 4 })
    expect(move({ group: 1, index: 2 }, 'Home', [0, 4, 5])).toEqual({ group: 1, index: 0 })
    expect(move({ group: 1, index: 2 }, 'End', [6, 4, 0])).toEqual({ group: 1, index: 3 })
  })
})

describe('a position that is not in the grid', () => {
  it('goes nowhere, whatever the key', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const) {
      expect(move({ group: 5, index: 0 }, key), key).toBeNull()
      expect(move({ group: 0, index: 6 }, key), key).toBeNull()
      expect(move({ group: -1, index: 0 }, key), key).toBeNull()
      expect(move({ group: 0, index: -1 }, key), key).toBeNull()
    }
  })

  it('survives a width that is not a width', () => {
    expect(move({ group: 0, index: 0 }, 'ArrowDown', SIZES, 0)).toEqual({ group: 0, index: 1 })
    // Not a number either: one column, as for 0, and never a position the picker cannot focus (`index: NaN`).
    for (const cols of [Number.NaN, Number.POSITIVE_INFINITY, -3]) expect(move({ group: 0, index: 0 }, 'ArrowDown', SIZES, cols), String(cols)).toEqual({ group: 0, index: 1 })
    expect(move({ group: 0, index: 1 }, 'ArrowUp', SIZES, Number.NaN)).toEqual({ group: 0, index: 0 })
  })
})

it('knows the keys it handles', () => {
  expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].every(isGridKey)).toBe(true)
  expect(['Enter', 'a', 'Tab', ' '].some(isGridKey)).toBe(false)
})
