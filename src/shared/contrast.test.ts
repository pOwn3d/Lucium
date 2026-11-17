// The WCAG contrast function the design tokens are measured with: known ratios, the forms of colour it reads, and what it refuses.

import { describe, expect, it } from 'vitest'
import { AA_CONTROL, AA_TEXT, compositeOver, contrastRatio, parseColor, relativeLuminance } from './contrast'

describe('parseColor', () => {
  it('reads hex in its four lengths', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#1e2027')).toEqual({ r: 30, g: 32, b: 39, a: 1 })
    expect(parseColor('#0f08')?.a).toBeCloseTo(0x88 / 255, 5)
    expect(parseColor('#14182880')?.a).toBeCloseTo(128 / 255, 5)
  })

  it('reads rgb() with spaces or commas and an alpha after a slash, a comma or in percent', () => {
    expect(parseColor('rgb(20 24 40 / 0.1)')).toEqual({ r: 20, g: 24, b: 40, a: 0.1 })
    expect(parseColor('rgba(20, 24, 40, 0.5)')).toEqual({ r: 20, g: 24, b: 40, a: 0.5 })
    expect(parseColor('rgb(255 255 255 / 50%)')?.a).toBe(0.5)
  })

  it('reads hsl() to the same colour as its hex', () => {
    const c = parseColor('hsl(222 78% 44%)')!
    expect([c.r, c.g, c.b].map(Math.round)).toEqual([25, 77, 200])
    expect(parseColor('hsl(0 0% 100%)')).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(parseColor('hsla(120deg, 100%, 25%, 0.4)')).toMatchObject({ a: 0.4 })
  })

  it('gives null for what is not a plain colour, so that nothing is measured on a guess', () => {
    for (const text of ['var(--text)', 'linear-gradient(red, blue)', 'color-mix(in srgb, red, blue)', '#12', 'rgb(1 2)', 'rgb(a b c)', '']) expect(parseColor(text), text).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white, 1 for a colour on itself, and the same either way round', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#62677a', '#62677a')).toBeCloseTo(1, 5)
    expect(contrastRatio('#16181f', '#f6f6f9')).toBeCloseTo(contrastRatio('#f6f6f9', '#16181f'), 10)
  })

  it('gives the published ratio of #767676 on white (the grey that just passes AA: 4.54)', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(AA_TEXT)
  })

  it('lays a translucent text over its background before measuring: what is seen, not what is written', () => {
    const solid = contrastRatio('#1a1d2b', '#c7d6f6')
    const translucent = contrastRatio('rgb(26 29 43 / 0.5)', '#c7d6f6')
    expect(translucent).toBeLessThan(solid)
    // 50 % of the ink over the background is the mid colour between the two.
    const mid = compositeOver({ r: 26, g: 29, b: 43, a: 0.5 }, { r: 199, g: 214, b: 246, a: 1 })
    expect(translucent).toBeCloseTo(contrastRatio({ ...mid, a: 1 }, '#c7d6f6'), 10)
  })

  it('lays a translucent background over the page it sits on', () => {
    const over = contrastRatio('#ffffff', 'rgb(0 0 0 / 0.5)', '#000000')
    const aloneOnWhite = contrastRatio('#ffffff', 'rgb(0 0 0 / 0.5)', '#ffffff')
    expect(over).toBeGreaterThan(aloneOnWhite)
  })

  it('refuses what it cannot read instead of answering for it', () => {
    expect(() => contrastRatio('var(--text)', '#fff')).toThrow(/not a colour/)
  })

  it('names the two AA thresholds: 4.5 for text, 3 for large text and the parts of a control', () => {
    expect([AA_TEXT, AA_CONTROL]).toEqual([4.5, 3])
  })
})

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white, and weighs green most', () => {
    expect(relativeLuminance(parseColor('#000')!)).toBe(0)
    expect(relativeLuminance(parseColor('#fff')!)).toBeCloseTo(1, 10)
    const [r, g, b] = ['#ff0000', '#00ff00', '#0000ff'].map((hex) => relativeLuminance(parseColor(hex)!)) as [number, number, number]
    expect(g).toBeGreaterThan(r)
    expect(r).toBeGreaterThan(b)
  })
})
