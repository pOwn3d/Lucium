// The veil measured from a file of the user's (auto-veil.ts): the part of the picture that is measured, the figures of its frames, the look they give,
// the floor of contrast for every brightness, the safe look when nothing could be measured, and the nine videos of Lucium as the calibration.

import { describe, expect, it } from 'vitest'
import {
  AUTO_VEIL_FALLBACK,
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  TEXT_SIDE_AT_TEXT_END,
  autoVeil,
  backgroundTypeOf,
  byHand,
  frameIndices,
  frameTimes,
  isUserFile,
  keepsHandLook,
  measureFrames,
  measuredRegion,
  sleepingTitleContrast,
  userFileBackground,
  withAutoVeil,
  type AutoVeilLook,
  type BackgroundMeasure,
  type FramePixels
} from './auto-veil'
import { BUILTIN_BACKGROUND_IDS, builtinBackground, builtinVideoFile, type BuiltinBackgroundId } from './builtin-backgrounds'
import { AA_TEXT } from './contrast'
import { TEXT_COLORS, VEIL_COLORS, cleanSpaceBackground, type SpaceBackground } from './space-media'
import { createInitialState, parseSavedState, persistableState, reduce, type Ctx } from './sidebar'

/** A frame of one colour (RGBA), of this size. */
function plain(r: number, g: number, b: number, a = 255, width = 4, height = 4): FramePixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set([r, g, b, a], i * 4)
  return { data, width, height }
}

/** The contrast of the sleeping title where the text ends, over the pixel the look is made for (the bright end under a dark veil, the dark end under a light one). */
function worstContrast(look: AutoVeilLook, measure: BackgroundMeasure): number {
  const local = (look.veil / 100) * (look.veilShape === 'text' ? TEXT_SIDE_AT_TEXT_END : 1)
  const pixel = look.veilColor === VEIL_COLORS[0] ? measure.p95 : measure.p05
  return sleepingTitleContrast(pixel, look, local)
}

describe('the part of a picture that is measured', () => {
  it('is what the sidebar shows of it (cover, in a box of 0.45, centred), and of that the left 60 %, under the tabs', () => {
    // Landscape: the middle band, 0.45 × 1080 wide.
    const landscape = measuredRegion(1920, 1080)!
    expect(landscape.x).toBeCloseTo((1920 - 486) / 2)
    expect(landscape.y).toBe(0)
    expect(landscape.width).toBeCloseTo(486 * 0.6)
    expect(landscape.height).toBe(1080)
    // A portrait video (9:16) is a little wider than the box too.
    expect(measuredRegion(1080, 1920)).toEqual({ x: (1080 - 864) / 2, y: 0, width: 864 * 0.6, height: 1920 })
    // Narrower than the box: the whole width, the middle of the height.
    const narrow = measuredRegion(100, 1000)!
    expect(narrow.x).toBe(0)
    expect(narrow.width).toBeCloseTo(60)
    expect(narrow.height).toBeCloseTo(100 / 0.45)
    expect(narrow.y).toBeCloseTo((1000 - 100 / 0.45) / 2)
  })

  it('is nothing for a size that is not one', () => {
    for (const [w, h] of [[0, 10], [10, 0], [Number.NaN, 10], [10, Number.POSITIVE_INFINITY], [-5, 10]] as const) expect(measuredRegion(w, h), `${w}x${h}`).toBeNull()
  })

  it('is brought down to a few thousand pixels of its own shape', () => {
    expect(SAMPLE_WIDTH * SAMPLE_HEIGHT).toBeLessThan(6000)
    expect(SAMPLE_HEIGHT / SAMPLE_WIDTH).toBeCloseTo(1 / (0.45 * 0.6), 1)
  })
})

