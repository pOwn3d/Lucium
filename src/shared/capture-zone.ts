// The zone of a capture chosen from the keyboard, as a drag of the pointer chooses it: the arrows move it, Shift and the arrows change its size
// from its right and bottom edges, Return takes it. Pure: the layer that draws the zone (RegionCapture, Panels.tsx) keeps it in its state.

export interface Zone {
  x: number
  y: number
  width: number
  height: number
}

export interface Bounds {
  width: number
  height: number
}

/** How far one press of an arrow moves the zone or one of its edges, in CSS pixels of the window. */
export const ZONE_STEP = 10
/** The smallest zone the keyboard leaves: the main process refuses a capture under 4 × 4 (shell/ipc.ts), the keyboard stays well above. */
export const ZONE_MIN = 40

const MOVES: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high))

/** The zone the keyboard starts from: the middle half of the window, so that the first arrow shows it where the eye already is. */
export function startZone(bounds: Bounds): Zone {
  const width = Math.max(ZONE_MIN, Math.round(bounds.width / 2))
  const height = Math.max(ZONE_MIN, Math.round(bounds.height / 2))
  return { x: Math.max(0, Math.round((bounds.width - width) / 2)), y: Math.max(0, Math.round((bounds.height - height) / 2)), width, height }
}

/**
 * The zone after an arrow: with no zone yet, the one it starts from (`startZone`: the first arrow shows it); else moved by `ZONE_STEP`, or with
 * Shift one edge pushed or pulled (→ and ↓ grow it, ← and ↑ shrink it, never under `ZONE_MIN`). It stays inside the window. Null for a key that
 * is not an arrow: the layer leaves that key to its other uses.
 */
export function zoneKey(zone: Zone | null, key: string, shift: boolean, bounds: Bounds): Zone | null {
  const move = MOVES[key]
  if (!move) return null
  if (!zone) return startZone(bounds)
  const [dx, dy] = move
  if (shift) {
    const width = clamp(zone.width + dx * ZONE_STEP, ZONE_MIN, bounds.width - zone.x)
    const height = clamp(zone.height + dy * ZONE_STEP, ZONE_MIN, bounds.height - zone.y)
    return { ...zone, width, height }
  }
  return { ...zone, x: clamp(zone.x + dx * ZONE_STEP, 0, bounds.width - zone.width), y: clamp(zone.y + dy * ZONE_STEP, 0, bounds.height - zone.height) }
}
