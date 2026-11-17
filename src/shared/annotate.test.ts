import { describe, expect, it } from 'vitest'
import { featureById, featureDefault } from './features'
import {
  annotateCentre,
  annotateNudge,
  ANNOTATE_COLORS,
  ANNOTATE_LIMITS,
  ANNOTATE_STROKES,
  ANNOTATE_TEXT_SIZES,
  annotateReduce,
  annotateScale,
  annotationSheetFor,
  blurCell,
  cleanAnnotationText,
  initialAnnotate,
  parseAnnotateDone,
  type AnnotateAction,
  type AnnotateState
} from './annotate'

/** The first 24 bytes of a PNG: its signature, and the header chunk that names the size. */
function pngOf(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const run = (state: AnnotateState, ...actions: AnnotateAction[]): AnnotateState => actions.reduce(annotateReduce, state)
const fresh = (width = 1000, height = 600) => initialAnnotate({ width, height })

/** A whole drag with the tool in `state`. */
const drag = (state: AnnotateState, ...points: Array<[number, number]>): AnnotateState => {
  const [first, ...rest] = points
  return run(state, { type: 'begin', at: { x: first![0], y: first![1] } }, ...rest.map(([x, y]): AnnotateAction => ({ type: 'extend', at: { x, y } })), { type: 'end' })
}

describe('the editor state', () => {
  it('starts empty with the arrow, the first colour and the middle thickness', () => {
    expect(fresh()).toMatchObject({ tool: 'arrow', color: ANNOTATE_COLORS[0], strength: 1, items: [], redo: [], draft: null })
  })

  it('takes only the tools, the colours and the thicknesses of its lists', () => {
    const state = fresh()
    expect(run(state, { type: 'tool', tool: 'blur' }).tool).toBe('blur')
    expect(run(state, { type: 'tool', tool: 'eraser' as never })).toBe(state)
    expect(run(state, { type: 'color', color: '#0a84ff' }).color).toBe('#0a84ff')
    expect(run(state, { type: 'color', color: 'red' })).toBe(state)
    expect(run(state, { type: 'color', color: 'url(javascript:alert(1))' })).toBe(state)
    expect(run(state, { type: 'strength', strength: 2 }).strength).toBe(2)
    for (const bad of [3, -1, 1.5, NaN, '1' as never]) expect(run(state, { type: 'strength', strength: bad })).toBe(state)
  })

  it('draws a line with the pen from the points of the drag, skipping those that are closer than a step', () => {
    const out = drag(run(fresh(), { type: 'tool', tool: 'pen' }), [10, 10], [10.4, 10.4], [20, 20], [30, 25])
    expect(out.items).toEqual([{ kind: 'pen', color: ANNOTATE_COLORS[0], width: ANNOTATE_STROKES[1], points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 25 }] }])
    expect(out.draft).toBeNull()
  })

  it('makes a dot of a click with the pen and nothing of a click with the other tools', () => {
    expect(drag(run(fresh(), { type: 'tool', tool: 'pen' }), [50, 50]).items).toHaveLength(1)
    for (const tool of ['arrow', 'rect', 'blur'] as const) expect(drag(run(fresh(), { type: 'tool', tool }), [50, 50], [51, 51]).items, tool).toEqual([])
  })

  it('draws an arrow from where the drag began to where it ended', () => {
    const out = drag(fresh(), [10, 20], [200, 120])
    expect(out.items[0]).toMatchObject({ kind: 'arrow', from: { x: 10, y: 20 }, to: { x: 200, y: 120 } })
  })

  it('draws a rectangle and a mosaic whatever the direction of the drag', () => {
    const rect = drag(run(fresh(), { type: 'tool', tool: 'rect' }), [300, 200], [100, 50])
    expect(rect.items[0]).toMatchObject({ kind: 'rect', x: 100, y: 50, w: 200, h: 150 })
    const blur = drag(run(fresh(), { type: 'tool', tool: 'blur' }), [100, 200], [300, 50])
    expect(blur.items[0]).toEqual({ kind: 'blur', x: 100, y: 50, w: 200, h: 150 })
  })

  it('keeps every point inside the picture and ignores points that are not numbers', () => {
    const out = drag(run(fresh(1000, 600), { type: 'tool', tool: 'rect' }), [-50, -50], [5000, 5000])
    expect(out.items[0]).toMatchObject({ x: 0, y: 0, w: 1000, h: 600 })
    const bad = run(fresh(), { type: 'begin', at: { x: NaN, y: 3 } })
    expect(bad.draft).toBeNull()
    const started = run(fresh(), { type: 'begin', at: { x: 5, y: 5 } })
    expect(run(started, { type: 'extend', at: { x: Infinity, y: 1 } })).toBe(started)
  })

  // The bound of a point is shared/clamp.ts: for a size that is not one (below zero), the point stays at 0 rather than going negative.
  it('never places a point at a negative coordinate, even on a picture whose size is not one', () => {
    const out = run(initialAnnotate({ width: -5, height: -5 }), { type: 'text', at: { x: 10, y: 10 }, text: 'ici' })
    expect(out.items.at(-1)).toMatchObject({ kind: 'text', at: { x: 0, y: 0 } })
  })

  it('keeps one drag at a time and drops it on abort', () => {
    const started = run(fresh(), { type: 'begin', at: { x: 5, y: 5 } })
    expect(run(started, { type: 'begin', at: { x: 90, y: 90 } }).draft).toBe(started.draft)
    const aborted = run(started, { type: 'abort' })
    expect(aborted.draft).toBeNull()
    expect(run(aborted, { type: 'end' }).items).toEqual([])
    // Changing the tool in the middle of a drag drops it too.
    expect(run(started, { type: 'tool', tool: 'pen' }).draft).toBeNull()
  })

  it('scales the thickness and the text to the width of the picture so that they look the same on the sheet', () => {
    expect(annotateScale(500)).toBe(1)
    expect(annotateScale(2000)).toBe(2)
    const wide = drag(fresh(2000, 1000), [10, 10], [300, 300])
    expect(wide.items[0]).toMatchObject({ width: ANNOTATE_STROKES[1] * 2 })
    const text = run(fresh(2000, 1000), { type: 'text', at: { x: 5, y: 5 }, text: 'ok' })
    expect(text.items[0]).toMatchObject({ kind: 'text', size: ANNOTATE_TEXT_SIZES[1] * 2 })
  })

  it('adds a text as one clean line and ignores an empty one', () => {
    const out = run(fresh(), { type: 'text', at: { x: 40, y: 30 }, text: '  Voir\nici\t! ' })
    expect(out.items).toEqual([{ kind: 'text', color: ANNOTATE_COLORS[0], size: ANNOTATE_TEXT_SIZES[1], at: { x: 40, y: 30 }, text: 'Voir ici !' }])
    const same = run(fresh(), { type: 'text', at: { x: 1, y: 1 }, text: ' \n ' })
    expect(same.items).toEqual([])
    expect(cleanAnnotationText(42)).toBe('')
    expect(cleanAnnotationText('x'.repeat(500))).toHaveLength(ANNOTATE_LIMITS.text)
  })

  it('undoes and redoes, and a new shape empties what could be redone', () => {
    let state = drag(fresh(), [0, 0], [100, 100])
    state = drag(state, [10, 10], [200, 200])
    const drawn = state.items
    state = run(state, { type: 'undo' })
    expect(state.items).toHaveLength(1)
    expect(state.redo).toHaveLength(1)
    // The shape undone comes back as it was, and only once: what was redone cannot be redone again (it would be drawn twice).
    const redone = run(state, { type: 'redo' })
    expect(redone.items).toEqual(drawn)
    expect(redone.redo).toEqual([])
    expect(run(redone, { type: 'redo' })).toBe(redone)
    expect(drag(state, [5, 5], [90, 90]).redo).toEqual([])
    // Nothing to undo or to redo is not a change.
    const empty = fresh()
    expect(run(empty, { type: 'undo' })).toBe(empty)
    expect(run(empty, { type: 'redo' })).toBe(empty)
    expect(run(run(state, { type: 'clear' }), { type: 'undo' }).items).toEqual([])
  })

  it('stops at the limit of shapes, and of points in a stroke', () => {
    let state = fresh()
    for (let i = 0; i < ANNOTATE_LIMITS.items + 5; i++) state = drag(state, [0, 0], [50 + i, 50])
    expect(state.items).toHaveLength(ANNOTATE_LIMITS.items)
    expect(run(state, { type: 'begin', at: { x: 1, y: 1 } }).draft).toBeNull()
    // A text does not begin with a drag: the limit is held where it is added.
    let texts = fresh()
    for (let i = 0; i < ANNOTATE_LIMITS.items + 5; i++) texts = run(texts, { type: 'text', at: { x: 1, y: 1 }, text: `t${i}` })
    expect(texts.items).toHaveLength(ANNOTATE_LIMITS.items)
    const points = Array.from({ length: ANNOTATE_LIMITS.points + 100 }, (_, i): [number, number] => [(i * 2) % 1000, Math.floor(i / 500) * 20])
    const stroke = drag(run(fresh(), { type: 'tool', tool: 'pen' }), ...points).items[0]
    // Every point is far enough from the one before: the stroke keeps exactly as many as the limit allows, not fewer.
    expect(stroke?.kind === 'pen' && stroke.points.length).toBe(ANNOTATE_LIMITS.points)
  })
})

