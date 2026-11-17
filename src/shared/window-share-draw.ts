// The drawing on the annotated-share view (docs/design/annotation-partage-fenetre.md, « Dessin »): the brush, the elements (strokes, shapes, texts),
// the selection rules, the history (undo and redo) and the limits that keep them bounded. Pure on purpose: the canvas that paints them is in
// renderer/window-share-view.ts. Nothing here is stored or sent: the elements live in the view window's memory, the brush in the main process.

import type { ShareNotice } from './window-share'
import { clamp01 } from './clamp'

/** The tools of the drawing. `select` picks and moves an element; `eraser` removes the elements it touches. */
export const DRAW_TOOLS = ['select', 'pen', 'highlighter', 'rectangle', 'ellipse', 'line', 'arrow', 'text', 'eraser'] as const
export type DrawTool = (typeof DRAW_TOOLS)[number]

/** The colours the brush may take. Anything else is refused. */
export const DRAW_COLORS = ['#e53935', '#fdd835', '#43a047', '#1e88e5', '#ffffff'] as const
export type DrawColor = (typeof DRAW_COLORS)[number]

/** The thicknesses, in pixels for a picture of `REFERENCE_HEIGHT` pixels of height (the view scales them with its picture). */
export const DRAW_WIDTHS = [2, 5, 10] as const
export type DrawWidth = (typeof DRAW_WIDTHS)[number]

export const REFERENCE_HEIGHT = 600

export interface Brush {
  tool: DrawTool
  color: DrawColor
  width: DrawWidth
}

export const DEFAULT_BRUSH: Brush = { tool: 'pen', color: '#e53935', width: 5 }

/** The most elements the picture keeps. A new element past this limit is not made. */
export const MAX_ELEMENTS = 300
/** The most points of one stroke. A stroke that reaches it stops taking points (it still ends where it is). */
export const MAX_POINTS_PER_STROKE = 2000
/** The most steps the history keeps for undo. */
export const HISTORY_LIMIT = 100
/** The longest text an element may carry. A longer text, or an empty one, is refused. */
export const TEXT_MAX_LENGTH = 200
/** The eraser's and the selection's reach, in picture heights (the same on both axes, so a round brush stays round). */
export const ERASER_RADIUS = 0.03

/** A point of the picture: 0 to 1 on both axes, measured on the picture itself (not on the window around it). */
export interface Point {
  x: number
  y: number
}

export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'arrow'

interface Style {
  color: DrawColor
  width: DrawWidth
}

/** An element of the picture, with its identity (the selection and the history refer to it). */
export type Element =
  | ({ id: number; kind: 'stroke'; tool: 'pen' | 'highlighter'; points: Point[] } & Style)
  | ({ id: number; kind: 'shape'; shape: ShapeKind; from: Point; to: Point } & Style)
  | ({ id: number; kind: 'text'; at: Point; text: string } & Style)

type DistributiveOmitId<T> = T extends unknown ? Omit<T, 'id'> : never
/** An element being drawn: it has no identity until it is kept. */
export type Draft = DistributiveOmitId<Element>

/** The elements, the history of the earlier states (for undo) and of the undone ones (for redo). */
export interface Drawing {
  elements: Element[]
  nextId: number
  past: Element[][]
  future: Element[][]
}

export const EMPTY_DRAWING: Drawing = { elements: [], nextId: 1, past: [], future: [] }

/** The commands of the command window that act on the view as a whole. */
export const EDIT_COMMANDS = ['undo', 'redo', 'clear'] as const
export type EditCommand = (typeof EDIT_COMMANDS)[number]

/** What the main process sends to the view window. */
export type DrawAction =
  | { type: 'brush'; brush: Brush }
  | { type: EditCommand }
  | { type: 'source' }
  | { type: 'pass'; on: boolean }
  /** What the view shows over the picture about its source (see shareNoticeOf). */
  | { type: 'notice'; notice: ShareNotice }

/** Whether a value is a brush the palette allows: the tool, the colour and the thickness must each be in their list. */
export function isBrush(raw: unknown): raw is Brush {
  if (typeof raw !== 'object' || raw === null) return false
  const { tool, color, width } = raw as Record<string, unknown>
  return (DRAW_TOOLS as readonly unknown[]).includes(tool) && (DRAW_COLORS as readonly unknown[]).includes(color) && (DRAW_WIDTHS as readonly unknown[]).includes(width)
}

/** Whether a value is one of the commands the command window may send (nothing else reaches the view). */
export function isEditCommand(raw: unknown): raw is EditCommand {
  return (EDIT_COMMANDS as readonly unknown[]).includes(raw)
}

