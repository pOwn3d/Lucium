// Where things sit in a window, as pure geometry: the shell places the native views with it and the interface lays out its CSS from the
// same numbers, so that the two cannot drift apart. The sidebar is at the left (the default side) unless `sidebarRight` mirrors the window:
// then the sidebar, the panel docked beside the page, the floating sidebar and the popovers all swap sides. `sidebarRight` is the side of the
// window being laid out: its own choice, else the setting (window-sidebar.ts, `sidebarPlacement`). A docked sidebar is a column `DOCK_WIDTH` wide.

import { FLOATING_INSET, PAGE_MARGIN, SIDE_PANEL_HEADER_HEIGHT, TOOLBAR_BAR_HEIGHT, TOOLBAR_HEIGHT, TRAFFIC_LIGHTS } from './ipc'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The transparent margin on the outer side of the floating sidebar, for its shadow. */
export const FLOAT_SHADOW = 12

/**
 * The part of the window's left edge the native traffic lights take, measured from the edge (three 14 px lights 20 px apart from x = 16, plus a
 * gap). macOS keeps them on the left whatever the layout, so a mirrored window leaves this room at the start of whatever sits under them.
 */
export const LIGHTS_CLEARANCE = 76

/** The docked sidebar (« barre collée », window-sidebar.ts): a column of site icons this wide takes the place of the sidebar, at its side. */
export const DOCK_WIDTH = 56

/**
 * Distance from the top of the window to the page card. The toolbar takes a row above it (one more under a light bar, for its line). In a
 * mirrored window the traffic lights sit above the page, not in the sidebar, and so they do beside a docked column (narrower than they are):
 * a bare strip keeps them off the page when the toolbar is hidden.
 */
export function stageTop(o: { showToolbar: boolean; toolbarLine: boolean; sidebarRight: boolean; docked?: boolean; margin?: number }): number {
  const margin = o.margin ?? PAGE_MARGIN
  if (o.showToolbar) return margin + (o.toolbarLine ? TOOLBAR_HEIGHT : TOOLBAR_BAR_HEIGHT)
  return margin + (o.sidebarRight || o.docked === true ? TOOLBAR_BAR_HEIGHT : 0)
}

export interface FrameInput {
  /** The window's content size. */
  width: number
  height: number
  /**
   * How much of the window the sidebar side of the card gives up: the sidebar's width, PAGE_MARGIN while it is hidden, or a value in
   * between while it slides in or out.
   */
  sideInset: number
  /** The sidebar is at the right. */
  sidebarRight: boolean
  /** Width of the panel docked at the side opposite to the sidebar; null when there is none. */
  panelWidth: number | null
  /** Distance from the top of the window to the page card (`stageTop`). */
  top: number
  /** The margin around the card (Settings › window border); `PAGE_MARGIN`, the default, when absent. */
  margin?: number
}

export interface Frame {
  /** The page card. */
  stage: Box
  /** The native page of the docked panel, under its header strip; null without a panel. */
  panel: Box | null
  /** The strip above the panel (its name and its close button), drawn by the interface. */
  panelHeader: Box | null
}

/**
 * The page card and the docked panel. At the left (the default layout) the card starts at the sidebar's edge and the panel sits at the right,
 * a margin away from the card and from the window; mirrored, the sidebar is at the right and the panel at the left.
 */
export function frameLayout(input: FrameInput): Frame {
  const { width, height, sideInset, sidebarRight, panelWidth, top } = input
  const margin = input.margin ?? PAGE_MARGIN
  // What the card gives up on the side away from the sidebar: the margin, or the panel with a margin on each side of it.
  const outer = panelWidth === null ? margin : panelWidth + margin * 2
  const x = sidebarRight ? outer : sideInset
  const right = sidebarRight ? sideInset : outer
  const stage: Box = { x, y: top, width: Math.max(0, width - x - right), height: Math.max(0, height - top - margin) }
  if (panelWidth === null) return { stage, panel: null, panelHeader: null }
  const panelX = sidebarRight ? margin : width - margin - panelWidth
  const header: Box = { x: panelX, y: margin, width: panelWidth, height: SIDE_PANEL_HEADER_HEIGHT }
  const panel: Box = { x: panelX, y: margin + SIDE_PANEL_HEADER_HEIGHT, width: panelWidth, height: Math.max(0, height - margin * 2 - SIDE_PANEL_HEADER_HEIGHT) }
  return { stage, panel, panelHeader: header }
}

