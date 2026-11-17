// Annotating a capture: what the sheet that follows a capture can draw over the picture, the limits that keep it bounded, the editor's
// state as a reducer (tool, colour, undo and redo) and the checks on what comes back from the sheet. Every coordinate is a pixel of the
// picture itself, not of the screen, so that the exported picture has the size of the capture whatever the size of the sheet.
// The drawing itself is in annotate-draw.ts; the shell side (holding the capture, saving, copying, sharing) is in main/shell/capture.ts.

import { imageHeader } from './space-image'
import { t } from './i18n'
import { clamp } from './clamp'

export const ANNOTATE_TOOLS = ['pen', 'arrow', 'rect', 'text', 'blur'] as const
export type AnnotateTool = (typeof ANNOTATE_TOOLS)[number]

export const ANNOTATE_TOOL_LABELS: Readonly<Record<AnnotateTool, string>> = {
  get pen() { return t('annotate.crayon') },
  get arrow() { return t('annotate.fleche') },
  get rect() { return t('annotate.rectangle') },
  get text() { return t('annotate.texte') },
  get blur() { return t('annotate.flou') }
}

export const ANNOTATE_COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#1c1c1e'] as const
export const ANNOTATE_COLOR_NAMES: Readonly<Record<(typeof ANNOTATE_COLORS)[number], string>> = {
  get '#ff3b30'() { return t('annotate.couleur-rouge') },
  get '#ff9500'() { return t('annotate.couleur-orange') },
  get '#ffcc00'() { return t('annotate.couleur-jaune') },
  get '#34c759'() { return t('annotate.couleur-vert') },
  get '#0a84ff'() { return t('annotate.couleur-bleu') },
  get '#ffffff'() { return t('annotate.couleur-blanc') },
  get '#1c1c1e'() { return t('annotate.couleur-noir') }
}

/** Three thicknesses, in pixels of a picture 1000 px wide: a wider picture scales them up so that a line looks the same on the sheet. */
export const ANNOTATE_STROKES = [3, 6, 10] as const
export const ANNOTATE_TEXT_SIZES = [20, 30, 46] as const
/** The names of the three thicknesses (and text sizes), thinnest first, in the language of the interface. */
export const annotateStrengthLabels = (): readonly [string, string, string] => [t('annotate.fin'), t('annotate.moyen'), t('annotate.epais')]
export const ANNOTATE_REFERENCE_WIDTH = 1000

export const ANNOTATE_LIMITS = {
  /** Shapes on one picture. */
  items: 200,
  /** Points of one pen stroke. */
  points: 2000,
  /** Characters of one text. */
  text: 200,
  /** A drag shorter than this (in picture pixels) draws nothing: it was a click. */
  minDrag: 4,
  /** Two points of a stroke closer than this are one. */
  minStep: 1.5,
  /** What the sheet takes: a bigger picture is saved the way captures always were. Chromium's canvas stops at 16384 px, and a decoded picture costs 4 bytes a pixel. */
  side: 16384,
  pixels: 30_000_000,
  /** The weight of a PNG the sheet takes or hands back. */
  bytes: 64 * 1024 * 1024
} as const

export interface Point {
  x: number
  y: number
}

export type Annotation =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'arrow'; color: string; width: number; from: Point; to: Point }
  | { kind: 'rect'; color: string; width: number; x: number; y: number; w: number; h: number }
  | { kind: 'text'; color: string; size: number; at: Point; text: string }
  /** A mosaic over the picture's own pixels: what is under it cannot be read back (a real blur could be undone). */
  | { kind: 'blur'; x: number; y: number; w: number; h: number }

export interface PictureSize {
  width: number
  height: number
}

/** How much a width of the sheet is scaled up to match the picture. */
export const annotateScale = (width: number): number => Math.max(1, width / ANNOTATE_REFERENCE_WIDTH)

/** The picture's pixels one cell of the mosaic covers: big enough that text under it cannot be read, in proportion to the picture. */
export const blurCell = (size: PictureSize): number => Math.max(10, Math.round(Math.max(size.width, size.height) / 90))

/** A text as it is kept: one line, no control character, at most `ANNOTATE_LIMITS.text` characters; '' when nothing is left. */
export function cleanAnnotationText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\p{Cc}+/gu, ' ').trim().slice(0, ANNOTATE_LIMITS.text).trim()
}

function inside(size: PictureSize, at: Point): Point | null {
  if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) return null
  return { x: clamp(at.x, 0, size.width), y: clamp(at.y, 0, size.height) }
}

