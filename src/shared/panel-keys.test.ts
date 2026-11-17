import { describe, expect, it } from 'vitest'
import { isAnswerKey, isLeaveKey, isUndoKey, listPanelKey, nextRowIndex, tabIndexInPanel } from './panel-keys'

describe('nextRowIndex', () => {
  it('moves one row with the arrows and stops at the ends of the list', () => {
    expect(nextRowIndex(0, 5, 'ArrowDown')).toBe(1)
    expect(nextRowIndex(4, 5, 'ArrowDown')).toBe(4)
    expect(nextRowIndex(2, 5, 'ArrowUp')).toBe(1)
    expect(nextRowIndex(0, 5, 'ArrowUp')).toBe(0)
  })
  it('starts on the first row when nothing has the focus yet', () => {
    expect(nextRowIndex(-1, 5, 'ArrowDown')).toBe(0)
    expect(nextRowIndex(-1, 5, 'ArrowUp')).toBe(0)
  })
  it('goes to the ends with Home and End, ignores other keys, and has no row in an empty list', () => {
    expect(nextRowIndex(2, 5, 'Home')).toBe(0)
    expect(nextRowIndex(2, 5, 'End')).toBe(4)
    expect(nextRowIndex(2, 5, 'a')).toBe(2)
    expect(nextRowIndex(0, 0, 'ArrowDown')).toBe(-1)
  })
})

describe('tabIndexInPanel', () => {
  it('goes round the ends, both ways, so that Tab never leaves the panel', () => {
    expect(tabIndexInPanel(2, 3, false)).toBe(0)
    expect(tabIndexInPanel(0, 3, true)).toBe(2)
    expect(tabIndexInPanel(0, 3, false)).toBe(1)
  })
  it('enters at the first part forwards and at the last backwards', () => {
    expect(tabIndexInPanel(-1, 3, false)).toBe(0)
    expect(tabIndexInPanel(-1, 3, true)).toBe(2)
    expect(tabIndexInPanel(0, 0, false)).toBe(-1)
  })
})

describe('isUndoKey', () => {
  const key = (init: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ key: 'z', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init })
  it('is ⌘Z (or Ctrl+Z) outside a field', () => {
    expect(isUndoKey(key({ metaKey: true }), false)).toBe(true)
    expect(isUndoKey(key({ ctrlKey: true, key: 'Z' }), false)).toBe(true)
  })
  it('is not Z alone, not redo (Shift), and not in a field, where it undoes the typing', () => {
    expect(isUndoKey(key({}), false)).toBe(false)
    expect(isUndoKey(key({ metaKey: true, shiftKey: true }), false)).toBe(false)
    expect(isUndoKey(key({ metaKey: true }), true)).toBe(false)
  })
})

describe('listPanelKey', () => {
  const key = (init: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }>) => ({ key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init })
  it('closes on Escape, in a field or not', () => {
    expect(listPanelKey(key({ key: 'Escape' }), false, false)).toEqual({ type: 'close' })
    expect(listPanelKey(key({ key: 'Escape' }), true, true)).toEqual({ type: 'close' })
  })
  it('leaves a key that something else took', () => {
    expect(listPanelKey(key({ key: 'Escape', defaultPrevented: true }), false, false)).toBeNull()
  })
  it('undoes with ⌘Z only when a deletion waits and the focus is not in a field', () => {
    expect(listPanelKey(key({ key: 'z', metaKey: true }), false, true)).toEqual({ type: 'undo' })
    expect(listPanelKey(key({ key: 'z', metaKey: true }), false, false)).toBeNull()
    expect(listPanelKey(key({ key: 'z', metaKey: true }), true, true)).toBeNull()
  })
  it('moves with the arrows, Home and End on the rows', () => {
    for (const name of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) expect(listPanelKey(key({ key: name }), false, false)).toEqual({ type: 'move', key: name })
  })
  it('keeps the caret keys for the fields, except ArrowDown in the search, which goes down into the results', () => {
    expect(listPanelKey(key({ key: 'ArrowUp' }), true, false)).toBeNull()
    expect(listPanelKey(key({ key: 'Home' }), true, false)).toBeNull()
    expect(listPanelKey(key({ key: 'End' }), true, false)).toBeNull()
    expect(listPanelKey(key({ key: 'ArrowDown' }), true, false)).toEqual({ type: 'move', key: 'ArrowDown' })
  })
  it('ignores the other keys', () => {
    expect(listPanelKey(key({ key: 'Enter' }), false, true)).toBeNull()
  })
})

describe('isLeaveKey and isAnswerKey', () => {
  it('leaves on Escape that nothing took', () => {
    expect(isLeaveKey({ key: 'Escape' })).toBe(true)
    expect(isLeaveKey({ key: 'Escape', defaultPrevented: true })).toBe(false)
    expect(isLeaveKey({ key: 'Enter' })).toBe(false)
  })
  it('answers on Return in a field, not on a button (which Return presses), not when the key was taken', () => {
    expect(isAnswerKey({ key: 'Enter' }, 'INPUT')).toBe(true)
    expect(isAnswerKey({ key: 'Enter' }, 'button')).toBe(false)
    expect(isAnswerKey({ key: 'Enter', defaultPrevented: true }, 'INPUT')).toBe(false)
    expect(isAnswerKey({ key: 'a' }, 'INPUT')).toBe(false)
  })
})
