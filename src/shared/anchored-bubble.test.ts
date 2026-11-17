import { describe, expect, it } from 'vitest'
import { BUBBLE_GAP, BUBBLE_MARGIN, bubblePlacement } from './anchored-bubble'

const win = { width: 980, height: 600 }
const sheet = { width: 420, height: 260 }

describe('bubblePlacement', () => {
  it('hangs a bubble on the right of a sidebar row, its arrow facing the middle of the row', () => {
    const row = { x: 12, y: 300, width: 220, height: 32 }
    const place = bubblePlacement(row, sheet, win, 'right')
    expect(place.side).toBe('right')
    expect(place.left).toBe(row.x + row.width + BUBBLE_GAP)
    expect(place.top).toBe(300 + 16 - 24)
    // The arrow's centre (6 px in) is level with the middle of the row.
    expect(place.top + place.arrow + 6).toBe(300 + 16)
  })

  it('puts a bubble under a button, and lines its end up with the button when told to', () => {
    const button = { x: 500, y: 40, width: 32, height: 28 }
    const start = bubblePlacement(button, sheet, win, 'bottom')
    expect(start).toMatchObject({ side: 'bottom', left: 516 - 24, top: 40 + 28 + BUBBLE_GAP })
    expect(bubblePlacement(button, sheet, win, 'bottom', 'end').left).toBe(516 + 24 - sheet.width)
  })

  it('keeps the bubble inside the window, and the arrow on the bubble, when the element is at an edge', () => {
    const corner = bubblePlacement({ x: 960, y: 30, width: 20, height: 24 }, sheet, win, 'bottom')
    expect(corner.left).toBe(win.width - sheet.width - BUBBLE_MARGIN)
    // The element is far to the right of the bubble's middle: the arrow runs to the end of the bubble but stops short of its corner.
    expect(corner.arrow).toBe(sheet.width - 12 - 6)
    const top = bubblePlacement({ x: 12, y: 2, width: 220, height: 20 }, sheet, win, 'right')
    expect(top.top).toBe(BUBBLE_MARGIN)
    expect(top.arrow).toBeGreaterThanOrEqual(12)
  })

  it('flips to the opposite side when the asked one has no room and the other has', () => {
    expect(bubblePlacement({ x: 400, y: 560, width: 32, height: 28 }, sheet, win, 'bottom').side).toBe('top')
    expect(bubblePlacement({ x: 400, y: 560, width: 32, height: 28 }, sheet, win, 'bottom').top).toBe(560 - BUBBLE_GAP - sheet.height)
    expect(bubblePlacement({ x: 900, y: 300, width: 60, height: 30 }, sheet, win, 'right').side).toBe('left')
    // Room on neither side: the side asked for, held inside the window.
    const small = bubblePlacement({ x: 100, y: 100, width: 40, height: 20 }, { width: 420, height: 400 }, { width: 500, height: 420 }, 'bottom')
    expect(small.side).toBe('bottom')
    expect(small.top).toBe(BUBBLE_MARGIN)
  })
})
