// The reference measures, replayed: the card of the 1680 x 888 window is x 323 → 1670, y 10 → 878 (1347 x 868).

import { describe, expect, it } from 'vitest'
import { activeTab, createInitialState, reduce, splitFor, splitIsFull, type Ctx } from './sidebar'
import type { SidebarState, SplitOrientation } from './model'
import { SPLIT_GAP, splitLayout, splitPaneStage } from './split'
import { splitRows } from './split-place'
import {
  DROP_THRESHOLDS,
  DROP_VEIL,
  JOIN_BANDS,
  NO_DROP_STATE,
  SPLIT_DROP_ZONES,
  STACK_SKEW,
  closedBox,
  dropLayout,
  dropPage,
  isBoxSide,
  isSplitDropZone,
  joinLayout,
  nextZone,
  planDrop,
  veilFor,
  type DropState,
  type DropZone,
  type JoinHost,
  type SplitDropZone
} from './split-drop'

const CARD = { x: 323, y: 10, width: 1347, height: 868 }
const SIZE = { width: CARD.width, height: CARD.height }

/** Walks a pointer through absolute window coordinates (as the reference measures were read) and returns the zone at each stop. */
function walk(stops: Array<[number, number]>, from: DropState = NO_DROP_STATE): DropZone[] {
  let state = from
  return stops.map(([x, y]) => {
    state = nextZone(state, { x: x - CARD.x, y: y - CARD.y }, SIZE)
    return state.zone
  })
}
const xs = (list: number[], y = 450): Array<[number, number]> => list.map((x) => [x, y])
const ys = (list: number[], x = 996): Array<[number, number]> => list.map((y) => [x, y])

describe('the layout of the veil', () => {
  it('left box: 669 wide, the reduced page 668 wide after a 10 px gap, the whole height', () => {
    const { box, page } = dropLayout('left', SIZE)
    expect([box.x + CARD.x, box.x + box.width + CARD.x, box.y + CARD.y, box.y + box.height + CARD.y]).toEqual([323, 992, 10, 878])
    expect([page.x + CARD.x, page.x + page.width + CARD.x]).toEqual([1002, 1670])
  })

  it('right box: the page 323 → 992 and the box 1002 → 1670', () => {
    const { box, page } = dropLayout('right', SIZE)
    expect([page.x + CARD.x, page.x + page.width + CARD.x]).toEqual([323, 992])
    expect([box.x + CARD.x, box.x + box.width + CARD.x]).toEqual([1002, 1670])
  })

  it('top box: y 10 → 434 over the page 444 → 878 (the first pane of a stack is 5 px shorter)', () => {
    const { box, page } = dropLayout('top', SIZE)
    expect([box.y + CARD.y, box.y + box.height + CARD.y]).toEqual([10, 434])
    expect([page.y + CARD.y, page.y + page.height + CARD.y]).toEqual([444, 878])
    expect(box.width).toBe(SIZE.width)
    expect(page.width).toBe(SIZE.width)
  })

  it('bottom box: the page y 10 → 434 over the box 444 → 878', () => {
    const { box, page } = dropLayout('bottom', SIZE)
    expect([page.y + CARD.y, page.y + page.height + CARD.y]).toEqual([10, 434])
    expect([box.y + CARD.y, box.y + box.height + CARD.y]).toEqual([444, 878])
  })

  it('always fills the area exactly: the two panes and the gap, for any size', () => {
    for (const size of [{ width: 1347, height: 868 }, { width: 800, height: 600 }, { width: 301, height: 233 }, { width: 99, height: 40 }]) {
      for (const side of ['left', 'right'] as const) {
        const { box, page } = dropLayout(side, size)
        expect(box.width + DROP_VEIL.gap + page.width, `${side} ${size.width}`).toBe(size.width)
      }
      for (const side of ['top', 'bottom'] as const) {
        const { box, page } = dropLayout(side, size)
        expect(box.height + DROP_VEIL.gap + page.height, `${side} ${size.height}`).toBe(size.height)
      }
    }
    expect(STACK_SKEW).toBe(5)
  })

  it('the page is whole in the ring and with no box; a closed box is flat against its edge', () => {
    for (const zone of ['ring', 'none'] as const) expect(dropPage(zone, SIZE)).toEqual({ x: 0, y: 0, width: 1347, height: 868 })
    expect(closedBox('left', SIZE)).toEqual({ x: 0, y: 0, width: 0, height: 868 })
    expect(closedBox('right', SIZE)).toEqual({ x: 1347, y: 0, width: 0, height: 868 })
    expect(closedBox('top', SIZE)).toEqual({ x: 0, y: 0, width: 1347, height: 0 })
    expect(closedBox('bottom', SIZE)).toEqual({ x: 0, y: 868, width: 1347, height: 0 })
  })

  it('draws with the measured colours and move', () => {
    expect(DROP_VEIL).toMatchObject({ boxFill: '#0e0f14', boxOutline: '#7d7e89', boxOutlineWidth: 2, boxRadius: 5, ringColor: '#2f39ff', ringWidth: 3, moveMs: 200, easing: 'ease-out' })
  })
})

