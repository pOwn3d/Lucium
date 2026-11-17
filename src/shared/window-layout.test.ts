import { describe, expect, it } from 'vitest'
import { CASCADE_STEP, cascadePosition } from './window-layout'

const screen = { x: 0, y: 25, width: 1600, height: 900 }

describe('cascadePosition', () => {
  it('opens a window one step down and to the right of the one it comes from', () => {
    expect(cascadePosition({ x: 100, y: 100, width: 1000, height: 700 }, screen)).toEqual({ x: 100 + CASCADE_STEP, y: 100 + CASCADE_STEP })
  })

  it('goes back to the top-left of the work area when the window would leave the screen', () => {
    expect(cascadePosition({ x: 500, y: 100, width: 1100, height: 700 }, screen)).toEqual({ x: CASCADE_STEP, y: 25 + CASCADE_STEP })
    expect(cascadePosition({ x: 100, y: 240, width: 1000, height: 700 }, screen)).toEqual({ x: CASCADE_STEP, y: 25 + CASCADE_STEP })
  })
})
