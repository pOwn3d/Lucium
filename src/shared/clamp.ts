// Keeping a number between two bounds. One definition for the whole application: there were six copies, two of which disagreed when
// the bounds cross.

/**
 * `value` brought between `min` and `max`. When the bounds cross (`min` > `max`: a popup or a bubble larger than the room it is placed in), `min` wins, so
 * that the start (left, top) of what is placed stays in view. NaN stays NaN.
 */
export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/** `value` brought between 0 and 1 (a ratio, a position in a box, an alpha). */
export const clamp01 = (value: number): number => clamp(value, 0, 1)

/** A number read from untrusted data (a state file, an imported theme), brought between the bounds; anything that is not a finite number gives `fallback`. */
export const clampOr = (value: unknown, min: number, max: number, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback)
