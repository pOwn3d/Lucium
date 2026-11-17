// Two fingers across the list of tabs go to the space before or after (setting `spaceSwipe`). The trackpad sends a horizontal wheel: this
// says when a run of wheel events is one gesture, how far it must go, and the lock that keeps the inertia that follows the fingers from going on to a
// second space. Pure: the sidebar hands in each event and does the step with `stepSpace`, the function the menu and the keyboard use.
//
// The sense is the system's: a wheel that scrolls the content to the right (deltaX > 0, fingers to the left with macOS' natural scrolling) brings the
// space on the right of the row, the next one. Shift with the wheel of a mouse (a sideways scroll) and the pinch of the trackpad (⌃) are no swipe.

/** How far the fingers go across before the space changes, in CSS pixels. A tap or a slip of a vertical scroll stays well under it. */
export const SWIPE_DISTANCE_PX = 60
/** A gesture is over once no wheel event came for this long: its inertia has died out, and the next one is a new gesture. */
export const SWIPE_QUIET_MS = 250
/** The run must be this many times more across than down: a vertical scroll that drifts sideways is not a swipe. */
export const SWIPE_DOMINANCE = 2
/** A wheel that counts in lines (deltaMode 1) or in pages (deltaMode 2), turned into pixels. */
const LINE_PX = 16
const PAGE_PX = 600

/** The fields of a `WheelEvent` the rule reads. `timeStamp` is the event's own (milliseconds). */
export interface WheelSample {
  deltaX: number
  deltaY: number
  deltaMode: number
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  timeStamp: number
}

/** What the window says about the gesture: the setting, a private window (one space), how many spaces, and whether something is dragged. */
export interface SwipeContext {
  enabled: boolean
  privateWindow: boolean
  spaceCount: number
  /** A drag in progress (a tab, a folder): the wheel scrolls the list under it, it does not change space. */
  busy?: boolean
}

/** The gesture under way: how far it went across and down, when its last event came, and whether it already changed space. */
export interface SwipeTracker {
  readonly x: number
  readonly y: number
  readonly lastAt: number | null
  readonly locked: boolean
}

export const SWIPE_IDLE: SwipeTracker = { x: 0, y: 0, lastAt: null, locked: false }

export interface SwipeOutcome {
  tracker: SwipeTracker
  /** The space to go to: 1 the next, -1 the previous, 0 none. */
  step: -1 | 0 | 1
}

const pixels = (delta: number, mode: number): number => (Number.isFinite(delta) ? delta * (mode === 1 ? LINE_PX : mode === 2 ? PAGE_PX : 1) : 0)

/** The next state of the gesture after one wheel event, and the space to go to (one per gesture at most). */
export function swipeStep(tracker: SwipeTracker, sample: WheelSample, context: SwipeContext): SwipeOutcome {
  // Off, in a private window, with a single space or under a drag: nothing is counted, and nothing is held for later.
  if (!context.enabled || context.privateWindow || context.spaceCount < 2 || context.busy === true) return { tracker: SWIPE_IDLE, step: 0 }
  // A pause ends the gesture: what it went through and its lock are forgotten (a clock that went back counts as a pause).
  const fresh = tracker.lastAt === null || sample.timeStamp - tracker.lastAt > SWIPE_QUIET_MS || sample.timeStamp < tracker.lastAt
  const base = fresh ? SWIPE_IDLE : tracker
  // A modifier makes it another gesture (a sideways scroll, a zoom): it counts for nothing, and only keeps a running gesture alive.
  if (sample.shiftKey || sample.ctrlKey || sample.altKey || sample.metaKey) return { tracker: { ...base, x: 0, y: 0, lastAt: sample.timeStamp }, step: 0 }
  const x = base.x + pixels(sample.deltaX, sample.deltaMode)
  const y = base.y + pixels(sample.deltaY, sample.deltaMode)
  const next: SwipeTracker = { x, y, lastAt: sample.timeStamp, locked: base.locked }
  // The inertia of a gesture that already changed space goes on for a while: it changes nothing more until it stops.
  if (base.locked) return { tracker: next, step: 0 }
  if (Math.abs(x) < SWIPE_DISTANCE_PX || Math.abs(x) < SWIPE_DOMINANCE * Math.abs(y)) return { tracker: next, step: 0 }
  return { tracker: { ...next, locked: true }, step: x > 0 ? 1 : -1 }
}
