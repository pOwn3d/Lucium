import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { createInitialState, parseSavedState, reduce, type Ctx } from './sidebar'
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, cleanUiScale, findLayerBounds, scaled, stageMetrics, uiFactor, unscaled, type StageInputs } from './ui-scale'
import { FIND_PANEL, FIND_REPLACE_PANEL, PAGE_MARGIN, TOOLBAR_BAR_HEIGHT, TOOLBAR_HEIGHT } from './ipc'

const ctx: Ctx = { now: 1, newId: () => 'id' }

describe('cleanUiScale', () => {
  it('keeps a whole percent between 100 and 200', () => {
    for (const value of [100, 105, 125, 150, 200]) expect(cleanUiScale(value)).toBe(value)
    expect(UI_SCALE_STEP).toBe(5)
    expect([UI_SCALE_MIN, UI_SCALE_MAX]).toEqual([100, 200])
  })

  it('rounds, and brings what is out of range to the nearest end: nothing below the default size is offered', () => {
    expect(cleanUiScale(124.6)).toBe(125)
    expect(cleanUiScale(99)).toBe(100)
    expect(cleanUiScale(-50)).toBe(100)
    expect(cleanUiScale(900)).toBe(200)
    expect(cleanUiScale(Infinity)).toBe(100)
  })

  it('is 100 for anything that is not a finite number', () => {
    for (const bad of [undefined, null, '150', NaN, {}, [], true]) expect(cleanUiScale(bad), String(bad)).toBe(100)
  })

  it('is what a state loaded from a file or changed from the interface holds', () => {
    expect(defaultSettings().uiScale).toBe(100)
    const state = createInitialState(ctx)
    expect(reduce(state, { type: 'settings/update', patch: { uiScale: 150 } }, ctx).settings.uiScale).toBe(150)
    expect(reduce(state, { type: 'settings/update', patch: { uiScale: 3000 } }, ctx).settings.uiScale).toBe(200)
    expect(reduce(state, { type: 'settings/update', patch: { uiScale: 40 } }, ctx).settings.uiScale).toBe(100)
    const damaged = JSON.stringify({ ...state, settings: { ...state.settings, uiScale: 'grand' } })
    expect(parseSavedState(damaged).settings.uiScale).toBe(100)
    const old = JSON.stringify({ ...state, settings: Object.fromEntries(Object.entries(state.settings).filter(([key]) => key !== 'uiScale')) })
    expect(parseSavedState(old).settings.uiScale).toBe(100)
  })
})

describe('scaled and uiFactor', () => {
  it('leave every length alone at 100 %: the default sizes do not move', () => {
    expect(uiFactor(100)).toBe(1)
    for (const value of [PAGE_MARGIN, TOOLBAR_BAR_HEIGHT, TOOLBAR_HEIGHT, 323, 7.3]) expect(scaled(value, uiFactor(100))).toBe(value)
    expect(unscaled(323, 1)).toBe(323)
  })

  it('multiply a length by the factor and round it to a whole point', () => {
    expect(uiFactor(125)).toBe(1.25)
    expect(scaled(10, 1.25)).toBe(13)
    expect(scaled(32, 1.25)).toBe(40)
    expect(scaled(33, 1.5)).toBe(50)
    expect(unscaled(50, 1.25)).toBe(40)
  })

  it('read the factor of a damaged setting as 1', () => {
    expect(uiFactor('x')).toBe(1)
    expect(uiFactor(undefined)).toBe(1)
  })
})

// The layout of the window as it was before the interface could be scaled: the page card's edges, written out with the default numbers.
const arcStage = (i: StageInputs) => ({
  left: i.sidebarVisible ? i.sidebarWidth : 10,
  right: i.sidePanelWidth !== null ? i.sidePanelWidth + 10 : 0,
  top: 10 + (i.showToolbar ? (i.line ? 33 : 32) : 0),
  margin: 10
})

describe('stageMetrics: the page card around which the interface is laid out', () => {
  const inputs: StageInputs[] = []
  for (const sidebarVisible of [true, false]) for (const showToolbar of [true, false]) for (const line of [true, false]) for (const sidePanelWidth of [null, 400]) inputs.push({ sidebarVisible, sidebarWidth: 323, showToolbar, line, sidePanelWidth })

  it('is exactly the default layout at 100 %, for every combination of sidebar, toolbar, line and side panel', () => {
    for (const input of inputs) expect(stageMetrics(input, 1), JSON.stringify(input)).toEqual(arcStage(input))
    // The figures themselves: 323 px sidebar, a 10 px margin, 42 px (32 px bar) or 43 px (with the line) above the page.
    expect(stageMetrics({ sidebarVisible: true, sidebarWidth: 323, showToolbar: true, line: false, sidePanelWidth: null }, 1)).toEqual({ left: 323, right: 0, top: 42, margin: 10 })
    expect(stageMetrics({ sidebarVisible: true, sidebarWidth: 323, showToolbar: true, line: true, sidePanelWidth: null }, 1).top).toBe(43)
  })

  it('takes every length times the factor, to the point, once the interface is scaled', () => {
    expect(stageMetrics({ sidebarVisible: true, sidebarWidth: 323, showToolbar: true, line: false, sidePanelWidth: null }, 1.25)).toEqual({ left: 404, right: 0, top: 53, margin: 13 })
    expect(stageMetrics({ sidebarVisible: false, sidebarWidth: 323, showToolbar: false, line: false, sidePanelWidth: 400 }, 1.5)).toEqual({ left: 15, right: 615, top: 15, margin: 15 })
  })
})

describe('findLayerBounds: the layer of the find panel', () => {
  const stage = { x: 323, y: 42, width: 1347, height: 836 }

  it('is the layer the sizes of the find panel are given in at 100 % (300 x 32, 17 under the top of the card, 10 from its right edge)', () => {
    const { width, height, top, right, shadow } = FIND_PANEL
    expect(findLayerBounds(stage, FIND_PANEL, 1)).toEqual({ x: stage.x + stage.width - right - width - shadow, y: stage.y + top - shadow, width: width + shadow * 2, height: height + shadow * 2 })
    expect(findLayerBounds(stage, FIND_PANEL, 1)).toEqual({ x: 1350, y: 49, width: 320, height: 52 })
    expect(findLayerBounds(stage, FIND_REPLACE_PANEL, 1).height).toBe(FIND_REPLACE_PANEL.height + FIND_REPLACE_PANEL.shadow * 2)
  })

  it('keeps the panel’s right edge the same distance from the card’s, scaled', () => {
    const layer = findLayerBounds(stage, FIND_PANEL, 1.25)
    const panelRight = layer.x + scaled(FIND_PANEL.shadow + FIND_PANEL.width, 1.25)
    expect(panelRight).toBe(stage.x + stage.width - scaled(FIND_PANEL.right, 1.25))
    expect(layer.width).toBe(scaled(300, 1.25) + 2 * scaled(10, 1.25))
  })
})
