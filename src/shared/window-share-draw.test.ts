import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BRUSH,
  EMPTY_DRAWING,
  MAX_ELEMENTS,
  MAX_POINTS_PER_STROKE,
  addElement,
  canAddElement,
  cleanText,
  clearAll,
  commitElements,
  contentRect,
  draftFor,
  eraseAt,
  extendDraft,
  hitElement,
  isBrush,
  isEditCommand,
  isKeepable,
  moveElement,
  pointIn,
  redo,
  restyleElement,
  shortcutOf,
  textKeyOutcome,
  undo,
  type Draft,
  type Drawing
} from './window-share-draw'

const key = (name: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: name,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers
})

/** A draft kept as a new element of the drawing. */
function keep(drawing: Drawing, draft: Draft): Drawing {
  return addElement(drawing, draft)
}
const stroke = (x: number, y: number): Draft => ({ kind: 'stroke', tool: 'pen', points: [{ x, y }], color: '#e53935', width: 5 })
const box = (x1: number, y1: number, x2: number, y2: number): Draft => ({
  kind: 'shape',
  shape: 'rectangle',
  from: { x: x1, y: y1 },
  to: { x: x2, y: y2 },
  color: '#e53935',
  width: 5
})

describe('the brush', () => {
  it('takes a tool, a colour and a thickness of the palette, and nothing else', () => {
    expect(isBrush(DEFAULT_BRUSH)).toBe(true)
    expect(isBrush({ tool: 'pen', color: '#000000', width: 5 })).toBe(false)
    expect(isBrush({ tool: 'pen', color: '#e53935', width: 7 })).toBe(false)
    expect(isBrush({ tool: 'laser', color: '#e53935', width: 5 })).toBe(false)
    expect(isBrush(null)).toBe(false)
  })

  it('takes only the edit commands the command window may send', () => {
    expect(['undo', 'redo', 'clear'].every(isEditCommand)).toBe(true)
    expect(isEditCommand('delete')).toBe(false)
    expect(isEditCommand({ type: 'clear' })).toBe(false)
  })
})

