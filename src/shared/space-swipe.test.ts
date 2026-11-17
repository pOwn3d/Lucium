// Two fingers across the list of tabs: one space per gesture, in the sense of the system, and never for a vertical scroll, Shift with the wheel, a single
// space or a private window.

import { describe, expect, it } from 'vitest'
import { SWIPE_DISTANCE_PX, SWIPE_IDLE, SWIPE_QUIET_MS, swipeStep, type SwipeContext, type SwipeTracker, type WheelSample } from './space-swipe'

const ON: SwipeContext = { enabled: true, privateWindow: false, spaceCount: 3 }

const wheel = (deltaX: number, deltaY: number, timeStamp: number, extra: Partial<WheelSample> = {}): WheelSample => ({
  deltaX,
  deltaY,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  timeStamp,
  ...extra
})

/** Runs the events through the rule, from a gesture at rest; the steps it asked for, in order, and where it ended. */
function play(events: readonly WheelSample[], context: SwipeContext = ON, from: SwipeTracker = SWIPE_IDLE): { steps: number[]; tracker: SwipeTracker } {
  let tracker = from
  const steps: number[] = []
  for (const event of events) {
    const outcome = swipeStep(tracker, event, context)
    tracker = outcome.tracker
    if (outcome.step !== 0) steps.push(outcome.step)
  }
  return { steps, tracker }
}

/** A swipe of the trackpad: `count` events 16 ms apart, each `dx` across and `dy` down, from `start`. */
const swipe = (dx: number, count: number, start = 0, dy = 0): WheelSample[] => Array.from({ length: count }, (_, i) => wheel(dx, dy, start + i * 16))

/** The inertia after the fingers left: deltas that shrink, 16 ms apart, for about a second. */
const inertia = (dx: number, start: number): WheelSample[] => Array.from({ length: 60 }, (_, i) => wheel(dx * 0.93 ** i, 0, start + i * 16))

describe('the distance', () => {
  it('changes nothing until the fingers went the whole distance across, then changes once', () => {
    expect(play(swipe(10, 5)).steps).toEqual([])
    expect(play([...swipe(10, 5), wheel(SWIPE_DISTANCE_PX - 50 - 1, 0, 80)]).steps).toEqual([])
    expect(play([...swipe(10, 5), wheel(SWIPE_DISTANCE_PX - 50, 0, 80)]).steps).toEqual([1])
  })

  it('goes to the next space when the content scrolls to the right (deltaX > 0), to the previous one the other way', () => {
    expect(play(swipe(20, 4)).steps).toEqual([1])
    expect(play(swipe(-20, 4)).steps).toEqual([-1])
  })

  it('counts a wheel in lines as sixteen pixels a line', () => {
    expect(play([wheel(3, 0, 0, { deltaMode: 1 })]).steps).toEqual([])
    expect(play([wheel(4, 0, 0, { deltaMode: 1 })]).steps).toEqual([1])
  })

  it('starts again from nothing after a pause: two slow halves are not one swipe', () => {
    expect(play([...swipe(10, 4), ...swipe(10, 4, 64 + SWIPE_QUIET_MS + 1)]).steps).toEqual([])
  })
})

describe('the lock of the inertia', () => {
  it('changes one space per gesture, however long the fingers go and the inertia lasts', () => {
    const fingers = swipe(25, 12)
    expect(play([...fingers, ...inertia(25, 12 * 16)]).steps).toEqual([1])
    // Even the other way, within the same gesture: the fingers that come back do not undo it.
    expect(play([...swipe(25, 6), ...swipe(-25, 12, 96)]).steps).toEqual([1])
  })

  it('lets the next gesture change space once the inertia has stopped', () => {
    const first = [...swipe(25, 6), ...inertia(25, 96)]
    const end = first.at(-1)!.timeStamp
    expect(play([...first, ...swipe(25, 6, end + SWIPE_QUIET_MS + 1)]).steps).toEqual([1, 1])
    // A second swipe that starts before the first one's inertia stopped is the same gesture.
    expect(play([...first, ...swipe(25, 6, end + SWIPE_QUIET_MS - 10)]).steps).toEqual([1])
  })

  it('takes a clock that went back as a pause, not as a gesture that never ends', () => {
    const { tracker } = play(swipe(25, 6, 10_000))
    expect(tracker.locked).toBe(true)
    expect(play(swipe(25, 6, 0), ON, tracker).steps).toEqual([1])
  })
})

describe('what is not a swipe', () => {
  it('ignores a vertical scroll, and one that drifts sideways less than half as much as it goes down', () => {
    expect(play(swipe(0, 30, 0, 40)).steps).toEqual([])
    expect(play(swipe(15, 30, 0, 40)).steps).toEqual([])
    // Mostly across with a little down is a swipe.
    expect(play(swipe(20, 6, 0, 5)).steps).toEqual([1])
  })

  it('ignores Shift with the wheel (a sideways scroll of a mouse), the pinch of the trackpad (⌃) and the other modifiers', () => {
    for (const key of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(play(swipe(40, 10).map((event) => ({ ...event, [key]: true }))).steps, key).toEqual([])
    }
  })

  it('changes nothing with a single space, in a private window, with the setting off or under a drag', () => {
    expect(play(swipe(40, 10), { ...ON, spaceCount: 1 }).steps).toEqual([])
    expect(play(swipe(40, 10), { ...ON, privateWindow: true }).steps).toEqual([])
    expect(play(swipe(40, 10), { ...ON, enabled: false }).steps).toEqual([])
    expect(play(swipe(40, 10), { ...ON, busy: true }).steps).toEqual([])
  })

  it('reads a delta that is not a number as nothing', () => {
    expect(play([wheel(Number.NaN, 0, 0), wheel(Number.POSITIVE_INFINITY, 0, 16)]).steps).toEqual([])
  })
})
