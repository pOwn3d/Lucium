// Where a bubble sits next to the element that opened it: beside or under the
// element, a small arrow pointing at its middle, kept inside the window. Pure, so that the numbers are measured without a window.

import type { PlusAnchor } from './plus-menu'
import { clamp } from './clamp'

export type BubbleSide = 'right' | 'left' | 'bottom' | 'top'
/** Along the edge it hangs from: `start` puts the bubble's first edge 24 px before the anchor's middle, `end` its last edge 24 px after it, `center` the middle of the bubble on it. */
export type BubbleAlign = 'start' | 'end' | 'center'

/** The least distance kept between a bubble and the window's edge. */
export const BUBBLE_MARGIN = 10
/** The distance between the element and the bubble: the room of the arrow. */
export const BUBBLE_GAP = 8
/** How far the arrow stays from the corners of the bubble. */
const ARROW_INSET = 12
/** The arrow is a 12 px square turned by 45 degrees: half of it stands outside the bubble. */
const ARROW_SIZE = 12
/** How much of the bubble stays before (`start`) or after (`end`) the anchor's middle. */
const ALIGN_OFFSET = 24

export interface BubblePlacement {
  /** The side of the element the bubble is on: the arrow points back to it. */
  side: BubbleSide
  left: number
  top: number
  /** Where the arrow sits along the bubble's edge: from its top edge (sides right and left) or from its left edge (bottom and top). */
  arrow: number
}

/**
 * Where a bubble of `size` goes for an element at `anchor` (window coordinates), in a window of `win`. It goes on the side asked for, or on the opposite
 * one when that side has no room and the other has; whatever happens it stays `BUBBLE_MARGIN` inside the window (a bubble larger than the room starts at the margin).
 */
export function bubblePlacement(anchor: PlusAnchor, size: { width: number; height: number }, win: { width: number; height: number }, side: BubbleSide = 'bottom', align: BubbleAlign = 'start'): BubblePlacement {
  const right = anchor.x + anchor.width
  const bottom = anchor.y + anchor.height
  const cx = anchor.x + anchor.width / 2
  const cy = anchor.y + anchor.height / 2
  const room = {
    right: win.width - BUBBLE_MARGIN - (right + BUBBLE_GAP),
    left: anchor.x - BUBBLE_GAP - BUBBLE_MARGIN,
    bottom: win.height - BUBBLE_MARGIN - (bottom + BUBBLE_GAP),
    top: anchor.y - BUBBLE_GAP - BUBBLE_MARGIN
  }
  const opposite: Record<BubbleSide, BubbleSide> = { right: 'left', left: 'right', bottom: 'top', top: 'bottom' }
  const need = side === 'right' || side === 'left' ? size.width : size.height
  const placed = room[side] >= need || room[opposite[side]] < need ? side : opposite[side]

  if (placed === 'right' || placed === 'left') {
    const left = placed === 'right' ? right + BUBBLE_GAP : anchor.x - BUBBLE_GAP - size.width
    const top = clamp(cy - ALIGN_OFFSET, BUBBLE_MARGIN, win.height - size.height - BUBBLE_MARGIN)
    return { side: placed, left: clamp(left, BUBBLE_MARGIN, Math.max(BUBBLE_MARGIN, win.width - size.width - BUBBLE_MARGIN)), top, arrow: clamp(cy - top - ARROW_SIZE / 2, ARROW_INSET, size.height - ARROW_INSET - ARROW_SIZE / 2) }
  }
  const left = clamp(align === 'end' ? cx + ALIGN_OFFSET - size.width : align === 'center' ? cx - size.width / 2 : cx - ALIGN_OFFSET, BUBBLE_MARGIN, win.width - size.width - BUBBLE_MARGIN)
  const top = clamp(placed === 'bottom' ? bottom + BUBBLE_GAP : anchor.y - BUBBLE_GAP - size.height, BUBBLE_MARGIN, win.height - size.height - BUBBLE_MARGIN)
  return { side: placed, left, top, arrow: clamp(cx - left - ARROW_SIZE / 2, ARROW_INSET, size.width - ARROW_INSET - ARROW_SIZE / 2) }
}
