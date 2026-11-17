// Where the bar of the page annotation stands (shared/annotate-bar.ts, shared/annotate-bar-position.ts): the position and how it is cleaned, the edge a drag lands on,
// the size of the bar in each layout (down to the narrowest window), where it goes in the window and the screen, the keys of the grip, and the menu of the positions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import {
  BAR_DRAG_THRESHOLD,
  BAR_INSET,
  BAR_METRICS,
  BAR_NUDGE,
  BAR_NUDGE_LARGE,
  BAR_SNAP_DISTANCE,
  MIN_WINDOW_WIDTH,
  barBounds,
  barBudget,
  barMenuEntries,
  barMetricVars,
  barSize,
  dragBounds,
  dragStarted,
  dropZones,
  floatingAt,
  isNudgeDirection,
  keepInside,
  nudgedPosition,
  lineWidth,
  positionForChoice,
  rowGroups,
  snapEdge,
  wrapGroups,
  type BarContent
} from './annotate-bar'
import { BAR_EDGES, DEFAULT_BAR_POSITION, cleanBarPosition, layoutOf, type BarPosition } from './annotate-bar-position'
import { defaultSettings } from './model'
import { createInitialState, reduce } from './sidebar'
import { clampSettings } from './sidebar-state'

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

const AREA = { x: 0, y: 0, width: 1440, height: 900 }
const WINDOW = { x: 300, y: 40, width: 900, height: 700 }
const none: BarContent = { laser: false, note: false }
const laser: BarContent = { laser: true, note: false }
/** The head of the row: the grip, the space, the Position button, and the Cursor key (28 + 2 + 28 + 72). */
const HEAD = BAR_METRICS.row.grip + BAR_METRICS.row.handleGap + BAR_METRICS.row.position + BAR_METRICS.row.key

describe('the position', () => {
  // Guard: the bar is on the left edge by default (where it always was); a state file that says nothing gives that.
  it('is the left edge by default, as the settings have it', () => {
    expect(DEFAULT_BAR_POSITION).toEqual({ kind: 'edge', edge: 'left' })
    expect(defaultSettings().annotateBar).toEqual(DEFAULT_BAR_POSITION)
  })

  describe('cleaned when it is read', () => {
    it.each(BAR_EDGES)('keeps the edge %s', (edge) => {
      expect(cleanBarPosition({ kind: 'edge', edge })).toEqual({ kind: 'edge', edge })
    })

    // Guard: a floating place keeps its whole coordinates and its layout; the rest of the fields do not stay.
    it('keeps a floating place, rounded, and only its fields', () => {
      expect(cleanBarPosition({ kind: 'floating', x: 10.6, y: 20.2, layout: 'row', extra: 'x', __proto__: { evil: true } })).toEqual({ kind: 'floating', x: 11, y: 20, layout: 'row' })
      expect(Object.keys(cleanBarPosition({ kind: 'edge', edge: 'top', extra: 1 }))).toEqual(['kind', 'edge'])
    })

    // Guard: a place that cannot be where a window is (negative, or farther than 20 000 points) is brought back, not given up: the bar is never parked out of reach.
    it('brings a floating place back to the corner of the window, and to a sane distance', () => {
      expect(cleanBarPosition({ kind: 'floating', x: -40, y: 99999, layout: 'column' })).toEqual({ kind: 'floating', x: 0, y: 20000, layout: 'column' })
    })

    // Guard: anything the position is not gives the default, never a half-read position (a bar that jumps to a corner on a damaged file).
    it.each([
      ['nothing', undefined],
      ['null', null],
      ['a text', 'left'],
      ['a number', 3],
      ['a list', ['edge', 'left']],
      ['an empty object', {}],
      ['an unknown kind', { kind: 'docked', edge: 'left' }],
      ['an unknown kind with the fields of a floating place', { kind: 'docked', x: 1, y: 2, layout: 'row' }],
      ['an edge without its edge', { kind: 'edge' }],
      ['an edge that is not one', { kind: 'edge', edge: 'middle' }],
      ['an edge as a prototype name', { kind: 'edge', edge: 'constructor' }],
      ['a floating place without a layout', { kind: 'floating', x: 1, y: 1 }],
      ['a floating place with a layout that is not one', { kind: 'floating', x: 1, y: 1, layout: 'diagonal' }],
      ['coordinates that are texts', { kind: 'floating', x: '1', y: '2', layout: 'row' }],
      ['a coordinate that is NaN', { kind: 'floating', x: Number.NaN, y: 2, layout: 'row' }],
      ['a coordinate that is infinite', { kind: 'floating', x: 1, y: Infinity, layout: 'row' }]
    ])('gives the default for %s', (_name, raw) => {
      expect(cleanBarPosition(raw)).toEqual(DEFAULT_BAR_POSITION)
    })
  })

  // Guard: the position goes through the same cleaning as every setting: on its way in from the file, and on its way in from a change of the settings.
  describe('kept in the settings', () => {
    it('is cleaned when the settings are read', () => {
      const damaged = { ...defaultSettings(), annotateBar: { kind: 'floating', x: 'far', y: 3, layout: 'row' } } as never
      expect(clampSettings(damaged).annotateBar).toEqual(DEFAULT_BAR_POSITION)
      const kept = { ...defaultSettings(), annotateBar: { kind: 'floating', x: 40, y: 50, layout: 'row' } } as never
      expect(clampSettings(kept).annotateBar).toEqual({ kind: 'floating', x: 40, y: 50, layout: 'row' })
    })

    it('is cleaned when a change of the settings brings it, and the other settings stay', () => {
      const ctx = { now: 1, newId: () => 'id' }
      const before = createInitialState(ctx)
      const moved = reduce(before, { type: 'settings/update', patch: { annotateBar: { kind: 'edge', edge: 'bottom' } } }, ctx)
      expect(moved.settings.annotateBar).toEqual({ kind: 'edge', edge: 'bottom' })
      const damaged = reduce(moved, { type: 'settings/update', patch: { annotateBar: { kind: 'edge', edge: 'sideways' } as never } }, ctx)
      expect(damaged.settings.annotateBar).toEqual(DEFAULT_BAR_POSITION)
      expect({ ...damaged.settings, annotateBar: null }).toEqual({ ...before.settings, annotateBar: null })
    })
  })

  describe('the layout', () => {
    // Guard: a column on the side edges, a row on the top and bottom ones, and the layout it was dropped with when it floats.
    it.each([
      ['left', { kind: 'edge', edge: 'left' }, 'column'],
      ['right', { kind: 'edge', edge: 'right' }, 'column'],
      ['top', { kind: 'edge', edge: 'top' }, 'row'],
      ['bottom', { kind: 'edge', edge: 'bottom' }, 'row'],
      ['floating, as a column', { kind: 'floating', x: 5, y: 5, layout: 'column' }, 'column'],
      ['floating, as a row', { kind: 'floating', x: 5, y: 5, layout: 'row' }, 'row']
    ] as const)('is the layout of the position: %s', (_name, position, layout) => {
      expect(layoutOf(position)).toBe(layout)
    })
  })
})

