// The grid of a split view as a structure: where a tab joins, what is left when a pane goes, « Disposition », and the split views of a file
// written before grids existed. The geometry is in split.test.ts, the veil and the zones of a drop in split-drop.test.ts.

import { describe, expect, it } from 'vitest'
import { activeTab, createInitialState, normalize, parseSavedState, persistableState, reduce, splitFor, type Ctx } from './sidebar'
import type { SidebarState, SplitOrientation, SplitView } from './model'
import { SPLIT_MIN_RATIO, equalRatios } from './split'
import { arranged, arrangementChoices, canArrange, defaultJoinZone, joinZones, joined, keepPanes, splitArrangement, withoutPane, type SplitShape } from './split-grid'
import { cleanSplits } from './state-clean'

const line = (tabIds: string[], orientation: SplitOrientation = 'horizontal', ratios = equalRatios(tabIds.length)): SplitShape => ({ tabIds, orientation, ratios })
const grid = (tabIds: string[], span?: 'top' | 'bottom' | 'left' | 'right', column = 0.5, row = 0.5): SplitShape => ({
  tabIds,
  orientation: 'horizontal',
  ratios: equalRatios(tabIds.length),
  grid: { column, row, ...(span ? { span } : {}) }
})

describe('where a tab joins a split view', () => {
  it('a row grows at its ends, every pane sharing equally, and stays a row', () => {
    expect(joined(line(['a', 'b']), 'x', 'right')).toEqual(line(['a', 'b', 'x']))
    expect(joined(line(['a', 'b', 'c']), 'x', 'left')).toEqual(line(['x', 'a', 'b', 'c']))
    expect(joined(line(['a', 'b'], 'vertical'), 'x', 'top')).toEqual(line(['x', 'a', 'b'], 'vertical'))
  })

  it('a split view of two takes a tab along a whole side across it: a grid of three, the two keeping their order and their shares', () => {
    expect(joined(line(['a', 'b'], 'horizontal', [0.3, 0.7]), 'x', 'bottom')).toMatchObject({ tabIds: ['a', 'b', 'x'], grid: { column: 0.3, row: 0.5, span: 'bottom' } })
    expect(joined(line(['a', 'b'], 'horizontal', [0.3, 0.7]), 'x', 'top')).toMatchObject({ tabIds: ['x', 'a', 'b'], grid: { column: 0.3, row: 0.5, span: 'top' } })
    expect(joined(line(['a', 'b'], 'vertical', [0.6, 0.4]), 'x', 'left')).toMatchObject({ tabIds: ['x', 'a', 'b'], grid: { column: 0.5, row: 0.6, span: 'left' } })
    expect(joined(line(['a', 'b'], 'vertical', [0.6, 0.4]), 'x', 'right')).toMatchObject({ tabIds: ['a', 'x', 'b'], grid: { span: 'right' } })
  })

  it('a split view of two takes a tab in a corner: the pane that held it keeps its other half, the other one runs the whole side', () => {
    // Side by side: a | b.
    expect(joined(line(['a', 'b']), 'x', 'bottom-right')).toMatchObject({ tabIds: ['a', 'b', 'x'], grid: { span: 'left' } })
    expect(joined(line(['a', 'b']), 'x', 'top-right')).toMatchObject({ tabIds: ['a', 'x', 'b'], grid: { span: 'left' } })
    expect(joined(line(['a', 'b']), 'x', 'bottom-left')).toMatchObject({ tabIds: ['a', 'b', 'x'], grid: { span: 'right' } })
    expect(joined(line(['a', 'b']), 'x', 'top-left')).toMatchObject({ tabIds: ['x', 'b', 'a'], grid: { span: 'right' } })
    // Stacked: a over b.
    expect(joined(line(['a', 'b'], 'vertical'), 'x', 'top-left')).toMatchObject({ tabIds: ['x', 'a', 'b'], grid: { span: 'bottom' } })
    expect(joined(line(['a', 'b'], 'vertical'), 'x', 'bottom-right')).toMatchObject({ tabIds: ['a', 'b', 'x'], grid: { span: 'top' } })
  })

  it('a row or a column of three takes a tab in a corner: 2 x 2, the panes in their order and the tab at the corner', () => {
    expect(joined(line(['a', 'b', 'c']), 'x', 'bottom-right')).toEqual({ ...line(['a', 'b', 'c', 'x']), grid: { column: 0.5, row: 0.5 } })
    expect(joined(line(['a', 'b', 'c']), 'x', 'bottom-left')?.tabIds).toEqual(['a', 'b', 'x', 'c'])
    expect(joined(line(['a', 'b', 'c'], 'vertical'), 'x', 'top-right')?.tabIds).toEqual(['a', 'x', 'b', 'c'])
  })

  it('a grid of three takes a tab in a corner: the long pane gives up the cell next to it, keeping the shares of the grid', () => {
    // Two on top (a, b), c under them: its own corners.
    expect(joined(grid(['a', 'b', 'c'], 'bottom', 0.3, 0.6), 'x', 'bottom-left')).toEqual({ ...line(['a', 'b', 'x', 'c']), grid: { column: 0.3, row: 0.6 } })
    expect(joined(grid(['a', 'b', 'c'], 'bottom'), 'x', 'bottom-right')?.tabIds).toEqual(['a', 'b', 'c', 'x'])
    // The corner of a pane of its own: it slides into the long pane's half below it.
    expect(joined(grid(['a', 'b', 'c'], 'bottom'), 'x', 'top-left')?.tabIds).toEqual(['x', 'b', 'a', 'c'])
    // One on the left (a), b and c stacked at its right: the corner of b pushes b to the left half of a.
    expect(joined(grid(['a', 'b', 'c'], 'left'), 'x', 'top-right')?.tabIds).toEqual(['b', 'x', 'a', 'c'])
  })

  it('takes nothing where it cannot: a side across three panes, a side of a grid, a full split view, a tab already in it', () => {
    expect(joined(line(['a', 'b', 'c']), 'x', 'top')).toBeNull()
    expect(joined(line(['a', 'b', 'c'], 'vertical'), 'x', 'right')).toBeNull()
    for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(joined(grid(['a', 'b', 'c'], 'left'), 'x', side), side).toBeNull()
    expect(joined(line(['a', 'b', 'c', 'd']), 'x', 'right')).toBeNull()
    expect(joined(grid(['a', 'b', 'c', 'd']), 'x', 'top-left')).toBeNull()
    expect(joined(line(['a', 'b']), 'b', 'right')).toBeNull()
    expect(joinZones(line(['a']))).toEqual([])
  })

  it('without a zone: the end of a row or a column, as before grids; the free half of the long pane of a grid of three', () => {
    expect(defaultJoinZone(line(['a', 'b']))).toBe('right')
    expect(defaultJoinZone(line(['a', 'b'], 'vertical'))).toBe('bottom')
    expect(defaultJoinZone(grid(['a', 'b', 'c'], 'bottom'))).toBe('bottom-right')
    expect(defaultJoinZone(grid(['a', 'b', 'c'], 'top'))).toBe('top-right')
    expect(defaultJoinZone(grid(['a', 'b', 'c'], 'left'))).toBe('bottom-left')
    expect(defaultJoinZone(grid(['a', 'b', 'c'], 'right'))).toBe('bottom-right')
    expect(joined(grid(['a', 'b', 'c'], 'left'), 'x')?.tabIds).toEqual(['a', 'b', 'x', 'c'])
  })
})

