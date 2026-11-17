import { describe, expect, it } from 'vitest'
import { centeredBounds, littleCenteredBounds, littleWindowBounds } from './little-window'

describe('littleWindowBounds', () => {
  it('takes 55 % x 75 % of a mid-size screen and sits 20 px from its top right corner (the windows of the applications)', () => {
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

describe('littleCenteredBounds', () => {
  it('puts a mid-size window in the middle of the work area, the menu bar left out', () => {
    // 55 % x 75 % of 1000 x 700 = 550 x 525; the free space is split evenly around it.
    expect(littleCenteredBounds({ x: 0, y: 25, width: 1000, height: 700 })).toEqual({ x: 225, y: 25 + 88, width: 550, height: 525 })
  })

  it('stays at most 900 x 650 on a large screen, and in the middle of it', () => {
    expect(littleCenteredBounds({ x: 0, y: 25, width: 3360, height: 1775 })).toEqual({ x: 1230, y: 25 + 563, width: 900, height: 650 })
  })

  it('follows the screen it opens on: the origin of the work area counts', () => {
    const second = littleCenteredBounds({ x: 1680, y: 0, width: 1920, height: 1080 })
    expect(second).toEqual({ x: 1680 + 510, y: 215, width: 900, height: 650 })
    expect(second.x + second.width / 2).toBe(1680 + 1920 / 2)
  })

  it('fills a screen that is small: never wider or taller than the work area, never outside it', () => {
    expect(littleCenteredBounds({ x: 100, y: 50, width: 400, height: 300 })).toEqual({ x: 100, y: 50, width: 400, height: 300 })
  })
})

describe('centeredBounds', () => {
  it('cuts a size larger than the work area to it', () => {
    expect(centeredBounds({ width: 5000, height: 4000 }, { x: 10, y: 20, width: 800, height: 600 })).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })
})
