import { describe, expect, it } from 'vitest'
import { FLOATING_INSET, PAGE_MARGIN, SIDE_PANEL_HEADER_HEIGHT, TOOLBAR_BAR_HEIGHT, TOOLBAR_HEIGHT, TRAFFIC_LIGHTS } from './ipc'
import { DOCK_WIDTH, FLOAT_SHADOW, LIGHTS_CLEARANCE, cardLeftUnderLights, cardRightGap, floatingBox, frameLayout, lightsRoom, popoverRightInset, shownSidebarWidth, sidebarLeft, stageTop, toolbarLeading, trafficLightsAt } from './frame-layout'

/** The formulas the shell used before the layout was shared (browser.ts, `stageRect` and `layout`): the left layout must keep giving exactly these. */
function arcStage(width: number, height: number, sidebarInset: number, panelWidth: number | null, top: number) {
  const right = panelWidth === null ? 0 : panelWidth + PAGE_MARGIN
  return { x: sidebarInset, y: top, width: Math.max(0, width - sidebarInset - right - PAGE_MARGIN), height: Math.max(0, height - top - PAGE_MARGIN) }
}
function arcPanel(width: number, height: number, panelWidth: number) {
  return { x: width - PAGE_MARGIN - panelWidth, y: PAGE_MARGIN + SIDE_PANEL_HEADER_HEIGHT, width: panelWidth, height: Math.max(0, height - PAGE_MARGIN * 2 - SIDE_PANEL_HEADER_HEIGHT) }
}

describe('frameLayout, sidebar at the left (the default)', () => {
  const sizes: Array<[number, number]> = [[1680, 888], [900, 600], [300, 200]]
  const insets = [323, 200, 420, PAGE_MARGIN, 150]
  const panels: Array<number | null> = [null, 280, 400, 720]
  const tops = [PAGE_MARGIN, PAGE_MARGIN + TOOLBAR_BAR_HEIGHT, PAGE_MARGIN + TOOLBAR_HEIGHT]

  it('gives exactly the numbers of the layout before it was shared', () => {
    for (const [width, height] of sizes) {
      for (const sideInset of insets) {
        for (const panelWidth of panels) {
          for (const top of tops) {
            const frame = frameLayout({ width, height, sideInset, sidebarRight: false, panelWidth, top })
            expect(frame.stage, `${width}x${height} inset ${sideInset} panel ${panelWidth} top ${top}`).toEqual(arcStage(width, height, sideInset, panelWidth, top))
            if (panelWidth === null) {
              expect(frame.panel).toBeNull()
              expect(frame.panelHeader).toBeNull()
            } else {
              expect(frame.panel).toEqual(arcPanel(width, height, panelWidth))
              expect(frame.panelHeader).toEqual({ x: width - PAGE_MARGIN - panelWidth, y: PAGE_MARGIN, width: panelWidth, height: SIDE_PANEL_HEADER_HEIGHT })
            }
          }
        }
      }
    }
  })

  it('puts the card at the sidebar and leaves a margin on the other three sides (the card of a 1680 x 888 window)', () => {
    const { stage } = frameLayout({ width: 1680, height: 888, sideInset: 323, sidebarRight: false, panelWidth: null, top: 42 })
    expect(stage).toEqual({ x: 323, y: 42, width: 1680 - 323 - 10, height: 888 - 42 - 10 })
  })
})