describe('the edge a drag lands on', () => {
  const window = { x: 100, y: 50, width: 800, height: 600 }

  // Guard: the pointer within 24 points of an edge lands the bar on it: 24 is in, 25 is out. Without the threshold a drop anywhere would stick to an edge, or none would.
  it.each([
    ['left', { x: 100 + BAR_SNAP_DISTANCE, y: 300 }, 'left'],
    ['left, one point farther', { x: 100 + BAR_SNAP_DISTANCE + 1, y: 300 }, null],
    ['right', { x: 900 - BAR_SNAP_DISTANCE, y: 300 }, 'right'],
    ['right, one point farther', { x: 900 - BAR_SNAP_DISTANCE - 1, y: 300 }, null],
    ['top', { x: 500, y: 50 + BAR_SNAP_DISTANCE }, 'top'],
    ['top, one point farther', { x: 500, y: 50 + BAR_SNAP_DISTANCE + 1 }, null],
    ['bottom', { x: 500, y: 650 - BAR_SNAP_DISTANCE }, 'bottom'],
    ['bottom, one point farther', { x: 500, y: 650 - BAR_SNAP_DISTANCE - 1 }, null],
    ['the middle of the window', { x: 500, y: 350 }, null]
  ])('lands on the right edge, or none: %s', (_name, pointer, edge) => {
    expect(snapEdge(pointer, window)).toBe(edge)
  })

  // Guard: a pointer pushed past an edge, or out of the window, is near it. Without it, the outline would go off as the pointer left the window.
  it('counts a pointer past an edge as near it', () => {
    expect(snapEdge({ x: 20, y: 300 }, window)).toBe('left')
    expect(snapEdge({ x: 2000, y: 300 }, window)).toBe('right')
    expect(snapEdge({ x: 500, y: -50 }, window)).toBe('top')
    expect(snapEdge({ x: 500, y: 2000 }, window)).toBe('bottom')
  })

  // Guard: near two edges (a corner), the nearer one wins, and an equal distance goes left, right, top, bottom. The order is the rule, not the order of the code.
  it('lands on the nearer edge in a corner, and on the left, right, top, bottom order for equal distances', () => {
    expect(snapEdge({ x: 110, y: 120 }, window)).toBe('left')
    expect(snapEdge({ x: 130, y: 60 }, window)).toBe('top')
    expect(snapEdge({ x: 121, y: 69 }, window)).toBe('top')
    expect(snapEdge({ x: 118, y: 70 }, window)).toBe('left')
    expect(snapEdge({ x: 112, y: 62 }, window)).toBe('left')
    expect(snapEdge({ x: 890, y: 60 }, window)).toBe('right')
    expect(snapEdge({ x: 500, y: 640 }, window)).toBe('bottom')
    expect(snapEdge({ x: 890, y: 640 }, window)).toBe('right')
  })

  it('is measured from the window, wherever it is on the screen', () => {
    expect(snapEdge({ x: 1450, y: 450 }, { x: 1440, y: 0, width: 1440, height: 900 })).toBe('left')
  })

  describe('the drop zones', () => {
    // Guard: the four zones the drag shows are the bands of the snap distance along the four edges of the window, as long as the edge: nothing else, and nowhere else.
    it('are the bands of 24 points along the four edges of the window', () => {
      expect(dropZones(window)).toEqual({
        left: { x: 100, y: 50, width: 24, height: 600 },
        right: { x: 100 + 800 - 24, y: 50, width: 24, height: 600 },
        top: { x: 100, y: 50, width: 800, height: 24 },
        bottom: { x: 100, y: 50 + 600 - 24, width: 800, height: 24 }
      })
      expect(dropZones(window, 10).left.width).toBe(10)
    })

    // Guard: what the zones show is what the drop does: a pointer in a zone lands the bar on that edge (the nearer one in a corner, where two zones meet), and a pointer
    // in none of them lands it on none. A zone drawn where the drop does not snap would promise a landing the bar does not make.
    it('are exactly where the pointer lands the bar on an edge', () => {
      const zones = dropZones(window)
      const inside = (point: { x: number; y: number }, zone: { x: number; y: number; width: number; height: number }): boolean =>
        point.x >= zone.x && point.x <= zone.x + zone.width && point.y >= zone.y && point.y <= zone.y + zone.height
      let corners = 0
      for (let x = window.x; x <= window.x + window.width; x += 5) {
        for (let y = window.y; y <= window.y + window.height; y += 5) {
          const point = { x, y }
          const within = BAR_EDGES.filter((edge) => inside(point, zones[edge]))
          const edge = snapEdge(point, window)
          expect(edge !== null, `${x},${y}`).toBe(within.length > 0)
          if (edge !== null) expect(within, `${x},${y}`).toContain(edge)
          if (within.length > 1) corners++
        }
      }
      // The corners belong to two zones, and the snap gives each pointer one of them.
      expect(corners).toBeGreaterThan(0)
    })

    it('are no longer than a window that is shorter than the distance', () => {
      expect(dropZones({ x: 0, y: 0, width: 10, height: 600 }).left.width).toBe(10)
      expect(dropZones({ x: 0, y: 0, width: 800, height: 10 }).top.height).toBe(10)
    })
  })

  it('starts the drag only after the pointer went a few points: a click is not a drag', () => {
    expect(BAR_DRAG_THRESHOLD).toBe(4)
    expect(dragStarted({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(false)
    expect(dragStarted({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true)
    expect(dragStarted({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false)
    expect(dragStarted({ x: 10, y: 10 }, { x: 13, y: 13 })).toBe(true)
    expect(dragStarted({ x: 10, y: 10 }, { x: 10, y: 6 })).toBe(true)
  })
})

describe('the size of the bar', () => {
  // Guard: the column is the one it has always been: 84 wide, up to 1000 high, and shorter when the window is.
  it('is 84 wide and up to 1000 high as a column, less in a shorter window', () => {
    expect(BAR_METRICS.column).toMatchObject({ width: 84, height: 1000 })
    expect(barSize('column', none, { width: 800, height: 5000 })).toEqual({ width: 84, height: 1000 })
    expect(barSize('column', none, { width: 800, height: 476 })).toEqual({ width: 84, height: 476 })
    expect(barSize('column', none, { width: 800, height: 0 })).toEqual({ width: 84, height: 0 })
  })

  it('makes room for the note under the column', () => {
    expect(barSize('column', { laser: false, note: true }, { width: 800, height: 5000 }).height).toBe(1000 + BAR_METRICS.column.noteHeight)
    expect(barSize('column', { laser: false, note: true }, { width: 800, height: 700 }).height).toBe(700)
  })

  // Guard: the row holds every group — the grip, the Position button and the Cursor key, the ten tools, the five colours, the timer and the four edits, and Quit —
  // on one line when the room allows: (28 + 2 + 28 + 72) + (10 × 40 + 9 × 2) + (5 × 20 + 4 × 6) + (40 + 4 × 50) + 50, with 10 between the groups, and the padding
  // and the border of the bar. The timer took the room the text buttons gave up: the row is as wide as it was without it (1024, 1112 with the laser).
  it('puts every group on one line when the window is wide enough', () => {
    expect(HEAD).toBe(130)
    expect(barSize('row', none, { width: 1400, height: 800 })).toEqual({ width: HEAD + 418 + 124 + 240 + 50 + 4 * 10 + 22, height: 42 + 14 })
    expect(barSize('row', laser, { width: 1400, height: 800 })).toEqual({ width: HEAD + 418 + 78 + 124 + 240 + 50 + 5 * 10 + 22, height: 42 + 14 })
    expect(barSize('row', none, { width: 1400, height: 800 }).width).toBe(1024)
    expect(barSize('row', laser, { width: 1400, height: 800 }).width).toBe(1112)
  })

  // Guard: in a narrower window the groups go to a second line, whole, rather than being cut: the line is broken before the group that no longer fits.
  it('puts the groups that do not fit on a second line', () => {
    // Room for 674: the head and the tools (558) fit, the colours (692 with them) do not: they go down with the edits and Quit (434).
    expect(barSize('row', none, { width: 696, height: 800 })).toEqual({ width: HEAD + 10 + 418 + 22, height: 2 * 42 + 4 + 14 })
    // With the looks of the laser: the head, the tools and the looks (646); the colours, the edits and Quit (434) wrap.
    expect(barSize('row', laser, { width: 696, height: 800 })).toEqual({ width: HEAD + 10 + 418 + 10 + 78 + 22, height: 2 * 42 + 4 + 14 })
  })

  // Guard: the narrowest window of Lucium is 720 wide: whatever the bar shows, its row is no wider than that window less the insets, and is two lines at most.
  it('fits the narrowest window, with every button, whatever it shows', () => {
    const budget = barBudget({ x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: 480 }, AREA)
    expect(budget.width).toBe(MIN_WINDOW_WIDTH - BAR_INSET * 2)
    for (const content of [none, laser, { laser: false, note: true }, { laser: true, note: true }]) {
      const size = barSize('row', content, budget)
      expect(size.width, JSON.stringify(content)).toBeLessThanOrEqual(budget.width)
      expect(size.height, JSON.stringify(content)).toBeLessThanOrEqual(2 * 42 + 4 + 14 + BAR_METRICS.row.noteHeight)
    }
  })

  // Guard: a wider window never gives a taller or a narrower-than-needed row: the lines are fewer as the room grows, and no line is wider than the room.
  it('never needs more lines in a wider window, and never exceeds the room it has', () => {
    let height = Infinity
    for (let room = 450; room <= 1500; room += 7) {
      const size = barSize('row', laser, { width: room, height: 800 })
      expect(size.width, `room ${room}`).toBeLessThanOrEqual(room)
      expect(size.height, `room ${room}`).toBeLessThanOrEqual(height)
      height = size.height
    }
  })

  it('stands alone on its line when a group is wider than the room', () => {
    // 418 for the tools alone, 22 for the frame: a room of 300 cannot hold them, and they are not cut in two (no window is that narrow: 720 is the least).
    const size = barSize('row', none, { width: 300, height: 800 })
    expect(size.width).toBe(418 + 22)
  })

  it('makes room for the note under the row', () => {
    const plain = barSize('row', none, { width: 696, height: 800 })
    expect(barSize('row', { laser: false, note: true }, { width: 696, height: 800 }).height).toBe(plain.height + BAR_METRICS.row.noteHeight)
  })

  // Guard: the first-use hint takes a block above the buttons, in both layouts; the width of the row does not change with it (the bubble is as wide as its text, at most the row).
  it('makes room for the hint above the column, within the window, and above the row', () => {
    const hinted: BarContent = { ...none, hint: true }
    expect(barSize('column', hinted, { width: 800, height: 5000 })).toEqual({ width: 84, height: 1000 + BAR_METRICS.column.hintHeight })
    expect(barSize('column', hinted, { width: 800, height: 700 }).height).toBe(700)
    const plain = barSize('row', none, { width: 696, height: 800 })
    expect(barSize('row', hinted, { width: 696, height: 800 })).toEqual({ width: plain.width, height: plain.height + BAR_METRICS.row.hintHeight })
    // A hint that is absent, or false, makes none.
    expect(barSize('row', { ...none, hint: false }, { width: 696, height: 800 })).toEqual(plain)
  })

  describe('the groups of the row', () => {
    const contents: BarContent[] = [none, laser, { laser: false, note: true }, { laser: true, note: true }, { laser: true, note: true, hint: true }]

    // Guard: the model counts the groups the page has: the head (grip, Position button, Cursor key), the tools, the looks of the laser only with the laser, the colours,
    // the timer and the four edits, Quit. A group the model forgot would be cut out of the row, which has no scrollbar.
    it('are the head, the tools, the looks of the laser (with the laser), the colours, the edits and Quit, with their widths', () => {
      expect(rowGroups(none)).toEqual([HEAD, 418, 124, 40 + 4 * 50, 50])
      expect(rowGroups(laser)).toEqual([HEAD, 418, 78, 124, 40 + 4 * 50, 50])
    })

    // Guard: the row contains every group, whatever room it has and whatever it shows: no group is lost or doubled by the wrapping, no line is wider than the window,
    // and the window is as high as its lines, the note and the hint need. The row never has a scrollbar (renderer/page-annotate-command.html), so what does not fit here is
    // cut off there, and that was « Quitter ».
    it('are all in the row at every room from the narrowest window up, none cut by the width or the height of its window', () => {
      const { row, button } = BAR_METRICS
      const frame = (row.padX + row.border) * 2
      for (const content of contents) {
        for (let width = MIN_WINDOW_WIDTH; width <= 2600; width += 3) {
          const budget = barBudget({ x: 0, y: 0, width, height: 900 }, { x: 0, y: 0, width: 2600, height: 1400 })
          const size = barSize('row', content, budget)
          const lines = wrapGroups(rowGroups(content), row.groupGap, budget.width - frame)
          const label = `${JSON.stringify(content)} in a window of ${width}`
          expect(lines.flat(), label).toEqual(rowGroups(content))
          for (const line of lines) expect(lineWidth(line, row.groupGap) + frame, label).toBeLessThanOrEqual(size.width)
          const needed = lines.length * button + (lines.length - 1) * row.lineGap + (row.padY + row.border) * 2 + (content.note ? row.noteHeight : 0) + (content.hint ? row.hintHeight : 0)
          expect(size.height, label).toBeGreaterThanOrEqual(needed)
          expect(size.width, label).toBeLessThanOrEqual(Math.max(budget.width, Math.max(...rowGroups(content)) + frame))
        }
      }
    })

    // Guard: the wrapping breaks before the group that no longer fits, and a group wider than the line stands alone (the same rule as the page's flex-wrap).
    it('wrap before the group that no longer fits', () => {
      expect(wrapGroups([100, 100, 100], 10, 230)).toEqual([[100, 100], [100]])
      expect(wrapGroups([100, 100, 100], 10, 210)).toEqual([[100, 100], [100]])
      expect(wrapGroups([100, 100, 100], 10, 209)).toEqual([[100], [100], [100]])
      expect(wrapGroups([300, 50], 10, 100)).toEqual([[300], [50]])
      expect(wrapGroups([], 10, 100)).toEqual([])
      expect(lineWidth([100, 100, 50], 10)).toBe(270)
      expect(lineWidth([], 10)).toBe(0)
    })
  })

  describe('the room of the bar', () => {
    it('is the window kept inside the screen, less the inset on both sides', () => {
      expect(barBudget(WINDOW, AREA)).toEqual({ width: 900 - 24, height: 700 - 24 })
      expect(barBudget({ ...WINDOW, width: 5000, height: 5000 }, AREA)).toEqual({ width: 1440 - 24, height: 900 - 24 })
    })

    // Guard: a pane of a split view, narrower than the smallest window, does not squeeze the row: it is laid out as for the smallest window (and may cover the other pane).
    it('lays the row out for the smallest window at the least, and the column for the height of the pane', () => {
      expect(barBudget({ x: 0, y: 0, width: 300, height: 400 }, AREA)).toEqual({ width: MIN_WINDOW_WIDTH - 24, height: 400 - 24 })
    })
  })

  it('counts the sizes the page lays the bar out with, which are the same numbers', () => {
    const vars = barMetricVars()
    expect(vars['--pa-column-w']).toBe(`${BAR_METRICS.column.width}px`)
    expect(vars['--pa-tool-w']).toBe(`${BAR_METRICS.row.tool}px`)
    expect(vars['--pa-text-w']).toBe(`${BAR_METRICS.row.text}px`)
    expect(vars['--pa-button-h']).toBe(`${BAR_METRICS.button}px`)
    for (const [name, value] of Object.entries(vars)) {
      expect(name).toMatch(/^--pa-[a-z-]+$/)
      expect(value).toMatch(/^\d+px$/)
    }
  })
})

describe('where the bar goes', () => {
  // Guard: on the left edge, 12 in, centred on the height of the window: the place it has always had.
  it('goes on the left edge, centred on the height of the window', () => {
    expect(barBounds({ kind: 'edge', edge: 'left' }, none, WINDOW, AREA)).toEqual({ x: 312, y: 40 + (700 - 676) / 2, width: 84, height: 676 })
  })

  it('goes on the right edge, 12 in, centred on the height', () => {
    expect(barBounds({ kind: 'edge', edge: 'right' }, none, WINDOW, AREA)).toEqual({ x: 300 + 900 - 84 - 12, y: 52, width: 84, height: 676 })
  })

  // Guard: along the top and bottom edges the bar is centred on the width of the window, and 12 in from the edge.
  it('goes on the top edge, centred on the width of the window', () => {
    // 876 of room: the head, the tools and the colours on a line (692), the edits and Quit under: 714 × 102.
    expect(barBounds({ kind: 'edge', edge: 'top' }, none, WINDOW, AREA)).toEqual({ x: 300 + (900 - 714) / 2, y: 40 + 12, width: 714, height: 102 })
  })

  it('goes on the bottom edge, centred on the width of the window', () => {
    expect(barBounds({ kind: 'edge', edge: 'bottom' }, none, WINDOW, AREA)).toEqual({ x: 393, y: 40 + 700 - 102 - 12, width: 714, height: 102 })
  })

  it('goes where it was left, from the corner of the window, when it floats', () => {
    expect(barBounds({ kind: 'floating', x: 100, y: 200, layout: 'row' }, none, WINDOW, AREA)).toEqual({ x: 400, y: 240, width: 714, height: 102 })
  })

  // Guard: a floating bar is held in the window when the window is smaller than it was, so it is never lost off the side of it.
  it('holds a floating bar inside the window', () => {
    expect(barBounds({ kind: 'floating', x: 5000, y: 5000, layout: 'row' }, none, WINDOW, AREA)).toEqual({ x: 300 + 900 - 714, y: 40 + 700 - 102, width: 714, height: 102 })
    expect(barBounds({ kind: 'floating', x: 0, y: 0, layout: 'row' }, none, WINDOW, AREA)).toMatchObject({ x: 300, y: 40 })
  })

  // Guard: the bar stays on the screen of the window, whatever the window does at the edge of it.
  it('keeps the bar inside the work area of the screen', () => {
    const hanging = { x: 1400, y: 40, width: 900, height: 700 }
    expect(barBounds({ kind: 'edge', edge: 'left' }, none, hanging, AREA).x).toBe(AREA.width - 84)
    expect(barBounds({ kind: 'edge', edge: 'right' }, none, hanging, AREA).x).toBe(AREA.width - 84)
    const high = barBounds({ kind: 'floating', x: 100, y: 100, layout: 'row' }, none, { x: 0, y: -200, width: 900, height: 500 }, AREA)
    expect(high.y).toBeGreaterThanOrEqual(AREA.y)
  })

  it('is as tall as its tools, less when the window or the screen is shorter', () => {
    expect(barBounds({ kind: 'edge', edge: 'left' }, none, { x: 0, y: 0, width: 900, height: 300 }, AREA).height).toBe(276)
    expect(barBounds({ kind: 'edge', edge: 'left' }, none, { x: 0, y: 0, width: 900, height: 2000 }, AREA).height).toBe(876)
    expect(barBounds({ kind: 'edge', edge: 'left' }, none, { x: 0, y: 0, width: 900, height: 2000 }, { ...AREA, height: 2000 }).height).toBe(1000)
  })

  // Guard: a pane narrower than the bar (a split view): the bar is centred on it, and only the screen holds it back.
  it('is centred on a pane that is narrower than the row, held by the screen only', () => {
    const pane = { x: 50, y: 40, width: 400, height: 600 }
    const bar = barBounds({ kind: 'edge', edge: 'top' }, none, pane, AREA)
    // The row of the smallest window (720 less the insets): the head and the tools on a line, the rest under.
    expect(bar.width).toBe(HEAD + 10 + 418 + 22)
    expect(bar.x).toBe(0)
  })

  describe('floating at a place', () => {
    it('is read back from where the bar stands, from the corner of the window, with its layout', () => {
      expect(floatingAt({ x: 450, y: 120, width: 676, height: 102 }, WINDOW, 'row')).toEqual({ kind: 'floating', x: 150, y: 80, layout: 'row' })
    })

    it('never gives a place before the corner of the window', () => {
      expect(floatingAt({ x: 100, y: 10, width: 84, height: 100 }, WINDOW, 'column')).toEqual({ kind: 'floating', x: 0, y: 0, layout: 'column' })
    })
  })

  describe('keepInside', () => {
    it('brings a rectangle into the window, then into the screen, the screen winning', () => {
      expect(keepInside({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 200, width: 400, height: 400 }, AREA)).toEqual({ x: 200, y: 200, width: 100, height: 100 })
      expect(keepInside({ x: 2000, y: 2000, width: 100, height: 100 }, { x: 200, y: 200, width: 400, height: 400 }, AREA)).toEqual({ x: 500, y: 500, width: 100, height: 100 })
      // A window that hangs off the screen: the screen holds the rectangle.
      expect(keepInside({ x: 1400, y: 0, width: 100, height: 100 }, { x: 1300, y: 0, width: 400, height: 400 }, AREA)).toEqual({ x: 1340, y: 0, width: 100, height: 100 })
    })

    it('keeps the top left corner in when the rectangle is larger than where it goes', () => {
      expect(keepInside({ x: 300, y: 300, width: 500, height: 500 }, { x: 200, y: 200, width: 400, height: 400 }, AREA)).toMatchObject({ x: 200, y: 200 })
    })
  })
})

describe('the drag', () => {
  const window = { x: 200, y: 100, width: 800, height: 500 }
  const size = { width: 84, height: 476 }

  // Guard: the bar follows the pointer by where the hand took it (the grip stays under the pointer), held in the window.
  it('puts the bar where the pointer is, less where it was taken', () => {
    expect(dragBounds({ x: 500, y: 400 }, { x: 10, y: 20 }, { width: 84, height: 200 }, window, AREA)).toEqual({ x: 490, y: 380, width: 84, height: 200 })
  })

  it('holds the bar inside the window and the screen', () => {
    expect(dragBounds({ x: 5000, y: 5000 }, { x: 10, y: 20 }, size, window, AREA)).toEqual({ x: 200 + 800 - 84, y: 100 + 500 - 476, ...size })
    expect(dragBounds({ x: -100, y: -100 }, { x: 10, y: 20 }, size, window, AREA)).toEqual({ x: 200, y: 100, ...size })
  })
})

describe('the keys of the grip', () => {
  const floating: BarPosition = { kind: 'floating', x: 100, y: 100, layout: 'row' }

  // Guard: an arrow moves a floating bar ten points, fifty with Shift, in the direction of the key.
  it.each([
    ['left', { x: 100 - BAR_NUDGE, y: 100 }],
    ['right', { x: 100 + BAR_NUDGE, y: 100 }],
    ['up', { x: 100, y: 100 - BAR_NUDGE }],
    ['down', { x: 100, y: 100 + BAR_NUDGE }]
  ] as const)('moves a floating bar %s by a step', (direction, to) => {
    expect(nudgedPosition(floating, direction, false, none, WINDOW, AREA)).toEqual({ kind: 'floating', ...to, layout: 'row' })
  })

  it('moves it by fifty with Shift', () => {
    expect(BAR_NUDGE).toBe(10)
    expect(BAR_NUDGE_LARGE).toBe(50)
    expect(nudgedPosition(floating, 'right', true, none, WINDOW, AREA)).toEqual({ kind: 'floating', x: 150, y: 100, layout: 'row' })
  })

  // Guard: the result is where the bar really is: held in the window, so that a key pressed against the edge does not pile up a distance the bar does not have.
  it('holds the bar in the window, and keeps the place it really has', () => {
    expect(nudgedPosition({ kind: 'floating', x: 0, y: 0, layout: 'row' }, 'left', false, none, WINDOW, AREA)).toEqual({ kind: 'floating', x: 0, y: 0, layout: 'row' })
    // The window is 900 wide and the row 714: the farthest right it can be is 186.
    expect(nudgedPosition({ kind: 'floating', x: 180, y: 0, layout: 'row' }, 'right', false, none, WINDOW, AREA)).toEqual({ kind: 'floating', x: 186, y: 0, layout: 'row' })
    expect(nudgedPosition({ kind: 'floating', x: 186, y: 0, layout: 'row' }, 'right', true, none, WINDOW, AREA)).toEqual({ kind: 'floating', x: 186, y: 0, layout: 'row' })
  })

  // Guard: the keys do not move a bar on an edge: the position comes back as it was.
  it('leaves a bar on an edge where it is', () => {
    const edge: BarPosition = { kind: 'edge', edge: 'left' }
    expect(nudgedPosition(edge, 'right', false, none, WINDOW, AREA)).toBe(edge)
  })

  it('knows the four directions, and nothing else', () => {
    for (const direction of ['left', 'right', 'up', 'down']) expect(isNudgeDirection(direction)).toBe(true)
    for (const direction of ['', 'LEFT', 'north', 'constructor', undefined, null, 3, {}]) expect(isNudgeDirection(direction)).toBe(false)
  })
})

describe('the menu of the positions', () => {
  const choices = (position: BarPosition) => barMenuEntries(position).map((entry) => (entry.kind === 'item' ? `${entry.label}${entry.checked ? ' ✓' : ''}` : entry.kind === 'title' ? `# ${entry.label}` : '-'))

  // Guard: the title, the four edges in the order of the design, a line, « Flottante »; the position the bar has is the one checked.
  it('lists a title, the four edges, a line and « Flottante », in French', () => {
    expect(choices({ kind: 'edge', edge: 'left' })).toEqual(['# Position de la barre', 'À droite', 'À gauche ✓', 'En haut', 'En bas', '-', 'Flottante'])
    expect(choices({ kind: 'edge', edge: 'right' })).toEqual(['# Position de la barre', 'À droite ✓', 'À gauche', 'En haut', 'En bas', '-', 'Flottante'])
    expect(choices({ kind: 'edge', edge: 'top' })).toEqual(['# Position de la barre', 'À droite', 'À gauche', 'En haut ✓', 'En bas', '-', 'Flottante'])
    expect(choices({ kind: 'edge', edge: 'bottom' })).toEqual(['# Position de la barre', 'À droite', 'À gauche', 'En haut', 'En bas ✓', '-', 'Flottante'])
    expect(choices({ kind: 'floating', x: 1, y: 1, layout: 'row' })).toEqual(['# Position de la barre', 'À droite', 'À gauche', 'En haut', 'En bas', '-', 'Flottante ✓'])
  })

  it('is in the language of the interface', () => {
    setLanguage('en')
    expect(choices({ kind: 'edge', edge: 'top' })).toEqual(['# Bar position', 'On the right', 'On the left', 'At the top ✓', 'At the bottom', '-', 'Floating'])
  })

  it('checks exactly one entry, and names each choice once', () => {
    for (const position of [DEFAULT_BAR_POSITION, { kind: 'floating', x: 1, y: 1, layout: 'column' } as const]) {
      const items = barMenuEntries(position).filter((entry) => entry.kind === 'item')
      expect(items.filter((entry) => entry.checked)).toHaveLength(1)
      expect(items.map((entry) => entry.choice)).toEqual(['right', 'left', 'top', 'bottom', 'floating'])
    }
  })

  describe('what a choice gives', () => {
    const bounds = { x: 412, y: 52, width: 676, height: 102 }
    it.each(BAR_EDGES)('puts the bar on the edge %s', (edge) => {
      expect(positionForChoice(edge, { kind: 'floating', x: 1, y: 1, layout: 'row' }, bounds, WINDOW)).toEqual({ kind: 'edge', edge })
    })

    // Guard: « Flottante » from an edge floats the bar where it stands, in its layout: no jump.
    it('floats the bar where it stands, in the layout of its edge', () => {
      expect(positionForChoice('floating', { kind: 'edge', edge: 'top' }, bounds, WINDOW)).toEqual({ kind: 'floating', x: 112, y: 12, layout: 'row' })
      expect(positionForChoice('floating', { kind: 'edge', edge: 'left' }, { x: 312, y: 52, width: 84, height: 676 }, WINDOW)).toEqual({ kind: 'floating', x: 12, y: 12, layout: 'column' })
    })

    it('keeps a floating bar as it is', () => {
      const current: BarPosition = { kind: 'floating', x: 33, y: 44, layout: 'column' }
      expect(positionForChoice('floating', current, bounds, WINDOW)).toBe(current)
    })
  })
})