export type ShortcutAction = EditCommand | 'delete'

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * The shortcut a key press means: Ctrl or Cmd with Z (undo), with Shift and Z (redo), with Shift and Backspace (clear all); Delete or Backspace
 * alone removes the selected element. Alt is part of none of them.
 */
export function shortcutOf(event: KeyLike): ShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey
  if (event.altKey) return null
  if (mod && event.shiftKey && event.key === 'Backspace') return 'clear'
  if (mod && event.key.toLowerCase() === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (!mod && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')) return 'delete'
  return null
}

/**
 * What a key pressed in the field of a text being typed does: Return keeps the text, Escape drops it, any other key is the field's. While a text
 * is being composed (Japanese, Chinese, Korean: `isComposing`), Return chooses a candidate and Escape gives the composition up: both belong to the
 * input method, and ending the text there would place it half typed.
 */
export function textKeyOutcome(event: { key: string; isComposing: boolean }): 'keep' | 'drop' | null {
  if (event.isComposing) return null
  if (event.key === 'Enter') return 'keep'
  if (event.key === 'Escape') return 'drop'
  return null
}

/** Whether one more element may be made, given how many there are. */
export function canAddElement(count: number): boolean {
  return count < MAX_ELEMENTS
}

/** The element a press starts with the brush's tool: a stroke for the pen and the highlighter, a shape for the four shapes, nothing otherwise. */
export function draftFor(brush: Brush, point: Point): Draft | null {
  const { color, width } = brush
  switch (brush.tool) {
    case 'pen':
    case 'highlighter':
      return { kind: 'stroke', tool: brush.tool, points: [point], color, width }
    case 'rectangle':
    case 'ellipse':
    case 'line':
    case 'arrow':
      return { kind: 'shape', shape: brush.tool, from: point, to: point, color, width }
    default:
      return null
  }
}

/** Follows the pointer with a draft: a stroke takes the point (up to the limit), a shape moves its end. Changes the draft in place. */
export function extendDraft(draft: Draft, point: Point): Draft {
  if (draft.kind === 'stroke') {
    if (draft.points.length < MAX_POINTS_PER_STROKE) draft.points.push(point)
  } else if (draft.kind === 'shape') {
    draft.to = point
  }
  return draft
}

/** Whether a draft is worth keeping: a shape that has no size (a click) is not. */
export function isKeepable(draft: Draft): boolean {
  return draft.kind !== 'shape' || draft.from.x !== draft.to.x || draft.from.y !== draft.to.y
}

/** The text an element carries: trimmed, and neither empty nor longer than `TEXT_MAX_LENGTH`. Anything else is refused (null). */
export function cleanText(raw: string): string | null {
  const text = raw.trim()
  return text.length === 0 || text.length > TEXT_MAX_LENGTH ? null : text
}

/** The height of a text's characters for a thickness, in pixels of a picture of `REFERENCE_HEIGHT` pixels. */
export function textSizeAt(width: number): number {
  return 8 + width * 3
}

/** The distance from `p` to the segment `a`-`b`, in picture heights. `aspect` is the picture's width over its height. */
function distanceToSegment(p: Point, a: Point, b: Point, aspect: number): number {
  const px = p.x * aspect
  const ax = a.x * aspect
  const bx = b.x * aspect
  const dx = bx - ax
  const dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (p.y - a.y) * dy) / length2))
  return Math.hypot(ax + t * dx - px, a.y + t * dy - p.y)
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The box an element (or a draft) takes in the picture, on the picture's 0 to 1 axes. A text is estimated from its size: no measure of the font. */
export function boundsOf(element: Draft, aspect: number): Bounds {
  if (element.kind === 'stroke') {
    const xs = element.points.map((point) => point.x)
    const ys = element.points.map((point) => point.y)
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
  }
  if (element.kind === 'shape') {
    return {
      minX: Math.min(element.from.x, element.to.x),
      minY: Math.min(element.from.y, element.to.y),
      maxX: Math.max(element.from.x, element.to.x),
      maxY: Math.max(element.from.y, element.to.y)
    }
  }
  const height = textSizeAt(element.width) / REFERENCE_HEIGHT
  const width = (element.text.length * 0.6 * height) / (aspect || 1)
  return { minX: element.at.x, minY: element.at.y, maxX: element.at.x + width, maxY: element.at.y + height }
}

