// Where the capsule of a control opens when the pointer rests on it. The capsule covers some 30 px under the point it is given: at the pointer, over a
// line of a panel, it hid the lower half of that line and the top of the next one. A wide control (a row, a header) has its capsule under its bottom
// edge; an icon keeps it at the pointer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLTIP } from '@shared/ipc'

const shown = vi.hoisted(() => ({ requests: [] as Array<{ x: number; y: number } | null> }))
vi.mock('./api', () => ({ api: () => ({ tooltip: (request: { x: number; y: number } | null) => void shown.requests.push(request) }) }))

import { hideTooltip, TIP_UNDER_EDGE, TIP_WIDE_CONTROL, tipProps } from './tooltip'

/** A control of this width, from x 20, its bottom edge at y 136 (36 px tall). */
const control = (width: number) => ({ getBoundingClientRect: () => ({ left: 20, right: 20 + width, width, top: 100, bottom: 136, height: 36 }) })

/** Rests the pointer at (x, y) on the control and gives back where the capsule's top and left are asked for. */
function restOn(width: number, x: number, y: number): { left: number; top: number } {
  const props = tipProps('Une ligne')
  props.onMouseEnter({ clientX: x, clientY: y, currentTarget: control(width) } as never)
  vi.advanceTimersByTime(TOOLTIP.delayMs)
  const request = shown.requests.at(-1)
  expect(request, 'the capsule is asked for').toBeTruthy()
  // The shell opens the capsule TOOLTIP.offsetY under the point it is given (main/shell/tooltip.ts).
  return { left: request!.x, top: request!.y + TOOLTIP.offsetY }
}

beforeEach(() => {
  vi.useFakeTimers()
  shown.requests.length = 0
})
afterEach(() => {
  hideTooltip()
  vi.useRealTimers()
})

describe('the capsule of a wide control', () => {
  it('opens under the bottom edge of the control, not over its lower half, whatever the height of the pointer in it', () => {
    for (const y of [101, 118, 135]) {
      const at = restOn(300, 150, y)
      expect(at.top, `pointer at y ${y}`).toBe(136 + TIP_UNDER_EDGE)
      expect(at.left).toBe(150)
      hideTooltip()
    }
  })

  it('keeps the x of the pointer inside the control', () => {
    expect(restOn(300, 5, 118).left).toBe(20)
    hideTooltip()
    expect(restOn(300, 900, 118).left).toBe(320)
  })
})

describe('the capsule of a narrow control', () => {
  it('stays at the pointer: an icon is no wider than its capsule', () => {
    expect(restOn(TIP_WIDE_CONTROL, 40, 118)).toEqual({ left: 40, top: 118 + TOOLTIP.offsetY })
    hideTooltip()
    expect(restOn(28, 30, 110)).toEqual({ left: 30, top: 110 + TOOLTIP.offsetY })
  })
})
