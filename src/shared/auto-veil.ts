// The veil a file of the user's gets when it becomes the background of a space: measured once, when the file is added or replaced, from a few of its
// frames, and written in the fields of the background the Fond panel already sets by hand (colour and strength of the veil, its shape, the colour of the
// text, its shadow). Nothing runs again afterwards: the background itself is the cache. Pure; the frames are read in the panel (renderer/background-probe.ts).
//
// The rule is the one of the videos Lucium comes with (builtin-backgrounds.ts), plus a floor of contrast:
//   - the strength starts from the same straight line of the mean luminance of the part of the picture under the tabs (35 % to 65 %, `veilStrength`);
//   - it is raised to the least that keeps the palest text of the list, the title of a sleeping tab, at 4.5:1 (WCAG AA) over the bright end of the
//     picture (its 95th percentile of relative luminance), where the text side of the veil is at its weakest under the text (60 % of the width);
//   - when a light veil with dark text needs less than the dark veil with white text (the 5th percentile then, the dark end), the light one is taken.
// The figures of the nine videos, measured with ffmpeg (the commands are by the calibration in auto-veil.test.ts), give back the strengths of
// builtin-backgrounds.ts within one step of the slider, and exactly from the figures that file was made from.

import { isBuiltinBackgroundFile, veilStrength } from './builtin-backgrounds'
import { compositeOver, contrastRatio, parseColor, AA_TEXT, type Rgba } from './contrast'
import { TEXT_COLORS, TEXT_SIDE_VEIL_MIN, VEIL_COLORS, type SpaceBackground, type SpaceBackgroundType } from './space-media'

/** Width over height of the sidebar a background is drawn in (200 to 420 pt wide, a window of 600 to 1000): the part of the picture `object-fit: cover` shows. */
export const SIDEBAR_ASPECT = 0.45
/** The share of that part, from the left, under the text of the tabs (as for `LEFT_LUMA` of the videos of Lucium). */
export const TEXT_SHARE = 0.6
/** The size the measured part is brought down to before its pixels are read: a few thousand pixels a frame, the shape of the measured part. */
export const SAMPLE_WIDTH = 38
export const SAMPLE_HEIGHT = Math.round(SAMPLE_WIDTH / (SIDEBAR_ASPECT * TEXT_SHARE))
/** Where the frames of a video are taken, in shares of its length: the fades of its start and end are left out. */
export const FRAME_SHARES = [0.1, 0.3, 0.5, 0.7, 0.9] as const
/** The longest the frames of a file may take to read before the safe veil is used instead. */
export const MEASURE_TIMEOUT_MS = 3000

/**
 * How much of the chosen strength the text side of the veil keeps where the text of the tabs ends (TEXT_SHARE of the width): its gradient
 * (sidebar.css, `.veil-text`) is the full strength at the left, 70 % of it at 55 % of the width and 15 % of it at the right edge. About 0.64.
 */
export const TEXT_SIDE_AT_TEXT_END = 0.7 - ((TEXT_SHARE - 0.55) / (1 - 0.55)) * (0.7 - 0.15)
/** The opacity of the title of a sleeping tab over a background with a text colour: with the shadow of the text, and without (sidebar.css, `.custom-text`). */
export const SLEEPING_TITLE_OPACITY = { halo: 0.85, plain: 0.65 } as const
/** Above this strength the text side is dropped for an even veil: the gradient would leave the end of the titles too bare to read. An even veil
 *  never needs more than 65 % (white over the darkest veil, or the darkest text over the light one), so no picture is hidden by the measure. */
export const TEXT_SIDE_MAX = 65
const STEP = 5
/** A 95th percentile at or under this (sRGB 3 of 255) is a frame that came out black: a decoding that failed looks like this. */
const BLACK_P95 = 0.001

/** What the measure writes in a background: the same fields as the Fond panel, and the mark that they come from the measure. */
export type AutoVeilLook = Required<Pick<SpaceBackground, 'veilColor' | 'veil' | 'textColor'>> & Pick<SpaceBackground, 'veilShape' | 'textHalo'> & { veilAuto: true }

/** The dark polarity, the look of Lucium: the darkest veil, white text with its shadow. */
const DARK = { veilColor: VEIL_COLORS[0], textColor: TEXT_COLORS[0], textHalo: true } as const
/** The light polarity: the light grey veil and the darkest text, without the shadow, which is black (tokens.css `--text-halo`) and would blur dark letters. */
const LIGHT = { veilColor: VEIL_COLORS[4], textColor: TEXT_COLORS[3] } as const

/**
 * The look used when the file could not be measured (it did not decode, its frames came out black, it took too long): the dark veil on the text side at
 * the strength the text side starts from, white text and its shadow. Never no veil: a decoding that failed looks like a very dark picture.
 */
