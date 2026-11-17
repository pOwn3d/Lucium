// The look of the command bar and of the site control center: the geometry of the card and the colours of the surfaces over the page
// behind (out of the ranking module, which the main process imports for the history). Pure.

import { hexToRgb, isHex, mix } from './theme'

// ---------- the card of the bar ----------

/**
 * The card of the command bar is 766 px wide; its list shows at most five rows of 50 px (a row is a 46 px highlight with 2 px
 * around it). The height follows the rows: 64 px of field and rule, 4 px above the list, 9 px below, the 1 px border twice.
 */
export const COMMAND_BAR_CARD = { width: 766, listRows: 5, rowPitch: 50, head: 64, above: 4, below: 9, border: 1 } as const

/** Height of the card for a number of rows (what is typed decides, down to the field alone), capped at five rows. */
export function commandBarHeight(rows: number): number {
  const { head, above, below, border, rowPitch, listRows } = COMMAND_BAR_CARD
  const shown = Math.min(Math.max(0, rows), listRows)
  return border * 2 + head + (shown > 0 ? above + shown * rowPitch + below : 0)
}

export interface CardSurface {
  /** Fill of the card: a dark tint with a tenth of the page showing through (it stands for a blur of the page behind it). */
  fill: string
  /** The 1 px inner edge. */
  edge: string
  /** The 1 px dark ring outside it, which only shows on a light page. */
  ring: string
}

export const CARD_TINT = '#181818'
export const CARD_TINT_OPACITY = 0.896
export const CARD_EDGE = '#424242'
export const CARD_EDGE_OPACITY = 0.842
/** The page behind the bar when nothing is known of it: the dark card of an empty page. */
export const DARK_PAGE = '#212225'

/**
 * The colour of what lies behind a panel: the colour the tab reports; white for a page that reports none (its root has no
 * background, so the browser paints it white); the dark card of an empty window when there is no tab at all (`undefined`).
 */
export function pageColorBehind(reported: string | null | undefined): string | undefined {
  if (reported === undefined) return undefined
  return isHex(reported) ? reported : '#ffffff'
}

/**
 * The look of the card over a page of this colour. The card is #191919 over a dark page and #303030 over a white one, with an
 * edge of #3d3d3d and #606060: a fixed dark tint at 90 % over what lies behind. The page of a tab is not reachable from the layer
 * (it is another view), so the colour the tab reports stands for the blurred page.
 */
export function cardSurface(pageColor?: string | null): CardSurface {
  const page = isHex(pageColor) ? pageColor : DARK_PAGE
  const { r, g, b } = hexToRgb(page)
  // The ring is as dark as the page is light: #050505 over white, nearly nothing over a dark page.
  const light = Math.min(1, Math.max(0, ((r + g + b) / 3 - 35) / 220))
  return { fill: mix(CARD_TINT, page, 1 - CARD_TINT_OPACITY), edge: mix(CARD_EDGE, page, 1 - CARD_EDGE_OPACITY), ring: `rgb(0 0 0 / ${(0.06 + light * 0.92).toFixed(2)})` }
}

// ---------- the site control center ----------

/** Opening and closing of the popover: it grows from its anchor in 0.22 s (2 % past its size, then settles) and folds back in 0.15 s. */
export const SITE_POPOVER_MOTION = { openMs: 370, closeMs: 150 } as const

export interface PopoverSurface {
  /** Fill of the card: black at 78 % over what lies behind it (#383838 over a white page). */
  fill: string
  /** The buttons of the top row: the card at a third of its brightness (#121212 over a white page). */
  tile: string
}

/**
 * How much of the page shows through the card. A white page, the most common one, gives the lightest card: at 22 % it is dark enough for the
 * secondary text of the dark tokens to reach 4.5:1 on it, and on a row of it under the pointer (at 36 % that text was at 3.5:1).
 */
export const POPOVER_PAGE_SHARE = 0.22

/** The look of the control center over a page of this colour; the colour the tab reports stands for the blurred page behind it. */
export function popoverSurface(pageColor?: string | null): PopoverSurface {
  const page = isHex(pageColor) ? pageColor : DARK_PAGE
  const fill = mix('#000000', page, POPOVER_PAGE_SHARE)
  return { fill, tile: mix('#000000', fill, 0.33) }
}
