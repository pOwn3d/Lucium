import { describe, expect, it } from 'vitest'
import { balancePair, commandPane, dividerKeyRatios, dividerValues, equalRatios, gridCover, gridDividerValues, gridDividers, gridKeyShare, gridLayout, gridRoom, gridSpanOf, isGridCount, resizeShare, hasSplitBar, pageRadius, PAGE_RADIUS, paneContent, paneTakesFocus, resizeRatios, splitBarRect, splitDividers, splitLayout, splitPaneStage, SPLIT_BAR_GAP, SPLIT_BAR_HEIGHT, SPLIT_GAP, SPLIT_KEY_STEP, SPLIT_MIN_RATIO, SPLIT_RING } from './split'

describe('splitLayout', () => {
  it('places two panes side by side with a gap and fills the stage', () => {
    const panes = splitLayout({ width: 1000 + SPLIT_GAP, height: 600 }, { orientation: 'horizontal', ratios: [0.5, 0.5] })
    expect(panes).toEqual([
      { x: 0, y: 0, width: 500, height: 600 },
      { x: 500 + SPLIT_GAP, y: 0, width: 500, height: 600 }
    ])
  })

  it('stacks panes in vertical orientation', () => {
    const panes = splitLayout({ width: 800, height: 400 + SPLIT_GAP }, { orientation: 'vertical', ratios: [0.25, 0.75] })
    expect(panes.map((p) => [p.y, p.height])).toEqual([[0, 100], [100 + SPLIT_GAP, 300]])
    expect(panes.every((p) => p.width === 800 && p.x === 0)).toBe(true)
  })

  it('exposes one divider per gap, sitting exactly in that gap', () => {
    const panes = splitLayout({ width: 1000, height: 500 }, { orientation: 'horizontal', ratios: equalRatios(3) })
    const dividers = splitDividers(panes, 'horizontal')
    expect(dividers).toHaveLength(2)
    expect(dividers[0]).toMatchObject({ x: panes[0]!.width, width: SPLIT_GAP, height: 500 })
    expect(dividers[1]!.x).toBe(panes[1]!.x + panes[1]!.width)
  })
})

describe('splitLayout with a toolbar for each pane', () => {
  it('leaves side-by-side panes alone: all their bars share the row above the stage', () => {
    const stage = { width: 1347, height: 836 }
    expect(splitLayout(stage, { orientation: 'horizontal', ratios: [0.5, 0.5] }, SPLIT_GAP, 32)).toEqual(splitLayout(stage, { orientation: 'horizontal', ratios: [0.5, 0.5] }))
  })

  it('makes room, for stacked panes, for the bar of each pane after the first: gap + bar between two pages', () => {
    const panes = splitLayout({ width: 1347, height: 836 }, { orientation: 'vertical', ratios: [0.5, 0.5] }, SPLIT_GAP, 32)
    expect(panes[0]).toEqual({ x: 0, y: 0, width: 1347, height: 397 })
    expect(panes[1]!.y).toBe(397 + SPLIT_GAP + 32)
    // The pages and what is between them fill the stage exactly.
    expect(panes[1]!.y + panes[1]!.height).toBe(836)
  })

  it('keeps the divider in the gap above the next bar, not over the bar', () => {
    const panes = splitLayout({ width: 1347, height: 836 }, { orientation: 'vertical', ratios: [0.5, 0.5] }, SPLIT_GAP, 32)
    const [divider] = splitDividers(panes, 'vertical')
    expect(divider!.y).toBe(panes[0]!.y + panes[0]!.height)
    expect(divider!.y + divider!.height).toBe(panes[1]!.y - 32)
  })
})

describe('resizeRatios', () => {
  it('moves the boundary between two panes and keeps the total', () => {
    const next = resizeRatios([0.5, 0.5], 0, 0.2)
    expect(next[0]).toBeCloseTo(0.7)
    expect(next[0]! + next[1]!).toBeCloseTo(1)
  })

  it('never shrinks a pane below the minimum', () => {
    const next = resizeRatios([0.5, 0.5], 0, 0.9)
    expect(next[1]).toBeCloseTo(SPLIT_MIN_RATIO)
    expect(resizeRatios([0.5, 0.5], 0, -0.9)[0]).toBeCloseTo(SPLIT_MIN_RATIO)
  })

  it('ignores an out-of-range divider', () => {
    expect(resizeRatios([0.5, 0.5], 5, 0.1)).toEqual([0.5, 0.5])
  })
})