// ---------- the keyboard's point ----------

const NUDGES: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/** Where the keyboard's point starts on a picture: its middle. */
export const annotateCentre = (size: PictureSize): Point => ({ x: Math.round(size.width / 2), y: Math.round(size.height / 2) })

/**
 * The keyboard's point after an arrow: with no point yet, the middle of the picture (the first arrow shows it); else moved by a hundredth of the
 * picture's longer side (never under 2 pixels), five times that with Shift, kept on the picture. Null for a key that is not an arrow. The sheet
 * begins, extends and ends a shape at this point, as the pointer does at its own.
 */
export function annotateNudge(at: Point | null, key: string, shift: boolean, size: PictureSize): Point | null {
  const move = NUDGES[key]
  if (!move) return null
  if (!at) return annotateCentre(size)
  const step = Math.max(2, Math.round(Math.max(size.width, size.height) / 100)) * (shift ? 5 : 1)
  return { x: clamp(at.x + move[0] * step, 0, size.width), y: clamp(at.y + move[1] * step, 0, size.height) }
}

export interface AnnotateState {
  size: PictureSize
  tool: AnnotateTool
  color: (typeof ANNOTATE_COLORS)[number]
  /** Index in ANNOTATE_STROKES and ANNOTATE_TEXT_SIZES. */
  strength: 0 | 1 | 2
  items: Annotation[]
  /** What undo took away, newest last; a new shape empties it. */
  redo: Annotation[]
  /** The shape being dragged, not yet part of the picture, and the point where the drag began (a rectangle keeps that corner fixed). */
  draft: Annotation | null
  origin: Point | null
}

export function initialAnnotate(size: PictureSize): AnnotateState {
  return { size, tool: 'arrow', color: ANNOTATE_COLORS[0], strength: 1, items: [], redo: [], draft: null, origin: null }
}

