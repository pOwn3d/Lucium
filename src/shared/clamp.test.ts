import { describe, expect, it } from 'vitest'
import { clamp, clamp01, clampOr } from './clamp'

describe('clamp', () => {
  it('leaves a value between the bounds as it is, and brings one outside to the nearest bound', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(12, 0, 10)).toBe(10)
    expect(clamp(0, 0, 10)).toBe(0)
    expect(clamp(10, 0, 10)).toBe(10)
    expect(clamp(7, 7, 7)).toBe(7)
  })

  it('gives the lower bound when the bounds cross, whatever the value: a box larger than its room keeps its start in view', () => {
    // A popup 900 wide in a work area 800 wide starting at 100: x may go from 100 to 0, and stays at 100.
    expect(clamp(50, 100, 0)).toBe(100)
    expect(clamp(-500, 100, 0)).toBe(100)
    expect(clamp(500, 100, 0)).toBe(100)
  })

  it('keeps NaN, and the infinities to the bounds', () => {
    expect(clamp(Number.NaN, 0, 1)).toBeNaN()
    expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(1)
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0)
  })
})

describe('clamp01', () => {
  it('brings a value between 0 and 1', () => {
    expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01(-0.1)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
  })
})

describe('clampOr', () => {
  it('clamps a finite number', () => {
    expect(clampOr(3, 1, 5, 2)).toBe(3)
    expect(clampOr(9, 1, 5, 2)).toBe(5)
    expect(clampOr(-9, 1, 5, 2)).toBe(1)
  })

  it('gives the fallback for anything that is not a finite number, unclamped', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined, {}, [3]]) expect(clampOr(value, 1, 5, 42), String(value)).toBe(42)
  })
})
