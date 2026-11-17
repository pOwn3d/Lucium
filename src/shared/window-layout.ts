// Where a new window opens: down and to the right of the one it was opened from, back to the top-left of the screen when it would not fit.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const CASCADE_STEP = 28

/** The position of a window of the size of `anchor` opened from it, kept inside `workArea`. */
export function cascadePosition(anchor: Rect, workArea: Rect): { x: number; y: number } {
  const x = anchor.x + CASCADE_STEP
  const y = anchor.y + CASCADE_STEP
  const fits = x + anchor.width <= workArea.x + workArea.width && y + anchor.height <= workArea.y + workArea.height
  return fits ? { x, y } : { x: workArea.x + CASCADE_STEP, y: workArea.y + CASCADE_STEP }
}