describe('what is left of a grid when a pane goes', () => {
  it('2 x 2 → 3: the pane beside it in its row takes its cell and runs along that side; the shares stay', () => {
    const four = grid(['a', 'b', 'c', 'd'], undefined, 0.3, 0.6)
    expect(withoutPane(four, 'd')).toEqual(grid(['a', 'b', 'c'], 'bottom', 0.3, 0.6))
    expect(withoutPane(four, 'a')).toEqual(grid(['b', 'c', 'd'], 'top', 0.3, 0.6))
    expect(withoutPane(four, 'b')).toEqual(grid(['a', 'c', 'd'], 'top', 0.3, 0.6))
    expect(withoutPane(four, 'c')).toEqual(grid(['a', 'b', 'd'], 'bottom', 0.3, 0.6))
  })

  it('3 → 2 side by side or stacked, as they were placed, keeping the share of the divider between them', () => {
    // a b over c: c gone, a and b side by side 30 / 70; a gone, b over c 60 / 40.
    const twoOnTop = grid(['a', 'b', 'c'], 'bottom', 0.3, 0.6)
    expect(withoutPane(twoOnTop, 'c')).toEqual(line(['a', 'b'], 'horizontal', [0.3, 0.7]))
    expect(withoutPane(twoOnTop, 'a')).toEqual(line(['b', 'c'], 'vertical', [0.6, 1 - 0.6]))
    // a on the left, b over c at its right: a gone, b over c; b gone, a beside c.
    const oneOnLeft = grid(['a', 'b', 'c'], 'left', 0.3, 0.6)
    expect(withoutPane(oneOnLeft, 'a')).toEqual(line(['b', 'c'], 'vertical', [0.6, 1 - 0.6]))
    expect(withoutPane(oneOnLeft, 'b')).toEqual(line(['a', 'c'], 'horizontal', [0.3, 0.7]))
    // a over c on the left, b the whole height at the right: a gone, c (left) comes first beside b.
    expect(withoutPane(grid(['a', 'b', 'c'], 'right', 0.4, 0.5), 'a')).toEqual(line(['c', 'b'], 'horizontal', [0.4, 1 - 0.4]))
    // One along the top: it gone, the two of the bottom row side by side.
    expect(withoutPane(grid(['a', 'b', 'c'], 'top', 0.4, 0.5), 'a')).toEqual(line(['b', 'c'], 'horizontal', [0.4, 1 - 0.4]))
  })

  it('a row or a column closes up and shares equally, as before grids; a tab that is not a pane changes nothing', () => {
    expect(withoutPane(line(['a', 'b', 'c'], 'vertical', [0.2, 0.3, 0.5]), 'b')).toEqual(line(['a', 'c'], 'vertical'))
    const split = grid(['a', 'b', 'c', 'd'])
    expect(withoutPane(split, 'x')).toBe(split)
    // Two panes gone at once: 4 → 3 → 2.
    expect(keepPanes(grid(['a', 'b', 'c', 'd'], undefined, 0.3, 0.6), ['a', 'c'])).toEqual(line(['a', 'c'], 'vertical', [0.6, 1 - 0.6]))
  })
})