describe('the point of the keyboard', () => {
  const size = { width: 1600, height: 900 }

  it('starts in the middle of the picture', () => {
    expect(annotateCentre(size)).toEqual({ x: 800, y: 450 })
  })

  it('moves a hundredth of the longer side with an arrow, five times that with Shift', () => {
    expect(annotateNudge({ x: 800, y: 450 }, 'ArrowRight', false, size)).toEqual({ x: 816, y: 450 })
    expect(annotateNudge({ x: 800, y: 450 }, 'ArrowUp', true, size)).toEqual({ x: 800, y: 370 })
    // A small picture still moves by 2 pixels.
    expect(annotateNudge({ x: 10, y: 10 }, 'ArrowDown', false, { width: 60, height: 40 })).toEqual({ x: 10, y: 12 })
  })

  it('stays on the picture', () => {
    expect(annotateNudge({ x: 5, y: 5 }, 'ArrowLeft', false, size)).toEqual({ x: 0, y: 5 })
    expect(annotateNudge({ x: 1590, y: 895 }, 'ArrowDown', true, size)).toEqual({ x: 1590, y: 900 })
  })

  it('leaves every key that is not an arrow to the sheet', () => {
    for (const key of ['Enter', ' ', 'Escape', 'Tab']) expect(annotateNudge({ x: 1, y: 1 }, key, false, size), key).toBeNull()
  })

  it('with no point yet shows it in the middle, whatever the arrow', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(annotateNudge(null, key, true, size), key).toEqual({ x: 800, y: 450 })
    expect(annotateNudge(null, 'Enter', false, size)).toBeNull()
  })
})

