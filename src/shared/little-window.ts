// Where a new mini window opens and at what size. The size is a choice (a share of the work area, within bounds). The mini window opens in the
// middle of the work area of a screen; the application windows (`web-apps-wiring`) keep the top right corner, 20 px from the edges.

import type { Rect } from './peek'

export const LITTLE_SIZE_RATIO = { width: 0.55, height: 0.75 } as const
export const LITTLE_SIZE_MAX = { width: 900, height: 650 } as const
/** The header (a field and the "open in" pill, 47 px tall) needs this much width to stay readable. */
export const LITTLE_SIZE_MIN = { width: 480, height: 360 } as const
export const LITTLE_SCREEN_MARGIN = 20

/** The size of a mini window for a screen's work area: 55 % x 75 % of it, at most 900 x 650, at least 480 x 360 (never more than the area). */
export function littleWindowSize(workArea: Rect): { width: number; height: number } {
  const fit = (ratio: number, available: number, min: number, max: number) => Math.max(Math.min(min, available), Math.min(max, Math.round(available * ratio)))
  return {
    width: fit(LITTLE_SIZE_RATIO.width, workArea.width, LITTLE_SIZE_MIN.width, LITTLE_SIZE_MAX.width),
    height: fit(LITTLE_SIZE_RATIO.height, workArea.height, LITTLE_SIZE_MIN.height, LITTLE_SIZE_MAX.height)
  }
}

/** A window of the mini window's size anchored at the top right of the work area, 20 px from the edges (the windows of the applications open there). */
export function littleWindowBounds(workArea: Rect): Rect {
  const { width, height } = littleWindowSize(workArea)
  return { x: workArea.x + workArea.width - width - LITTLE_SCREEN_MARGIN, y: workArea.y + LITTLE_SCREEN_MARGIN, width, height }
}

/**
 * A window of `size` in the middle of the work area (the menu bar and the Dock are outside it, so the middle is that of what the user can use).
 * A size larger than the area is cut to it: the window never sticks out.
 */
export function centeredBounds(size: { width: number; height: number }, workArea: Rect): Rect {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height }
}

/** Where a mini window that shows a page opens: its size for this work area, in the middle of it. */
export function littleCenteredBounds(workArea: Rect): Rect {
  return centeredBounds(littleWindowSize(workArea), workArea)
}