describe('« Disposition »', () => {
  it('turns a row of three into two on top and one under them, a column of three into one on the left and two at its right, four into 2 x 2', () => {
    expect(arranged(line(['a', 'b', 'c']), 'grid')).toEqual(grid(['a', 'b', 'c'], 'bottom'))
    expect(arranged(line(['a', 'b', 'c'], 'vertical'), 'grid')).toEqual({ ...grid(['a', 'b', 'c'], 'left'), orientation: 'vertical' })
    expect(arranged(line(['a', 'b', 'c', 'd']), 'grid')).toEqual(grid(['a', 'b', 'c', 'd']))
  })

  it('goes back from a grid to the row or the column it was, with its shares, the panes in their order', () => {
    const row = line(['a', 'b', 'c'], 'horizontal', [0.2, 0.3, 0.5])
    const inGrid = arranged(row, 'grid')
    expect(arranged(inGrid, 'horizontal')).toEqual(row)
    expect(arranged(inGrid, 'vertical')).toEqual({ ...row, orientation: 'vertical' })
  })

  it('changes nothing for the arrangement it is in, or for a grid of two panes (the same object: no new state)', () => {
    const two = line(['a', 'b'])
    expect(arranged(two, 'grid')).toBe(two)
    expect(arranged(two, 'horizontal')).toBe(two)
    const inGrid = grid(['a', 'b', 'c'], 'left')
    expect(arranged(inGrid, 'grid')).toBe(inGrid)
    expect(canArrange(two, 'grid')).toBe(false)
    expect(canArrange(two, 'vertical')).toBe(true)
  })

  it('lists Côte à côte, En colonne and Grille, the one the split view is in checked, Grille greyed out for two panes', () => {
    const at = (split: SplitShape) => arrangementChoices(split).map(({ label, checked, enabled }) => [label, checked, enabled])
    expect(at(line(['a', 'b']))).toEqual([['Côte à côte', true, true], ['En colonne', false, true], ['Grille', false, false]])
    expect(at(line(['a', 'b', 'c'], 'vertical'))).toEqual([['Côte à côte', false, true], ['En colonne', true, true], ['Grille', false, true]])
    expect(at(grid(['a', 'b', 'c', 'd']))).toEqual([['Côte à côte', false, true], ['En colonne', false, true], ['Grille', true, true]])
    expect(arrangementChoices(grid(['a', 'b', 'c'])).map((c) => c.arrangement)).toEqual(['horizontal', 'vertical', 'grid'])
    // A grid left on two panes (a file edited by hand) is read as its row.
    expect(splitArrangement({ ...line(['a', 'b']), grid: { column: 0.5, row: 0.5 } })).toBe('horizontal')
  })
})

