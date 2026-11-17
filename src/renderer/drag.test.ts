// @vitest-environment happy-dom
// A drag started on an edge (the sidebar, a divider of a split view, the docked panel) listens on the window until it ends. It must end when the
// button is released, and also when the release cannot reach this window any more: a drag that never ends resizes at every move of the pointer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDrag } from './drag'

const moveTo = (x: number): void => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x }))
const fire = (type: string): void => void window.dispatchEvent(new Event(type))

let seen: number[] = []
const drag = (): void => startDrag((event) => void seen.push(event.clientX))

beforeEach(() => {
  vi.useFakeTimers()
  seen = []
})
afterEach(() => {
  // Whatever a test left listening is ended.
  fire('pointerup')
  vi.useRealTimers()
})

describe('a drag', () => {
  it('follows the pointer, and delivers the last position when the button is released', () => {
    drag()
    vi.advanceTimersByTime(20)
    moveTo(10)
    moveTo(20)
    moveTo(30)
    fire('pointerup')
    expect(seen.at(-1)).toBe(30)
  })

  it.each(['pointerup', 'pointercancel', 'blur'])('is over after « %s »: the moves that follow resize nothing', (ending) => {
    drag()
    vi.advanceTimersByTime(20)
    moveTo(10)
    fire(ending)
    const until = [...seen]
    expect(until.at(-1)).toBe(10)
    // The pointer moves on, no button held, well after the throttle.
    for (const x of [40, 80, 120]) {
      vi.advanceTimersByTime(50)
      moveTo(x)
    }
    vi.advanceTimersByTime(50)
    expect(seen).toEqual(until)
  })

  it('delivers the position that was waiting when the system cancels the pointer', () => {
    drag()
    vi.advanceTimersByTime(20)
    moveTo(10)
    // Within the throttle: this one waits for its turn.
    moveTo(25)
    expect(seen).toEqual([10])
    fire('pointercancel')
    expect(seen).toEqual([10, 25])
    vi.advanceTimersByTime(50)
    expect(seen).toEqual([10, 25])
  })
})
