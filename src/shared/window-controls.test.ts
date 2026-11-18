import { describe, expect, it } from 'vitest'
import tokensCss from '../renderer/tokens.css?raw'
import { colorOf, tokenValues, type Scheme } from './design-tokens'
import { TOOLBAR_BAR_HEIGHT, WEB_APP_HEADER_HEIGHT } from './ipc-layout'
import { createInitialState } from './sidebar'
import { CONTROLS_BACKGROUND, CONTROLS_SYMBOL, appMenuAnchor, controlsHeight, controlsOverlay, controlsSymbolColor, firstControlsOverlay, stripHoldsMenu, stripUnderControls, type ControlsBackdrop } from './window-controls'

const hex = (value: { r: number; g: number; b: number }): string => `#${[value.r, value.g, value.b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`

const back = (over: Partial<ControlsBackdrop> = {}): ControlsBackdrop => ({ appearance: 'dark', toolbar: true, split: false, privateBar: false, ...over })

describe('the ink of the symbols of the system buttons', () => {
  it('is --text-on-space of the tokens, in each scheme: the ink of the glyphs next to them', () => {
    for (const [scheme, key] of [['light', 'onLight'], ['dark', 'onDark']] as const satisfies ReadonlyArray<readonly [Scheme, keyof typeof CONTROLS_SYMBOL]>) {
      const values = tokenValues(tokensCss, { scheme, hue: 250 })
      expect(CONTROLS_SYMBOL[key], scheme).toBe(hex(colorOf(values, 'var(--text-on-space)', scheme)))
    }
  })

  it('reads on the default bar of the window: dark ink on a light window, light ink on a dark one', () => {
    expect(controlsSymbolColor(back({ appearance: 'light' }))).toBe(CONTROLS_SYMBOL.onLight)
    expect(controlsSymbolColor(back({ appearance: 'dark' }))).toBe(CONTROLS_SYMBOL.onDark)
  })

  it('reads on the colour a page chose for its bar, whatever the window: the ink that contrasts more', () => {
    expect(controlsSymbolColor(back({ appearance: 'dark', pageColor: '#ffffff' }))).toBe(CONTROLS_SYMBOL.onLight)
    expect(controlsSymbolColor(back({ appearance: 'light', pageColor: '#101010' }))).toBe(CONTROLS_SYMBOL.onDark)
    // A mid-tone brand blue carries the dark ink (white would stay under 3:1 on it), as the toolbar's glyphs do.
    expect(controlsSymbolColor(back({ appearance: 'dark', pageColor: '#3b82f6' }))).toBe(CONTROLS_SYMBOL.onLight)
  })

  it('is light over the strips of a split view, which are always dark, even in a light window', () => {
    expect(controlsSymbolColor(back({ appearance: 'light', split: true }))).toBe(CONTROLS_SYMBOL.onDark)
  })

  it('is light over the blue bar of a private window, unless the page has a colour of its own', () => {
    expect(controlsSymbolColor(back({ appearance: 'light', privateBar: true }))).toBe(CONTROLS_SYMBOL.onDark)
    expect(controlsSymbolColor(back({ appearance: 'light', privateBar: true, pageColor: '#ffffff' }))).toBe(CONTROLS_SYMBOL.onLight)
  })

  it('follows the window itself, not a bar that is not there, when the toolbar is hidden', () => {
    expect(controlsSymbolColor(back({ toolbar: false, appearance: 'light', pageColor: '#101010', split: true, privateBar: true }))).toBe(CONTROLS_SYMBOL.onLight)
    expect(controlsSymbolColor(back({ toolbar: false, appearance: 'dark', pageColor: '#ffffff' }))).toBe(CONTROLS_SYMBOL.onDark)
  })
})

