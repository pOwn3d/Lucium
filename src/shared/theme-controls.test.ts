import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXTURE_AMOUNT, HUE_MIN_SATURATION, hueOfTheme, huePatch, noisePatch, overlayPatch } from './theme-controls'
import { cleanTheme, hexToHsl, themeFromHue, type SpaceTheme } from './theme'

const theme = (over: Partial<SpaceTheme> = {}): SpaceTheme => cleanTheme({ ...themeFromHue(220), overlay: 'none', noise: 0, ...over })
const apply = (base: SpaceTheme, patch: Partial<SpaceTheme> | null): SpaceTheme => cleanTheme({ ...base, ...patch })

describe('the texture select', () => {
  it('gives a texture chosen on a theme without any a visible amount: a texture of nothing would show nothing', () => {
    const next = apply(theme(), overlayPatch(theme(), 'fine'))
    expect(next.overlay).toBe('fine')
    expect(next.noise).toBe(DEFAULT_TEXTURE_AMOUNT)
  })

  it('keeps the amount the theme already has', () => {
    expect(overlayPatch(theme({ noise: 0.2 }), 'coarse')).toEqual({ overlay: 'coarse' })
  })

  it('takes the texture off without forgetting its amount', () => {
    const patch = overlayPatch(theme({ overlay: 'grain', noise: 0.3 }), 'none')
    expect(patch).toEqual({ overlay: 'none' })
    expect(apply(theme({ overlay: 'grain', noise: 0.3 }), patch).noise).toBe(0.3)
  })
})

describe('the amount of texture', () => {
  it('switches the grain on when there was no texture and there is an amount now', () => {
    expect(noisePatch(theme(), 0.4)).toEqual({ noise: 0.4, overlay: 'grain' })
  })

  it('leaves the texture alone otherwise', () => {
    expect(noisePatch(theme(), 0)).toEqual({ noise: 0 })
    expect(noisePatch(theme({ overlay: 'fine' }), 0.4)).toEqual({ noise: 0.4 })
  })
})

describe('the hue slider', () => {
  it('moves the hue of the first colour and keeps its lightness', () => {
    const before = theme()
    const patch = huePatch(before, 100)!
    const first = hexToHsl(patch.baseColors[0]!)
    expect(Math.abs(first.h - 100)).toBeLessThan(2)
    expect(first.l).toBeCloseTo(hexToHsl(before.baseColors[0]!).l, 1)
  })

  it('gives a grey enough colour to have a hue, so that the slider shows something', () => {
    const grey = cleanTheme({ ...themeFromHue(0), baseColors: ['#808080'], harmony: 'custom' })
    const moved = hexToHsl(huePatch(grey, 200)!.baseColors[0]!)
    expect(moved.s).toBeGreaterThanOrEqual(HUE_MIN_SATURATION - 0.02)
    expect(Math.abs(moved.h - 200)).toBeLessThan(3)
  })

  it('wraps and rounds any value it is given, and moves nothing for what is not a number', () => {
    expect(hueOfTheme(apply(theme(), huePatch(theme(), 360)))).toBeLessThan(3)
    expect(hueOfTheme(apply(theme(), huePatch(theme(), -90)))).toBeGreaterThan(260)
    expect(huePatch(theme(), Number.NaN)).toBeNull()
  })

  it('shows on the slider the hue of the first colour', () => {
    expect(Math.abs(hueOfTheme(theme()) - 220)).toBeLessThan(3)
    const moved = apply(theme(), huePatch(theme(), 40))
    expect(Math.abs(hueOfTheme(moved) - 40)).toBeLessThan(3)
  })

  it('makes the other colours of a derived harmony follow the first (the theme does it, not the slider)', () => {
    const base = theme({ harmony: 'analogous', baseColors: themeFromHue(220).baseColors })
    const moved = apply(base, huePatch(base, 100))
    expect(moved.baseColors.length).toBe(base.baseColors.length)
    if (moved.baseColors.length > 1) expect(moved.baseColors[1]).not.toBe(base.baseColors[1])
  })
})