export type AnnotateAction =
  | { type: 'tool'; tool: AnnotateTool }
  | { type: 'color'; color: string }
  | { type: 'strength'; strength: number }
  | { type: 'begin'; at: Point }
  | { type: 'extend'; at: Point }
  | { type: 'end' }
  | { type: 'abort' }
  | { type: 'text'; at: Point; text: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clear' }

const strokeWidth = (state: AnnotateState): number => Math.round(ANNOTATE_STROKES[state.strength] * annotateScale(state.size.width))

function started(state: AnnotateState, at: Point): Annotation | null {
  switch (state.tool) {
    case 'pen':
      return { kind: 'pen', color: state.color, width: strokeWidth(state), points: [at] }
    case 'arrow':
      return { kind: 'arrow', color: state.color, width: strokeWidth(state), from: at, to: at }
    case 'rect':
      return { kind: 'rect', color: state.color, width: strokeWidth(state), x: at.x, y: at.y, w: 0, h: 0 }
    case 'blur':
      return { kind: 'blur', x: at.x, y: at.y, w: 0, h: 0 }
    default:
      return null
  }
}

function extended(draft: Annotation, origin: Point, at: Point): Annotation {
  switch (draft.kind) {
    case 'pen': {
      const last = draft.points[draft.points.length - 1]!
      if (Math.hypot(at.x - last.x, at.y - last.y) < ANNOTATE_LIMITS.minStep || draft.points.length >= ANNOTATE_LIMITS.points) return draft
      return { ...draft, points: [...draft.points, at] }
    }
    case 'arrow':
      return { ...draft, to: at }
    case 'rect':
    case 'blur':
      return { ...draft, x: Math.min(origin.x, at.x), y: Math.min(origin.y, at.y), w: Math.abs(at.x - origin.x), h: Math.abs(at.y - origin.y) }
    default:
      return draft
  }
}

/** Whether a dragged shape is worth keeping: a click makes a dot with the pen and nothing with the others. */
function worthKeeping(shape: Annotation): boolean {
  const min = ANNOTATE_LIMITS.minDrag
  switch (shape.kind) {
    case 'pen':
      return shape.points.length >= 1
    case 'arrow':
      return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= min
    case 'rect':
    case 'blur':
      return shape.w >= min && shape.h >= min
    default:
      return true
  }
}

const add = (state: AnnotateState, shape: Annotation): AnnotateState =>
  state.items.length >= ANNOTATE_LIMITS.items ? { ...state, draft: null, origin: null } : { ...state, items: [...state.items, shape], redo: [], draft: null, origin: null }

export function annotateReduce(state: AnnotateState, action: AnnotateAction): AnnotateState {
  switch (action.type) {
    case 'tool':
      return (ANNOTATE_TOOLS as readonly string[]).includes(action.tool) ? { ...state, tool: action.tool, draft: null, origin: null } : state
    case 'color':
      return (ANNOTATE_COLORS as readonly string[]).includes(action.color) ? { ...state, color: action.color as AnnotateState['color'] } : state
    case 'strength':
      return action.strength === 0 || action.strength === 1 || action.strength === 2 ? { ...state, strength: action.strength } : state
    case 'begin': {
      const at = inside(state.size, action.at)
      if (!at || state.draft || state.items.length >= ANNOTATE_LIMITS.items) return state
      const draft = started(state, at)
      if (!draft) return state
      return { ...state, draft, origin: at }
    }
    case 'extend': {
      const at = inside(state.size, action.at)
      return at && state.draft && state.origin ? { ...state, draft: extended(state.draft, state.origin, at) } : state
    }
    case 'end':
      if (!state.draft) return state
      return worthKeeping(state.draft) ? add(state, state.draft) : { ...state, draft: null, origin: null }
    case 'abort':
      return state.draft ? { ...state, draft: null, origin: null } : state
    case 'text': {
      const at = inside(state.size, action.at)
      const text = cleanAnnotationText(action.text)
      if (!at || text === '') return state
      const size = Math.round(ANNOTATE_TEXT_SIZES[state.strength] * annotateScale(state.size.width))
      return add(state, { kind: 'text', color: state.color, size, at, text })
    }
    case 'undo': {
      const last = state.items[state.items.length - 1]
      return last ? { ...state, items: state.items.slice(0, -1), redo: [...state.redo, last], draft: null, origin: null } : state
    }
    case 'redo': {
      const next = state.redo[state.redo.length - 1]
      return next ? { ...state, items: [...state.items, next], redo: state.redo.slice(0, -1) } : state
    }
    case 'clear':
      return state.items.length === 0 ? state : { ...state, items: [], redo: [], draft: null, origin: null }
  }
}

// ---------- what the shell holds, and what comes back ----------

/** The size of the sheet's picture, or null when the sheet is not for this capture: the function is off, or the picture is not a PNG the sheet can handle. */
export function annotationSheetFor(png: Uint8Array, enabled: boolean): PictureSize | null {
  if (!enabled || png.length === 0 || png.length > ANNOTATE_LIMITS.bytes) return null
  const header = imageHeader(png)
  if (!header || header.format !== 'png') return null
  const { width, height } = header
  if (width < 1 || height < 1 || width > ANNOTATE_LIMITS.side || height > ANNOTATE_LIMITS.side || width * height > ANNOTATE_LIMITS.pixels) return null
  return { width, height }
}

export const ANNOTATE_ACTIONS = ['copy', 'save', 'share', 'open'] as const
export type AnnotateActionName = (typeof ANNOTATE_ACTIONS)[number]

/** What the sheet sends when the user chooses: the id of the capture it was shown, what to do, and the picture drawn on. */
export interface AnnotateDoneRequest {
  id: string
  action: AnnotateActionName
  png: Uint8Array
}

export type AnnotateReply = { ok: true } | { ok: false; message: string }

const ID = /^[0-9a-f-]{36}$/

/**
 * The request as the main process takes it, or why it does not. The picture must be a PNG of the size of the capture the id names (the sheet
 * draws on a canvas of that size; anything else did not come from it) and not heavier than the limit.
 */
export function parseAnnotateDone(raw: unknown, held: { id: string } & PictureSize): { ok: true; request: AnnotateDoneRequest } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'form' }
  const { id, action, png } = raw as { id?: unknown; action?: unknown; png?: unknown }
  if (typeof id !== 'string' || !ID.test(id) || id !== held.id) return { ok: false, reason: 'id' }
  if (typeof action !== 'string' || !(ANNOTATE_ACTIONS as readonly string[]).includes(action)) return { ok: false, reason: 'action' }
  const bytes = png instanceof ArrayBuffer ? new Uint8Array(png) : ArrayBuffer.isView(png) ? new Uint8Array(png.buffer, png.byteOffset, png.byteLength) : null
  if (!bytes || bytes.length === 0 || bytes.length > ANNOTATE_LIMITS.bytes) return { ok: false, reason: 'size' }
  const header = imageHeader(bytes)
  if (!header || header.format !== 'png' || header.width !== held.width || header.height !== held.height) return { ok: false, reason: 'picture' }
  return { ok: true, request: { id, action: action as AnnotateActionName, png: bytes } }
}