describe('paneContent', () => {
  const pane = { x: 679, y: 0, width: 669, height: 836 }

  it("leaves the unfocused pane's page the whole pane", () => {
    expect(paneContent(pane, false)).toEqual(pane)
  })

  it("insets the focused pane's page by the ring (2 px) on its sides and bottom, not under the bar: the blue is at x = 1002..1003, the page from 1004", () => {
    expect(SPLIT_RING).toBe(2)
    expect(paneContent(pane, true)).toEqual({ x: 681, y: 0, width: 665, height: 834 })
  })

  it('never goes negative in a pane the user squeezed to nothing', () => {
    expect(paneContent({ x: 0, y: 0, width: 3, height: 1 }, true)).toEqual({ x: 2, y: 0, width: 0, height: 0 })
  })
})

describe('pageRadius', () => {
  it("is the card's 8 px, and 6 for the page inside a split view's ring: the ring's own inner edge (8 less its 2 px)", () => {
    expect(PAGE_RADIUS).toBe(8)
    expect(pageRadius(false)).toBe(8)
    expect(pageRadius(true)).toBe(6)
    expect(pageRadius(true, 3)).toBe(5)
  })

  it('never goes negative, whatever the ring', () => {
    expect(pageRadius(true, 20)).toBe(0)
  })
})

describe('the bar under a split view of two panes', () => {
  const two = { tabIds: ['a', 'b'] }
  const three = { tabIds: ['a', 'b', 'c'] }

  it('belongs to a split view of exactly two panes', () => {
    expect(hasSplitBar(two)).toBe(true)
    expect(hasSplitBar(three)).toBe(false)
    expect(hasSplitBar({ tabIds: ['a'] })).toBe(false)
  })

  it('takes 36 px and the 8 px above it off the stage of the panes, so that no native page ever goes under it', () => {
    expect(SPLIT_BAR_HEIGHT).toBe(36)
    const stage = { width: 1000, height: 600 }
    expect(splitPaneStage(stage, two)).toEqual({ width: 1000, height: 600 - SPLIT_BAR_HEIGHT - SPLIT_BAR_GAP })
    const panes = splitLayout(splitPaneStage(stage, two), { orientation: 'horizontal', ratios: [0.5, 0.5] })
    expect(panes.every((pane) => pane.y + pane.height <= 600 - SPLIT_BAR_HEIGHT - SPLIT_BAR_GAP)).toBe(true)
  })

  it('leaves the stage of the other split views as it is, and the extra fields of the stage with it', () => {
    const stage = { x: 3, y: 4, width: 1000, height: 600 }
    expect(splitPaneStage(stage, three)).toBe(stage)
    expect(splitPaneStage(stage, two)).toMatchObject({ x: 3, y: 4, width: 1000 })
  })

  it('never makes the stage negative in a window squeezed under the bar', () => {
    expect(splitPaneStage({ width: 300, height: 20 }, two).height).toBe(0)
  })

  it('has its strip at the foot of the stage, below the panes and their gap', () => {
    const stage = { width: 1000, height: 600 }
    const strip = splitBarRect(stage, two)!
    expect(strip).toEqual({ x: 0, y: 600 - SPLIT_BAR_HEIGHT, width: 1000, height: SPLIT_BAR_HEIGHT })
    expect(strip.y).toBeGreaterThanOrEqual(splitPaneStage(stage, two).height + SPLIT_BAR_GAP)
    expect(splitBarRect(stage, three)).toBeNull()
  })
})