export const AUTO_VEIL_FALLBACK: AutoVeilLook = { ...DARK, veil: TEXT_SIDE_VEIL_MIN, veilShape: 'text', veilAuto: true }

/** The pixels of one frame, as a canvas gives them (RGBA, 4 bytes a pixel, row after row). */
export interface FramePixels {
  data: ArrayLike<number>
  width: number
  height: number
}

/** Three figures of the frames of a file: the mean luma (0 to 255, gamma, as `LEFT_LUMA`) and the 95th and 5th percentiles of relative luminance. */
export interface BackgroundMeasure {
  meanY: number
  p95: number
  p05: number
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The part of a picture of this size that is measured: the part the sidebar shows (`object-fit: cover` in a box of SIDEBAR_ASPECT, centred), then the
 * TEXT_SHARE of it at the left, under the tabs. Null for a size that is not one.
 */
export function measuredRegion(width: number, height: number): Region | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null
  const wider = width / height > SIDEBAR_ASPECT
  const shownWidth = wider ? height * SIDEBAR_ASPECT : width
  const shownHeight = wider ? height : width / SIDEBAR_ASPECT
  return { x: (width - shownWidth) / 2, y: (height - shownHeight) / 2, width: shownWidth * TEXT_SHARE, height: shownHeight }
}

/** The times (seconds) of the frames read from a video of this length; the first frame alone when the length is not known. */
export function frameTimes(duration: number): number[] {
  if (!(duration > 0) || !Number.isFinite(duration)) return [0]
  return FRAME_SHARES.map((share) => share * duration)
}

/** The frames read from an animation of `count` frames (a GIF): the same shares as a video, each frame once. */
export function frameIndices(count: number): number[] {
  if (!(count > 1) || !Number.isFinite(count)) return [0]
  return [...new Set(FRAME_SHARES.map((share) => Math.min(count - 1, Math.floor(share * count))))]
}

const linear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const percentile = (sorted: Float64Array, share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!

/**
 * The figures of the frames, every pixel of each counted alike. A pixel that is mostly transparent is left out: it is not the picture but the sidebar
 * under it. Null when no pixel is left (no frame, or a picture that is all transparent).
 */
export function measureFrames(frames: readonly FramePixels[]): BackgroundMeasure | null {
  const lumas: number[] = []
  let lumaSum = 0
  for (const frame of frames) {
    const pixels = Math.min(frame.width * frame.height, Math.floor(frame.data.length / 4))
    for (let i = 0; i < pixels; i++) {
      const at = i * 4
      if (frame.data[at + 3]! < 128) continue
      const [r, g, b] = [frame.data[at]!, frame.data[at + 1]!, frame.data[at + 2]!]
      lumaSum += 0.299 * r + 0.587 * g + 0.114 * b
      lumas.push(0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b))
    }
  }
  if (lumas.length === 0) return null
  const sorted = Float64Array.from(lumas).sort()
  return { meanY: lumaSum / lumas.length, p95: percentile(sorted, 0.95), p05: percentile(sorted, 0.05) }
}

/** A grey of this relative luminance, as an sRGB colour. */
function greyOf(luminance: number): Rgba {
  const l = Math.min(1, Math.max(0, luminance))
  const c = l <= 0.03928 / 12.92 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
  return { r: c * 255, g: c * 255, b: c * 255, a: 1 }
}

/**
 * The contrast of the title of a sleeping tab (the palest text of the list) over a pixel of this luminance under the veil, the veil at `localStrength`
 * (0 to 1) there: the veil laid over the pixel, then the text at its opacity over both.
 */
export function sleepingTitleContrast(pixelLuminance: number, look: Pick<SpaceBackground, 'veilColor' | 'textColor' | 'textHalo'>, localStrength: number): number {
  const veil = parseColor(look.veilColor ?? VEIL_COLORS[0])!
  const text = parseColor(look.textColor ?? TEXT_COLORS[0])!
  const ground = compositeOver({ ...veil, a: Math.min(1, Math.max(0, localStrength)) }, greyOf(pixelLuminance))
  return contrastRatio({ ...text, a: look.textHalo ? SLEEPING_TITLE_OPACITY.halo : SLEEPING_TITLE_OPACITY.plain }, ground)
}

/** The least veil (percent, where the text ends) that keeps the sleeping title at AA_TEXT over a pixel of this luminance. */
function leastVeil(pixelLuminance: number, polarity: typeof DARK | typeof LIGHT): number {
  for (let percent = 0; percent <= 100; percent++) if (sleepingTitleContrast(pixelLuminance, polarity, percent / 100) >= AA_TEXT) return percent
  return 100
}

