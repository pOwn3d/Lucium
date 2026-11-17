import { describe, expect, it } from 'vitest'
import { anchorInPoints } from './popup-anchor'

describe('anchorInPoints', () => {
  const icon = { x: 1200, y: 14, width: 24, height: 24 }

  it('leaves the rectangle alone at 100 %: nothing is computed', () => {
    expect(anchorInPoints(icon, 1)).toBe(icon)
    expect(anchorInPoints(icon, 1.0004)).toBe(icon)
  })

  it('puts the CSS pixels of a zoomed interface in points, so that the popup opens under its icon and not 25 % to the left of it', () => {
    expect(anchorInPoints(icon, 1.25)).toEqual({ x: 1500, y: 17.5, width: 30, height: 30 })
    expect(anchorInPoints(icon, 2).x).toBe(2400)
  })

  it('does not turn a damaged factor into a rectangle of NaN', () => {
    expect(anchorInPoints(icon, NaN)).toBe(icon)
    expect(anchorInPoints(icon, Infinity)).toBe(icon)
  })
})