describe('frameLayout, sidebar at the right (mirrored)', () => {
  it('is the mirror image of the left layout: what was measured from the left is measured from the right', () => {
    for (const [width, sideInset, panelWidth] of [[1680, 323, null], [1680, 323, 400], [900, 200, 280], [900, 10, 400]] as Array<[number, number, number | null]>) {
      const left = frameLayout({ width, height: 800, sideInset, sidebarRight: false, panelWidth, top: 42 })
      const right = frameLayout({ width, height: 800, sideInset, sidebarRight: true, panelWidth, top: 42 })
      // The card's left edge in the mirror is the right margin of the original, and the other way round.
      expect(right.stage.x, `${width}/${sideInset}/${panelWidth}`).toBe(width - (left.stage.x + left.stage.width))
      expect(right.stage.x + right.stage.width).toBe(width - left.stage.x)
      expect(right.stage.width).toBe(left.stage.width)
      expect(right.stage.y).toBe(left.stage.y)
      expect(right.stage.height).toBe(left.stage.height)
      if (left.panel && right.panel) {
        expect(right.panel.x).toBe(width - (left.panel.x + left.panel.width))
        expect(right.panel.width).toBe(left.panel.width)
        expect(right.panel.y).toBe(left.panel.y)
        expect(right.panelHeader!.x).toBe(right.panel.x)
      }
    }
  })

  it('docks the panel at the left, a margin from the window and from the card', () => {
    const { stage, panel } = frameLayout({ width: 1680, height: 888, sideInset: 323, sidebarRight: true, panelWidth: 400, top: 42 })
    expect(panel).toEqual({ x: PAGE_MARGIN, y: PAGE_MARGIN + SIDE_PANEL_HEADER_HEIGHT, width: 400, height: 888 - PAGE_MARGIN * 2 - SIDE_PANEL_HEADER_HEIGHT })
    expect(stage.x).toBe(PAGE_MARGIN + 400 + PAGE_MARGIN)
    // The card ends where the sidebar starts.
    expect(stage.x + stage.width).toBe(1680 - 323)
  })

  it('never gives a negative size, however small the window', () => {
    const frame = frameLayout({ width: 200, height: 100, sideInset: 420, sidebarRight: true, panelWidth: 720, top: 52 })
    expect(frame.stage.width).toBe(0)
    expect(frame.stage.height).toBeGreaterThanOrEqual(0)
    expect(frame.panel!.height).toBeGreaterThanOrEqual(0)
  })
})

describe('stageTop', () => {
  it('is the margin plus the toolbar row, one more under a light bar', () => {
    expect(stageTop({ showToolbar: true, toolbarLine: false, sidebarRight: false })).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
    expect(stageTop({ showToolbar: true, toolbarLine: true, sidebarRight: false })).toBe(PAGE_MARGIN + TOOLBAR_HEIGHT)
    expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight: false })).toBe(PAGE_MARGIN)
  })

  it('keeps a strip for the traffic lights in a mirrored window whose toolbar is hidden', () => {
    expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight: true })).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
    expect(stageTop({ showToolbar: true, toolbarLine: false, sidebarRight: true })).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
  })
})

describe('floatingBox', () => {
  it('is at the left edge with the sidebar at the left, at the right edge when mirrored', () => {
    const width = 323 + FLOATING_INSET + FLOAT_SHADOW
    expect(floatingBox({ width: 1000, height: 700, sidebarWidth: 323, sidebarRight: false })).toEqual({ x: 0, y: 0, width, height: 700 })
    expect(floatingBox({ width: 1000, height: 700, sidebarWidth: 323, sidebarRight: true })).toEqual({ x: 1000 - width, y: 0, width, height: 700 })
  })
})

describe('trafficLightsAt', () => {
  it('follows the sidebar at the left: shown with it, hidden with it, inset with the floating copy', () => {
    expect(trafficLightsAt({ sidebarVisible: true, floating: false, sidebarRight: false })).toEqual({ visible: true, position: { ...TRAFFIC_LIGHTS } })
    expect(trafficLightsAt({ sidebarVisible: false, floating: false, sidebarRight: false }).visible).toBe(false)
    expect(trafficLightsAt({ sidebarVisible: false, floating: true, sidebarRight: false })).toEqual({ visible: true, position: { x: TRAFFIC_LIGHTS.x + FLOATING_INSET, y: TRAFFIC_LIGHTS.y + FLOATING_INSET } })
  })

  it('belong to the window when the sidebar is at the right: always shown, never moved', () => {
    for (const [sidebarVisible, floating] of [[true, false], [false, false], [false, true]] as const) {
      expect(trafficLightsAt({ sidebarVisible, floating, sidebarRight: true })).toEqual({ visible: true, position: { ...TRAFFIC_LIGHTS } })
    }
  })
})

describe('lightsRoom', () => {
  it('is nothing with the sidebar at the left', () => {
    expect(lightsRoom({ sidebarRight: false, x: 0 })).toBe(0)
    expect(lightsRoom({ sidebarRight: false, x: 10 })).toBe(0)
  })

  it('is what is left of the traffic lights\' room when the bar starts near the window edge, and nothing further in', () => {
    expect(lightsRoom({ sidebarRight: true, x: PAGE_MARGIN })).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
    expect(lightsRoom({ sidebarRight: true, x: 60 })).toBe(LIGHTS_CLEARANCE - 60)
    expect(lightsRoom({ sidebarRight: true, x: LIGHTS_CLEARANCE })).toBe(0)
    expect(lightsRoom({ sidebarRight: true, x: 420 })).toBe(0)
  })
})

