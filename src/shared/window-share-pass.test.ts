import { describe, expect, it } from 'vitest'
import { isPassClick, sourcePoint, type PassClick } from './window-share-pass'

/** A view of 960 × 600 where a 16:10 stream is letterboxed at x 0 .. 960 (no bar left or right). */
const click = (point: { x: number; y: number }, extra: Partial<PassClick> = {}): PassClick => ({
  point,
  picture: { x: 0, y: 60, width: 960, height: 480 },
  stream: { width: 1440, height: 900 },
  ...extra
})
/** A window of 1440 × 900 points, at the top left of the screen. */
const window1440 = { x: 0, y: 0, width: 1440, height: 900 }

describe('sourcePoint: the click of the view, in the window', () => {
  it('maps the centre of the picture to the centre of the window', () => {
    expect(sourcePoint(click({ x: 480, y: 300 }), window1440)).toEqual({ x: 720, y: 450 })
  })

  it('maps the top left corner of the picture to the top left corner of the window', () => {
    expect(sourcePoint(click({ x: 0, y: 60 }), window1440)).toEqual({ x: 0, y: 0 })
  })

  it('takes the scale of the stream: a window streamed at twice its points gives the same point', () => {
    const dense = click({ x: 480, y: 300 }, { stream: { width: 2880, height: 1800 } })
    expect(sourcePoint(dense, window1440)).toEqual({ x: 720, y: 450 })
  })

  it('takes the window position, which can be left of or above the main display', () => {
    expect(sourcePoint(click({ x: 480, y: 300 }), { x: -1600, y: -200, width: 1440, height: 900 })).toEqual({ x: -880, y: 250 })
  })

  it('refuses a click in the margin around a letterboxed picture', () => {
    const boxed = click({ x: 10, y: 300 }, { picture: { x: 100, y: 60, width: 760, height: 480 } })
    expect(sourcePoint(boxed, window1440)).toBeNull()
    expect(sourcePoint(click({ x: 500, y: 20 }), window1440)).toBeNull()
  })

  it('refuses the right and bottom edges, which are the next pixel', () => {
    expect(sourcePoint(click({ x: 960, y: 300 }), window1440)).toBeNull()
    expect(sourcePoint(click({ x: 480, y: 540 }), window1440)).toBeNull()
  })

  it('refuses a stream whose proportions no longer match the window (a window resized during the share)', () => {
    const resized = { x: 0, y: 0, width: 1000, height: 900 }
    expect(sourcePoint(click({ x: 480, y: 300 }), resized)).toBeNull()
  })

  it('accepts a difference of proportions within the tolerance', () => {
    const slightly = { x: 0, y: 0, width: 1440, height: 905 }
    expect(sourcePoint(click({ x: 480, y: 300 }), slightly)).not.toBeNull()
  })

  it('refuses an empty window', () => {
    expect(sourcePoint(click({ x: 480, y: 300 }), { x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })
})

describe('isPassClick: what the view sends is checked before anything is done', () => {
  it('accepts a well-formed click', () => {
    expect(isPassClick(click({ x: 1, y: 2 }))).toBe(true)
  })

  it('refuses a missing point, a missing stream, and values that are not finite numbers', () => {
    expect(isPassClick({ picture: click({ x: 0, y: 0 }).picture, stream: { width: 1, height: 1 } })).toBe(false)
    expect(isPassClick({ ...click({ x: 0, y: 0 }), stream: undefined })).toBe(false)
    expect(isPassClick(click({ x: Number.NaN, y: 0 }))).toBe(false)
    expect(isPassClick(click({ x: 0, y: Number.POSITIVE_INFINITY }))).toBe(false)
    expect(isPassClick(click({ x: 1e9, y: 0 }))).toBe(false)
  })

  it('refuses a picture or a stream without a size', () => {
    expect(isPassClick(click({ x: 0, y: 0 }, { picture: { x: 0, y: 0, width: 0, height: 480 } }))).toBe(false)
    expect(isPassClick(click({ x: 0, y: 0 }, { stream: { width: 1440, height: 0 } }))).toBe(false)
    expect(isPassClick(click({ x: 0, y: 0 }, { stream: { width: 0, height: 900 } }))).toBe(false)
  })

  it('refuses anything that is not an object', () => {
    expect(isPassClick(null)).toBe(false)
    expect(isPassClick('clic')).toBe(false)
    expect(isPassClick(42)).toBe(false)
  })
})
