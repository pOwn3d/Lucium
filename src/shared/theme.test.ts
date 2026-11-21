import { describe, expect, it } from 'vitest'
import {
  backgroundColors, cleanTheme, defaultTheme, harmonize, hexToHsl, hslToHex, isHex, luminance, mix, noiseImage,
  colorAtPadPoint, pagePaletteCss, pagePaletteVars, parseCssColor, sitePaletteCss, resolveAppearance, themeFromArc, themeFromHue, themeHue, themeVars,
  padPointOf, pageSchemeOf, themeSourceOf, toolbarTint, withColorAt, withColorCount, withHarmony,
  SPACE_HOVER, SPACE_INK, SPACE_WASH, spaceInks, type ResolvedAppearance, type SpaceTheme
} from './theme'
import { AA_CONTROL, AA_TEXT, compositeOver, contrastRatio, parseColor, type Rgba } from './contrast'
import { colorOf, tokenValues } from './design-tokens'
import { presetTheme } from './space-creation'
import { NAMED_COLORS } from './theme-colors'
import { READY_THEMES } from './theme-presets'
import { toolbarIsLight } from './toolbar'
import tokensCss from '../renderer/tokens.css?raw'

describe('colour maths', () => {
  it('round-trips hex through HSL within one step', () => {
    for (const hex of ['#ff0000', '#3366cc', '#808080', '#0d0d12', '#f2f2f6']) {
      const back = hslToHex(hexToHsl(hex))
      const [a, b] = [parseInt(hex.slice(1), 16), parseInt(back.slice(1), 16)]
      expect(Math.abs(((a >> 16) & 255) - ((b >> 16) & 255))).toBeLessThanOrEqual(1)
      expect(Math.abs(((a >> 8) & 255) - ((b >> 8) & 255))).toBeLessThanOrEqual(1)
      expect(Math.abs((a & 255) - (b & 255))).toBeLessThanOrEqual(1)
    }
  })

  it('mixes and measures luminance', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#102030', '#ffffff', 0)).toBe('#102030')
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1)
    expect(luminance('#ffff00')).toBeGreaterThan(luminance('#0000ff'))
  })

  it('accepts only 6-digit hex colours', () => {
    expect(isHex('#a1B2c3')).toBe(true)
    for (const bad of ['a1b2c3', '#abc', '#12345g', 12, null, 'red']) expect(isHex(bad)).toBe(false)
  })
})

describe('harmonize', () => {
  const primary = '#ff3300'
  it('derives companions by hue rotation', () => {
    const [p, c] = harmonize(primary, 'complementary', 2)
    expect(p).toBe(primary)
    expect(Math.round(hexToHsl(c!).h)).toBe((Math.round(hexToHsl(primary).h) + 180) % 360)
    const triad = harmonize(primary, 'triadic', 3)
    expect(triad.map((c) => Math.round(hexToHsl(c).h))).toEqual([12, 132, 252])
  })

  it('never returns more colours than asked, or more than three, and a custom harmony adds none', () => {
    expect(harmonize(primary, 'triadic', 1)).toEqual([primary])
    expect(harmonize(primary, 'analogous', 9)).toHaveLength(3)
    expect(harmonize(primary, 'custom', 3)).toEqual([primary])
  })
})

describe('cleanTheme', () => {
  it('fills a missing theme with the default and keeps a valid one', () => {
    expect(cleanTheme(undefined)).toEqual(defaultTheme())
    const t = { ...defaultTheme(), baseColors: ['#112233', '#445566'], harmony: 'custom' as const, intensity: 0.4, overlay: 'coarse' as const }
    expect(cleanTheme(t)).toEqual(t)
  })

  it('discards bad colours, clamps numbers and falls back on unknown names', () => {
    const t = cleanTheme({ baseColors: ['nope', '#12'] as never, intensity: 7, angle: -50, noise: Number.NaN, overlay: 'sparkle' as never, harmony: 'rainbow' as never, appearance: 'sepia' as never })
    expect(t.baseColors).toEqual(defaultTheme().baseColors)
    expect(t).toMatchObject({ intensity: 1, angle: 0, overlay: 'grain', harmony: 'complementary', appearance: 'auto' })
    expect(t.noise).toBe(defaultTheme().noise)
  })

  it('re-derives companions so a derived harmony cannot drift from its primary colour', () => {
    const t = cleanTheme({ baseColors: ['#ff0000', '#00ff00'], harmony: 'complementary' })
    expect(t.baseColors).toEqual(harmonize('#ff0000', 'complementary', 2))
    expect(cleanTheme({ baseColors: ['#ff0000', '#00ff00'], harmony: 'custom' }).baseColors).toEqual(['#ff0000', '#00ff00'])
  })

  it('never keeps more than three colours', () => {
    expect(cleanTheme({ baseColors: ['#111111', '#222222', '#333333', '#444444'], harmony: 'custom' }).baseColors).toHaveLength(3)
  })
})