describe('the reducer, with a grid', () => {
  const names = ['a', 'b', 'c', 'd', 'e'] as const

  /** Tabs a … e of one space, with a, b, c and d in a split view of four in a grid (a on screen). */
  function gridOfFour() {
    let n = 0
    const ctx: Ctx = { now: 1_000_000, newId: () => `id${++n}` }
    let state: SidebarState = createInitialState(ctx)
    for (const name of names) state = reduce(state, { type: 'tab/open', url: `https://${name}.example/`, background: name !== 'a' }, ctx)
    const id = Object.fromEntries(names.map((name, i) => [name, state.tabs[i]!.id])) as Record<(typeof names)[number], string>
    state = reduce(state, { type: 'split/create', tabId: id.a, withTabId: id.b }, ctx)
    state = reduce(state, { type: 'split/create', tabId: id.c, withTabId: id.a }, ctx)
    state = reduce(state, { type: 'split/create', tabId: id.d, withTabId: id.a }, ctx)
    state = reduce(state, { type: 'split/layout', id: state.splits[0]!.id, layout: 'grid' }, ctx)
    state = reduce(state, { type: 'tab/select', id: id.a }, ctx)
    return { ctx, state, id, splitId: state.splits[0]!.id }
  }

  it('closing a pane of 2 x 2 leaves a grid of three; closing another leaves two panes side by side or stacked', () => {
    const { ctx, state, id } = gridOfFour()
    expect(state.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c, id.d], grid: { column: 0.5, row: 0.5 } })
    const three = reduce(state, { type: 'split/remove', tabId: id.d }, ctx)
    expect(three.splits[0]).toMatchObject({ tabIds: [id.a, id.b, id.c], grid: { span: 'bottom' } })
    const two = reduce(three, { type: 'split/remove', tabId: id.c }, ctx)
    expect(two.splits[0]).toMatchObject({ tabIds: [id.a, id.b], orientation: 'horizontal', ratios: [0.5, 0.5] })
    expect(two.splits[0]?.grid).toBeUndefined()
    // The other way: the top left pane of the grid of three gone, the two left are stacked.
    expect(reduce(three, { type: 'split/remove', tabId: id.a }, ctx).splits[0]).toMatchObject({ tabIds: [id.b, id.c], orientation: 'vertical' })
  })

  it('a tab of the grid closed or archived shrinks it the same way (pruneSplits)', () => {
    const { ctx, state, id } = gridOfFour()
    const closed = reduce(state, { type: 'tab/close', id: id.b }, ctx)
    expect(closed.splits[0]).toMatchObject({ tabIds: [id.a, id.c, id.d], grid: { span: 'top' } })
    const again = reduce(closed, { type: 'tab/close', id: id.c }, ctx)
    expect(again.splits[0]).toMatchObject({ tabIds: [id.a, id.d] })
    expect(again.splits[0]?.grid).toBeUndefined()
  })

  it('moves the dividers of a grid, refusing a share that leaves a column or a row under the minimum', () => {
    const { ctx, state, splitId } = gridOfFour()
    const moved = reduce(state, { type: 'split/grid', id: splitId, column: 0.3, row: 0.7 }, ctx)
    expect(moved.splits[0]?.grid).toEqual({ column: 0.3, row: 0.7 })
    for (const [column, row] of [[SPLIT_MIN_RATIO / 2, 0.5], [0.5, 1 - SPLIT_MIN_RATIO / 2], [Number.NaN, 0.5], [0.5, Number.POSITIVE_INFINITY]]) {
      expect(reduce(moved, { type: 'split/grid', id: splitId, column: column!, row: row! }, ctx), `${column} ${row}`).toBe(moved)
    }
    // The same shares, or a split view without a grid: nothing changes.
    expect(reduce(moved, { type: 'split/grid', id: splitId, column: 0.3, row: 0.7 }, ctx)).toBe(moved)
    const asRow = reduce(moved, { type: 'split/layout', id: splitId, layout: 'horizontal' }, ctx)
    expect(asRow.splits[0]?.grid).toBeUndefined()
    expect(reduce(asRow, { type: 'split/grid', id: splitId, column: 0.4, row: 0.4 }, ctx)).toBe(asRow)
  })

  it('refuses an arrangement it does not know, and leaves the state as it is for the one it is in', () => {
    const { ctx, state, splitId } = gridOfFour()
    expect(reduce(state, { type: 'split/layout', id: splitId, layout: 'diagonal' as never }, ctx)).toBe(state)
    expect(reduce(state, { type: 'split/layout', id: splitId, layout: 'grid' }, ctx)).toBe(state)
    expect(reduce(state, { type: 'split/layout', id: 'nothing', layout: 'vertical' }, ctx)).toBe(state)
    // « Empiler les volets » of the menu of a tab takes a grid back to a column, and never makes one.
    expect(reduce(state, { type: 'split/orientation', id: splitId, orientation: 'vertical' }, ctx).splits[0]).toMatchObject({ orientation: 'vertical' })
    expect(reduce(state, { type: 'split/orientation', id: splitId, orientation: 'vertical' }, ctx).splits[0]?.grid).toBeUndefined()
    const asRow = reduce(state, { type: 'split/layout', id: splitId, layout: 'horizontal' }, ctx)
    expect(reduce(asRow, { type: 'split/orientation', id: splitId, orientation: 'grid' as never }, ctx)).toBe(asRow)
  })

  it('refuses a join zone it does not know: the tab joins at the default place', () => {
    const { ctx, state, id } = gridOfFour()
    const three = reduce(state, { type: 'split/remove', tabId: id.d }, ctx)
    const joinedAnyway = reduce(three, { type: 'split/create', tabId: id.e, withTabId: id.a, zone: 'diagonal' as never }, ctx)
    expect(joinedAnyway.splits[0]?.tabIds).toEqual([id.a, id.b, id.c, id.e])
    expect(activeTab(joinedAnyway)?.id).toBe(id.e)
  })

  it('puts a grid back as it was with the « Annuler » of a closed pane', () => {
    const { ctx, state, id } = gridOfFour()
    const before = splitFor(state, id.a)!
    const three = reduce(state, { type: 'split/remove', tabId: id.b }, ctx)
    expect(reduce(three, { type: 'split/restore', split: before }, ctx).splits[0]).toEqual(before)
  })
})

