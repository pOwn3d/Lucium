// Minimum font size of the pages (Settings › Apparence › Accessibilité). It is Chromium's own `minimumFontSize` web preference: no text of a page is
// drawn smaller than this many CSS pixels, whatever the site asks. 0 is "off" (the default) and changes nothing. A web preference is fixed when a page is
// made (Electron has no way to change it afterwards), so a new value reaches the tabs opened after it; the ones already open keep what they had.

/** The sizes the setting offers, in pixels; 0 is off. */
export const MIN_FONT_SIZES = [0, 10, 12, 14, 16, 18, 20, 24] as const
/** What the switch of the feature writes when it is turned on. */
export const MIN_FONT_SIZE_ON = 12
export const MIN_FONT_SIZE_MAX = 32
/** Below this a minimum would change nothing visible: it counts as off. */
export const MIN_FONT_SIZE_FLOOR = 9

/** The size of a saved file: a whole number of pixels between the floor and the maximum, or 0 (off) for anything else, a size too small to matter included. */
export function cleanMinimumFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const size = Math.round(value)
  return size < MIN_FONT_SIZE_FLOOR ? 0 : Math.min(MIN_FONT_SIZE_MAX, size)
}
