import { describe, expect, it } from 'vitest'
import { SETTINGS_WINDOW_OPTIONS } from './settings-window'

// A window of 684 x 650, fixed, made almost every pane scroll.
describe('the window of the Settings', () => {
  it('opens larger than 684 x 650, so that a pane rarely needs a scroll bar', () => {
    expect(SETTINGS_WINDOW_OPTIONS.useContentSize).toBe(true)
    expect(SETTINGS_WINDOW_OPTIONS.width).toBeGreaterThanOrEqual(760)
    expect(SETTINGS_WINDOW_OPTIONS.height).toBeGreaterThanOrEqual(740)
  })

  it('can be made smaller, down to 684 x 650, for a small screen', () => {
    expect(SETTINGS_WINDOW_OPTIONS.resizable).toBe(true)
    expect(SETTINGS_WINDOW_OPTIONS.minWidth).toBeLessThanOrEqual(684)
    expect(SETTINGS_WINDOW_OPTIONS.minHeight).toBeLessThanOrEqual(650)
  })
})
