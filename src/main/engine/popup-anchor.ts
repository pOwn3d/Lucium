// The popup of an extension icon is placed from the rectangle of the icon, which the page of the interface measured in CSS pixels. With the
// interface zoomed (Settings › Général › Taille de l’interface) the window has `factor` times as many points as those pixels: the rectangle is
// put in points before the popup is first placed. Pure, so that it can be checked without a window.

export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}

/** The rectangle in points; the same object when the factor is 1 (nothing is computed at 100 %). */
export function anchorInPoints(rect: AnchorRect, factor: number): AnchorRect {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.001) return rect
  return { x: rect.x * factor, y: rect.y * factor, width: rect.width * factor, height: rect.height * factor }
}