describe('the height of the system buttons', () => {
  it('covers the border above the toolbar and the toolbar, in a browser window: the card starts right under them', () => {
    expect(controlsHeight({ kind: 'browser', margin: 10 })).toBe(10 + TOOLBAR_BAR_HEIGHT)
    expect(controlsHeight({ kind: 'browser', margin: 0 })).toBe(TOOLBAR_BAR_HEIGHT)
    expect(controlsHeight({ kind: 'browser', margin: 24 })).toBe(24 + TOOLBAR_BAR_HEIGHT)
  })

  it('is the header of an application window, whatever its border', () => {
    expect(controlsHeight({ kind: 'app', margin: 10 })).toBe(WEB_APP_HEADER_HEIGHT)
  })

  it('grows with the zoom of the interface, to the whole point', () => {
    expect(controlsOverlay({ ...back(), kind: 'browser', margin: 10, scale: 1.25 }).height).toBe(Math.round(42 * 1.25))
    expect(controlsOverlay({ ...back(), kind: 'browser', margin: 10 }).height).toBe(42)
  })
})

describe('what a window is given', () => {
  it('has no background of its own: the bar under the buttons shows through', () => {
    expect(controlsOverlay({ ...back(), kind: 'browser', margin: 10 }).color).toBe(CONTROLS_BACKGROUND)
    expect(CONTROLS_BACKGROUND).toBe('rgba(0, 0, 0, 0)')
  })

  it('is made from the settings of the window before any page has told what is behind the buttons', () => {
    const { settings } = createInitialState({ now: 1, newId: () => 'id' })
    expect(firstControlsOverlay({ ...settings, windowBorder: 10, showToolbar: true, uiScale: 100 }, { dark: true })).toEqual({ color: CONTROLS_BACKGROUND, symbolColor: CONTROLS_SYMBOL.onDark, height: 42 })
    expect(firstControlsOverlay({ ...settings, windowBorder: 0, showToolbar: true, uiScale: 100 }, { dark: false })).toEqual({ color: CONTROLS_BACKGROUND, symbolColor: CONTROLS_SYMBOL.onLight, height: 32 })
    expect(firstControlsOverlay({ ...settings, windowBorder: 10, showToolbar: true, uiScale: 100 }, { dark: false, privateBar: true }).symbolColor).toBe(CONTROLS_SYMBOL.onDark)
  })
})

describe('where the button ☰ opens the menu', () => {
  const window = { width: 1360, height: 860 }

  it('is the point the interface names, rounded, when it is inside the window', () => {
    expect(appMenuAnchor({ x: 12.4, y: 41.6 }, window)).toEqual({ x: 12, y: 42 })
    expect(appMenuAnchor({ x: 0, y: 0 }, window)).toEqual({ x: 0, y: 0 })
    expect(appMenuAnchor({ x: 1360, y: 860 }, window)).toEqual({ x: 1360, y: 860 })
  })

  it('is refused for anything else: not a point, not numbers, not finite, outside the window', () => {
    for (const bad of [null, undefined, 'x', 4, [], {}, { x: 1 }, { y: 1 }, { x: '1', y: 2 }, { x: NaN, y: 2 }, { x: 1, y: Infinity }, { x: -1, y: 2 }, { x: 1, y: -0.5 }, { x: 1361, y: 2 }, { x: 1, y: 861 }]) {
      expect(appMenuAnchor(bad, window), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the strips of a split view under the buttons of the system', () => {
  const stage = { width: 1000 }

  it('holds the button ☰ in the strip that starts the top row, and the room in the one that ends it', () => {
    // Two panes side by side.
    expect([stripHoldsMenu({ x: 0, y: 0, width: 495 }), stripUnderControls({ x: 0, y: 0, width: 495 }, stage)]).toEqual([true, false])
    expect([stripHoldsMenu({ x: 505, y: 0, width: 495 }), stripUnderControls({ x: 505, y: 0, width: 495 }, stage)]).toEqual([false, true])
  })

  it('is both in a strip that spans the stage: a single column, or a stack', () => {
    expect([stripHoldsMenu({ x: 0, y: 0, width: 1000 }), stripUnderControls({ x: 0, y: 0, width: 1000 }, stage)]).toEqual([true, true])
  })

  it('is neither in a strip of a lower row (a stack or a grid): the buttons are at the window’s top', () => {
    expect([stripHoldsMenu({ x: 0, y: 420, width: 1000 }), stripUnderControls({ x: 0, y: 420, width: 1000 }, stage)]).toEqual([false, false])
    expect([stripHoldsMenu({ x: 0, y: 300, width: 495 }), stripUnderControls({ x: 505, y: 300, width: 495 }, stage)]).toEqual([false, false])
  })
})