describe('the zones (the same position gives another zone according to the way the pointer came)', () => {
  it('going right from the left: left up to x = 1000, the ring at 1050 and 1100, right from 1150', () => {
    expect(walk(xs([700, 800, 900, 1000, 1050, 1100, 1150, 1200, 1500]))).toEqual(['left', 'left', 'left', 'left', 'ring', 'ring', 'right', 'right', 'right'])
  })

  it('going left from the right: right down to 1050, the ring at 1000 and 900, left at 800 and 700, nothing from 600', () => {
    const from: DropState = { zone: 'right', horizontal: 'right', vertical: 'middle' }
    expect(walk(xs([1500, 1200, 1100, 1050, 1000, 900, 800, 700, 600]), from)).toEqual(['right', 'right', 'right', 'right', 'ring', 'ring', 'left', 'left', 'none'])
  })

  it('has a memory: the same x = 900 is the left box going right and the ring going left', () => {
    const right = walk(xs([700, 900]))
    const left = walk(xs([1200, 900]), { zone: 'right', horizontal: 'right', vertical: 'middle' })
    expect([right[1], left[1]]).toEqual(['left', 'ring'])
  })

  it('going down at the middle of the page: the top box up to y = 300, the ring from 450 to 830, the bottom box from 850', () => {
    const middle: DropState = { zone: 'ring', horizontal: 'ring', vertical: 'middle' }
    expect(walk(ys([40, 150, 300, 450, 600, 830, 850, 870]), { ...middle, vertical: 'top', zone: 'top' })).toEqual(['top', 'top', 'top', 'ring', 'ring', 'ring', 'bottom', 'bottom'])
  })

  it('going up from the middle by the left: the left box down to y = 120, the top box from y = 80', () => {
    const left: DropState = { zone: 'left', horizontal: 'left', vertical: 'middle' }
    expect(walk(ys([450, 300, 200, 120, 80, 40], 700), left)).toEqual(['left', 'left', 'left', 'left', 'top', 'top'])
  })

  it('arms nothing near the sidebar, whatever the height, and nothing for a pointer that is not a number', () => {
    expect(walk([[360, 40], [360, 450], [360, 850]])).toEqual(['none', 'none', 'none'])
    expect(nextZone(NO_DROP_STATE, { x: Number.NaN, y: 100 }, SIZE)).toEqual(NO_DROP_STATE)
    expect(nextZone({ zone: 'left', horizontal: 'left', vertical: 'middle' }, { x: 500, y: 400 }, { width: 0, height: 0 })).toEqual(NO_DROP_STATE)
  })

  it('with the sidebar at the right reads the page in a mirror: nothing armed near the right edge, the sides keep their names', () => {
    const walkMirrored = (stops: Array<[number, number]>, from: DropState = NO_DROP_STATE): DropZone[] => {
      let state = from
      return stops.map(([x, y]) => {
        state = nextZone(state, { x: x - CARD.x, y: y - CARD.y }, SIZE, true)
        return state.zone
      })
    }
    // Going from the sidebar (the right) to the left: the mirror of "going right from the left".
    const mirror = (x: number) => CARD.x * 2 + CARD.width - x
    expect(walkMirrored(xs([700, 800, 900, 1000, 1050, 1100, 1150, 1200, 1500].map(mirror)))).toEqual(['right', 'right', 'right', 'right', 'ring', 'ring', 'left', 'left', 'left'])
    expect(walkMirrored(xs([1640, 1500, 1200]))).toEqual(['none', 'none', 'right'])
    // Mirrored or not, the top and bottom edges are the same.
    expect(walkMirrored(ys([40, 150, 300, 450, 600, 830, 850, 870]), { zone: 'top', horizontal: 'ring', vertical: 'top' })).toEqual(['top', 'top', 'top', 'ring', 'ring', 'ring', 'bottom', 'bottom'])
  })

  it('keeps its thresholds in order, so that the hold never swallows a zone', () => {
    const t = DROP_THRESHOLDS
    expect(t.none).toBeLessThan(t.left)
    expect(t.left + t.holdX).toBeLessThan(t.right)
    expect(t.right - t.holdX).toBeGreaterThan(t.left)
    expect(t.top).toBeLessThan(t.topLeaves)
    expect(t.bottomLeaves).toBeLessThan(t.bottom)
  })
})

