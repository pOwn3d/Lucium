// Where a new mini window opens: in the top right corner of the screen, 20 px from the edges, at a size that is a choice (a share
// of the work area, within bounds).

import type { Rect } from './peek'

export const LITTLE_SIZE_RATIO = { width: 0.55, height: 0.75 } as const
export const LITTLE_SIZE_MAX = { width: 900, height: 650 } as const
/** The header (a field and the "open in" pill, 47 px tall) needs this much width to stay readable. */
export const LITTLE_SIZE_MIN = { width: 480, height: 360 } as const
export const LITTLE_SCREEN_MARGIN = 20

/** The window for a screen's work area: 55 % x 75 % of it, at most 900 x 650, anchored at the top right. */
export function littleWindowBounds(workArea: Rect): Rect {
  const fit = (ratio: number, available: number, min: number, max: number) => Math.max(Math.min(min, available), Math.min(max, Math.round(available * ratio)))
  const width = fit(LITTLE_SIZE_RATIO.width, workArea.width, LITTLE_SIZE_MIN.width, LITTLE_SIZE_MAX.width)
  const height = fit(LITTLE_SIZE_RATIO.height, workArea.height, LITTLE_SIZE_MIN.height, LITTLE_SIZE_MAX.height)
  return { x: workArea.x + workArea.width - width - LITTLE_SCREEN_MARGIN, y: workArea.y + LITTLE_SCREEN_MARGIN, width, height }
}
