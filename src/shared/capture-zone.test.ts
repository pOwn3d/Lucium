// The zone of a capture chosen from the keyboard: where it starts, how the arrows move it and size it, and that it never leaves the window.

import { describe, expect, it } from 'vitest'
import { startZone, zoneKey, ZONE_MIN, ZONE_STEP, type Zone } from './capture-zone'

const window = { width: 1200, height: 800 }

describe('the zone the keyboard starts from', () => {
  it('is the middle half of the window', () => {
    expect(startZone(window)).toEqual({ x: 300, y: 200, width: 600, height: 400 })
  })

  it('is never smaller than the smallest zone the keyboard leaves, even in a tiny window', () => {
    const zone = startZone({ width: 50, height: 30 })
    expect([zone.width, zone.height]).toEqual([ZONE_MIN, ZONE_MIN])
    expect([zone.x, zone.y]).toEqual([5, 0])
  })
})

describe('an arrow on the zone', () => {
  const zone: Zone = { x: 300, y: 200, width: 600, height: 400 }

  it('moves it by one step, the size kept', () => {
    expect(zoneKey(zone, 'ArrowRight', false, window)).toEqual({ ...zone, x: 300 + ZONE_STEP })
    expect(zoneKey(zone, 'ArrowLeft', false, window)).toEqual({ ...zone, x: 300 - ZONE_STEP })
    expect(zoneKey(zone, 'ArrowDown', false, window)).toEqual({ ...zone, y: 200 + ZONE_STEP })
    expect(zoneKey(zone, 'ArrowUp', false, window)).toEqual({ ...zone, y: 200 - ZONE_STEP })
  })

  it('keeps it inside the window at every edge', () => {
    expect(zoneKey({ ...zone, x: 4 }, 'ArrowLeft', false, window)?.x).toBe(0)
    expect(zoneKey({ ...zone, y: 3 }, 'ArrowUp', false, window)?.y).toBe(0)
    expect(zoneKey({ ...zone, x: 596 }, 'ArrowRight', false, window)?.x).toBe(600)
    expect(zoneKey({ ...zone, y: 398 }, 'ArrowDown', false, window)?.y).toBe(400)
  })

  it('with Shift grows it from its right and bottom edges with → and ↓, and shrinks it with ← and ↑, the corner kept', () => {
    expect(zoneKey(zone, 'ArrowRight', true, window)).toEqual({ ...zone, width: 600 + ZONE_STEP })
    expect(zoneKey(zone, 'ArrowDown', true, window)).toEqual({ ...zone, height: 400 + ZONE_STEP })
    expect(zoneKey(zone, 'ArrowLeft', true, window)).toEqual({ ...zone, width: 600 - ZONE_STEP })
    expect(zoneKey(zone, 'ArrowUp', true, window)).toEqual({ ...zone, height: 400 - ZONE_STEP })
  })

  it('with Shift never makes it smaller than the smallest zone, nor wider than the window from where it is', () => {
    expect(zoneKey({ ...zone, width: ZONE_MIN + 3 }, 'ArrowLeft', true, window)?.width).toBe(ZONE_MIN)
    expect(zoneKey({ ...zone, height: ZONE_MIN }, 'ArrowUp', true, window)?.height).toBe(ZONE_MIN)
    expect(zoneKey({ ...zone, width: 895 }, 'ArrowRight', true, window)?.width).toBe(900)
    expect(zoneKey({ ...zone, height: 598 }, 'ArrowDown', true, window)?.height).toBe(600)
  })

  it('leaves every other key to the layer', () => {
    for (const key of ['Enter', 'Escape', '2', 'Tab', ' ']) expect(zoneKey(zone, key, false, window), key).toBeNull()
  })

  it('with no zone yet shows the one the keyboard starts from, whatever the arrow, and still leaves the other keys', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(zoneKey(null, key, true, window), key).toEqual(startZone(window))
    expect(zoneKey(null, 'Enter', false, window)).toBeNull()
  })
})