/** Up to the next step of the slider (a hair of rounding off is not a step). */
const stepUp = (percent: number): number => Math.ceil(percent / STEP - 1e-9) * STEP

/** The strength and shape for a polarity: the text side while it can carry the floor, an even veil beyond. */
function strengthFor(ramp: number, least: number): Pick<AutoVeilLook, 'veil' | 'veilShape'> {
  const textSide = Math.max(ramp, stepUp(least / TEXT_SIDE_AT_TEXT_END))
  if (textSide <= TEXT_SIDE_MAX) return { veil: textSide, veilShape: 'text' }
  return { veil: Math.max(ramp, stepUp(least)) }
}

/**
 * The look of a measured file. The dark veil starts from the strength of the videos of Lucium for this mean luminance; the light one from the same line
 * read from white (a darker picture wants more of it). Each is raised to its floor of contrast; the light one is taken only when its floor is lower than
 * the dark one's (at equal floors, the dark one, the look of Lucium). Without a measure, or for frames that came out black, the safe look.
 */
export function autoVeil(measure: BackgroundMeasure | null): { look: AutoVeilLook; measured: boolean } {
  if (!measure || !Number.isFinite(measure.meanY) || !(measure.p95 > BLACK_P95)) return { look: AUTO_VEIL_FALLBACK, measured: false }
  const darkFloor = leastVeil(measure.p95, DARK)
  const lightFloor = leastVeil(measure.p05, LIGHT)
  if (lightFloor < darkFloor) return { look: { ...LIGHT, ...strengthFor(veilStrength(255 - measure.meanY), lightFloor), veilAuto: true }, measured: true }
  return { look: { ...DARK, ...strengthFor(veilStrength(measure.meanY), darkFloor), veilAuto: true }, measured: true }
}

/** The fields of a background that make its look: what the measure writes, and what the Fond panel sets by hand. */
const LOOK_FIELDS = ['veilColor', 'veil', 'veilShape', 'tone', 'textColor', 'textHalo', 'veilAuto'] as const

/** The background with the measured look in place of the one it had (a tone left from before would come back if the text colour were taken away). */
export function withAutoVeil(background: SpaceBackground, look: AutoVeilLook): SpaceBackground {
  const rest = { ...background }
  for (const field of LOOK_FIELDS) delete rest[field]
  return { ...rest, ...look }
}

/** The background after a change made by hand in the Fond panel: it is no longer the measured one, and a new file will not replace it. */
export function byHand(background: SpaceBackground): SpaceBackground {
  const { veilAuto: _auto, ...rest } = background
  return rest
}

/**
 * Whether the look of a space's background was set by hand: a file of the user's whose look was not measured (or was changed since) and that has one.
 * A new file then keeps that look and is not measured. A video of Lucium (its look is its own), a colour, or a file that never had a look is not.
 */
export function keepsHandLook(background: SpaceBackground | undefined): boolean {
  if (!background || background.type === 'color' || background.veilAuto === true || isBuiltinBackgroundFile(background.value)) return false
  return background.veilColor !== undefined || background.veilShape !== undefined || background.tone !== undefined || background.textColor !== undefined || background.textHalo !== undefined
}

/** Whether a background is a file of the user's, the only kind measured (a colour has no picture, and a video of Lucium comes with its look). */
export function isUserFile(background: Pick<SpaceBackground, 'type' | 'value'> | undefined): boolean {
  return !!background && background.type !== 'color' && !isBuiltinBackgroundFile(background.value)
}

/** The kind of background a file of this MIME type makes. */
export function backgroundTypeOf(mimeType: string): Exclude<SpaceBackgroundType, 'color'> {
  return mimeType === 'image/gif' ? 'gif' : mimeType.startsWith('video/') ? 'video' : 'image'
}

/**
 * The background a space gets for a file of the user's it was given (added, or in place of another): the file, looped and silent for a video, with the
 * measured look; or, when the look of the background it replaces was set by hand, that look, unmeasured. Without either, the file alone.
 */
export function userFileBackground(previous: SpaceBackground | undefined, media: { filename: string; mimeType: string; look?: AutoVeilLook }): SpaceBackground {
  const type = backgroundTypeOf(media.mimeType)
  const file: SpaceBackground = { type, value: media.filename, ...(type === 'video' ? { muted: true, loop: true } : type === 'gif' ? { loop: true } : {}) }
  if (previous && keepsHandLook(previous)) {
    const kept: SpaceBackground = { ...file }
    for (const field of LOOK_FIELDS) if (previous[field] !== undefined) Object.assign(kept, { [field]: previous[field] })
    return kept
  }
  return media.look ? withAutoVeil(file, media.look) : file
}