describe('the frames that are read', () => {
  it('are five for a video, at 10, 30, 50, 70 and 90 % of its length (not its fades), the first one when its length is unknown', () => {
    expect(frameTimes(10)).toEqual([1, 3, 5, 7, 9].map((t) => expect.closeTo(t, 9)))
    for (const unknown of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(frameTimes(unknown), String(unknown)).toEqual([0])
  })

  it('are up to five of a GIF, at the same shares, each once', () => {
    expect(frameIndices(100)).toEqual([10, 30, 50, 70, 90])
    expect(frameIndices(3)).toEqual([0, 1, 2])
    expect(frameIndices(1)).toEqual([0])
    expect(frameIndices(Number.NaN)).toEqual([0])
  })
})

describe('the figures of the frames', () => {
  it('are the mean luma (0 to 255) and the 95th and 5th percentiles of relative luminance', () => {
    expect(measureFrames([plain(255, 255, 255)])).toEqual({ meanY: 255, p95: expect.closeTo(1, 6), p05: expect.closeTo(1, 6) })
    expect(measureFrames([plain(0, 0, 0)])).toEqual({ meanY: 0, p95: 0, p05: 0 })
    // Half white, half black, over two frames: the mean is in the middle, the percentiles at each end.
    expect(measureFrames([plain(255, 255, 255), plain(0, 0, 0)])).toEqual({ meanY: 127.5, p95: expect.closeTo(1, 6), p05: 0 })
    // Mid grey: luma 128, relative luminance about 0.216.
    expect(measureFrames([plain(128, 128, 128)])).toEqual({ meanY: expect.closeTo(128, 9), p95: expect.closeTo(0.2158, 3), p05: expect.closeTo(0.2158, 3) })
  })

  it('weigh green most and blue least, as the eye does', () => {
    const green = measureFrames([plain(0, 255, 0)])!
    const blue = measureFrames([plain(0, 0, 255)])!
    expect(green.p95).toBeCloseTo(0.7152, 4)
    expect(blue.p95).toBeCloseTo(0.0722, 4)
    expect(green.meanY).toBeCloseTo(0.587 * 255)
  })

  it('leave out the pixels that are mostly transparent (the sidebar shows under them), and are nothing when no pixel is left', () => {
    expect(measureFrames([plain(255, 255, 255), plain(0, 0, 0, 0)])).toEqual({ meanY: 255, p95: expect.closeTo(1, 6), p05: expect.closeTo(1, 6) })
    expect(measureFrames([plain(0, 0, 0, 10)])).toBeNull()
    expect(measureFrames([])).toBeNull()
  })

  it('read no further than the pixels a frame says it has', () => {
    const frame = plain(255, 255, 255, 255, 2, 2)
    expect(measureFrames([{ ...frame, width: 1, height: 1 }])).toEqual({ meanY: 255, p95: expect.closeTo(1, 6), p05: expect.closeTo(1, 6) })
  })
})

describe('the look of a measured file', () => {
  it('keeps the sleeping title at 4.5:1 or more where the text ends, for every brightness of the picture, with an even veil of 65 % at most', () => {
    let worst = Number.POSITIVE_INFINITY
    let strongest = 0
    for (let p95 = 0.002; p95 <= 1; p95 += 0.01) {
      for (const p05 of [0, p95 / 4, p95 / 2, p95]) {
        for (const meanY of [0, 30, 80, 140, 200, 255]) {
          const measure = { meanY, p95, p05 }
          const { look, measured } = autoVeil(measure)
          expect(measured).toBe(true)
          expect(look.veil).toBeLessThanOrEqual(65)
          strongest = Math.max(strongest, look.veil)
          const contrast = worstContrast(look, measure)
          worst = Math.min(worst, contrast)
          expect(contrast, JSON.stringify({ measure, look })).toBeGreaterThanOrEqual(AA_TEXT)
        }
      }
    }
    // The floor is reached, not passed by far: the rule asks the least that reads.
    expect(worst).toBeLessThan(5)
    expect(strongest).toBe(65)
  })

  it('raises the veil of a bright picture above the line of the videos of Lucium, and switches to an even veil where the text side would not carry it', () => {
    // A picture that is dark on average with a bright sky: the line alone would give 55 % on the text side, about 35 % where the text ends, too
    // little over the sky; the floor asks more than the text side can give under 65 %, so the veil is even, and stronger where the text ends.
    const sky = autoVeil({ meanY: 40, p95: 0.6, p05: 0.001 }).look
    expect(sky.veilColor).toBe(VEIL_COLORS[0])
    expect(sky.veilShape).toBeUndefined()
    expect(sky.veil).toBeGreaterThan(55 * TEXT_SIDE_AT_TEXT_END)
    // A darker picture keeps the text side, at the strength of the line (55 % for a mean luma of 40).
    expect(autoVeil({ meanY: 40, p95: 0.1, p05: 0.001 }).look).toMatchObject({ veil: 55, veilShape: 'text' })
  })

  it('grows with the brightness of the picture where the text ends, at the step of the slider, from 35 %', () => {
    // Where the text ends: the text side keeps about 0.64 of its strength there, an even veil all of it.
    const atTextEnd = (look: AutoVeilLook) => look.veil * (look.veilShape === 'text' ? TEXT_SIDE_AT_TEXT_END : 1)
    let before = 0
    for (let p95 = 0.002; p95 <= 1; p95 += 0.02) {
      const { look } = autoVeil({ meanY: 30, p95, p05: 0 })
      expect(look.veilColor).toBe(VEIL_COLORS[0])
      expect(look.veil % 5).toBe(0)
      expect(atTextEnd(look)).toBeGreaterThanOrEqual(before)
      before = atTextEnd(look)
    }
    before = 0
    for (let meanY = 0; meanY <= 120; meanY += 5) {
      const { look } = autoVeil({ meanY, p95: 0.05, p05: 0 })
      expect(look.veil).toBeGreaterThanOrEqual(before)
      expect(look.veil % 5).toBe(0)
      expect(look.veil).toBeGreaterThanOrEqual(35)
      before = look.veil
    }
  })

  it('takes the dark veil and white text with its shadow for a dark picture, the light veil and dark text without shadow for a bright one', () => {
    expect(autoVeil({ meanY: 20, p95: 0.05, p05: 0.001 }).look).toEqual({ veilColor: '#0b0c12', veil: 40, veilShape: 'text', textColor: '#ffffff', textHalo: true, veilAuto: true })
    const white = autoVeil(measureFrames([plain(255, 255, 255)])).look
    expect(white).toEqual({ veilColor: '#f4f4f6', veil: 35, veilShape: 'text', textColor: '#0b0c12', veilAuto: true })
    // The colours are ones the Fond panel offers, so it shows them chosen.
    expect(VEIL_COLORS as readonly string[]).toContain(white.veilColor)
    expect(TEXT_COLORS as readonly string[]).toContain(white.textColor)
  })

  it('takes the light veil only when it needs less than the dark one: a bright picture with deep shadows keeps the dark veil', () => {
    const contrasted = { meanY: 150, p95: 0.9, p05: 0.0005 }
    const { look } = autoVeil(contrasted)
    expect(look.veilColor).toBe(VEIL_COLORS[0])
    expect(worstContrast(look, contrasted)).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('is the safe look (the dark veil at 60 % on the text side, white text, shadow) when nothing could be measured, or the frames came out black, never no veil', () => {
    expect(AUTO_VEIL_FALLBACK).toEqual({ veilColor: '#0b0c12', veil: 60, veilShape: 'text', textColor: '#ffffff', textHalo: true, veilAuto: true })
    expect(autoVeil(null)).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    expect(autoVeil(measureFrames([plain(0, 0, 0), plain(2, 2, 2)]))).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    expect(autoVeil({ meanY: Number.NaN, p95: 0.5, p05: 0.1 })).toEqual({ look: AUTO_VEIL_FALLBACK, measured: false })
    // A very dark picture that is not black is measured.
    expect(autoVeil({ meanY: 3, p95: 0.004, p05: 0 }).measured).toBe(true)
  })
})

describe('the calibration on the nine videos of Lucium', () => {
  // Mean luma, 95th and 5th percentiles of relative luminance, and the strength the maintainer validated by eye (builtin-backgrounds.ts). Measured on
  // 2026-11-12 with ffmpeg, 8 frames of each video from 5 % to 95 % of its length, brought down to 72 × 128, the left 60 % of each:
  //   ffmpeg -ss <time> -i lucium-<id>.mp4 -frames:v 1 -vf scale=72:128:flags=area -f rawvideo -pix_fmt rgb24 -
  // then, on every pixel, luma = 0.299 R + 0.587 G + 0.114 B and the WCAG relative luminance, whose percentiles are taken over all the frames.
  const EIGHT_FRAMES: Record<BuiltinBackgroundId, [meanY: number, p95: number, p05: number]> = {
    'aurores-boreales': [55.6, 0.261, 0.0036],
    'temple-brume': [45.0, 0.177, 0.003],
    village: [50.4, 0.129, 0.0097],
    foret: [41.1, 0.063, 0.0087],
    montagnes: [37.8, 0.121, 0.0025],
    'ville-cyberpunk': [45.2, 0.1, 0.0052],
    'fonds-marins': [27.7, 0.133, 0.0008],
    'serre-lucioles': [22.7, 0.044, 0.0012],
    'hublot-spatial': [14.3, 0.036, 0.0006]
  }
  // The same, measured the way the panel does (the five frames of `frameTimes`, the part `measuredRegion` keeps, 38 pixels wide):
  //   ffmpeg -ss <time> -i lucium-<id>.mp4 -frames:v 1 -vf "crop=<0.45 × height>:<height>:<centred>:0,scale=64:<height>:flags=area" ...
  // and the left 38 columns.
  const AS_THE_PANEL: Record<BuiltinBackgroundId, [meanY: number, p95: number, p05: number]> = {
    'aurores-boreales': [57.8, 0.29, 0.0037],
    'temple-brume': [47.8, 0.197, 0.0032],
    village: [51.4, 0.134, 0.0109],
    foret: [41.9, 0.064, 0.0096],
    montagnes: [39.0, 0.128, 0.0027],
    'ville-cyberpunk': [47.5, 0.099, 0.0063],
    'fonds-marins': [31.1, 0.155, 0.0009],
    'serre-lucioles': [23.5, 0.047, 0.0013],
    'hublot-spatial': [15.3, 0.043, 0.0008]
  }
  // The mean luma of the left 60 % of the picture of each video, from which builtin-backgrounds.ts made its strengths (LEFT_LUMA there).
  const LEFT_LUMA: Record<BuiltinBackgroundId, number> = {
    'aurores-boreales': 58.6,
    'temple-brume': 49.8,
    'serre-lucioles': 21.5,
    village: 52.1,
    foret: 42.7,
    montagnes: 41.2,
    'ville-cyberpunk': 46.8,
    'fonds-marins': 28.6,
    'hublot-spatial': 13.8
  }

  it('gives each video the look it comes with, the dark veil on the text side, at one step of the slider at most from its strength', () => {
    for (const figures of [EIGHT_FRAMES, AS_THE_PANEL]) {
      for (const id of BUILTIN_BACKGROUND_IDS) {
        const [meanY, p95, p05] = figures[id]
        const builtin = builtinBackground(builtinVideoFile(id))!
        const { look, measured } = autoVeil({ meanY, p95, p05 })
        expect(measured, id).toBe(true)
        expect({ ...look, veil: 0 }, id).toEqual({ veilColor: builtin.veilColor, veilShape: builtin.veilShape, textColor: builtin.textColor, textHalo: builtin.textHalo, veil: 0, veilAuto: true })
        expect(Math.abs(look.veil - builtin.veil!), `${id}: ${look.veil} for ${builtin.veil}`).toBeLessThanOrEqual(5)
      }
    }
  })

  it('gives back exactly the strengths of the videos from the figures they were made from', () => {
    for (const id of BUILTIN_BACKGROUND_IDS) {
      const [, p95, p05] = EIGHT_FRAMES[id]
      expect(autoVeil({ meanY: LEFT_LUMA[id], p95, p05 }).look.veil, id).toBe(builtinBackground(builtinVideoFile(id))!.veil)
    }
  })
})

describe('the look in the background of a space', () => {
  const file: SpaceBackground = { type: 'image', value: '1730000000000-0a1b2c3d.png' }
  const look: AutoVeilLook = { veilColor: '#0b0c12', veil: 55, veilShape: 'text', textColor: '#ffffff', textHalo: true, veilAuto: true }

  it('replaces the look the background had, a tone left from before included, and keeps the rest', () => {
    const before: SpaceBackground = { type: 'video', value: 'a.mp4', muted: true, loop: true, paused: true, tone: 'dark', veilColor: '#f4f4f6', veil: 20, textColor: '#14213d' }
    expect(withAutoVeil(before, { ...look, veilShape: undefined, textHalo: undefined })).toEqual({ type: 'video', value: 'a.mp4', muted: true, loop: true, paused: true, veilColor: '#0b0c12', veil: 55, textColor: '#ffffff', veilAuto: true })
  })

  it('stops being the measured one at a change by hand, which keeps everything else', () => {
    expect(byHand({ ...file, ...look, veil: 70 })).toEqual({ ...file, veilColor: '#0b0c12', veil: 70, veilShape: 'text', textColor: '#ffffff', textHalo: true })
    expect(byHand(file)).toEqual(file)
  })

  it('is kept by the state, read again from its file, and the flag is read back only as true', () => {
    expect(cleanSpaceBackground({ ...file, ...look })).toEqual({ ...file, ...look })
    for (const wrong of [false, 'true', 1, null]) expect(cleanSpaceBackground({ ...file, veilAuto: wrong }), String(wrong)).toEqual(file)
    let n = 0
    const ctx: Ctx = { now: 1, newId: () => `id${++n}` }
    const initial = createInitialState(ctx)
    const state = reduce(initial, { type: 'space/update', id: initial.spaces[0]!.id, patch: { background: { ...file, ...look } } }, ctx)
    expect(state.spaces[0]!.background).toEqual({ ...file, ...look })
    const read = parseSavedState(JSON.stringify(persistableState(state)))
    expect(read.spaces[0]!.background).toEqual({ ...file, ...look })
  })

  it('reads a background of 1.0.1, which has no flag, as it was: its look is the user’s', () => {
    const older: SpaceBackground = { ...file, veilColor: '#0b0c12', veil: 40, textHalo: true }
    expect(cleanSpaceBackground(older)).toEqual(older)
    expect(keepsHandLook(cleanSpaceBackground(older))).toBe(true)
  })
})

describe('the background a file of the user gets', () => {
  const upload = { filename: '1730000000000-0a1b2c3d.mp4', mimeType: 'video/mp4' }
  const look = autoVeil({ meanY: 40, p95: 0.1, p05: 0.001 }).look

  it('is the file, looped and silent for a video, with the measured look', () => {
    expect(userFileBackground(undefined, { ...upload, look })).toEqual({ type: 'video', value: upload.filename, muted: true, loop: true, ...look })
    expect(userFileBackground(undefined, { filename: 'x.gif', mimeType: 'image/gif', look })).toEqual({ type: 'gif', value: 'x.gif', loop: true, ...look })
    expect(userFileBackground(undefined, { filename: 'x.png', mimeType: 'image/png' })).toEqual({ type: 'image', value: 'x.png' })
  })

  it('is measured again in place of a file whose look was measured, of a video of Lucium, of a colour, or of a file that never had a look', () => {
    const previous: SpaceBackground[] = [
      { type: 'image', value: 'old.png', veilColor: '#f4f4f6', veil: 35, veilShape: 'text', textColor: '#0b0c12', veilAuto: true },
      builtinBackground(builtinVideoFile('village'))!,
      { type: 'color', value: '#336699' },
      { type: 'image', value: 'old.png' }
    ]
    for (const before of previous) {
      expect(keepsHandLook(before), before.value).toBe(false)
      expect(userFileBackground(before, { ...upload, look }), before.value).toEqual({ type: 'video', value: upload.filename, muted: true, loop: true, ...look })
    }
  })

  it('keeps, in place of a file whose look was set by hand, that look, unmeasured', () => {
    const hand: SpaceBackground = { type: 'image', value: 'old.png', veilColor: '#14213d', veil: 80, tone: 'light', textHalo: true }
    expect(keepsHandLook(hand)).toBe(true)
    expect(userFileBackground(hand, { ...upload, look })).toEqual({ type: 'video', value: upload.filename, muted: true, loop: true, veilColor: '#14213d', veil: 80, tone: 'light', textHalo: true })
    // A tone alone is a look set by hand too (the choice of « Couleur du texte »).
    expect(keepsHandLook({ type: 'image', value: 'old.png', tone: 'dark' })).toBe(true)
  })

  it('is measured only for a file of the user’s', () => {
    expect(isUserFile({ type: 'image', value: 'old.png' })).toBe(true)
    expect(isUserFile({ type: 'video', value: builtinVideoFile('foret') })).toBe(false)
    expect(isUserFile({ type: 'color', value: '#336699' })).toBe(false)
    expect(isUserFile(undefined)).toBe(false)
    expect([backgroundTypeOf('image/gif'), backgroundTypeOf('video/webm'), backgroundTypeOf('image/webp')]).toEqual(['gif', 'video', 'image'])
  })
})
