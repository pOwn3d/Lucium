import { describe, expect, it } from 'vitest'
import type { TabItem } from './model'
import { GRID_PICTURE_LIMIT, gridPictures, isGridKey, moveGridSelection, selectionAfterClose } from './tab-grid'

const tab = (id: string, lastActiveAt: number, extra: Partial<TabItem> = {}): TabItem => ({ id, lastActiveAt, ...extra }) as TabItem
const picture = (id: string) => `data:image/jpeg;base64,${id}`

describe('the pictures of the tab overview', () => {
  const tabs = [tab('a', 1), tab('b', 3), tab('c', 2)]

  it('gives the picture of each tab that has one, and nothing for the others', () => {
    const pictures = gridPictures({ tabs }, (id) => (id === 'b' ? picture(id) : null), false)
    expect(pictures).toEqual({ b: picture('b') })
  })

  it('never carries the picture of a private tab', () => {
    const withPrivate = [tab('a', 1), tab('p', 5, { private: true })]
    expect(Object.keys(gridPictures({ tabs: withPrivate }, picture, false))).toEqual(['a'])
  })

  it('carries no picture at all in a private window', () => {
    expect(gridPictures({ tabs }, picture, true)).toEqual({})
  })

  it('keeps the tabs used last when there are more than the limit', () => {
    const many = Array.from({ length: GRID_PICTURE_LIMIT + 5 }, (_, i) => tab(`t${i}`, i))
    const pictures = gridPictures({ tabs: many }, picture, false)
    expect(Object.keys(pictures)).toHaveLength(GRID_PICTURE_LIMIT)
    expect(pictures[`t${GRID_PICTURE_LIMIT + 4}`]).toBeDefined()
    expect(pictures['t0']).toBeUndefined()
  })

  it('does not spend the limit on tabs that have no picture', () => {
    const many = Array.from({ length: GRID_PICTURE_LIMIT + 5 }, (_, i) => tab(`t${i}`, i))
    // The most recent five have none: the limit is still filled by the ones before them.
    const pictures = gridPictures({ tabs: many }, (id) => (Number(id.slice(1)) >= GRID_PICTURE_LIMIT ? null : picture(id)), false)
    expect(Object.keys(pictures)).toHaveLength(GRID_PICTURE_LIMIT)
  })
})

describe('the keys of the grid', () => {
  it('moves one card left and right and stops at the ends', () => {
    expect(moveGridSelection(2, 6, 3, 'ArrowRight')).toBe(3)
    expect(moveGridSelection(5, 6, 3, 'ArrowRight')).toBe(5)
    expect(moveGridSelection(2, 6, 3, 'ArrowLeft')).toBe(1)
    expect(moveGridSelection(0, 6, 3, 'ArrowLeft')).toBe(0)
  })

  it('moves one row up and down and stays on the first and last row', () => {
    expect(moveGridSelection(1, 7, 3, 'ArrowDown')).toBe(4)
    expect(moveGridSelection(4, 7, 3, 'ArrowDown')).toBe(4)
    expect(moveGridSelection(4, 7, 3, 'ArrowUp')).toBe(1)
    expect(moveGridSelection(1, 7, 3, 'ArrowUp')).toBe(1)
  })

  it('goes to the ends with Home and End', () => {
    expect(moveGridSelection(4, 7, 3, 'Home')).toBe(0)
    expect(moveGridSelection(1, 7, 3, 'End')).toBe(6)
  })

  it('answers 0 with no card, and a single column is a list', () => {
    expect(moveGridSelection(3, 0, 3, 'ArrowDown')).toBe(0)
    expect(moveGridSelection(1, 4, 0, 'ArrowDown')).toBe(2)
  })

  it('recognises its keys only', () => {
    expect(isGridKey('ArrowUp')).toBe(true)
    expect(isGridKey('Tab')).toBe(false)
  })

  it('puts the selection on the card that takes the place of a closed one', () => {
    expect(selectionAfterClose(2, 5)).toBe(2)
    expect(selectionAfterClose(4, 4)).toBe(3)
    expect(selectionAfterClose(0, 0)).toBe(0)
  })
})
