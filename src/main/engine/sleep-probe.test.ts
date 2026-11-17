// A tab whose video floats in a Picture in Picture window must not be put to sleep or frozen (its window would close while it is watched): the page
// and its frames are asked, for both ways a video floats.

import { describe, expect, it } from 'vitest'
import { FLOAT_FRAMES_MAX, FLOATS, SLEEP_PROBE, probeWithFrames, type ProbeFrame } from './sleep-probe'

/** The expression run in a document with these globals: `document` and `self` as the page has them. */
const run = (code: string, document: object, self: object = {}): unknown => new Function('document', 'self', `return ${code}`)(document, self)

const frame = (answer: unknown): ProbeFrame & { asked: number } => {
  const f = {
    asked: 0,
    executeJavaScript: (code: string) => {
      f.asked++
      expect(code).toBe(FLOATS)
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    }
  }
  return f
}

describe('what a document is asked', () => {
  it('floats when a video of it is in Picture in Picture, or when it opened a document there, and not otherwise', () => {
    expect(run(FLOATS, { pictureInPictureElement: {} })).toBe(true)
    expect(run(FLOATS, { pictureInPictureElement: null }, { documentPictureInPicture: { window: {} } })).toBe(true)
    expect(run(FLOATS, { pictureInPictureElement: null }, { documentPictureInPicture: { window: null } })).toBe(false)
    // An engine without the API of floated documents.
    expect(run(FLOATS, { pictureInPictureElement: null }, {})).toBe(false)
  })

  it('answers both questions of the page in one object', () => {
    expect(run(SLEEP_PROBE, { pictureInPictureElement: null }, { documentPictureInPicture: { window: {} } })).toEqual({ pictureInPicture: true, unsentInput: false })
    expect(run(SLEEP_PROBE, { pictureInPictureElement: null }, { __luciumUnsent: () => true })).toEqual({ pictureInPicture: false, unsentInput: true })
  })
})

describe('the answer of a page and its frames', () => {
  it('keeps a tab whose embedded player floats a video, though the page itself does not', async () => {
    expect(await probeWithFrames({ pictureInPicture: false, unsentInput: false }, [frame(false), frame(true)])).toEqual({ pictureInPicture: true, unsentInput: false })
  })

  it('does not ask the frames when the page already floats a video, and keeps its answer about typed text', async () => {
    const f = frame(false)
    expect(await probeWithFrames({ pictureInPicture: true, unsentInput: true }, [f])).toEqual({ pictureInPicture: true, unsentInput: true })
    expect(f.asked).toBe(0)
  })

  it('says no Picture in Picture when no frame floats one, and counts a frame that cannot answer as not floating', async () => {
    expect(await probeWithFrames({ pictureInPicture: false, unsentInput: true }, [frame(false), frame(new Error('gone')), frame('yes')])).toEqual({ pictureInPicture: false, unsentInput: true })
    expect(await probeWithFrames({ pictureInPicture: false, unsentInput: false }, [])).toEqual({ pictureInPicture: false, unsentInput: false })
  })

  it('knows nothing when the page could not answer, whatever its frames say: nothing is put to sleep then', async () => {
    expect(await probeWithFrames(null, [frame(true)])).toBeNull()
    expect(await probeWithFrames({ pictureInPicture: false } as never, [frame(true)])).toBeNull()
  })

  it('asks at most the first frames', async () => {
    const frames = Array.from({ length: FLOAT_FRAMES_MAX + 5 }, () => frame(false))
    await probeWithFrames({ pictureInPicture: false, unsentInput: false }, frames)
    expect(frames.filter((f) => f.asked > 0)).toHaveLength(FLOAT_FRAMES_MAX)
  })
})