describe('popoverRightInset', () => {
  it('is 13 px, whatever the sidebar does, while it is at the left or hidden', () => {
    expect(popoverRightInset({ sidebarRight: false, sidebarVisible: true, sidebarWidth: 323 })).toBe(13)
    expect(popoverRightInset({ sidebarRight: true, sidebarVisible: false, sidebarWidth: 323 })).toBe(13)
  })

  it('stops 3 px inside the sidebar\'s edge when it is at the right', () => {
    expect(popoverRightInset({ sidebarRight: true, sidebarVisible: true, sidebarWidth: 323 })).toBe(326)
  })
})

describe('sidebarLeft', () => {
  it('is 0 at the left and measured from the right edge when mirrored (the floating copy is inset)', () => {
    expect(sidebarLeft({ width: 1000, sidebarWidth: 323, sidebarRight: false, floating: false })).toBe(0)
    expect(sidebarLeft({ width: 1000, sidebarWidth: 323, sidebarRight: true, floating: false })).toBe(677)
    expect(sidebarLeft({ width: 1000, sidebarWidth: 323, sidebarRight: true, floating: true })).toBe(672)
  })
})

describe('a sidebar docked to a column of icons (« barre collée »)', () => {
  it('keeps the traffic lights at the window’s top left corner, shown, on either side of the column (a column is a shown sidebar)', () => {
    expect(trafficLightsAt({ sidebarVisible: true, floating: false, sidebarRight: false })).toEqual({ visible: true, position: { ...TRAFFIC_LIGHTS } })
    expect(trafficLightsAt({ sidebarVisible: true, floating: false, sidebarRight: true })).toEqual({ visible: true, position: { ...TRAFFIC_LIGHTS } })
    // Hidden, the column is not on screen: the lights go with the sidebar at the left, as always.
    expect(trafficLightsAt({ sidebarVisible: false, floating: false, sidebarRight: false }).visible).toBe(false)
  })

  it('keeps a bare strip above the page for the lights when the toolbar is hidden, as a mirrored window does', () => {
    expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight: false, docked: true })).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
    expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight: false, docked: false })).toBe(PAGE_MARGIN)
    expect(stageTop({ showToolbar: true, toolbarLine: false, sidebarRight: false, docked: true })).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
  })

  it('starts the page card at the column’s edge: the card takes the rest of the window', () => {
    const frame = frameLayout({ width: 1200, height: 800, sideInset: DOCK_WIDTH, sidebarRight: false, panelWidth: null, top: 42 })
    expect(frame.stage).toEqual({ x: DOCK_WIDTH, y: 42, width: 1200 - DOCK_WIDTH - PAGE_MARGIN, height: 800 - 42 - PAGE_MARGIN })
    const mirrored = frameLayout({ width: 1200, height: 800, sideInset: DOCK_WIDTH, sidebarRight: true, panelWidth: null, top: 42 })
    expect(mirrored.stage).toEqual({ x: PAGE_MARGIN, y: 42, width: 1200 - DOCK_WIDTH - PAGE_MARGIN, height: 800 - 42 - PAGE_MARGIN })
  })

  it('makes the toolbar leave room for the lights where the card starts under them, whichever side the column is on', () => {
    // The column at the left: the card starts at 56, the lights reach 76.
    expect(cardLeftUnderLights({ sidebarRight: false, docked: true, outer: PAGE_MARGIN })).toBe(DOCK_WIDTH)
    expect(toolbarLeading({ sidebarRight: false, docked: true, outer: PAGE_MARGIN })).toBe(LIGHTS_CLEARANCE - DOCK_WIDTH)
    // At the right (docked or not): the card starts at the window border, or after the panel docked at the left.
    expect(toolbarLeading({ sidebarRight: true, docked: true, outer: PAGE_MARGIN })).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
    expect(toolbarLeading({ sidebarRight: true, docked: false, outer: PAGE_MARGIN })).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
    expect(toolbarLeading({ sidebarRight: true, docked: false, outer: 400 })).toBe(0)
    // The full sidebar at the left holds the lights: nothing to leave.
    expect(cardLeftUnderLights({ sidebarRight: false, docked: false, outer: PAGE_MARGIN })).toBeNull()
    expect(toolbarLeading({ sidebarRight: false, docked: false, outer: PAGE_MARGIN })).toBe(0)
  })

  it('measures the side of the window the sidebar takes: the column, else the sidebar', () => {
    expect(shownSidebarWidth({ docked: true, sidebarWidth: 323 })).toBe(DOCK_WIDTH)
    expect(shownSidebarWidth({ docked: false, sidebarWidth: 323 })).toBe(323)
    expect(popoverRightInset({ sidebarRight: true, sidebarVisible: true, sidebarWidth: shownSidebarWidth({ docked: true, sidebarWidth: 323 }) })).toBe(DOCK_WIDTH + 3)
  })
})