describe('what a drop does', () => {
  it('puts the dragged tab in the box, the page on screen on the other side, and shows the dragged one', () => {
    expect(planDrop('right', 'b', 'a')).toEqual({ kind: 'pair', first: 'a', second: 'b', orientation: 'horizontal', focus: 'second' })
    expect(planDrop('left', 'b', 'a')).toEqual({ kind: 'pair', first: 'b', second: 'a', orientation: 'horizontal', focus: 'first' })
    expect(planDrop('bottom', 'b', 'a')).toEqual({ kind: 'pair', first: 'a', second: 'b', orientation: 'vertical', focus: 'second' })
    expect(planDrop('top', 'b', 'a')).toEqual({ kind: 'pair', first: 'b', second: 'a', orientation: 'vertical', focus: 'first' })
  })

  it('a tab dragged onto itself keeps its side and leaves the other pane to a new tab', () => {
    expect(planDrop('right', 'a', 'a')).toEqual({ kind: 'new-tab', tab: 'a', newTab: 'before', orientation: 'horizontal' })
    expect(planDrop('left', 'a', 'a')).toEqual({ kind: 'new-tab', tab: 'a', newTab: 'after', orientation: 'horizontal' })
    expect(planDrop('bottom', 'a', 'a')).toEqual({ kind: 'new-tab', tab: 'a', newTab: 'before', orientation: 'vertical' })
    expect(planDrop('top', 'a', 'a')).toEqual({ kind: 'new-tab', tab: 'a', newTab: 'after', orientation: 'vertical' })
  })

  it('does nothing in the ring, near the sidebar, or for a zone that is not one', () => {
    for (const zone of ['ring', 'none'] as const) expect(planDrop(zone, 'b', 'a')).toBeNull()
    expect(isSplitDropZone('ring')).toBe(true)
    expect(isSplitDropZone('none')).toBe(false)
    expect(isSplitDropZone('diagonal')).toBe(false)
    expect(isSplitDropZone(undefined)).toBe(false)
    expect(isBoxSide('ring')).toBe(false)
  })
})