describe('rendering', () => {
  it('resolves auto from the system, and keeps an explicit choice', () => {
    expect(resolveAppearance({ ...defaultTheme(), appearance: 'auto' }, true)).toBe('dark')
    expect(resolveAppearance({ ...defaultTheme(), appearance: 'auto' }, false)).toBe('light')
    expect(resolveAppearance({ ...defaultTheme(), appearance: 'light' }, true)).toBe('light')
  })

  it('makes dark backgrounds dark and light ones light, and fades to neutral at zero intensity', () => {
    const t = themeFromHue(210)
    const [d] = backgroundColors(t, 'dark')
    const [l] = backgroundColors(t, 'light')
    expect(luminance(d!)).toBeLessThan(0.1)
    expect(luminance(l!)).toBeGreaterThan(0.6)
    expect(backgroundColors({ ...t, intensity: 0 }, 'dark')[0]).toBe('#0d0d12')
  })

  it('builds the gradient with the dial angle, and a readable text colour for each appearance', () => {
    const t = { ...themeFromHue(30), angle: 200 }
    const dark = themeVars(t, 'dark')
    const light = themeVars(t, 'light')
    expect(dark['--bg-gradient']).toMatch(/^linear-gradient\(200deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/)
    expect(luminance(dark['--text']!)).toBeGreaterThan(luminance(light['--text']!))
    expect(themeHue(t)).toBe(30)
  })

  it('turns the texture off cleanly and caps its opacity', () => {
    expect(noiseImage('none')).toBeNull()
    expect(noiseImage('grain')).toContain('baseFrequency=\'0.9\'')
    // Specks that show on a dark and on a light background: white and black, opaque away from the middle of the noise (a raw mid-grey tile blended in overlay shows nothing).
    expect(noiseImage('grain')).toContain("feFuncA type='table' tableValues='0.6 0 0.6'")
    expect(noiseImage('grain')).toContain("color-interpolation-filters='sRGB'")
    expect(themeVars({ ...defaultTheme(), overlay: 'none', noise: 1 }, 'dark')['--grain-opacity']).toBe('0')
    expect(Number(themeVars({ ...defaultTheme(), overlay: 'grain', noise: 1 }, 'dark')['--grain-opacity'])).toBeLessThanOrEqual(0.45)
  })
})

describe('page palette (what is exposed to sites)', () => {
  it('uses the --arc-palette variable names, with a foreground that contrasts with the background', () => {
    const vars = pagePaletteVars(themeFromHue(220), 'dark')
    for (const name of ['title', 'subtitle', 'background', 'backgroundExtra', 'focus', 'hover', 'foregroundPrimary', 'foregroundSecondary', 'foregroundTertiary', 'cutoutColor', 'maxContrastColor', 'minContrastColor']) {
      expect(vars).toHaveProperty(`--arc-palette-${name}`)
    }
    expect(vars).toHaveProperty('--arc-background-simple-color')
    expect(luminance(vars['--arc-palette-title']!)).toBeGreaterThan(luminance(vars['--arc-palette-background']!))
    const light = pagePaletteVars(themeFromHue(220), 'light')
    expect(luminance(light['--arc-palette-title']!)).toBeLessThan(luminance(light['--arc-palette-background']!))
  })

  it('renders a :root rule', () => {
    expect(pagePaletteCss(defaultTheme(), 'dark')).toMatch(/^:root \{\n(  --arc-[\w-]+: .+;\n)+\}$/)
  })

  // allowThemeToSites: a page is told the palette of its space only when the person allowed it.
  it('gives a page the palette of its space only while the switch is on, and nothing while it is off', () => {
    const theme = themeFromHue(220)
    expect(sitePaletteCss(true, theme, false)).toBe(pagePaletteCss(theme, resolveAppearance(theme, false)))
    expect(sitePaletteCss(true, theme, false)).toContain('--arc-palette-background')
    expect(sitePaletteCss(false, theme, false)).toBe('')
    expect(sitePaletteCss(true, undefined, false)).toBe('')
  })

  it('follows the dark mode of the system for a theme that follows it', () => {
    const theme = { ...themeFromHue(220), appearance: 'auto' as const }
    expect(sitePaletteCss(true, theme, true)).not.toBe(sitePaletteCss(true, theme, false))
  })
})

describe('themeFromArc', () => {
  const color = (r: number, g: number, b: number) => ({ red: r, green: g, blue: b, alpha: 1, colorSpace: 'extendedSRGB' })
  const arc = (extra: Record<string, unknown> = {}, bg: Record<string, unknown> = {}) => ({
    background: {
      single: {
        _0: {
          isVibrant: true,
          contentOverBackgroundAppearance: 'dark',
          ...bg,
          style: {
            color: {
              _0: {
                blendedGradient: {
                  _0: { baseColors: [color(1, 0, 0), color(0, 1, 0)], overlayColors: [], translucencyStyle: 'light', wheel: { complimentary: {} }, modifiers: { overlay: 'grain', intensityFactor: 0.9, noiseFactor: 0.25 }, ...extra }
                }
              }
            }
          }
        }
      }
    }
  })

  it('reads colours, harmony, intensity, texture and appearance from the shape of a real imported theme', () => {
    const t = themeFromArc(arc())!
    expect(t).toMatchObject({ harmony: 'complementary', intensity: 0.9, overlay: 'grain', noise: 0.25, translucency: 'light', vibrant: true, appearance: 'dark' })
    expect(t.baseColors[0]).toBe('#ff0000')
    expect(t.baseColors).toHaveLength(2)
  })

  it('maps a light appearance and a missing wheel', () => {
    expect(themeFromArc(arc({}, { contentOverBackgroundAppearance: 'light' }))!.appearance).toBe('light')
    expect(themeFromArc(arc({ wheel: undefined }))!.harmony).toBe('custom')
  })

  it('returns null for anything that is not a blended gradient, instead of guessing', () => {
    for (const bad of [null, {}, { background: { single: { _0: { style: { color: { _0: { solid: {} } } } } } } }, 'x', arc({ baseColors: [] })]) {
      expect(themeFromArc(bad)).toBeNull()
    }
  })
})

describe('parseCssColor', () => {
  it('reads the colour formats a page reports', () => {
    expect(parseCssColor('#abc')).toBe('#aabbcc')
    expect(parseCssColor(' #A1B2C3 ')).toBe('#a1b2c3')
    expect(parseCssColor('rgb(255, 0, 128)')).toBe('#ff0080')
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toBe('#0a141e')
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toBe('#0a141e')
  })

  it('refuses transparent and unsupported values so a page without a colour changes nothing', () => {
    for (const bad of ['rgba(0, 0, 0, 0)', 'rgb(0 0 0 / 0%)', 'transparent', 'red', 'hsl(0, 0%, 0%)', '', null, 42, undefined]) expect(parseCssColor(bad)).toBeNull()
  })
})

describe('editing helpers', () => {
  // The number of base colours is the number of dots: two here, the second one derived from the first.
  const base = cleanTheme({ baseColors: ['#ff3300', '#000000'], harmony: 'complementary' })

  it('switches harmony by re-deriving colours from the primary one', () => {
    const triad = withHarmony(base, 'triadic')
    expect(triad.baseColors).toHaveLength(3)
    expect(triad.baseColors[0]).toBe('#ff3300')
    expect(withHarmony(base, 'monochrome').baseColors).toHaveLength(2)
  })

  it('keeps the colours when switching to a custom harmony', () => {
    const colors = withHarmony(base, 'custom').baseColors
    expect(colors).toEqual(base.baseColors)
  })

  it('adds and removes colours within one to three, for derived and custom harmonies', () => {
    expect(withColorCount(base, 3).baseColors).toHaveLength(3)
    expect(withColorCount(base, 9).baseColors).toHaveLength(3)
    expect(withColorCount(base, 0).baseColors).toEqual(['#ff3300'])
    expect(withColorCount(base, 1).baseColors).toEqual(['#ff3300'])
    const custom = cleanTheme({ baseColors: ['#112233', '#445566'], harmony: 'custom' })
    const grown = withColorCount(custom, 3).baseColors
    expect(grown.slice(0, 2)).toEqual(['#112233', '#445566'])
    expect(grown).toHaveLength(3)
    expect(grown[2]).not.toBe(grown[1])
    expect(withColorCount(custom, 1).baseColors).toEqual(['#112233'])
    // A custom palette is bounded too: never empty, never more than three.
    expect(withColorCount(custom, 9).baseColors).toHaveLength(3)
    expect(withColorCount(custom, 0).baseColors).toEqual(['#112233'])
  })

  it('moves the primary dot and lets the others follow, but refuses to move a companion of a derived harmony', () => {
    const moved = withColorAt(base, 0, '#00FF88')!
    expect(moved.baseColors[0]).toBe('#00ff88')
    expect(moved.baseColors).toHaveLength(2)
    expect(moved.baseColors[1]).not.toBe(base.baseColors[1])
    expect(withColorAt(base, 1, '#00ff88')).toBeNull()
  })

  it('moves any dot freely with a custom harmony, and ignores bad input', () => {
    const custom = cleanTheme({ baseColors: ['#112233', '#445566'], harmony: 'custom' })
    expect(withColorAt(custom, 1, '#abcdef')!.baseColors).toEqual(['#112233', '#abcdef'])
    expect(withColorAt(custom, 2, '#abcdef')).toBeNull()
    expect(withColorAt(custom, 0, 'red')).toBeNull()
  })

  it('maps pad positions to colours and back: hue along x, light at the top and dark at the bottom', () => {
    expect(hexToHsl(colorAtPadPoint(0.5, 0.5, 0.8)).h).toBeCloseTo(180, 0)
    expect(hexToHsl(colorAtPadPoint(0.5, 0, 0.8)).l).toBeGreaterThan(hexToHsl(colorAtPadPoint(0.5, 1, 0.8)).l)
    // Out of the pad is clamped to its edge, and a grey (no saturation) still keeps a little colour.
    expect(colorAtPadPoint(9, -4, 0.8)).toBe(colorAtPadPoint(1, 0, 0.8))
    expect(hexToHsl(colorAtPadPoint(0.3, 0.5, 0)).s).toBeGreaterThan(0)
    const color = '#3366cc'
    const point = padPointOf(color)
    const hsl = hexToHsl(color)
    const back = hexToHsl(colorAtPadPoint(point.x, point.y, hsl.s))
    expect(back.h).toBeCloseTo(hsl.h, -0.5)
    expect(back.l).toBeCloseTo(hsl.l, 1)
  })

})

describe('toolbarTint', () => {
  it('takes the page colour and keeps text readable on it: dark text on a light page, light text on a dark one', () => {
    expect(toolbarTint('#ffffff')).toMatchObject({ '--toolbar-bg': '#ffffff', '--text': '#1c1c22' })
    expect(toolbarTint('#101018')).toMatchObject({ '--toolbar-bg': '#101018', '--text': '#f1f1f5' })
  })

  it('switches between the two where black starts to contrast more than white (a mid grey already carries black)', () => {
    expect(toolbarTint('#f0f0f0')['--text']).toBe('#1c1c22')
    expect(toolbarTint('#202020')['--text']).toBe('#f1f1f5')
    expect(toolbarTint('#808080')['--tb-icon']).toMatch(/^rgb\(0 0 0 \//)
    expect(toolbarTint('#6a6a6a')['--tb-icon']).toMatch(/^rgb\(255 255 255 \//)
  })

  it("keeps the opacities read off the pixels where they are readable: white 67 / 75 / 62.5 % on a dark bar, black 55 / 60 % on a light one", () => {
    expect(toolbarTint('#3f3f3f')).toMatchObject({ '--tb-icon': 'rgb(255 255 255 / 0.67)', '--tb-text': 'rgb(255 255 255 / 0.75)', '--tb-rest': 'rgb(255 255 255 / 0.625)', '--tb-icon-off': 'rgb(255 255 255 / 0.25)' })
    expect(toolbarTint('#ffffff')).toMatchObject({ '--tb-icon': 'rgb(0 0 0 / 0.55)', '--tb-text': 'rgb(0 0 0 / 0.6)', '--tb-icon-off': 'rgb(0 0 0 / 0.25)' })
  })

  it('raises an opacity just enough where the design is under the minimum: the rest of the address on a white bar was black at 50 % (3.98:1)', () => {
    expect(toolbarTint('#ffffff')['--tb-rest']).toBe('rgb(0 0 0 / 0.54)')
    expect(contrastRatio('rgb(0 0 0 / 0.5)', '#ffffff')).toBeLessThan(AA_TEXT)
    expect(contrastRatio('rgb(0 0 0 / 0.53)', '#ffffff')).toBeLessThan(AA_TEXT + 0.05)
  })

  /** What the bar draws with each ink, and what WCAG 2.2 AA asks of it: 3:1 for a glyph, 4.5:1 for text. */
  const INKS: ReadonlyArray<[name: string, min: number]> = [['--tb-icon', AA_CONTROL], ['--tb-text', AA_TEXT], ['--tb-rest', AA_TEXT], ['--text', AA_TEXT], ['--muted', AA_TEXT]]
  /** The inks of a bar under their minimum, as readable lines. */
  const unreadable = (color: string, tint: Record<string, string> = toolbarTint(color)): string[] =>
    INKS.filter(([name, min]) => contrastRatio(tint[name]!, color) < min).map(([name, min]) => `${color}: ${name} ${tint[name]} is ${contrastRatio(tint[name]!, color).toFixed(2)}:1, needs ${min}`)
  // Colours that sites declare, which the design left under 3:1: mid-tone blues, reds and greens, and a mid grey.
  const BRANDS = ['#1da1f2', '#ff0000', '#1877f2', '#ff4500', '#4285f4', '#34a853', '#1db954', '#25d366', '#5865f2', '#0a66c2', '#bbbbbb']

  it('keeps the glyphs at 3:1 and the host, the rest of the address and the text at 4.5:1 on any colour a page can declare', () => {
    const lines: string[] = BRANDS.flatMap((color) => unreadable(color))
    // A grid of the whole cube, every 15 levels of each channel, and every grey.
    const hex = (...channels: number[]): string => `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`
    for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) lines.push(...unreadable(hex(r, g, b)))
    for (let grey = 0; grey < 256; grey++) lines.push(...unreadable(hex(grey, grey, grey)))
    expect(lines.slice(0, 8)).toEqual([])
  })

  it('measures what it says: the opacities of the design alone, with white up to the middle of the luminance scale, fail on those colours', () => {
    const designed = (color: string): Record<string, string> => {
      const light = luminance(color) > 0.5
      return { '--tb-icon': light ? 'rgb(0 0 0 / 0.55)' : 'rgb(255 255 255 / 0.67)', '--tb-text': light ? 'rgb(0 0 0 / 0.6)' : 'rgb(255 255 255 / 0.75)', '--tb-rest': light ? 'rgb(0 0 0 / 0.5)' : 'rgb(255 255 255 / 0.625)', '--text': light ? '#1c1c22' : '#f1f1f5', '--muted': light ? 'rgb(28 28 34 / 0.62)' : 'rgb(241 241 245 / 0.6)' }
    }
    for (const color of BRANDS) expect(unreadable(color, designed(color)).length, color).toBeGreaterThan(0)
    expect(unreadable('#1da1f2', designed('#1da1f2'))[0]).toContain('--tb-icon rgb(255 255 255 / 0.67) is 2.02:1')
  })

  it('leaves the bar the colour of the page, and the line under it to the bars that toolbarIsLight calls light (the page is placed by that rule)', () => {
    for (const color of [...BRANDS, '#ffffff', '#c0c0c0', '#808080', '#3f3f3f']) {
      const tint = toolbarTint(color)
      expect(tint['--toolbar-bg']).toBe(color)
      expect(tint['--toolbar-line'] !== 'transparent', color).toBe(toolbarIsLight(color, 'dark'))
    }
  })

  it("drops the window's texture: a page that declares its own colour is plain (the stripes of a private window are for a bar with no colour)", () => {
    expect(toolbarTint('#ffffff')['--toolbar-texture']).toBe('none')
    expect(toolbarTint('#3f3f3f')['--toolbar-texture']).toBe('none')
  })

  it('draws the 1 px line (black at 5 %: #f2f2f2 on white) under a light bar only, and hovers a light bar with the same 5 %', () => {
    expect(toolbarTint('#ffffff')).toMatchObject({ '--toolbar-line': 'rgb(0 0 0 / 0.05)', '--tb-hover': 'rgb(0 0 0 / 0.05)' })
    expect(toolbarTint('#3f3f3f')['--toolbar-line']).toBe('transparent')
  })
})

describe('the two appearances of the settings', () => {
  it('turn Lucium by themeSourceOf: the system for Automatique and for anything that is not light or dark', () => {
    expect(themeSourceOf('auto')).toBe('system')
    expect(themeSourceOf('light')).toBe('light')
    expect(themeSourceOf('dark')).toBe('dark')
    for (const junk of [undefined, null, '', 'Dark', 'system', 3]) expect(themeSourceOf(junk), String(junk)).toBe('system')
  })

  it('ask the pages by pageSchemeOf: nothing for Automatique and for anything that is not light or dark', () => {
    expect(pageSchemeOf('auto')).toBeNull()
    expect(pageSchemeOf('light')).toBe('light')
    expect(pageSchemeOf('dark')).toBe('dark')
    for (const junk of [undefined, null, '', 'Dark', 'system', 3]) expect(pageSchemeOf(junk), String(junk)).toBeNull()
  })
})

// A person gives a space any colour: one of the ten named ones, a point of the pad, a code, an import. The text written on that colour (the
// sidebar, the empty page, the mini window) must read on all of them, not only on the themes the application makes itself.
describe('the inks of a space, on the colours a person can choose', () => {
  const APPEARANCES: readonly ResolvedAppearance[] = ['light', 'dark']
  const PAD = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].flatMap((hue) => [0, 0.5, 1].flatMap((y) => [1, 0.05].map((saturation) => colorAtPadPoint(hue / 360, y, saturation))))
  /** Every theme measured: the named colours as the sheet « Nouvel espace » makes them, each colour alone, the pad, black, white, the hues and the ready themes. */
  const THEMES: Array<{ id: string; theme: SpaceTheme }> = [
    ...NAMED_COLORS.map((color) => ({ id: color.id, theme: presetTheme(color.hex) })),
    ...[...NAMED_COLORS.map((color) => color.hex), ...PAD, '#000000', '#ffffff', '#808080'].map((hex) => ({ id: `${hex} alone`, theme: cleanTheme({ ...defaultTheme(), baseColors: [hex], harmony: 'custom' }) })),
    ...Array.from({ length: 72 }, (_, i) => ({ id: `hue ${i * 5}`, theme: themeFromHue(i * 5) })),
    ...READY_THEMES.map((ready) => ({ id: ready.name, theme: ready.theme }))
  ].flatMap(({ id, theme }) => [
    { id, theme },
    { id: `${id}, not vibrant, half intensity`, theme: { ...theme, vibrant: false, intensity: 0.5 } }
  ])

  /** What the tokens give at this appearance: the inks of the space and a tile. */
  const tokens = (appearance: ResolvedAppearance) => {
    const values = tokenValues(tokensCss, { scheme: appearance, hue: 250 })
    return { text: colorOf(values, 'var(--text-on-space)', appearance), secondary: colorOf(values, 'var(--text-on-space-2)', appearance), tile: colorOf(values, 'var(--tile)', appearance) }
  }

  /**
   * The texts under their minimum on the grounds of a theme, with the inks given: each end of its gradient, bare and under a tile. The secondary
   * text is the one written on the bare background; a tile has its own (`onTile`).
   */
  function unreadable(inksOf: (theme: SpaceTheme, appearance: ResolvedAppearance) => { text: string | Rgba; secondary: string | Rgba; onTile: string | Rgba; glyph?: string | Rgba }): string[] {
    const lines: string[] = []
    for (const { id, theme } of THEMES) {
      for (const appearance of APPEARANCES) {
        const inks = inksOf(theme, appearance)
        const { tile } = tokens(appearance)
        for (const color of backgroundColors(theme, appearance)) {
          const bare = parseColor(color)!
          for (const [ground, under] of [['bare', bare], ['under a tile', compositeOver(tile, bare)]] as const) {
            for (const [name, ink, needed] of [['text', inks.text, AA_TEXT], ['secondary text', ground === 'bare' ? inks.secondary : inks.onTile, AA_TEXT], ['glyph', inks.glyph, AA_CONTROL]] as const) {
              if (ink === undefined) continue
              const ratio = contrastRatio(ink, under)
              if (ratio < needed) lines.push(`${name} on ${color} ${ground} (${id}, ${appearance}): ${ratio.toFixed(2)}:1, needs ${needed}`)
            }
          }
        }
      }
    }
    return lines
  }

  it('starts from the inks of tokens.css, and washes the background at least as much as a tile does', () => {
    for (const appearance of APPEARANCES) {
      const { text, secondary, tile } = tokens(appearance)
      expect(parseColor(SPACE_INK[appearance].soft), appearance).toEqual(text)
      expect({ ...parseColor(SPACE_INK[appearance].soft)!, a: SPACE_INK[appearance].secondary }, appearance).toEqual(secondary)
      expect({ ...parseColor(SPACE_WASH[appearance].color)!, a: tile.a }, appearance).toEqual(tile)
      expect(SPACE_WASH[appearance].amount, appearance).toBeGreaterThanOrEqual(tile.a)
    }
  })

  it('read at 4.5:1 (3:1 for a glyph) on both ends of the gradient, bare and under a tile, on every one of them', () => {
    expect(THEMES.length).toBeGreaterThan(200)
    expect(unreadable(spaceInks).slice(0, 8)).toEqual([])
  })

  // A row under the pointer is washed more than a tile at rest, and the title of a sleeping tab is written there in the secondary text.
  const hoverTokens = (appearance: ResolvedAppearance) => {
    const values = tokenValues(tokensCss, { scheme: appearance, hue: 250 })
    return { wash: colorOf(values, 'var(--tile-hover)', appearance), secondary: colorOf(values, 'var(--text-on-tile-hover-2)', appearance) }
  }
  /** The themes where an ink is under 4.5:1 on an end of the gradient once the hover wash is laid. */
  function unreadableUnderThePointer(inkOf: (theme: SpaceTheme, appearance: ResolvedAppearance) => string | Rgba): string[] {
    const lines: string[] = []
    for (const { id, theme } of THEMES) {
      for (const appearance of APPEARANCES) {
        for (const color of backgroundColors(theme, appearance)) {
          const ratio = contrastRatio(inkOf(theme, appearance), compositeOver(hoverTokens(appearance).wash, parseColor(color)!))
          if (ratio < AA_TEXT) lines.push(`secondary text on ${color} under the pointer (${id}, ${appearance}): ${ratio.toFixed(2)}:1`)
        }
      }
    }
    return lines
  }

  it('start, under the pointer, from the wash and the ink tokens.css gives a row on hover', () => {
    for (const appearance of APPEARANCES) {
      const { wash, secondary } = hoverTokens(appearance)
      expect({ ...parseColor(SPACE_HOVER[appearance].color)!, a: SPACE_HOVER[appearance].amount }, appearance).toEqual(wash)
      expect({ ...parseColor(SPACE_INK[appearance].soft)!, a: SPACE_HOVER[appearance].secondary }, appearance).toEqual(secondary)
    }
  })

  it('read at 4.5:1 under the pointer on every one of them: the secondary text of a hovered row has an ink of its own', () => {
    expect(unreadableUnderThePointer((theme, appearance) => spaceInks(theme, appearance).onHover).slice(0, 8)).toEqual([])
    // The ink of the bare background would not do: it is what a sleeping title had under the pointer before.
    const before = unreadableUnderThePointer((theme, appearance) => spaceInks(theme, appearance).secondary).join('\n')
    expect(before).toMatch(/\(sand, dark\)/)
    expect(before).toMatch(/\(night, light\)/)
    // Where the soft ink cannot reach it under the wash, this text alone takes the plain one.
    expect(spaceInks(presetTheme(NAMED_COLORS.find((color) => color.id === 'sand')!.hex), 'dark')).toMatchObject({ text: '#f1f2f6', onHover: expect.stringMatching(/^rgb\(255 255 255 \//) })
    // And on the grey the wash brings to the middle, where white does not read either, the plain ink of the other appearance.
    expect(spaceInks(cleanTheme({ ...defaultTheme(), baseColors: ['#ffffff'], harmony: 'custom' }), 'dark').onHover).toMatch(/^rgb\(0 0 0 \//)
    for (const appearance of APPEARANCES) expect(themeVars(defaultTheme(), appearance)['--text-on-tile-hover-2']).toBe(spaceInks(defaultTheme(), appearance).onHover)
  })

  it('read at 4.5:1 under the pointer on every one of them for the text of a hovered row as well (the title of an awake tab)', () => {
    expect(unreadableUnderThePointer((theme, appearance) => spaceInks(theme, appearance).onHoverText).slice(0, 8)).toEqual([])
    // The text of the rest of the sidebar falls short there on « Sable » in the dark appearance (4.46:1), and on other light colours chosen in dark.
    expect(unreadableUnderThePointer((theme, appearance) => spaceInks(theme, appearance).text).join('\n')).toMatch(/\(sand, dark\)/)
    // Only the hovered row changes, and by one step: the soft ink becomes the plain one, the text at rest keeps the soft one.
    expect(spaceInks(presetTheme(NAMED_COLORS.find((color) => color.id === 'sand')!.hex), 'dark')).toMatchObject({ text: '#f1f2f6', onHoverText: '#ffffff' })
    // On the grey the wash brings to the middle, where white does not read, the plain ink of the other appearance.
    expect(spaceInks(cleanTheme({ ...defaultTheme(), baseColors: ['#ffffff'], harmony: 'custom' }), 'dark').onHoverText).toBe('#000000')
    // A theme where the text reads keeps it, to the digit; the stylesheet's own value is the text of the space.
    for (const appearance of APPEARANCES) {
      expect(spaceInks(defaultTheme(), appearance).onHoverText).toBe(spaceInks(defaultTheme(), appearance).text)
      expect(themeVars(defaultTheme(), appearance)['--text-on-tile-hover']).toBe(spaceInks(defaultTheme(), appearance).onHoverText)
      const values = tokenValues(tokensCss, { scheme: appearance, hue: 250 })
      expect(colorOf(values, 'var(--text-on-tile-hover)', appearance), appearance).toEqual(colorOf(values, 'var(--text-on-space)', appearance))
    }
  })

  it('measure what they say: the secondary text of the tokens alone is under 4.5:1 on « Sable » and « Jaune » in the dark appearance, and on « Nuit » in the light one', () => {
    const lines = unreadable((_theme, appearance) => ({ text: tokens(appearance).text, secondary: tokens(appearance).secondary, onTile: tokens(appearance).secondary })).join('\n')
    expect(lines).toMatch(/secondary text on #[0-9a-f]{6} bare \(sand, dark\)/)
    expect(lines).toMatch(/secondary text on #[0-9a-f]{6} bare \(yellow, dark\)/)
    expect(lines).toMatch(/secondary text on #[0-9a-f]{6} under a tile \(night, light\)/)
    expect(lines).toMatch(/secondary text on #[0-9a-f]{6} under a tile \(hue 250, dark\)/)
    // And the soft ink itself does not reach it on the lightest background of the dark appearance (white, shaded).
    expect(lines).toMatch(/\ntext on #[0-9a-f]{6} under a tile \(#ffffff alone, dark\)/)
  })

  it('leave a theme that already reads as the tokens write it, to the digit', () => {
    // The default theme of a space, and « Nuit » in the dark appearance.
    expect(spaceInks(defaultTheme(), 'dark')).toMatchObject({ text: '#f1f2f6', secondary: 'rgb(241 242 246 / 0.7)' })
    expect(spaceInks(defaultTheme(), 'light')).toMatchObject({ text: '#1a1d2b', secondary: 'rgb(26 29 43 / 0.74)' })
    expect(spaceInks(presetTheme('#2b2f4a'), 'dark')).toMatchObject({ text: '#f1f2f6', secondary: 'rgb(241 242 246 / 0.7)' })
    // Most of the hues keep them in the light appearance, where the tiles are faint.
    const kept = Array.from({ length: 72 }, (_, i) => spaceInks(themeFromHue(i * 5), 'light').secondary).filter((ink) => ink === 'rgb(26 29 43 / 0.74)')
    expect(kept.length).toBeGreaterThan(36)
  })

  it('raise the opacity only as far as needed (more under a tile than on the bare background), and take the plain ink only where the soft one cannot read', () => {
    const sand = spaceInks(presetTheme(NAMED_COLORS.find((color) => color.id === 'sand')!.hex), 'dark')
    expect(sand.text).toBe('#f1f2f6')
    const opacity = (ink: string): number => Number(/\/ ([\d.]+)\)$/.exec(ink)![1])
    expect(opacity(sand.secondary)).toBeGreaterThan(0.7)
    expect(opacity(sand.onTile)).toBeGreaterThan(opacity(sand.secondary))
    expect(opacity(sand.onTile)).toBeLessThan(1)
    // One hundredth less would be under the minimum: the raise stops at the first opacity that reads.
    const [bare] = backgroundColors(presetTheme(NAMED_COLORS.find((color) => color.id === 'sand')!.hex), 'dark')
    expect(contrastRatio(sand.secondary.replace(/[\d.]+\)$/, `${opacity(sand.secondary) - 0.02})`), bare!)).toBeLessThan(AA_TEXT + 0.05)
    expect(spaceInks(cleanTheme({ ...defaultTheme(), baseColors: ['#ffffff'], harmony: 'custom' }), 'dark').text).toBe('#ffffff')
  })

  it('are what the window is given: the roles of the tokens for the text on the space, and the same secondary ink for --muted (the empty page, the layout bar of a split view)', () => {
    const theme = presetTheme(NAMED_COLORS.find((color) => color.id === 'yellow')!.hex)
    for (const appearance of APPEARANCES) {
      const inks = spaceInks(theme, appearance)
      expect(themeVars(theme, appearance)).toMatchObject({ '--text-on-space': inks.text, '--text-on-space-2': inks.secondary, '--text-on-tile-2': inks.onTile, '--glyph-on-space': inks.glyph, '--muted': inks.secondary })
    }
  })
})
