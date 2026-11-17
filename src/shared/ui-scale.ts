// Size of the interface (Settings › Général › Taille de l’interface). The page keeps its own zoom (site-zoom.ts); this scales what the
// application draws around it: the sidebar, the toolbar and the panels. The surfaces of the interface are zoomed as a whole (Electron's
// `setZoomFactor`), so a length in CSS pixels becomes `factor` times as many points on the screen, and everything the main process
// computes in points from such a length goes through `scaled` below. At 100 % nothing is multiplied and nothing is zoomed: the
// default sizes are untouched.

import { PAGE_MARGIN, TOOLBAR_BAR_HEIGHT, TOOLBAR_HEIGHT } from './ipc'

export const UI_SCALE_MIN = 100
export const UI_SCALE_MAX = 200
export const UI_SCALE_STEP = 5

/**
 * The scale of a saved file, in whole percent between `UI_SCALE_MIN` and `UI_SCALE_MAX`. Anything else gives 100. Below 100 is not offered:
 * the system's traffic lights keep their size and would run into the sidebar's buttons, which are placed in CSS pixels.
 */
export function cleanUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_SCALE_MIN
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value)))
}

/** The zoom factor of the interface surfaces: 1 at 100 %. */
export function uiFactor(percent: unknown): number {
  return cleanUiScale(percent) / 100
}

/** A length of the interface in points on the screen: `value` CSS pixels at `factor`. The very same number when the factor is 1. */
export function scaled(value: number, factor: number): number {
  return factor === 1 ? value : Math.round(value * factor)
}

/** The other way: a length in points on the screen (a window's size, where the pointer is) in CSS pixels of a zoomed surface. */
export function unscaled(value: number, factor: number): number {
  return factor === 1 ? value : value / factor
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** What decides where the page card goes (shell/browser.ts `stageRect`): the sidebar and the toolbar of the window, the side panel if one is docked. */
export interface StageInputs {
  sidebarVisible: boolean
  sidebarWidth: number
  showToolbar: boolean
  /** The 1 px line under a light toolbar takes a row above the page. */
  line: boolean
  /** The width of the docked side panel, or null when there is none. */
  sidePanelWidth: number | null
}

/**
 * The lengths around the page card, in points: where its left edge is when nothing slides (`left`), the room on its right for a side
 * panel, the height above it (margin, toolbar, line) and the margin under and beside it. At a factor of 1 these are the default sizes:
 * 323 or 10, 0 or 10 + the width of the panel, 10 / 42 / 43, 10.
 */
export function stageMetrics(input: StageInputs, factor: number): { left: number; right: number; top: number; margin: number } {
  return {
    left: scaled(input.sidebarVisible ? input.sidebarWidth : PAGE_MARGIN, factor),
    right: input.sidePanelWidth !== null ? scaled(input.sidePanelWidth + PAGE_MARGIN, factor) : 0,
    top: scaled(PAGE_MARGIN + (input.showToolbar ? (input.line ? TOOLBAR_HEIGHT : TOOLBAR_BAR_HEIGHT) : 0), factor),
    margin: scaled(PAGE_MARGIN, factor)
  }
}

/**
 * The layer of the find panel over the page card: the panel's own size and offsets (`panel`, in CSS pixels) plus the transparent margin
 * its shadow needs, put in points. The panel sits `top` under the top of the card and `right` from its right edge.
 */
export function findLayerBounds(stage: Box, panel: { width: number; height: number; top: number; right: number; shadow: number }, factor: number): Box {
  const f = (n: number) => scaled(n, factor)
  return { x: stage.x + stage.width - f(panel.right) - f(panel.width) - f(panel.shadow), y: stage.y + f(panel.top) - f(panel.shadow), width: f(panel.width) + f(panel.shadow) * 2, height: f(panel.height) + f(panel.shadow) * 2 }
}