describe('the split views of a file (the migration to grids)', () => {
  /** A state of three tabs and the split views given, written to a file and read back. */
  function roundTrip(splits: unknown[]): SidebarState {
    let n = 0
    const ctx: Ctx = { now: 1_000_000, newId: () => `id${++n}` }
    let state: SidebarState = createInitialState(ctx)
    for (const name of ['a', 'b', 'c', 'd']) state = reduce(state, { type: 'tab/open', url: `https://${name}.example/`, background: true }, ctx)
    const file = { ...persistableState(state), splits: splits.map((sp) => ({ spaceId: state.activeSpaceId, ...(sp as object) })) }
    return parseSavedState(JSON.stringify(file))
  }
  const ids = (state: SidebarState) => state.tabs.map((t) => t.id)

  it('opens the rows and the columns of a file written before grids as they were: no grid, the same panes, order and shares', () => {
    const [a, b, c, d] = ids(roundTrip([]))
    const row = { id: 'sv-row', tabIds: [a, b], orientation: 'horizontal', ratios: [0.3, 0.7] }
    const column = { id: 'sv-col', tabIds: [c, d], orientation: 'vertical', ratios: [0.4, 0.6] }
    const opened = roundTrip([row, column])
    expect(opened.splits).toEqual([{ ...row, spaceId: opened.activeSpaceId }, { ...column, spaceId: opened.activeSpaceId }])
    expect(opened.splits.every((sp) => !('grid' in sp))).toBe(true)
    // Read again, it is the same file: nothing to migrate twice.
    expect(normalize(opened)).toEqual(opened)
  })

  it('keeps a grid of three or four through a file, and it reads back the same', () => {
    const [a, b, c, d] = ids(roundTrip([]))
    const four: Omit<SplitView, 'spaceId'> = { id: 'sv-4', tabIds: [a!, b!, c!, d!], orientation: 'horizontal', ratios: equalRatios(4), grid: { column: 0.3, row: 0.6 } }
    const three: Omit<SplitView, 'spaceId'> = { id: 'sv-3', tabIds: [a!, b!, c!], orientation: 'vertical', ratios: equalRatios(3), grid: { column: 0.4, row: 0.5, span: 'left' } }
    const opened = roundTrip([four])
    expect(opened.splits[0]).toEqual({ ...four, spaceId: opened.activeSpaceId })
    expect(normalize(opened)).toEqual(opened)
    expect(roundTrip([three]).splits[0]).toEqual({ ...three, spaceId: opened.activeSpaceId })
  })

  it('repairs what a file says of a grid: no grid for two panes, a side only for three, shares within the bounds', () => {
    const shape = (tabIds: string[], gridField: unknown) => ({ id: 'sv', spaceId: 'sp', tabIds, orientation: 'vertical', ratios: equalRatios(tabIds.length), grid: gridField })
    expect(cleanSplits([shape(['a', 'b'], { column: 0.3, row: 0.6 })])[0]).not.toHaveProperty('grid')
    expect(cleanSplits([shape(['a', 'b', 'c'], { column: 0.3, row: 0.6, span: 'diagonal' })])[0]?.grid).toEqual({ column: 0.3, row: 0.6, span: 'bottom' })
    expect(cleanSplits([shape(['a', 'b', 'c', 'd'], { column: 0.3, row: 0.6, span: 'left' })])[0]?.grid).toEqual({ column: 0.3, row: 0.6 })
    expect(cleanSplits([shape(['a', 'b', 'c', 'd'], { column: 0.01, row: 'half' })])[0]?.grid).toEqual({ column: 0.5, row: 0.5 })
    expect(cleanSplits([shape(['a', 'b', 'c', 'd'], 'grid')])[0]).not.toHaveProperty('grid')
    expect(cleanSplits([shape(['a', 'b', 'c', 'd'], null)])[0]).not.toHaveProperty('grid')
  })

  it('a grid of four whose tab is gone from the file opens as the grid of three that closing it would leave', () => {
    const [a, b, c, d] = ids(roundTrip([]))
    const opened = roundTrip([{ id: 'sv-4', tabIds: [a, b, c, d, 'gone'].filter((x) => x !== b), orientation: 'horizontal', ratios: equalRatios(4), grid: { column: 0.3, row: 0.6 } }])
    // The file lists a, c, d and a tab that is no more: a grid of four with one pane missing.
    expect(opened.splits[0]).toMatchObject({ tabIds: [a, c, d], grid: { column: 0.3, row: 0.6, span: 'bottom' } })
  })
})