/** The floating sidebar's view: the panel (inset FLOATING_INSET from the edges) and the transparent margin its shadow needs, at the sidebar's side. */
export function floatingBox(o: { width: number; height: number; sidebarWidth: number; sidebarRight: boolean }): Box {
  const width = o.sidebarWidth + FLOATING_INSET + FLOAT_SHADOW
  return { x: o.sidebarRight ? o.width - width : 0, y: 0, width, height: o.height }
}

/**
 * Whether the traffic lights show and where. With the sidebar at the left they belong to it: shown with it, hidden along with it, inset
 * with the floating copy. At the right they belong to the window (macOS cannot put them on the right) and always show, at the same place. A docked
 * column is a shown sidebar: the lights stay at the window's top left corner, on either side of it.
 */
export function trafficLightsAt(o: { sidebarVisible: boolean; floating: boolean; sidebarRight: boolean }): { visible: boolean; position: { x: number; y: number } } {
  if (o.sidebarRight) return { visible: true, position: { ...TRAFFIC_LIGHTS } }
  return {
    visible: o.sidebarVisible || o.floating,
    position: o.floating ? { x: TRAFFIC_LIGHTS.x + FLOATING_INSET, y: TRAFFIC_LIGHTS.y + FLOATING_INSET } : { ...TRAFFIC_LIGHTS }
  }
}

/** How much a bar that starts at `x` (window coordinates) must leave empty on its left for the traffic lights; always 0 with the sidebar at the left. */
export function lightsRoom(o: { sidebarRight: boolean; x: number }): number {
  return o.sidebarRight ? Math.max(0, LIGHTS_CLEARANCE - o.x) : 0
}

/**
 * Where the page card starts, in window coordinates, when the traffic lights are over its toolbar: the sidebar at the right (the card starts after
 * `outer`, what it gives up on the side away from the sidebar: the margin, or the docked panel and its margins), or a column docked at the left (the
 * card starts at its edge). Null when the lights are not over the card: the full sidebar at the left holds them, or hides them with it.
 */
export function cardLeftUnderLights(o: { sidebarRight: boolean; docked: boolean; outer: number }): number | null {
  if (o.sidebarRight) return o.outer
  return o.docked ? DOCK_WIDTH : null
}

/** The room the toolbar of the page card leaves at its start for the traffic lights (see `cardLeftUnderLights`); 0 when they are not over it. */
export function toolbarLeading(o: { sidebarRight: boolean; docked: boolean; outer: number }): number {
  const left = cardLeftUnderLights(o)
  return left === null ? 0 : lightsRoom({ sidebarRight: true, x: left })
}

/** How much of the window the sidebar's side takes while it is shown: the column of a docked sidebar, else the sidebar's width. */
export const shownSidebarWidth = (o: { docked: boolean; sidebarWidth: number }): number => (o.docked ? DOCK_WIDTH : o.sidebarWidth)

/** The popover of the site control centre ends this far from the window's right edge, 3 px inside the page card. */
const POPOVER_RIGHT = PAGE_MARGIN + 3

/**
 * Distance from the right edge of the window to the right end of a popover that hangs from the toolbar (the site control centre): 3 px
 * inside the card's right edge, which is the sidebar's edge when the sidebar is at the right and shown.
 */
export function popoverRightInset(o: { sidebarRight: boolean; sidebarVisible: boolean; sidebarWidth: number }): number {
  return o.sidebarRight && o.sidebarVisible ? o.sidebarWidth + POPOVER_RIGHT - PAGE_MARGIN : POPOVER_RIGHT
}

/**
 * The popover of the site hangs from the strip of the pane it was opened from in a split view: its right end is the strip's (13 px inside), not the
 * window's, which would put it over the other pane. `windowWidth` is the width of the window; null when there is no strip to hang from (the usual place).
 */
export function paneRightInset(strip: { x: number; width: number } | undefined, windowWidth: number): number | null {
  if (!strip || !Number.isFinite(strip.x) || !Number.isFinite(strip.width) || !Number.isFinite(windowWidth) || strip.width <= 0) return null
  const inset = windowWidth - (strip.x + strip.width) + POPOVER_RIGHT
  return inset >= POPOVER_RIGHT && inset < windowWidth ? Math.round(inset) : null
}

/** Left end of the sidebar in window coordinates (a card that must stay inside the sidebar, such as the hover card, needs it). */
export function sidebarLeft(o: { width: number; sidebarWidth: number; sidebarRight: boolean; floating: boolean }): number {
  if (!o.sidebarRight) return 0
  return o.width - o.sidebarWidth - (o.floating ? FLOATING_INSET : 0)
}