describe('the mosaic', () => {
  it('has cells that grow with the picture and never below 10 pixels', () => {
    expect(blurCell({ width: 300, height: 200 })).toBe(10)
    expect(blurCell({ width: 2000, height: 4500 })).toBe(50)
  })
})

describe('what the sheet takes', () => {
  it('is not for a capture when the function is off', () => {
    expect(annotationSheetFor(pngOf(800, 600), false)).toBeNull()
    expect(annotationSheetFor(pngOf(800, 600), true)).toEqual({ width: 800, height: 600 })
  })

  it('refuses what is not a PNG, an empty picture, and a picture too big for a canvas', () => {
    expect(annotationSheetFor(new Uint8Array(0), true)).toBeNull()
    expect(annotationSheetFor(new TextEncoder().encode('not a png at all, just text of some length'), true)).toBeNull()
    expect(annotationSheetFor(pngOf(0, 100), true)).toBeNull()
    expect(annotationSheetFor(pngOf(100, 0), true)).toBeNull()
    expect(annotationSheetFor(pngOf(ANNOTATE_LIMITS.side + 1, 10), true)).toBeNull()
    // A tall picture is held to the side of a canvas too, though its pixels are few.
    expect(annotationSheetFor(pngOf(10, ANNOTATE_LIMITS.side + 1), true)).toBeNull()
    expect(annotationSheetFor(pngOf(10, ANNOTATE_LIMITS.side), true)).toEqual({ width: 10, height: ANNOTATE_LIMITS.side })
    expect(annotationSheetFor(pngOf(8000, 8000), true)).toBeNull()
    expect(annotationSheetFor(pngOf(5000, 6000), true)).toEqual({ width: 5000, height: 6000 })
  })

  it('refuses a picture that weighs too much', () => {
    expect(annotationSheetFor(pngOf(800, 600, ANNOTATE_LIMITS.bytes), true)).toBeNull()
  })
})

