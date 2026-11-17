// The box of the command bar: its width, its height, and what the size and the shape chosen in the settings make of them. Moved out of
// command-bar.ts as it was.

import { COMMAND_BAR_SHAPES, COMMAND_BAR_SHAPE_DEFAULT, COMMAND_BAR_SIZES, COMMAND_BAR_SIZE_DEFAULT, type CommandBarShape, type CommandBarSize } from './model'

/**
 * The size of the bar by what it holds: the field alone is 640 px wide; with lines to choose from it is 720 px, the lines on the left and the
 * preview of the highlighted one on the right. The bar of a Mini-fenêtre fills its window (no width of its own, no preview: the window is 490 px).
 */
export const BAR_WIDTH = { field: 640, results: 720 } as const
/** The preview column. */
export const PREVIEW_WIDTH = 250

export function barLayout(rows: number, little: boolean): { width: number | null; preview: boolean } {
  if (little) return { width: null, preview: false }
  return rows > 0 ? { width: BAR_WIDTH.results, preview: true } : { width: BAR_WIDTH.field, preview: false }
}

/** The tallest the list of lines grows in the card: 380 px (a taller list scrolls). */
export const BAR_LIST_HEIGHT = 380

/** How much each size scales the card: `m` is the card as it always was, so nothing moves for someone who never chose. */
const SIZE_FACTOR: Readonly<Record<CommandBarSize, number>> = { s: 0.875, m: 1, l: 1.2, xl: 1.45 }
/** How much each shape stretches the width of the card (and of its preview column) and the height of its list, on top of the size. */
const SHAPE_FACTOR: Readonly<Record<CommandBarShape, { width: number; height: number }>> = {
  balanced: { width: 1, height: 1 },
  wide: { width: 1.2, height: 0.8 },
  tall: { width: 0.95, height: 1.35 }
}

/** The size a saved or received value stands for: one of the four words, or `m` (a damaged setting gives back the card it always had). */
export const cleanBarSize = (value: unknown): CommandBarSize => COMMAND_BAR_SIZES.find((size) => size === value) ?? COMMAND_BAR_SIZE_DEFAULT
/** The shape a saved or received value stands for: one of the three words, or `balanced`. */
export const cleanBarShape = (value: unknown): CommandBarShape => COMMAND_BAR_SHAPES.find((shape) => shape === value) ?? COMMAND_BAR_SHAPE_DEFAULT

/**
 * The dimensions of the card for the size and the shape the user chose (Settings › Recherche): its width, the height the list of lines grows to,
 * and the width of the preview column, all whole pixels. `preview` is whether lines are on offer (`barLayout`): the card is wider then. With the
 * defaults (`m`, `balanced`) these are 640 / 720 px, 380 px and 250 px. The style sheet never lets the card beyond the window, whatever
 * these say (`min(…, 100% - 16px)` and the room under the card for the list).
 */
export function barBox(size: CommandBarSize, shape: CommandBarShape, preview: boolean): { width: number; list: number; previewWidth: number } {
  const scale = SIZE_FACTOR[cleanBarSize(size)]
  const { width, height } = SHAPE_FACTOR[cleanBarShape(shape)]
  return {
    width: Math.round((preview ? BAR_WIDTH.results : BAR_WIDTH.field) * scale * width),
    list: Math.round(BAR_LIST_HEIGHT * scale * height),
    previewWidth: Math.round(PREVIEW_WIDTH * scale * width)
  }
}
