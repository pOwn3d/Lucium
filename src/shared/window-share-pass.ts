// The passage mode of the annotated share (docs/design/annotation-partage-fenetre.md, « Mode passage »): a click on the view is sent to the window it
// shows. This file is pure: the conversion of a click into a point of the source window, and the check of what the view sends. The native calls
// (Accessibility, CoreGraphics) are in main/shell/window-share-native.ts; the rules of the share are in main/shell/window-share.ts.

/** The shortcut that switches between the drawing and the passage (⌥⌘P), held system-wide while a window is shared. */
export const PASS_SHORTCUT = 'Alt+CmdOrCtrl+P'

/**
 * How far the picture's proportions may differ from the window's before the click is refused. A window resized during the share has a new
 * size on the picture before the list of windows says so: the click waits for both to agree.
 */
export const PASS_ASPECT_TOLERANCE = 0.02

/** A rectangle in pixels of the view (CSS pixels of its page). */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A point in pixels (of the view, or of the screen for a point of the source window). */
export interface Point {
  x: number
  y: number
}

/**
 * A click the view sends: the point in the view's page, the place of the picture in that page (the video is letterboxed in the window), and the
 * size of the stream (its pixels). Nothing else leaves the view.
 */
export interface PassClick {
  point: Point
  picture: Box
  stream: { width: number; height: number }
}

/** Why a click or the passage mode did not happen, when the command window must say so. A click outside the picture is not a reason: it is ignored. */
export type PassNote = 'accessibility' | 'unavailable'

const LIMIT = 1_000_000

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMIT

function isBox(raw: unknown): raw is Box {
  if (typeof raw !== 'object' || raw === null) return false
  const box = raw as Record<string, unknown>
  return finite(box['x']) && finite(box['y']) && finite(box['width']) && finite(box['height']) && (box['width'] as number) > 0 && (box['height'] as number) > 0
}

/** Whether a value sent by the view is a well-formed click: finite numbers, and a picture and a stream with a size. */
export function isPassClick(raw: unknown): raw is PassClick {
  if (typeof raw !== 'object' || raw === null) return false
  const click = raw as Record<string, unknown>
  const point = click['point'] as Record<string, unknown> | undefined
  const stream = click['stream'] as Record<string, unknown> | undefined
  if (!point || !stream) return false
  return (
    finite(point['x']) &&
    finite(point['y']) &&
    isBox(click['picture']) &&
    finite(stream['width']) &&
    finite(stream['height']) &&
    (stream['width'] as number) > 0 &&
    (stream['height'] as number) > 0
  )
}

/**
 * Where a click of the view lands in the source window, in the points of the screen (the coordinates CoreGraphics uses: the origin at the top
 * left of the main display). `bounds` is the window's frame in those points. Returns null when the click is not on the picture (the margin around
 * a letterboxed picture, which is also the window's outside), or when the picture and the window no longer have the same proportions.
 *
 * The stream and the window are linked by their scale: the stream has `stream.width` pixels for `bounds.width` points, so a point of the picture is
 * a fraction of the window whatever the density of the stream (a Retina window is streamed in twice as many pixels).
 */
export function sourcePoint(click: PassClick, bounds: Box): Point | null {
  const { point, picture, stream } = click
  if (!isBox(picture) || !isBox(bounds)) return null
  const proportions = stream.width / stream.height / (bounds.width / bounds.height)
  if (Math.abs(proportions - 1) > PASS_ASPECT_TOLERANCE) return null
  // The position on the picture, from 0 to 1 on each axis. The right and bottom edges are outside: 1 is the next pixel.
  const u = (point.x - picture.x) / picture.width
  const v = (point.y - picture.y) / picture.height
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return null
  // Pixels of the stream per point of the window, on each axis. A position inside the picture (0 ≤ u, v < 1) is inside the window.
  const scaleX = stream.width / bounds.width
  const scaleY = stream.height / bounds.height
  return { x: bounds.x + (u * stream.width) / scaleX, y: bounds.y + (v * stream.height) / scaleY }
}
