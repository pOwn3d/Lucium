import type { TooltipRequest } from './ipc'

/** Longest text or keycap list taken from a UI surface: the capsule is a short label, never a paragraph. */
export const TOOLTIP_TEXT_MAX = 120
export const TOOLTIP_KEYS_MAX = 5
const KEY_MAX = 3

/** Reads a request from a UI surface; anything that is not a short label at a finite point is refused (null). */
export function parseTooltip(raw: unknown): TooltipRequest | null {
  const r = raw as Partial<TooltipRequest> | null
  if (!r || typeof r.text !== 'string' || r.text.length === 0 || r.text.length > TOOLTIP_TEXT_MAX) return null
  if (typeof r.x !== 'number' || typeof r.y !== 'number' || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return null
  if (r.keys !== undefined && (!Array.isArray(r.keys) || r.keys.length > TOOLTIP_KEYS_MAX || r.keys.some((k) => typeof k !== 'string' || k.length === 0 || k.length > KEY_MAX))) return null
  // The only variant is the media player's bubble; any other name would be a surface asking for a look it does not have.
  if (r.variant !== undefined && r.variant !== 'media') return null
  // The only side asked for is the left (a tile of a column docked at the right); the default opens to the right.
  if (r.side !== undefined && r.side !== 'left') return null
  return { text: r.text, ...(r.keys ? { keys: r.keys } : {}), x: r.x, y: r.y, ...(r.variant ? { variant: r.variant } : {}), ...(r.side ? { side: r.side } : {}) }
}
