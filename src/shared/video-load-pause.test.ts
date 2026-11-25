// The rules of the automatic pause of the video behind a space (shared/video-load-pause.ts): a call stops it at once, a loaded machine after several
// readings, and each lets it go by itself when the cause is over.

import { describe, expect, it } from 'vitest'
import { INITIAL_VIDEO_PAUSE, LOAD_PAUSE_CPU, LOAD_PAUSE_READINGS, LOAD_RESUME_CPU, nextVideoPause, videoHeldStill, type VideoPauseReading, type VideoPauseState } from './video-load-pause'

const calm: VideoPauseReading = { capturing: false, cpu: 10, pressure: false }
const busy: VideoPauseReading = { capturing: false, cpu: LOAD_PAUSE_CPU, pressure: false }
/** The readings in turn, from the state each one leaves. */
const run = (readings: VideoPauseReading[], from: VideoPauseState = INITIAL_VIDEO_PAUSE): VideoPauseState => readings.reduce(nextVideoPause, from)

describe('a call', () => {
  it('stops the video at the first reading, and lets it go at the first reading without one', () => {
    expect(run([{ ...calm, capturing: true }]).reason).toBe('capture')
    expect(run([{ ...calm, capturing: true }, calm]).reason).toBeNull()
  })

  it('comes before the load: a call that ends while the machine is loaded leaves the load to be seen again', () => {
    const during = run([{ ...busy, capturing: true }])
    expect(during).toEqual({ reason: 'capture', loaded: 0 })
    expect(run([busy], during)).toEqual({ reason: null, loaded: 1 })
  })
})

describe('a loaded machine', () => {
  it('stops the video only after the readings in a row that the guard asks', () => {
    expect(run(Array(LOAD_PAUSE_READINGS - 1).fill(busy)).reason).toBeNull()
    expect(run(Array(LOAD_PAUSE_READINGS).fill(busy)).reason).toBe('load')
  })

  it('does not count a burst: a calm reading between two busy ones starts the count again', () => {
    expect(run([busy, busy, busy, calm, busy, busy, busy]).reason).toBeNull()
  })

  it('counts memory pressure as a load, whatever the processor says', () => {
    expect(run(Array(LOAD_PAUSE_READINGS).fill({ ...calm, pressure: true })).reason).toBe('load')
  })

  it('lets go once the processor is under the lower mark, not before (no start and stop at each reading)', () => {
    const held = run(Array(LOAD_PAUSE_READINGS).fill(busy))
    // Between the two marks: still held.
    expect(run([{ ...calm, cpu: LOAD_RESUME_CPU }], held).reason).toBe('load')
    expect(run([{ ...calm, cpu: LOAD_RESUME_CPU - 1 }], held).reason).toBeNull()
  })

  it('is held while memory stays short even if the processor is calm', () => {
    const held = run(Array(LOAD_PAUSE_READINGS).fill(busy))
    expect(run([{ ...calm, pressure: true }], held).reason).toBe('load')
  })

  it('ignores a reading with no processor figure (the first of a meter): it neither counts nor resets', () => {
    const none: VideoPauseReading = { capturing: false, cpu: null, pressure: false }
    expect(run([busy, busy, none, busy, busy]).reason).toBe('load')
    const held = run(Array(LOAD_PAUSE_READINGS).fill(busy))
    expect(run([none], held).reason).toBe('load')
  })
})

describe('what holds the video still', () => {
  it('is the battery saver, a call or a load, and nothing else', () => {
    expect(videoHeldStill({})).toBe(false)
    expect(videoHeldStill({ batterySaverOn: true })).toBe(true)
    expect(videoHeldStill({ videoLoadPause: 'capture' })).toBe(true)
    expect(videoHeldStill({ videoLoadPause: 'load' })).toBe(true)
  })
})