/** Whether the point comes within the eraser's reach of the element: a stroke by its segments, a shape or a text by its box. */
function touches(element: Element, point: Point, aspect: number): boolean {
  if (element.kind === 'stroke') {
    return element.points.some((current, index) => distanceToSegment(point, element.points[index - 1] ?? current, current, aspect) <= ERASER_RADIUS)
  }
  const box = boundsOf(element, aspect)
  const margin = ERASER_RADIUS / (aspect || 1)
  return point.x >= box.minX - margin && point.x <= box.maxX + margin && point.y >= box.minY - ERASER_RADIUS && point.y <= box.maxY + ERASER_RADIUS
}

/** The topmost element the point touches, or null. The selection takes this one. */
export function hitElement(elements: readonly Element[], point: Point, aspect: number): Element | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index]!
    if (touches(element, point, aspect)) return element
  }
  return null
}

/** The elements that stay after the eraser has touched `point`: every element it touches is removed as a whole. */
export function eraseAt(elements: readonly Element[], point: Point, aspect: number): Element[] {
  return elements.filter((element) => !touches(element, point, aspect))
}

/** The element moved by (dx, dy) on the picture's axes. The moved element is a new object: the history keeps the old one. */
export function moveElement(element: Element, dx: number, dy: number): Element {
  const shift = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy })
  if (element.kind === 'stroke') return { ...element, points: element.points.map(shift) }
  if (element.kind === 'shape') return { ...element, from: shift(element.from), to: shift(element.to) }
  return { ...element, at: shift(element.at) }
}

/** The elements with the colour and the thickness of one of them changed. The other elements are left as they are. */
export function restyleElement(elements: readonly Element[], id: number, color: DrawColor, width: DrawWidth): Element[] {
  return elements.map((element) => (element.id === id ? { ...element, color, width } : element))
}

/** Records a new state of the elements: the state before it goes to the history, and the redo history is cleared. Same state, nothing recorded. */
function record(drawing: Drawing, elements: Element[], nextId: number = drawing.nextId): Drawing {
  if (elements === drawing.elements && nextId === drawing.nextId) return drawing
  return { elements, nextId, past: [...drawing.past, drawing.elements].slice(-HISTORY_LIMIT), future: [] }
}

/** Keeps a draft as a new element, with the next identity. Past the limit of elements, nothing is kept. */
export function addElement(drawing: Drawing, draft: Draft): Drawing {
  if (!canAddElement(drawing.elements.length)) return drawing
  const element = { ...draft, id: drawing.nextId } as Element
  return record(drawing, [...drawing.elements, element], drawing.nextId + 1)
}

/** Whether two lists hold the same elements (the same objects, in the same order): a gesture that changed nothing records nothing. */
export function sameElements(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((element, index) => element === b[index])
}

/** Records the elements after a gesture (a move, an erasing, a restyling): one step of history for the whole gesture, none if nothing changed. */
export function commitElements(drawing: Drawing, elements: Element[]): Drawing {
  return sameElements(elements, drawing.elements) ? drawing : record(drawing, elements)
}

/** Removes every element, as one step of history. An empty picture has nothing to remove. */
export function clearAll(drawing: Drawing): Drawing {
  return drawing.elements.length === 0 ? drawing : record(drawing, [])
}

export function undo(drawing: Drawing): Drawing {
  const previous = drawing.past[drawing.past.length - 1]
  if (!previous) return drawing
  return { elements: previous, nextId: drawing.nextId, past: drawing.past.slice(0, -1), future: [drawing.elements, ...drawing.future] }
}

export function redo(drawing: Drawing): Drawing {
  const next = drawing.future[0]
  if (!next) return drawing
  return { elements: next, nextId: drawing.nextId, past: [...drawing.past, drawing.elements].slice(-HISTORY_LIMIT), future: drawing.future.slice(1) }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the picture sits in a box, the way `object-fit: contain` puts a video: centred, same proportions, letterboxed. Until the picture's size is
 * known, the picture is the whole box.
 */
export function contentRect(box: { width: number; height: number }, picture: { width: number; height: number }): Rect {
  if (!box.width || !box.height || !picture.width || !picture.height) return { x: 0, y: 0, width: box.width, height: box.height }
  const scale = Math.min(box.width / picture.width, box.height / picture.height)
  const width = picture.width * scale
  const height = picture.height * scale
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}

/** A window position (in pixels of the box) as a point of the picture, clamped to its edges. */
export function pointIn(rect: Rect, clientX: number, clientY: number): Point {
  return {
    x: rect.width ? clamp01((clientX - rect.x) / rect.width) : 0,
    y: rect.height ? clamp01((clientY - rect.y) / rect.height) : 0
  }
}