describe('what the sheet sends back', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const held = { id, width: 800, height: 600 }
  const good = { id, action: 'save', png: pngOf(800, 600) }

  it('takes a PNG of the size of the capture, with an action of the list', () => {
    for (const action of ['copy', 'save', 'share']) {
      const parsed = parseAnnotateDone({ ...good, action }, held)
      expect(parsed.ok && parsed.request.action).toBe(action)
    }
    // A view over a bigger buffer (what Node's Buffer is), as the IPC delivers it: only the bytes of the view count.
    const padded = new Uint8Array(40)
    padded.set(pngOf(800, 600), 7)
    const parsed = parseAnnotateDone({ ...good, png: padded.subarray(7) }, held)
    expect(parsed.ok && parsed.request.png.length).toBe(33)
    const view = parseAnnotateDone({ ...good, png: pngOf(800, 600).buffer }, held)
    expect(view.ok).toBe(true)
  })

  it('refuses a request that is not an object, another capture’s id, an unknown action', () => {
    for (const raw of [null, undefined, 'save', 42, []]) expect(parseAnnotateDone(raw, held), String(raw)).toMatchObject({ ok: false })
    expect(parseAnnotateDone({ ...good, id: '11111111-1111-1111-1111-111111111111' }, held)).toEqual({ ok: false, reason: 'id' })
    expect(parseAnnotateDone({ ...good, id: 'not an id' }, { ...held, id: 'not an id' })).toEqual({ ok: false, reason: 'id' })
    expect(parseAnnotateDone({ ...good, action: 'delete' }, held)).toEqual({ ok: false, reason: 'action' })
    expect(parseAnnotateDone({ ...good, action: undefined }, held)).toEqual({ ok: false, reason: 'action' })
  })

  it('refuses a picture that is not a PNG, not the size of the capture, empty or too heavy', () => {
    expect(parseAnnotateDone({ ...good, png: 'data:image/png;base64,AAAA' }, held)).toEqual({ ok: false, reason: 'size' })
    expect(parseAnnotateDone({ ...good, png: new Uint8Array(0) }, held)).toEqual({ ok: false, reason: 'size' })
    expect(parseAnnotateDone({ ...good, png: new TextEncoder().encode('GIF89a nothing like a png at all, but long enough') }, held)).toEqual({ ok: false, reason: 'picture' })
    expect(parseAnnotateDone({ ...good, png: pngOf(801, 600) }, held)).toEqual({ ok: false, reason: 'picture' })
    expect(parseAnnotateDone({ ...good, png: pngOf(800, 20_000) }, held)).toEqual({ ok: false, reason: 'picture' })
    expect(parseAnnotateDone({ ...good, png: pngOf(800, 600, ANNOTATE_LIMITS.bytes) }, held)).toEqual({ ok: false, reason: 'size' })
  })
})

describe('the switch', () => {
  it('is registered, and off by default: a capture is saved and copied at once until the user turns the sheet on', () => {
    expect(featureById('annotate-capture')).toMatchObject({ key: 'annotateCapture', group: 'interface' })
    expect(featureDefault('annotate-capture')).toBe(false)
  })
})
