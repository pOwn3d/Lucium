import { describe, expect, it } from 'vitest'
import { MIN_FONT_SIZES, MIN_FONT_SIZE_MAX, MIN_FONT_SIZE_ON, cleanMinimumFontSize } from './min-font-size'

describe('the minimum font size of a saved file', () => {
  it('keeps a whole size between 9 and 32 pixels, and turns anything else off', () => {
    expect(cleanMinimumFontSize(14)).toBe(14)
    expect(cleanMinimumFontSize(13.6)).toBe(14)
    expect(cleanMinimumFontSize(9)).toBe(9)
    expect(cleanMinimumFontSize(MIN_FONT_SIZE_MAX)).toBe(MIN_FONT_SIZE_MAX)
    for (const off of [0, 8, 8.4, -5, undefined, null, '14', NaN, Infinity, {}]) expect(cleanMinimumFontSize(off), String(off)).toBe(0)
  })

  it('caps a size that would make the pages unreadable', () => {
    expect(cleanMinimumFontSize(33)).toBe(MIN_FONT_SIZE_MAX)
    expect(cleanMinimumFontSize(5000)).toBe(MIN_FONT_SIZE_MAX)
  })

  it('offers only sizes it accepts, and the size the switch turns on is one of them', () => {
    for (const size of MIN_FONT_SIZES) expect(cleanMinimumFontSize(size)).toBe(size)
    expect(MIN_FONT_SIZES).toContain(MIN_FONT_SIZE_ON)
  })
})
