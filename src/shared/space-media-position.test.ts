// The framing of a video background (« Cadrage »): the part of the video the sidebar shows, chosen by dragging a frame. Read back from the state, written by
// the reducer (`space/background-position`), turned into the CSS `object-position`, and the geometry of the frame (coverShare, draggedPosition, steppedPosition).
import { describe, expect, it } from 'vitest'
import {
  CENTERED_POSITION,
  POSITION_STEP,
  backgroundObjectPosition,
  cleanBackgroundPosition,
  cleanSpaceBackground,
  coverShare,
  draggedPosition,
  steppedPosition,
  withBackgroundPosition,
  type SpaceBackground
} from './space-media'
import { createInitialState, parseSavedState, persistableState, reduce, type Ctx } from './sidebar'

const video: SpaceBackground = { type: 'video', value: 'large.mp4', loop: true, muted: true }

describe('the position of a video read from the state', () => {
  it('keeps two whole percents between 0 and 100, for a video', () => {
    expect(cleanSpaceBackground({ ...video, position: { x: 20, y: 80 } })).toEqual({ ...video, position: { x: 20, y: 80 } })
    expect(cleanBackgroundPosition({ x: 0, y: 100 })).toEqual({ x: 0, y: 100 })
    expect(cleanBackgroundPosition({ x: 33.4, y: 66.6 })).toEqual({ x: 33, y: 67 })
  })

  it('drops what is not a position, and the centre, which is the absence of one', () => {
    for (const bad of [undefined, null, 'left', 50, [], { x: 10 }, { x: '10', y: 20 }, { x: NaN, y: 20 }, { x: Infinity, y: 20 }, { x: -1, y: 20 }, { x: 20, y: 101 }]) {
      expect(cleanBackgroundPosition(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(cleanBackgroundPosition(CENTERED_POSITION)).toBeUndefined()
    expect(cleanSpaceBackground({ ...video, position: { x: 50, y: 50 } })).toEqual(video)
  })

  it('is read for a video only: a picture or a colour has no framing', () => {
    expect(cleanSpaceBackground({ type: 'image', value: 'p.png', position: { x: 20, y: 80 } })).toEqual({ type: 'image', value: 'p.png' })
    expect(cleanSpaceBackground({ type: 'color', value: '#112233', position: { x: 20, y: 80 } })).toEqual({ type: 'color', value: '#112233' })
  })
})

describe('the background framed at a position', () => {
  it('writes the position, in whole percents kept between 0 and 100', () => {
    expect(withBackgroundPosition(video, 30, 70)).toEqual({ ...video, position: { x: 30, y: 70 } })
    expect(withBackgroundPosition(video, 33.4, 66.6)).toEqual({ ...video, position: { x: 33, y: 67 } })
    expect(withBackgroundPosition(video, -40, 250)).toEqual({ ...video, position: { x: 0, y: 100 } })
  })

  it('removes the position at the centre, and keeps the rest of the background', () => {
    const framed = { ...video, paused: true, veilColor: '#0b0c12', position: { x: 10, y: 90 } }
    expect(withBackgroundPosition(framed, 50, 50)).toEqual({ ...video, paused: true, veilColor: '#0b0c12' })
    expect(withBackgroundPosition(framed, 10, 40)).toEqual({ ...framed, position: { x: 10, y: 40 } })
  })

  it('changes nothing for a picture, a colour, or a value that is not a number', () => {
    const image: SpaceBackground = { type: 'image', value: 'p.png' }
    expect(withBackgroundPosition(image, 10, 10)).toBe(image)
    expect(withBackgroundPosition(video, Number.NaN, 10)).toBe(video)
    expect(withBackgroundPosition(video, 10, Infinity)).toBe(video)
  })

  it('says its CSS object-position, and nothing at the centre or for another type', () => {
    expect(backgroundObjectPosition({ type: 'video', position: { x: 20, y: 80 } })).toBe('20% 80%')
    expect(backgroundObjectPosition(video)).toBeUndefined()
    expect(backgroundObjectPosition({ type: 'image', position: { x: 20, y: 80 } })).toBeUndefined()
  })
})

describe('the action space/background-position', () => {
  const setup = () => {
    let n = 0
    const ctx = (): Ctx => ({ now: 1, newId: () => `id-${++n}` })
    let state = createInitialState(ctx())
    state = reduce(state, { type: 'space/create', name: 'Deux', emoji: '2', hue: 200 }, ctx())
    const [first, second] = state.spaces
    state = reduce(state, { type: 'space/update', id: first!.id, patch: { background: video } }, ctx())
    state = reduce(state, { type: 'space/update', id: second!.id, patch: { background: video } }, ctx())
    return { ctx, state, first: first!.id, second: second!.id }
  }
  const backgroundOf = (state: ReturnType<typeof setup>['state'], id: string) => state.spaces.find((space) => space.id === id)!.background

  it('frames the video of the space it names, and of that one only', () => {
    const { ctx, state, first, second } = setup()
    const next = reduce(state, { type: 'space/background-position', id: first, x: 25, y: 60 }, ctx())
    expect(backgroundOf(next, first)).toEqual({ ...video, position: { x: 25, y: 60 } })
    expect(backgroundOf(next, second)).toEqual(video)
  })

  it('keeps the values between 0 and 100 and whole, and takes the centre as no position', () => {
    const { ctx, state, first } = setup()
    expect(backgroundOf(reduce(state, { type: 'space/background-position', id: first, x: -20, y: 400 }, ctx()), first)).toEqual({ ...video, position: { x: 0, y: 100 } })
    const framed = reduce(state, { type: 'space/background-position', id: first, x: 12.4, y: 87.6 }, ctx())
    expect(backgroundOf(framed, first)).toEqual({ ...video, position: { x: 12, y: 88 } })
    expect(backgroundOf(reduce(framed, { type: 'space/background-position', id: first, x: 50, y: 50 }, ctx()), first)).toEqual(video)
  })

  it('changes nothing for a space without a video, an unknown space, or a value that is not a number', () => {
    const { ctx, state, first } = setup()
    const still = reduce(state, { type: 'space/update', id: first, patch: { background: { type: 'image', value: 'p.png' } } }, ctx())
    expect(reduce(still, { type: 'space/background-position', id: first, x: 10, y: 10 }, ctx())).toBe(still)
    const none = reduce(state, { type: 'space/update', id: first, patch: { background: undefined } }, ctx())
    expect(reduce(none, { type: 'space/background-position', id: first, x: 10, y: 10 }, ctx())).toBe(none)
    expect(reduce(state, { type: 'space/background-position', id: 'gone', x: 10, y: 10 }, ctx())).toBe(state)
    expect(reduce(state, { type: 'space/background-position', id: first, x: Number.NaN, y: 10 }, ctx())).toBe(state)
    expect(reduce(state, { type: 'space/background-position', id: first, x: '10' as unknown as number, y: 10 }, ctx())).toBe(state)
  })

  it('is no new state when the position is the one the space has', () => {
    const { ctx, state, first } = setup()
    const framed = reduce(state, { type: 'space/background-position', id: first, x: 25, y: 60 }, ctx())
    expect(reduce(framed, { type: 'space/background-position', id: first, x: 25, y: 60 }, ctx())).toBe(framed)
    expect(reduce(state, { type: 'space/background-position', id: first, x: 50, y: 50 }, ctx())).toBe(state)
  })

  it('is remembered for its space only, through a save and a reload, and kept when the pause is changed', () => {
    const { ctx, state, first, second } = setup()
    let next = reduce(state, { type: 'space/background-position', id: first, x: 25, y: 60 }, ctx())
    next = reduce(next, { type: 'space/update', id: first, patch: { background: { ...backgroundOf(next, first)!, paused: true } } }, ctx())
    const loaded = parseSavedState(JSON.stringify(persistableState(next)))
    expect(loaded.spaces.find((space) => space.id === first)!.background).toEqual({ ...video, paused: true, position: { x: 25, y: 60 } })
    expect(loaded.spaces.find((space) => space.id === second)!.background).toEqual(video)
  })
})

describe('the frame over the whole video', () => {
  it('is as wide as the part of a wide video the box shows, and as tall as the video', () => {
    // A 16:9 video in a box twice as tall as it is wide: 16:9 shown 100 px tall is 178 px wide, the box 50 px wide shows 28 % of it.
    const share = coverShare({ width: 1920, height: 1080 }, { width: 50, height: 100 })
    expect(share.y).toBe(1)
    expect(share.x).toBeCloseTo(50 / ((1920 / 1080) * 100), 3)
  })

  it('is as tall as the part of a tall video the box shows, and as wide as the video', () => {
    const share = coverShare({ width: 1080, height: 1920 }, { width: 100, height: 50 })
    expect(share.x).toBe(1)
    expect(share.y).toBeLessThan(0.3)
  })

  it('shows everything of a video that has the shape of the box, or whose size is not known', () => {
    expect(coverShare({ width: 500, height: 1000 }, { width: 50, height: 100 })).toEqual({ x: 1, y: 1 })
    expect(coverShare({ width: 0, height: 0 }, { width: 50, height: 100 })).toEqual({ x: 1, y: 1 })
    expect(coverShare({ width: 1920, height: 1080 }, { width: 0, height: 100 })).toEqual({ x: 1, y: 1 })
  })
})

describe('the drag of the frame', () => {
  const share = { x: 0.25, y: 1 }
  const shown = { width: 400, height: 225 }

  it('moves the position by the part of the room the pointer crossed: all of the room is 100 points', () => {
    // The room is 75 % of 400 px = 300 px.
    expect(draggedPosition({ x: 50, y: 50 }, { x: 150, y: 0 }, share, shown)).toEqual({ x: 100, y: 50 })
    expect(draggedPosition({ x: 0, y: 50 }, { x: 60, y: 0 }, share, shown)).toEqual({ x: 20, y: 50 })
    expect(draggedPosition({ x: 40, y: 50 }, { x: -30, y: 0 }, share, shown)).toEqual({ x: 30, y: 50 })
  })

  it('stops at the edges of the video', () => {
    expect(draggedPosition({ x: 90, y: 50 }, { x: 500, y: 0 }, share, shown).x).toBe(100)
    expect(draggedPosition({ x: 10, y: 50 }, { x: -500, y: 0 }, share, shown).x).toBe(0)
  })

  it('leaves an axis with no room as it is, whatever the pointer does on it', () => {
    expect(draggedPosition({ x: 50, y: 30 }, { x: 0, y: 200 }, share, shown).y).toBe(30)
  })

  it('leaves the position as it is for a pointer that gave no number', () => {
    expect(draggedPosition({ x: 50, y: 30 }, { x: Number.NaN, y: 0 }, share, shown)).toEqual({ x: 50, y: 30 })
  })
})

describe('the arrow keys on the frame', () => {
  const both = { x: 0.5, y: 0.5 }

  it('move the frame by a step the way of the arrow', () => {
    expect(steppedPosition({ x: 50, y: 50 }, 'ArrowRight', both)).toEqual({ x: 50 + POSITION_STEP, y: 50 })
    expect(steppedPosition({ x: 50, y: 50 }, 'ArrowLeft', both)).toEqual({ x: 50 - POSITION_STEP, y: 50 })
    expect(steppedPosition({ x: 50, y: 50 }, 'ArrowDown', both)).toEqual({ x: 50, y: 50 + POSITION_STEP })
    expect(steppedPosition({ x: 50, y: 50 }, 'ArrowUp', both)).toEqual({ x: 50, y: 50 - POSITION_STEP })
  })

  it('stop at the edges, and leave an axis with no room alone', () => {
    expect(steppedPosition({ x: 98, y: 2 }, 'ArrowRight', both)).toEqual({ x: 100, y: 2 })
    expect(steppedPosition({ x: 98, y: 2 }, 'ArrowUp', both)).toEqual({ x: 98, y: 0 })
    expect(steppedPosition({ x: 50, y: 50 }, 'ArrowDown', { x: 0.25, y: 1 })).toEqual({ x: 50, y: 50 })
  })

  it('give no position for another key, which is left to the page', () => {
    expect(steppedPosition({ x: 50, y: 50 }, 'Tab', both)).toBeNull()
    expect(steppedPosition({ x: 50, y: 50 }, 'a', both)).toBeNull()
  })
})