describe('when a drag opens the veil', () => {
  function twoTabs() {
    let n = 0
    const ctx: Ctx = { now: 1_000_000, newId: () => `id${++n}` }
    let state: SidebarState = createInitialState(ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://a.example/' }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://b.example/', background: true }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://c.example/', background: true }, ctx)
    return { ctx, state, a: state.tabs[0]!.id, b: state.tabs[1]!.id, c: state.tabs[2]!.id }
  }
  const idle = { overlayOpen: false, hasPage: true }

  it('opens for another tab of the same space dragged over a single page', () => {
    const { state, b } = twoTabs()
    expect(veilFor(state, b, idle)).not.toBeNull()
  })

  it('opens for the tab on screen itself (the press that starts the drag selects it)', () => {
    const { state, a } = twoTabs()
    expect(veilFor(state, a, idle)).not.toBeNull()
  })

  it('does not open with the setting off, with the sidebar hidden, over a panel, or with no page', () => {
    const { state, b } = twoTabs()
    expect(veilFor({ ...state, settings: { ...state.settings, dragToSplit: false } }, b, idle)).toBeNull()
    expect(veilFor({ ...state, settings: { ...state.settings, sidebarVisible: false } }, b, idle)).toBeNull()
    expect(veilFor(state, b, { ...idle, overlayOpen: true })).toBeNull()
    expect(veilFor(state, b, { ...idle, hasPage: false })).toBeNull()
  })

  it('does not open for a tab that is not there, or when nothing is on screen', () => {
    const { state } = twoTabs()
    expect(veilFor(state, 'nothing', idle)).toBeNull()
    expect(veilFor({ ...state, activeTabBySpace: {} }, state.tabs[1]!.id, idle)).toBeNull()
  })

  it('opens over a page that is in a split view (the tab would join it), but not for a tab that is in one', () => {
    const { ctx, state, a, b, c } = twoTabs()
    const split = reduce(state, { type: 'split/create', tabId: a, withTabId: b }, ctx)
    expect(veilFor(split, c, idle)).not.toBeNull()
    expect(veilFor(split, c, idle)).toEqual({ kind: 'join', split: split.splits[0] })
    // A pane of the split view on screen is already there.
    expect(veilFor(split, b, idle)).toBeNull()
    expect(veilFor(split, a, idle)).toBeNull()
    // A tab of another split view: two split views are never merged.
    const other = reduce(reduce(state, { type: 'split/create', tabId: b, withTabId: c }, ctx), { type: 'tab/select', id: a }, ctx)
    expect(veilFor(other, b, idle)).toBeNull()
    expect(veilFor(other, a, idle)).not.toBeNull()
    expect(veilFor(other, a, idle)).toEqual({ kind: 'page' })
  })

  it('does not open for a tab of another space', () => {
    const { ctx, state, b } = twoTabs()
    // A new space is shown with a tab of its own; the tab dragged is still the one of the first space.
    const there = reduce(reduce(state, { type: 'space/create', name: 'Autre', emoji: '🧪', hue: 90 }, ctx), { type: 'tab/open', url: 'https://d.example/' }, ctx)
    expect(there.activeSpaceId).not.toBe(state.activeSpaceId)
    expect(veilFor(there, b, idle)).toBeNull()
    expect(veilFor(there, there.tabs.at(-1)!.id, idle)).not.toBeNull()
  })
})

describe('the zones over a split view the tab would join (three columns by three rows)', () => {
  const ROW_OF_TWO: JoinHost = { orientation: 'horizontal', ratios: [0.5, 0.5] }
  const ROW_OF_THREE: JoinHost = { orientation: 'horizontal', ratios: [1 / 3, 1 / 3, 1 / 3] }
  const COLUMN_OF_TWO: JoinHost = { orientation: 'vertical', ratios: [0.5, 0.5] }
  const COLUMN_OF_THREE: JoinHost = { orientation: 'vertical', ratios: [1 / 3, 1 / 3, 1 / 3] }
  const GRID_OF_THREE: JoinHost = { orientation: 'horizontal', ratios: [1 / 3, 1 / 3, 1 / 3], grid: { column: 0.5, row: 0.5, span: 'bottom' } }

  /** Like `walk`, over the split view `join` (and the sidebar at the right with `mirrored`). */
  function walkJoin(join: JoinHost, stops: Array<[number, number]>, mirrored = false, from: DropState = NO_DROP_STATE): DropZone[] {
    let state = from
    return stops.map(([x, y]) => {
      state = nextZone(state, { x: x - CARD.x, y: y - CARD.y }, SIZE, mirrored, join)
      return state.zone
    })
  }

  it('side by side, across the middle of the height: the left and right ends and the ring, with the thresholds of a single page', () => {
    expect(walkJoin(ROW_OF_TWO, xs([700, 900, 1050, 1200, 1500]))).toEqual(['left', 'left', 'ring', 'right', 'right'])
    expect(walkJoin(ROW_OF_THREE, xs([700, 900, 1050, 1200, 1500]))).toEqual(['left', 'left', 'ring', 'right', 'right'])
  })

  it('in the top quarter: the corners at the sides, the top edge in the middle; in the bottom quarter, the same below', () => {
    expect(walkJoin(ROW_OF_TWO, xs([700, 900, 1050, 1200, 1500], 40))).toEqual(['top-left', 'top-left', 'top', 'top-right', 'top-right'])
    expect(walkJoin(ROW_OF_TWO, xs([700, 900, 1050, 1200, 1500], 870))).toEqual(['bottom-left', 'bottom-left', 'bottom', 'bottom-right', 'bottom-right'])
    // A row of three takes no tab along its top or bottom: the middle of those edges is the ring, the corners still make a grid.
    expect(walkJoin(ROW_OF_THREE, xs([700, 1050, 1200], 40))).toEqual(['top-left', 'ring', 'top-right'])
    // Over a single page the same top edge is a zone of its own, and there is no corner.
    expect(walk(xs([700, 1200], 40))).toEqual(['top', 'top'])
  })

  it('keeps a band for 5 % of the height on the way out: the same y = 250 is the corner going down and the side going up', () => {
    const left: DropState = { zone: 'left', horizontal: 'left', vertical: 'middle' }
    expect(walkJoin(ROW_OF_TWO, ys([100, 250, 280, 450], 700))).toEqual(['top-left', 'top-left', 'left', 'left'])
    expect(walkJoin(ROW_OF_TWO, ys([450, 250, 200], 700), false, left)).toEqual(['left', 'left', 'top-left'])
    const b = JOIN_BANDS
    expect(b.top).toBeLessThan(b.top + b.hold)
    expect(b.top + b.hold).toBeLessThan(b.bottom - b.hold)
  })

  it('stacked: the top and bottom ends in the middle column; the sides only for a stack of two (one pane along a whole side)', () => {
    expect(walkJoin(COLUMN_OF_TWO, ys([100, 300, 450, 600, 700, 850], 1050))).toEqual(['top', 'ring', 'ring', 'ring', 'bottom', 'bottom'])
    expect(walkJoin(COLUMN_OF_TWO, xs([700, 1500]))).toEqual(['left', 'right'])
    expect(walkJoin(COLUMN_OF_THREE, xs([700, 1500]))).toEqual(['ring', 'ring'])
    expect(walkJoin(COLUMN_OF_THREE, [[700, 40], [1500, 870]])).toEqual(['top-left', 'bottom-right'])
  })

  it('a grid of three takes a tab in its corners only: its sides and its centre are the ring', () => {
    expect(walkJoin(GRID_OF_THREE, xs([700, 1200], 40))).toEqual(['top-left', 'top-right'])
    expect(walkJoin(GRID_OF_THREE, xs([700, 1050, 1200]))).toEqual(['ring', 'ring', 'ring'])
    expect(walkJoin(GRID_OF_THREE, [[1050, 40], [1050, 870]])).toEqual(['ring', 'ring'])
  })

  it('arms nothing near the sidebar, at either side of the window, whatever the height', () => {
    expect(walkJoin(COLUMN_OF_TWO, [[360, 40], [360, 450], [360, 850]])).toEqual(['none', 'none', 'none'])
    expect(walkJoin(ROW_OF_TWO, [[1640, 40], [1640, 450]], true)).toEqual(['none', 'none'])
    // From the sidebar at the right toward the left: the mirror of 700, 900, 1050 and 1200 going right from the left.
    expect(walkJoin(ROW_OF_TWO, xs([1293, 1093, 943, 793]), true)).toEqual(['right', 'right', 'ring', 'left'])
    // The corners keep the names of the sides they are on.
    expect(walkJoin(ROW_OF_TWO, [[1293, 40]], true)).toEqual(['top-right'])
    expect(walkJoin(ROW_OF_TWO, [[793, 850]], true)).toEqual(['bottom-left'])
  })

  it('arms nothing over a split view of four, nor for a pointer that is not a number', () => {
    const four: JoinHost = { orientation: 'horizontal', ratios: [0.25, 0.25, 0.25, 0.25], grid: { column: 0.5, row: 0.5 } }
    expect(walkJoin(four, [[700, 40], [1050, 40], [1500, 450], [1500, 870]])).toEqual(['ring', 'ring', 'ring', 'ring'])
    expect(nextZone(NO_DROP_STATE, { x: Number.NaN, y: 100 }, SIZE, false, ROW_OF_TWO)).toEqual(NO_DROP_STATE)
  })
})

describe('the veil over a split view', () => {
  const HEADER = 32
  const two = { orientation: 'horizontal' as const, ratios: [0.3, 0.7] }

  it('at rest draws each pane where the shell shows its page (the strip of the bar under two panes left free)', () => {
    const shell = splitLayout(splitPaneStage(SIZE, { tabIds: ['a', 'b'] }), two, SPLIT_GAP, HEADER)
    for (const zone of ['none', 'ring'] as const) expect(joinLayout(zone, SIZE, two, HEADER), zone).toEqual({ panes: shell, box: null })
    expect(shell[0]!.height).toBe(SIZE.height - 36 - 8)
  })

  it('2 → 3: a box at the right end, the three sharing the whole card equally (three panes have no bar)', () => {
    const { panes, box } = joinLayout('right', SIZE, two, HEADER)
    expect(box).toEqual({ x: 904, y: 0, width: 442, height: 868 })
    expect(panes.map((p) => [p.x, p.width, p.height])).toEqual([[0, 442, 868], [452, 442, 868]])
  })

  it('2 → 3 at the left end: the box first, the two panes after it in their order', () => {
    const { panes, box } = joinLayout('left', SIZE, two, HEADER)
    expect(box).toMatchObject({ x: 0, width: 442 })
    expect(panes.map((p) => p.x)).toEqual([452, 904])
  })

  it('3 → 4 in a stack: the box at the bottom, room left between the pages for the bar of each pane', () => {
    const stack = { orientation: 'vertical' as const, ratios: [1 / 3, 1 / 3, 1 / 3] }
    const { panes, box } = joinLayout('bottom', SIZE, stack, HEADER)
    expect(panes.map((p) => p.y)).toEqual([0, 228, 456])
    expect(box).toMatchObject({ x: 0, y: 684, width: 1347 })
    expect(joinLayout('top', SIZE, stack, HEADER).box).toMatchObject({ y: 0 })
    // The sides are no ends of a stack.
    expect(joinLayout('right', SIZE, stack, HEADER).box).toBeNull()
  })

  it('never opens a box over a split view of four, a row or a grid', () => {
    const four = { orientation: 'horizontal' as const, ratios: [0.25, 0.25, 0.25, 0.25] }
    for (const host of [four, { ...four, grid: { column: 0.5, row: 0.5 } }]) {
      for (const zone of [...SPLIT_DROP_ZONES, 'none'] as const) {
        const { panes, box } = joinLayout(zone, SIZE, host, HEADER)
        expect(box, zone).toBeNull()
        expect(panes, zone).toHaveLength(4)
      }
    }
  })

  // The grid in these cases: the card less the 10 px gap is 1337 wide; less the gap and the 32 px bar of the bottom row, 826 high (413 + 413), the
  // bottom row starting at 413 + 10 + 32 = 455.
  it('2 → 3 along the bottom: two on top keeping their 30 / 70, the box under them the whole width', () => {
    const { panes, box } = joinLayout('bottom', SIZE, two, HEADER)
    expect(panes).toEqual([{ x: 0, y: 0, width: 401, height: 413 }, { x: 411, y: 0, width: 936, height: 413 }])
    expect(box).toEqual({ x: 0, y: 455, width: 1347, height: 413 })
    expect(joinLayout('top', SIZE, two, HEADER)).toEqual({ box: { x: 0, y: 0, width: 1347, height: 413 }, panes: [{ x: 0, y: 455, width: 401, height: 413 }, { x: 411, y: 455, width: 936, height: 413 }] })
  })

  it('2 → 3 in a corner: the box is that cell, the pane that held it keeps its other cell, the other pane runs the whole height', () => {
    const bottomRight = joinLayout('bottom-right', SIZE, two, HEADER)
    expect(bottomRight.box).toEqual({ x: 411, y: 455, width: 936, height: 413 })
    expect(bottomRight.panes).toEqual([{ x: 0, y: 0, width: 401, height: 868 }, { x: 411, y: 0, width: 936, height: 413 }])
    const topLeft = joinLayout('top-left', SIZE, two, HEADER)
    expect(topLeft.box).toEqual({ x: 0, y: 0, width: 401, height: 413 })
    expect(topLeft.panes).toEqual([{ x: 0, y: 455, width: 401, height: 413 }, { x: 411, y: 0, width: 936, height: 868 }])
  })

  it('3 → 4 in a corner of a row: a 2 × 2 grid, the panes in their order and the box in the corner', () => {
    const row = { orientation: 'horizontal' as const, ratios: [1 / 3, 1 / 3, 1 / 3] }
    const { panes, box } = joinLayout('bottom-right', SIZE, row, HEADER)
    expect(box).toEqual({ x: 679, y: 455, width: 668, height: 413 })
    expect(panes).toEqual([{ x: 0, y: 0, width: 669, height: 413 }, { x: 679, y: 0, width: 668, height: 413 }, { x: 0, y: 455, width: 669, height: 413 }])
    expect(joinLayout('top-right', SIZE, row, HEADER).box).toEqual({ x: 679, y: 0, width: 668, height: 413 })
  })

  it('3 → 4 in a corner of a grid of three: the long pane gives up the cell next to the corner', () => {
    const grid = { orientation: 'horizontal' as const, ratios: [1 / 3, 1 / 3, 1 / 3], grid: { column: 0.5, row: 0.5, span: 'bottom' as const } }
    // Its own corner: the long pane keeps the other one.
    const own = joinLayout('bottom-left', SIZE, grid, HEADER)
    expect(own.box).toEqual({ x: 0, y: 455, width: 669, height: 413 })
    expect(own.panes[2]).toEqual({ x: 679, y: 455, width: 668, height: 413 })
    // The corner of a pane of its own: that pane slides down into the long pane's half, which keeps the other half.
    const other = joinLayout('top-left', SIZE, grid, HEADER)
    expect(other.box).toEqual({ x: 0, y: 0, width: 669, height: 413 })
    expect(other.panes).toEqual([{ x: 0, y: 455, width: 669, height: 413 }, { x: 679, y: 0, width: 668, height: 413 }, { x: 679, y: 455, width: 668, height: 413 }])
    // Its sides take no tab.
    for (const zone of ['left', 'right', 'top', 'bottom'] as const) expect(joinLayout(zone, SIZE, grid, HEADER).box, zone).toBeNull()
  })

  it('closes a corner box to the point of its corner', () => {
    expect(closedBox('top-left', SIZE)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(closedBox('bottom-right', SIZE)).toEqual({ x: 1347, y: 868, width: 0, height: 0 })
    expect(closedBox('top-right', SIZE)).toEqual({ x: 1347, y: 0, width: 0, height: 0 })
    expect(closedBox('bottom-left', SIZE)).toEqual({ x: 0, y: 868, width: 0, height: 0 })
  })
})

describe('what a drop on a split view does', () => {
  const host = { tabIds: ['a', 'b'], orientation: 'horizontal' as const }
  const SIDES = ['left', 'right', 'top', 'bottom'] as const
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
  /** The zones of a drop that make a plan over `on`, with the tab `x` dragged onto the page of `a`. */
  const taken = (on?: Parameters<typeof planDrop>[3]) => [...SIDES, ...CORNERS, 'ring', 'none'].filter((zone) => planDrop(zone as DropZone, 'x', 'a', on) !== null)

  it('the dragged tab joins it in the cell the box is on, a side or a corner', () => {
    expect(planDrop('right', 'c', 'a', host)).toEqual({ kind: 'join', tab: 'c', with: 'a', zone: 'right' })
    expect(planDrop('left', 'c', 'b', host)).toEqual({ kind: 'join', tab: 'c', with: 'b', zone: 'left' })
    expect(planDrop('bottom', 'c', 'a', { ...host, orientation: 'vertical' })).toEqual({ kind: 'join', tab: 'c', with: 'a', zone: 'bottom' })
    expect(planDrop('top-right', 'c', 'a', host)).toEqual({ kind: 'join', tab: 'c', with: 'a', zone: 'top-right' })
  })

  it('over a single page: the four sides make a split view of two, a corner nothing', () => {
    expect(taken()).toEqual([...SIDES])
    for (const zone of CORNERS) expect(planDrop(zone, 'b', 'a'), zone).toBeNull()
  })

  it('over two panes: the four sides and the four corners (a row grows at its ends, its top and bottom take a pane along them)', () => {
    expect(taken(host)).toEqual([...SIDES, ...CORNERS])
    expect(taken({ ...host, orientation: 'vertical' })).toEqual([...SIDES, ...CORNERS])
  })

  it('over three: the two ends of a row or a column and the four corners; a grid of three, its corners only', () => {
    const three = ['a', 'b', 'c']
    expect(taken({ tabIds: three, orientation: 'horizontal' })).toEqual(['left', 'right', ...CORNERS])
    expect(taken({ tabIds: three, orientation: 'vertical' })).toEqual(['top', 'bottom', ...CORNERS])
    expect(taken({ tabIds: three, orientation: 'horizontal', grid: { column: 0.5, row: 0.5, span: 'left' } })).toEqual([...CORNERS])
  })

  it('over four, a row or a grid: nothing (the veil says it is full)', () => {
    const four = ['a', 'b', 'c', 'd']
    expect(taken({ tabIds: four, orientation: 'horizontal' })).toEqual([])
    expect(taken({ tabIds: four, orientation: 'vertical', grid: { column: 0.5, row: 0.5 } })).toEqual([])
  })

  it('does nothing in the ring, near the sidebar, for one of its own panes, or when the page on screen is not one of its panes', () => {
    for (const zone of ['ring', 'none'] as const) expect(planDrop(zone, 'c', 'a', host), zone).toBeNull()
    expect(planDrop('right', 'b', 'a', host)).toBeNull()
    expect(planDrop('right', 'c', 'x', host)).toBeNull()
    expect(planDrop('top-left', 'c', 'x', host)).toBeNull()
  })
})

describe('a tab dropped on a split view becomes one more pane, up to four', () => {
  const idle = { overlayOpen: false, hasPage: true }
  const names = ['a', 'b', 'c', 'd', 'e', 'f'] as const

  /** Tabs a … f of one space (a on screen), with a and b in a split view. */
  function splitOfTwo(orientation: SplitOrientation = 'horizontal') {
    let n = 0
    const ctx: Ctx = { now: 1_000_000, newId: () => `id${++n}` }
    let state: SidebarState = createInitialState(ctx)
    for (const name of names) state = reduce(state, { type: 'tab/open', url: `https://${name}.example/`, background: name !== 'a' }, ctx)
    const id = Object.fromEntries(names.map((name, i) => [name, state.tabs[i]!.id])) as Record<(typeof names)[number], string>
    state = reduce(state, { type: 'split/create', tabId: id.a, withTabId: id.b, orientation }, ctx)
    return { ctx, state, id }
  }

  /** What the shell does with a drop of `dragged` on `zone` of the veil (shell/browser-overlay.ts `dropOnPage`), or null when the veil does not take it. */
  function dropOn(state: SidebarState, ctx: Ctx, dragged: string, zone: SplitDropZone): SidebarState | null {
    if (veilFor(state, dragged, idle)?.kind !== 'join') return null
    const current = activeTab(state)!
    const plan = planDrop(zone, dragged, current.id, splitFor(state, current.id))
    if (plan?.kind !== 'join') return null
    return reduce(state, { type: 'split/create', tabId: plan.tab, withTabId: plan.with, zone: plan.zone }, ctx)
  }

  it('2 → 3 on the right end, then 3 → 4 on the left end: the panes share equally, the dropped tab is shown', () => {
    const { ctx, state, id } = splitOfTwo()
    const three = dropOn(state, ctx, id.c, 'right')!
    expect(three.splits).toHaveLength(1)
    expect(three.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c], orientation: 'horizontal' })
    expect(three.splits[0]!.ratios.every((r) => Math.abs(r - 1 / 3) < 1e-9)).toBe(true)
    expect(activeTab(three)?.id).toBe(id.c)
    const four = dropOn(three, ctx, id.d, 'left')!
    expect(four.splits[0]?.tabIds).toEqual([id.d, id.a, id.b, id.c])
    expect(four.splits[0]!.ratios.every((r) => Math.abs(r - 0.25) < 1e-9)).toBe(true)
    expect(activeTab(four)?.id).toBe(id.d)
  })

  it('a stack grows at its top or its bottom and stays a stack', () => {
    const { ctx, state, id } = splitOfTwo('vertical')
    const three = dropOn(state, ctx, id.c, 'top')!
    expect(three.splits[0]).toMatchObject({ tabIds: [id.c, id.a, id.b], orientation: 'vertical' })
    expect(dropOn(three, ctx, id.d, 'bottom')!.splits[0]?.tabIds).toEqual([id.c, id.a, id.b, id.d])
    // A stack of three takes no tab at its sides.
    expect(dropOn(three, ctx, id.d, 'left')).toBeNull()
  })

  it('2 → 3 in a corner makes a grid: the dropped tab in the corner, shown; the pane that was there keeps its other half', () => {
    const { ctx, state, id } = splitOfTwo()
    const three = dropOn(state, ctx, id.c, 'bottom-right')!
    expect(three.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c], grid: { column: 0.5, row: 0.5, span: 'left' } })
    expect(activeTab(three)?.id).toBe(id.c)
    // The other corner of the long pane: 2 × 2, the long pane up in its half.
    const four = dropOn(three, ctx, id.d, 'bottom-left')!
    expect(four.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.d, id.c], grid: { column: 0.5, row: 0.5 } })
    expect(four.splits[0]?.grid?.span).toBeUndefined()
    expect(activeTab(four)?.id).toBe(id.d)
  })

  it('2 → 3 along the bottom of a row: two on top, the dropped tab under them the whole width', () => {
    const { ctx, state, id } = splitOfTwo()
    expect(dropOn(state, ctx, id.c, 'bottom')!.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c], orientation: 'horizontal', grid: { span: 'bottom' } })
    // Along the left of a stack: one the whole height, the two stacked at its right.
    const stacked = splitOfTwo('vertical')
    expect(dropOn(stacked.state, stacked.ctx, stacked.id.c, 'left')!.splits[0]).toMatchObject({ tabIds: [stacked.id.c, stacked.id.a, stacked.id.b], grid: { span: 'left' } })
  })

  it('the four windows asked for: a row of three and a tab in its bottom right corner make a 2 × 2 grid, the panes in their order', () => {
    const { ctx, state, id } = splitOfTwo()
    const row = dropOn(state, ctx, id.c, 'right')!
    expect(row.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c], orientation: 'horizontal' })
    expect(row.splits[0]?.grid).toBeUndefined()
    const four = dropOn(row, ctx, id.d, 'bottom-right')!
    expect(four.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c, id.d], grid: { column: 0.5, row: 0.5 } })
    expect(dropOn(row, ctx, id.d, 'top-left')!.splits[0]?.tabIds).toEqual([id.d, id.a, id.b, id.c])
  })

  it('at four the veil says it is full and takes no drop, and the reducer refuses a fifth pane: the tab stays where it was', () => {
    const { ctx, state, id } = splitOfTwo()
    const four = dropOn(dropOn(state, ctx, id.c, 'right')!, ctx, id.d, 'right')!
    expect(four.splits[0]?.tabIds).toHaveLength(4)
    expect(veilFor(four, id.e, idle)).toMatchObject({ kind: 'full' })
    expect(veilFor(four, id.e, idle)).not.toBeNull()
    for (const zone of SPLIT_DROP_ZONES) expect(planDrop(zone, id.e, activeTab(four)!.id, splitFor(four, id.a)), zone).toBeNull()
    expect(reduce(four, { type: 'split/create', tabId: id.e, withTabId: id.a, zone: 'left' }, ctx)).toBe(four)
    expect(reduce(four, { type: 'split/create', tabId: id.e, withTabId: id.a }, ctx)).toBe(four)
    // A grid of four is just as full.
    const grid = reduce(four, { type: 'split/layout', id: four.splits[0]!.id, layout: 'grid' }, ctx)
    expect(veilFor(grid, id.e, idle)).toMatchObject({ kind: 'full' })
    expect(reduce(grid, { type: 'split/create', tabId: id.e, withTabId: id.a, zone: 'top-left' }, ctx)).toBe(grid)
  })

  it('tells the menu and the shortcut that a split view of four is full, and one of three is not', () => {
    const { ctx, state, id } = splitOfTwo()
    const three = dropOn(state, ctx, id.c, 'right')!
    expect(splitIsFull(state)).toBe(false)
    expect(splitIsFull(three)).toBe(false)
    expect(splitIsFull(dropOn(three, ctx, id.d, 'right')!)).toBe(true)
  })

  it('a tab already in the view is no new pane: no veil, and the reducer changes nothing', () => {
    const { ctx, state, id } = splitOfTwo()
    expect(veilFor(state, id.b, idle)).toBeNull()
    expect(planDrop('right', id.b, id.a, splitFor(state, id.a))).toBeNull()
    expect(reduce(state, { type: 'split/create', tabId: id.b, withTabId: id.a, zone: 'right' }, ctx)).toBe(state)
  })

  it('a tab of another space joins no split view of this one', () => {
    const { ctx, state, id } = splitOfTwo()
    let there = reduce(state, { type: 'space/create', name: 'Autre', emoji: '🧪', hue: 90 }, ctx)
    there = reduce(there, { type: 'tab/open', url: 'https://g.example/' }, ctx)
    const g = there.tabs.at(-1)!.id
    // Back to the first space, whose split view is on screen; the tab of the other space is dragged.
    there = reduce(there, { type: 'tab/select', id: id.a }, ctx)
    expect(splitFor(there, activeTab(there)!.id)).toBeDefined()
    expect(veilFor(there, g, idle)).toBeNull()
    expect(reduce(there, { type: 'split/create', tabId: g, withTabId: id.a, zone: 'right' }, ctx)).toBe(there)
  })

  it('a pinned tab joins as a pane and stays pinned (the existing rule: a split view never unpins a tab); the view is one row', () => {
    const { ctx, state, id } = splitOfTwo()
    const pinned = reduce(reduce(state, { type: 'tab/pin', id: id.c }, ctx), { type: 'tab/select', id: id.a }, ctx)
    expect(pinned.tabs.find((t) => t.id === id.c)?.pinned).toBe(true)
    const three = dropOn(pinned, ctx, id.c, 'right')!
    expect(three.splits[0]?.tabIds).toEqual([id.a, id.b, id.c])
    expect(three.tabs.find((t) => t.id === id.c)?.pinned).toBe(true)
    const lists = [{ tabs: three.tabs.filter((t) => t.pinned), folder: false }, { tabs: three.tabs.filter((t) => !t.pinned), folder: false }]
    const { rows, covered } = splitRows(lists, three.splits)
    expect(rows.size).toBe(1)
    expect(covered.size).toBe(2)
  })

  it('the dropped tab leaves its row of the sidebar, as for a split view of two, and taking it out of the view gives the row back', () => {
    const { ctx, state, id } = splitOfTwo()
    const today = (s: SidebarState) => [{ tabs: s.tabs.filter((t) => !t.pinned), folder: false }]
    const three = dropOn(state, ctx, id.c, 'right')!
    const drawn = splitRows(today(three), three.splits)
    // One row for the view (at the place of its first tab), and none of its own for the tab that joined it.
    expect([...drawn.rows.keys()]).toEqual([id.a])
    expect(drawn.covered.has(id.c)).toBe(true)
    const out = reduce(three, { type: 'split/remove', tabId: id.c }, ctx)
    expect(out.splits[0]?.tabIds).toEqual([id.a, id.b])
    expect(splitRows(today(out), out.splits).covered.has(id.c)).toBe(false)
    expect(out.tabs.some((t) => t.id === id.c)).toBe(true)
  })
})
