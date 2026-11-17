import { describe, expect, it } from 'vitest'
import { littleWindowBounds } from './little-window'

describe('littleWindowBounds', () => {
  it('takes 55 % x 75 % of a mid-size screen and sits 20 px from its top right corner', () => {
    expect(littleWindowBounds({ x: 0, y: 25, width: 1000, height: 700 })).toEqual({ x: 430, y: 45, width: 550, height: 525 })
  })

  it('never grows past 900 x 650 on a large screen', () => {
    expect(littleWindowBounds({ x: 0, y: 25, width: 3360, height: 1775 })).toEqual({ x: 2440, y: 45, width: 900, height: 650 })
  })

  it('follows the screen it opens on: its origin counts in the anchor', () => {
    const second = littleWindowBounds({ x: 1680, y: 0, width: 1920, height: 1080 })
    expect(second.x + second.width).toBe(1680 + 1920 - 20)
    expect(second.y).toBe(20)
  })

  it('keeps the header readable on a small screen: at least 480 wide, but never wider than the screen', () => {
    expect(littleWindowBounds({ x: 0, y: 0, width: 700, height: 500 }).width).toBe(480)
    expect(littleWindowBounds({ x: 0, y: 0, width: 400, height: 300 })).toMatchObject({ width: 400, height: 300 })
  })
})