describe('the shortcuts', () => {
  it('undoes with Ctrl or Cmd and Z, redoes with Shift, and clears with Shift and Backspace', () => {
    expect(shortcutOf(key('z', { metaKey: true }))).toBe('undo')
    expect(shortcutOf(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(shortcutOf(key('Backspace', { metaKey: true, shiftKey: true }))).toBe('clear')
  })

  it('deletes the selection with Delete or Backspace alone, and does nothing with Alt', () => {
    expect(shortcutOf(key('Delete'))).toBe('delete')
    expect(shortcutOf(key('Backspace'))).toBe('delete')
    expect(shortcutOf(key('z'))).toBeNull()
    expect(shortcutOf(key('z', { metaKey: true, altKey: true }))).toBeNull()
  })
})

describe('the tools', () => {
  it('starts a stroke for the pen, a shape for the four shapes, and nothing for the others', () => {
    const at = { x: 0.2, y: 0.3 }
    expect(draftFor({ ...DEFAULT_BRUSH, tool: 'pen' }, at)).toMatchObject({ kind: 'stroke', tool: 'pen' })
    expect(draftFor({ ...DEFAULT_BRUSH, tool: 'arrow' }, at)).toMatchObject({ kind: 'shape', shape: 'arrow' })
    expect(draftFor({ ...DEFAULT_BRUSH, tool: 'select' }, at)).toBeNull()
    expect(draftFor({ ...DEFAULT_BRUSH, tool: 'text' }, at)).toBeNull()
    expect(draftFor({ ...DEFAULT_BRUSH, tool: 'eraser' }, at)).toBeNull()
  })

  it('does not keep a shape that has no size (a click)', () => {
    expect(isKeepable(box(0.5, 0.5, 0.5, 0.5))).toBe(false)
    expect(isKeepable(box(0.5, 0.5, 0.6, 0.5))).toBe(true)
  })

  it('stops a stroke at the most points, and keeps the points before it', () => {
    const draft = stroke(0, 0)
    for (let index = 0; index < MAX_POINTS_PER_STROKE + 500; index += 1) extendDraft(draft, { x: index / 10000, y: 0 })
    expect(draft.kind === 'stroke' && draft.points).toHaveLength(MAX_POINTS_PER_STROKE)
  })
})

describe('the elements and their limit', () => {
  it('gives each kept element its own identity, and undo and redo bring them back', () => {
    let drawing = keep(EMPTY_DRAWING, stroke(0.1, 0.1))
    drawing = keep(drawing, box(0.2, 0.2, 0.4, 0.4))
    expect(drawing.elements.map((element) => element.id)).toEqual([1, 2])
    drawing = undo(drawing)
    expect(drawing.elements.map((element) => element.id)).toEqual([1])
    drawing = redo(drawing)
    expect(drawing.elements.map((element) => element.id)).toEqual([1, 2])
  })

  it('keeps no element past the limit', () => {
    expect(canAddElement(MAX_ELEMENTS - 1)).toBe(true)
    expect(canAddElement(MAX_ELEMENTS)).toBe(false)
    let drawing = EMPTY_DRAWING
    for (let index = 0; index < MAX_ELEMENTS + 5; index += 1) drawing = keep(drawing, stroke(0.1, 0.1))
    expect(drawing.elements).toHaveLength(MAX_ELEMENTS)
  })

  it('refuses an empty text, a blank one and a text past the length, and trims the others', () => {
    expect(cleanText('')).toBeNull()
    expect(cleanText('   ')).toBeNull()
    expect(cleanText('a'.repeat(201))).toBeNull()
    expect(cleanText('  bonjour  ')).toBe('bonjour')
  })
})

describe('the history', () => {
  it('undoes a clear, and a new change after an undo drops the redo', () => {
    const drawing = keep(EMPTY_DRAWING, stroke(0.1, 0.1))
    const cleared = clearAll(drawing)
    expect(cleared.elements).toHaveLength(0)
    expect(undo(cleared).elements).toHaveLength(1)
    const branched = keep(undo(cleared), box(0.3, 0.3, 0.5, 0.5))
    expect(branched.future).toHaveLength(0)
    expect(redo(branched)).toBe(branched)
  })

  it('records a gesture that changed nothing as no step at all', () => {
    const drawing = keep(EMPTY_DRAWING, stroke(0.1, 0.1))
    const same = commitElements(drawing, drawing.elements.slice())
    expect(same).toBe(drawing)
    expect(clearAll(EMPTY_DRAWING)).toBe(EMPTY_DRAWING)
  })

  it('makes a move one step: undo brings the element back where it was', () => {
    // Offsets that are exact in binary, so that the positions compare as equal.
    const drawing = keep(EMPTY_DRAWING, box(0.25, 0.25, 0.5, 0.5))
    const moved = commitElements(drawing, drawing.elements.map((element) => moveElement(element, 0.25, 0.25)))
    expect(moved.elements[0]).toMatchObject({ from: { x: 0.5, y: 0.5 }, to: { x: 0.75, y: 0.75 } })
    expect(undo(moved).elements[0]).toMatchObject({ from: { x: 0.25, y: 0.25 }, to: { x: 0.5, y: 0.5 } })
  })
})

describe('the selection and the eraser', () => {
  const drawing = keep(keep(EMPTY_DRAWING, stroke(0.5, 0.5)), box(0.2, 0.2, 0.4, 0.4))

  it('picks the topmost element the point touches', () => {
    expect(hitElement(drawing.elements, { x: 0.3, y: 0.3 }, 1)?.id).toBe(2)
    expect(hitElement(drawing.elements, { x: 0.9, y: 0.9 }, 1)).toBeNull()
  })

  it('erases the elements the eraser touches, and keeps the others', () => {
    const remaining = eraseAt(drawing.elements, { x: 0.5, y: 0.5 }, 1)
    expect(remaining.map((element) => element.id)).toEqual([2])
  })

  it('restyles only the selected element', () => {
    const restyled = restyleElement(drawing.elements, 1, '#1e88e5', 10)
    expect(restyled[0]).toMatchObject({ color: '#1e88e5', width: 10 })
    expect(restyled[1]).toBe(drawing.elements[1])
  })
})

describe('the picture in the window', () => {
  it('centres a picture with its proportions, and takes the whole box until its size is known', () => {
    expect(contentRect({ width: 960, height: 600 }, { width: 1920, height: 1080 })).toEqual({ x: 0, y: 30, width: 960, height: 540 })
    expect(contentRect({ width: 960, height: 600 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 960, height: 600 })
  })

  it('reads a window position as a point of the picture, clamped to its edges', () => {
    const rect = { x: 0, y: 30, width: 960, height: 540 }
    expect(pointIn(rect, 480, 300)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointIn(rect, -50, 2000)).toEqual({ x: 0, y: 1 })
  })
})

describe('a key pressed in the field of a text being typed', () => {
  it('keeps the text on Return, drops it on Escape, and leaves any other key to the field', () => {
    expect(textKeyOutcome({ key: 'Enter', isComposing: false })).toBe('keep')
    expect(textKeyOutcome({ key: 'Escape', isComposing: false })).toBe('drop')
    expect(textKeyOutcome({ key: 'a', isComposing: false })).toBeNull()
  })

  it('ends nothing while a text is being composed: Return chooses a candidate of the input method, Escape gives the composition up', () => {
    expect(textKeyOutcome({ key: 'Enter', isComposing: true })).toBeNull()
    expect(textKeyOutcome({ key: 'Escape', isComposing: true })).toBeNull()
  })
})
