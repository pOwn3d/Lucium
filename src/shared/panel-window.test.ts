import { describe, expect, it } from 'vitest'
import tokensCss from '../renderer/tokens.css?raw'
import { PANEL_WINDOW_BACKGROUND, panelWindowBackground } from './panel-window'
import { colorOf, tokenValues, type Scheme } from './design-tokens'

const hex = (value: { r: number; g: number; b: number }): string => `#${[value.r, value.g, value.b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`

// That the four windows are created with it is checked in main/panel-window-background.test.ts.
describe('the background of the windows of their own', () => {
  it('is the window background of the tokens, in each appearance, at the default hue', () => {
    for (const scheme of ['light', 'dark'] as const satisfies readonly Scheme[]) {
      const values = tokenValues(tokensCss, { scheme, hue: 250 })
      expect(PANEL_WINDOW_BACKGROUND[scheme], scheme).toBe(hex(colorOf(values, 'var(--surface-2)', scheme)))
    }
  })

  it('follows the appearance: light for a light system, dark for a dark one', () => {
    expect(panelWindowBackground(false)).toBe(PANEL_WINDOW_BACKGROUND.light)
    expect(panelWindowBackground(true)).toBe(PANEL_WINDOW_BACKGROUND.dark)
    expect(panelWindowBackground(false)).not.toBe(panelWindowBackground(true))
  })
})