describe('the buttons of the system over the right end of the window (Windows)', () => {
  it('keep a bare strip above the page card when the toolbar is hidden, on either side of the sidebar and docked or not', () => {
    for (const sidebarRight of [false, true]) {
      for (const docked of [false, true]) {
        expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight, docked, controls: true }), `${sidebarRight} ${docked}`).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
      }
    }
    // Without them (every other window) nothing changes: the card starts at the margin with the sidebar at the left.
    expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight: false, controls: false })).toBe(PAGE_MARGIN)
    expect(stageTop({ showToolbar: false, toolbarLine: false, sidebarRight: false })).toBe(PAGE_MARGIN)
  })

  it('leave the toolbar row as it is when it is shown, with the line of a light bar too', () => {
    expect(stageTop({ showToolbar: true, toolbarLine: false, sidebarRight: false, controls: true })).toBe(PAGE_MARGIN + TOOLBAR_BAR_HEIGHT)
    expect(stageTop({ showToolbar: true, toolbarLine: true, sidebarRight: true, controls: true })).toBe(PAGE_MARGIN + TOOLBAR_HEIGHT)
  })

  it('measure how far the card ends from the window edge: the border, the docked panel, or the sidebar at the right', () => {
    const base = { sidebarWidth: 323, margin: PAGE_MARGIN }
    // The sidebar at the left: what the card gives up at its right, the border or the panel docked there with its margins.
    expect(cardRightGap({ ...base, sidebarRight: false, sidebarVisible: true, docked: false, outer: PAGE_MARGIN })).toBe(PAGE_MARGIN)
    expect(cardRightGap({ ...base, sidebarRight: false, sidebarVisible: true, docked: false, outer: 280 + PAGE_MARGIN * 2 })).toBe(280 + PAGE_MARGIN * 2)
    // The sidebar at the right and shown: the card ends at its edge, the column's when docked.
    expect(cardRightGap({ ...base, sidebarRight: true, sidebarVisible: true, docked: false, outer: PAGE_MARGIN })).toBe(323)
    expect(cardRightGap({ ...base, sidebarRight: true, sidebarVisible: true, docked: true, outer: PAGE_MARGIN })).toBe(DOCK_WIDTH)
    // Hidden, it is the border again.
    expect(cardRightGap({ ...base, sidebarRight: true, sidebarVisible: false, docked: false, outer: PAGE_MARGIN })).toBe(PAGE_MARGIN)
  })
})

describe('the room for the traffic lights on a system that has none', () => {
  it('is nothing: no strip of the toolbar starts under lights that are not there, whichever side the sidebar is on', () => {
    for (const docked of [false, true]) {
      expect(cardLeftUnderLights({ sidebarRight: true, docked, outer: PAGE_MARGIN, lights: false })).toBeNull()
      expect(toolbarLeading({ sidebarRight: true, docked, outer: PAGE_MARGIN, lights: false })).toBe(0)
      expect(toolbarLeading({ sidebarRight: false, docked, outer: PAGE_MARGIN, lights: false })).toBe(0)
    }
    expect(lightsRoom({ sidebarRight: true, x: 8, lights: false })).toBe(0)
  })

  it('is the same as ever on macOS, said or not', () => {
    expect(lightsRoom({ sidebarRight: true, x: 8 })).toBe(LIGHTS_CLEARANCE - 8)
    expect(lightsRoom({ sidebarRight: true, x: 8, lights: true })).toBe(LIGHTS_CLEARANCE - 8)
    expect(toolbarLeading({ sidebarRight: true, docked: false, outer: PAGE_MARGIN, lights: true })).toBe(LIGHTS_CLEARANCE - PAGE_MARGIN)
  })
})
