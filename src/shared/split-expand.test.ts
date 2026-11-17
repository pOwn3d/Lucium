import { describe, expect, it } from 'vitest'
import { SPLIT_MIN_RATIO } from './split'
import { expandedRatios, isExpanded, toggledGrid, toggledRatios } from './split-expand'

describe('expandedRatios', () => {
  it('gives the focused pane what the others’ minimum leaves, summing to one', () => {
    for (const [count, index] of [[2, 0], [2, 1], [3, 1], [4, 3]] as const) {
      const ratios = expandedRatios(count, index)
      expect(ratios.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
      expect(ratios.filter((_, i) => i !== index).every((r) => r === SPLIT_MIN_RATIO)).toBe(true)
      expect(ratios[index]).toBeCloseTo(1 - SPLIT_MIN_RATIO * (count - 1), 10)
    }
  })

  it('falls back to equal shares for a pane that does not exist', () => {
    expect(expandedRatios(2, 5)).toEqual([0.5, 0.5])
  })
})

describe('toggledRatios', () => {
  it('expands the focused pane, then gives equal shares back', () => {
    const expanded = toggledRatios([0.5, 0.5], 1)
    expect(isExpanded(expanded, 1)).toBe(true)
    expect(isExpanded(expanded, 0)).toBe(false)
    expect(toggledRatios(expanded, 1)).toEqual([0.5, 0.5])
  })

  it('expands another pane when it is not the one that is expanded', () => {
    expect(isExpanded(toggledRatios(toggledRatios([0.5, 0.5], 0), 1), 1)).toBe(true)
  })
})

describe('toggledGrid', () => {
  const max = 1 - SPLIT_MIN_RATIO

  it('gives the pane of a cell its column and its row, as wide and as high as the minimum of the others allows, then equal shares back', () => {
    const square = { column: 0.5, row: 0.5 }
    expect(toggledGrid(square, 4, 0)).toEqual({ column: max, row: max })
    expect(toggledGrid(square, 4, 3)).toEqual({ column: SPLIT_MIN_RATIO, row: SPLIT_MIN_RATIO })
    expect(toggledGrid(toggledGrid(square, 4, 3), 4, 3)).toEqual(square)
    // Another pane expanded already: this one takes its place.
    expect(toggledGrid(toggledGrid(square, 4, 0), 4, 1)).toEqual({ column: SPLIT_MIN_RATIO, row: max })
  })

  it('grows a pane along a whole side across it only, and keeps its side', () => {
    // Two on top, the third under them the whole width: it grows in height, the columns stay.
    expect(toggledGrid({ column: 0.3, row: 0.5, span: 'bottom' }, 3, 2)).toEqual({ column: 0.3, row: SPLIT_MIN_RATIO, span: 'bottom' })
    expect(toggledGrid({ column: 0.3, row: 0.5, span: 'left' }, 3, 0)).toEqual({ column: max, row: 0.5, span: 'left' })
    expect(toggledGrid({ column: 0.5, row: 0.5 }, 4, 7)).toEqual({ column: 0.5, row: 0.5 })
  })
})
