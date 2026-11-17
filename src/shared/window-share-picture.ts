// The black-picture check of the annotated share (docs/design/annotation-partage-fenetre.md, « Fenêtre source fermée ou absente »). The view samples its picture a few
// pixels at a time and keeps the samples in memory only. A picture that stays black is reported to main, which says so to the user: a window
// that is minimized, hidden or on another desktop sends no picture. Pure: the sampling itself is in renderer/window-share-view.ts.

/** Seconds between two samples of the picture, in milliseconds. */
export const PICTURE_SAMPLE_MS = 1000

/** Samples in a row that must be black before the picture counts as blank: 4 s at PICTURE_SAMPLE_MS, so that a dark frame does not count. */
export const BLANK_ROUNDS = 4

/** The brightest channel of a pixel at or under this level is black: a dark frame is not, a black picture is. */
export const BLACK_LEVEL = 8

/**
 * Whether the pixels of an RGBA image are all black. Each pixel is four values (red, green, blue, alpha); the alpha is not read, a transparent
 * pixel counts as black. An empty image is not black: nothing was sampled.
 */
export function isBlackPicture(rgba: ArrayLike<number>): boolean {
  if (rgba.length < 4) return false
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    const brightest = Math.max(rgba[index]!, rgba[index + 1]!, rgba[index + 2]!)
    if (brightest > BLACK_LEVEL) return false
  }
  return true
}

/** The number of samples in a row that were black, after this sample: it counts up on a black one, and starts again on any other. */
export function nextBlankRun(run: number, black: boolean): number {
  return black ? run + 1 : 0
}

/** Whether the picture counts as blank after `run` black samples in a row. */
export function isBlankRun(run: number): boolean {
  return run >= BLANK_ROUNDS
}