describe('balancePair (double-click on a divider)', () => {
  it('gives two panes the same share: 50 / 50 for a split view of two', () => {
    expect(balancePair([0.3, 0.7], 0)).toEqual([0.5, 0.5])
  })

  it('only shares what the two panes around the divider have, and leaves the others alone', () => {
    const next = balancePair([0.1, 0.5, 0.4], 1)
    expect(next[0]).toBe(0.1)
    expect(next[1]).toBeCloseTo(0.45)
    expect(next[2]).toBeCloseTo(0.45)
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('does nothing for a divider that is not there', () => {
    const ratios = [0.5, 0.5]
    expect(balancePair(ratios, 1)).toBe(ratios)
    expect(balancePair(ratios, -1)).toBe(ratios)
  })
})

describe('dividerKeyRatios (the keys of a divider that has the keyboard)', () => {
  it('moves a divider side by side by 5 % with ← and →', () => {
    expect(SPLIT_KEY_STEP).toBe(0.05)
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowLeft', 'horizontal')![0]).toBeCloseTo(0.45)
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowRight', 'horizontal')![0]).toBeCloseTo(0.55)
  })

  it('moves a stacked divider with ↑ and ↓, and leaves ← → to the page', () => {
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowUp', 'vertical')![0]).toBeCloseTo(0.45)
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowDown', 'vertical')![0]).toBeCloseTo(0.55)
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowLeft', 'vertical')).toBeNull()
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowUp', 'horizontal')).toBeNull()
  })

  it('never takes a pane under the minimum, with the arrows, Home or End', () => {
    expect(dividerKeyRatios([SPLIT_MIN_RATIO + 0.01, 1 - SPLIT_MIN_RATIO - 0.01], 0, 'ArrowLeft', 'horizontal')![0]).toBeCloseTo(SPLIT_MIN_RATIO)
    expect(dividerKeyRatios([0.5, 0.5], 0, 'Home', 'horizontal')![0]).toBeCloseTo(SPLIT_MIN_RATIO)
    expect(dividerKeyRatios([0.5, 0.5], 0, 'End', 'horizontal')![1]).toBeCloseTo(SPLIT_MIN_RATIO)
  })

  it('leaves a key pressed with ⌘, ⌃ or ⌥ to the menu bar and the system', () => {
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowLeft', 'horizontal', true)).toBeNull()
    expect(dividerKeyRatios([0.5, 0.5], 0, 'Home', 'horizontal', true)).toBeNull()
    expect(dividerKeyRatios([0.5, 0.5], 0, 'Enter', 'horizontal', true)).toBeNull()
    expect(dividerKeyRatios([0.5, 0.5], 0, 'ArrowLeft', 'horizontal', false)).not.toBeNull()
  })

  it('shares equally with Enter, and ignores every other key', () => {
    expect(dividerKeyRatios([0.2, 0.8], 0, 'Enter', 'horizontal')).toEqual([0.5, 0.5])
    expect(dividerKeyRatios([0.2, 0.8], 0, 'a', 'horizontal')).toBeNull()
    expect(dividerKeyRatios([0.2, 0.8], 0, 'Tab', 'horizontal')).toBeNull()
  })
})

describe('dividerValues (what a screen reader reads of a divider)', () => {
  it('reads whole percentages that add up to 100 for two panes, whatever the rounding', () => {
    expect(dividerValues([0.5, 0.5], 0)).toMatchObject({ now: 50, first: 50, second: 50 })
    expect(dividerValues([0.125, 0.875], 0)).toMatchObject({ first: 13, second: 87 })
    const odd = dividerValues([0.333, 0.667], 0)!
    expect(odd.first + odd.second).toBe(100)
  })

  it('bounds the first pane by the minimum of each pane', () => {
    expect(dividerValues([0.5, 0.5], 0)).toMatchObject({ min: 12, max: 88 })
    expect(dividerValues([0.2, 0.3, 0.5], 0)).toMatchObject({ min: 12, max: 38 })
  })

  it('has nothing to say of a divider that is not there', () => {
    expect(dividerValues([0.5, 0.5], 1)).toBeNull()
  })
})

// A zoom in a split view used to work in one pane only: the zoom, the
// find, print… act on the pane that has the keyboard, which a click in a frame of another site gives a pane without the shell being told.
describe('commandPane', () => {
  /** The engine's answer: the pages that have the keyboard; every question is noted. */
  const engine = (...focused: string[]) => {
    const asked: string[] = []
    return { asked, hasFocus: (id: string) => (asked.push(id), focused.includes(id)) }
  }

  // Guard: the pane that has the keyboard wins over the selected tab.
  it('is the pane whose page has the keyboard, when that is not the selected tab', () => {
    expect(commandPane('zoom', ['zoom', 'notes'], engine('notes').hasFocus)).toBe('notes')
    expect(commandPane('a', ['a', 'b', 'c'], engine('c').hasFocus)).toBe('c')
  })

  it('is the selected tab when its page has the keyboard, and the other panes are not asked', () => {
    const e = engine('zoom', 'notes')
    expect(commandPane('zoom', ['zoom', 'notes'], e.hasFocus)).toBe('zoom')
    expect(e.asked).toEqual(['zoom'])
  })

  it('is the selected tab when no page has the keyboard (the sidebar, a toolbar, the button of the zoom mark, a panel has it)', () => {
    expect(commandPane('zoom', ['zoom', 'notes'], engine().hasFocus)).toBe('zoom')
  })

  it('asks nothing outside a split view: the selected tab, as before', () => {
    const e = engine('other')
    expect(commandPane('a', ['a'], e.hasFocus)).toBe('a')
    expect(commandPane('a', [], e.hasFocus)).toBe('a')
    expect(commandPane(undefined, ['a', 'b'], e.hasFocus)).toBeUndefined()
    expect(e.asked).toEqual([])
  })

  it('never goes to a page that is not on screen, even when it has the keyboard', () => {
    expect(commandPane('a', ['a', 'b'], engine('behind').hasFocus)).toBe('a')
    // The selected tab not among the panes (a stale list): it stays, nothing is asked.
    const e = engine('b')
    expect(commandPane('x', ['a', 'b'], e.hasFocus)).toBe('x')
    expect(e.asked).toEqual([])
  })
})

describe('paneTakesFocus', () => {
  // Guard: a press in the other pane of the split view on screen moves the focus there.
  it('moves the focus to another pane of the split view of the selected tab', () => {
    expect(paneTakesFocus('zoom', ['zoom', 'notes'], 'notes')).toBe(true)
  })

  it('leaves the selection alone for the selected pane, a tab outside the split view, or no split view', () => {
    expect(paneTakesFocus('zoom', ['zoom', 'notes'], 'zoom')).toBe(false)
    expect(paneTakesFocus('zoom', ['zoom', 'notes'], 'behind')).toBe(false)
    expect(paneTakesFocus('zoom', undefined, 'notes')).toBe(false)
    expect(paneTakesFocus(undefined, ['zoom', 'notes'], 'notes')).toBe(false)
  })
})

describe('the geometry of a grid', () => {
  // A stage of 1010 x 642: less the 10 px gap, 1000 wide; less the gap and the 32 px bar of the bottom row, 600 high.
  const STAGE = { width: 1010, height: 642 }
  const HEADER = 32
  const square = { column: 0.5, row: 0.5 }
  const shares = { column: 0.3, row: 0.6 }

  it('2 x 2: four cells in reading order, the bottom row below the gap and its own bars, the whole stage filled', () => {
    expect(gridLayout(STAGE, square, 4, SPLIT_GAP, HEADER)).toEqual([
      { x: 0, y: 0, width: 500, height: 300 },
      { x: 510, y: 0, width: 500, height: 300 },
      { x: 0, y: 342, width: 500, height: 300 },
      { x: 510, y: 342, width: 500, height: 300 }
    ])
    const panes = gridLayout(STAGE, shares, 4, SPLIT_GAP, HEADER)
    expect(panes.map((p) => [p.width, p.height])).toEqual([[300, 360], [700, 360], [300, 240], [700, 240]])
    expect(panes[3]!.x + panes[3]!.width).toBe(STAGE.width)
    expect(panes[3]!.y + panes[3]!.height).toBe(STAGE.height)
    // The bar of a pane of the bottom row sits right under the gap between the rows, like the bar of the second pane of a stack.
    expect(panes[2]!.y - HEADER).toBe(panes[0]!.y + panes[0]!.height + SPLIT_GAP)
  })

  it('three: the pane along a whole side covers both of its cells and the gap between them', () => {
    const at = (span: 'top' | 'bottom' | 'left' | 'right') => gridLayout(STAGE, { ...shares, span }, 3, SPLIT_GAP, HEADER)
    // Two on top and one under them, the whole width.
    expect(at('bottom')).toEqual([{ x: 0, y: 0, width: 300, height: 360 }, { x: 310, y: 0, width: 700, height: 360 }, { x: 0, y: 402, width: 1010, height: 240 }])
    // One on the left, the whole height, and two stacked at its right.
    expect(at('left')).toEqual([{ x: 0, y: 0, width: 300, height: 642 }, { x: 310, y: 0, width: 700, height: 360 }, { x: 310, y: 402, width: 700, height: 240 }])
    expect(at('top')).toEqual([{ x: 0, y: 0, width: 1010, height: 360 }, { x: 0, y: 402, width: 300, height: 240 }, { x: 310, y: 402, width: 700, height: 240 }])
    expect(at('right')).toEqual([{ x: 0, y: 0, width: 300, height: 360 }, { x: 310, y: 0, width: 700, height: 642 }, { x: 0, y: 402, width: 300, height: 240 }])
    // A grid of three that names no side is two on top and one under them; one of four ignores a side.
    expect(gridLayout(STAGE, shares, 3, SPLIT_GAP, HEADER)).toEqual(at('bottom'))
    expect(gridLayout(STAGE, { ...shares, span: 'left' }, 4, SPLIT_GAP, HEADER)).toEqual(gridLayout(STAGE, shares, 4, SPLIT_GAP, HEADER))
  })

  it('is what splitLayout gives a split view with a grid of three or four panes; with two panes the grid is ignored', () => {
    const grid = { ...shares, span: 'left' as const }
    expect(splitLayout(STAGE, { orientation: 'vertical', ratios: equalRatios(3), grid }, SPLIT_GAP, HEADER)).toEqual(gridLayout(STAGE, grid, 3, SPLIT_GAP, HEADER))
    expect(splitLayout(STAGE, { orientation: 'horizontal', ratios: [0.5, 0.5], grid }, SPLIT_GAP, HEADER)).toEqual(splitLayout(STAGE, { orientation: 'horizontal', ratios: [0.5, 0.5] }, SPLIT_GAP, HEADER))
  })

  it('has a column divider and a row divider in the gaps; in 2 x 2 they cross, and each grip sits in its first stretch', () => {
    expect(gridDividers(STAGE, shares, 4, SPLIT_GAP, HEADER)).toEqual([
      { axis: 'column', rect: { x: 300, y: 0, width: 10, height: 642 }, grip: 180 },
      { axis: 'row', rect: { x: 0, y: 360, width: 1010, height: 10 }, grip: 150 }
    ])
  })

  it('with three panes, each divider stops beside the pane along a whole side, and its grip is in its middle', () => {
    const at = (span: 'top' | 'bottom' | 'left' | 'right') => gridDividers(STAGE, { ...shares, span }, 3, SPLIT_GAP, HEADER).map((d) => [d.rect, d.grip])
    expect(at('bottom')).toEqual([[{ x: 300, y: 0, width: 10, height: 360 }, 180], [{ x: 0, y: 360, width: 1010, height: 10 }, 505]])
    expect(at('top')).toEqual([[{ x: 300, y: 402, width: 10, height: 240 }, 120], [{ x: 0, y: 360, width: 1010, height: 10 }, 505]])
    expect(at('left')).toEqual([[{ x: 300, y: 0, width: 10, height: 642 }, 321], [{ x: 310, y: 360, width: 700, height: 10 }, 350]])
    expect(at('right')).toEqual([[{ x: 300, y: 0, width: 10, height: 642 }, 321], [{ x: 0, y: 360, width: 300, height: 10 }, 150]])
  })

  it('moves a divider within the room it shares, never under the minimum, and keeps its proportion when the stage changes', () => {
    expect(gridRoom(STAGE, 'column', SPLIT_GAP, HEADER)).toBe(1000)
    expect(gridRoom(STAGE, 'row', SPLIT_GAP, HEADER)).toBe(600)
    expect(resizeShare(0.5, 0.2)).toBeCloseTo(0.7)
    expect(resizeShare(0.5, 0.9)).toBe(1 - SPLIT_MIN_RATIO)
    expect(resizeShare(0.5, -0.9)).toBe(SPLIT_MIN_RATIO)
    // The same shares in a stage twice as wide: the left column is still 30 % of it.
    expect(gridLayout({ width: 2010, height: 642 }, shares, 4, SPLIT_GAP, HEADER)[0]!.width).toBe(600)
  })

  it('answers the keys of a divider: left and right arrows for the columns, up and down for the rows, Home, End and Enter for both', () => {
    expect(gridKeyShare(0.5, 'ArrowRight', 'column')).toBeCloseTo(0.5 + SPLIT_KEY_STEP)
    expect(gridKeyShare(0.5, 'ArrowLeft', 'column')).toBeCloseTo(0.5 - SPLIT_KEY_STEP)
    expect(gridKeyShare(0.5, 'ArrowDown', 'column')).toBeNull()
    expect(gridKeyShare(0.5, 'ArrowDown', 'row')).toBeCloseTo(0.5 + SPLIT_KEY_STEP)
    expect(gridKeyShare(0.5, 'ArrowRight', 'row')).toBeNull()
    expect(gridKeyShare(0.3, 'Home', 'row')).toBeCloseTo(SPLIT_MIN_RATIO)
    expect(gridKeyShare(0.3, 'End', 'column')).toBeCloseTo(1 - SPLIT_MIN_RATIO)
    expect(gridKeyShare(0.3, 'Enter', 'column')).toBeCloseTo(0.5)
    expect(gridKeyShare(0.3, 'ArrowRight', 'column', true)).toBeNull()
    expect(gridDividerValues(0.3)).toEqual({ now: 30, min: 12, max: 88, first: 30, second: 70 })
  })

  it('tells which cells a pane covers, and holds grids of three or four panes only', () => {
    expect(gridCover({ span: 'left' }, 3, 0)).toEqual([0, 0, 0, 1])
    expect(gridCover({}, 4, 3)).toEqual([1, 1, 1, 1])
    expect(gridCover({}, 4, 4)).toBeUndefined()
    expect(gridSpanOf({ span: 'top' }, 4)).toBe('none')
    expect([1, 2, 3, 4, 5].map(isGridCount)).toEqual([false, false, true, true, false])
  })
})
