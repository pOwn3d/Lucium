import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { backgroundColors, cleanTheme, defaultTheme, hexToHsl, hexToRgb, isHex, luminance, rgbToHex, themeHue, type SpaceTheme } from './theme'
import { encodeThemeCode, parseThemeCode } from './theme-code'
import { READY_THEMES, readyThemeOf, readyThemePreview, type ReadyTheme } from './theme-presets'

const rendered = (t: ReadyTheme) => backgroundColors(t.theme, t.theme.appearance as 'light' | 'dark')[0]!
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

describe('ready themes', () => {
  it('offers at least the themes that were asked for, under the names the row shows', () => {
    const names = READY_THEMES.map((t) => t.name)
    for (const wanted of ['Dracula', 'Nord', 'Solarized sombre', 'Solarized clair', 'Gruvbox sombre', 'Tokyo Night', 'Catppuccin Mocha', 'Catppuccin Latte', 'One Dark', 'Monokai', 'Rosé Pine', 'GitHub sombre']) {
      expect(names, wanted).toContain(wanted)
    }
  })

  it('names the variant of a palette in the language of the interface, and keeps the names of the palettes and the ids as they are', () => {
    const ids = READY_THEMES.map((t) => t.id)
    try {
      setLanguage('en')
      const names = READY_THEMES.map((t) => t.name)
      for (const wanted of ['Solarized Dark', 'Solarized Light', 'Gruvbox Dark', 'Gruvbox Light', 'GitHub Dark', 'GitHub Light', 'Dracula', 'Dracula Alucard', 'Tokyo Night Storm', 'Rosé Pine']) {
        expect(names, wanted).toContain(wanted)
      }
      // No word of the French variant left in an English name.
      expect(names.filter((name) => /\b(?:sombre|clair)\b/.test(name))).toEqual([])
      expect(new Set(names).size).toBe(READY_THEMES.length)
      setLanguage('fr')
      expect(READY_THEMES.find((t) => t.id === 'github-light')!.name).toBe('GitHub clair')
    } finally {
      setLanguage('fr')
    }
    // A space refers to a ready theme by its id (`ready:<id>`): the language never changes it.
    expect(READY_THEMES.map((t) => t.id)).toEqual(ids)
    expect(ids).toEqual(expect.arrayContaining(['solarized-dark', 'solarized-light', 'gruvbox-dark', 'gruvbox-light', 'github-dark', 'github-light']))
  })

  it('has one id and one name per theme, and one look per theme', () => {
    expect(new Set(READY_THEMES.map((t) => t.id)).size).toBe(READY_THEMES.length)
    expect(new Set(READY_THEMES.map((t) => t.name)).size).toBe(READY_THEMES.length)
    expect(new Set(READY_THEMES.map((t) => encodeThemeCode(t.theme))).size).toBe(READY_THEMES.length)
    for (const t of READY_THEMES) expect(t.id).toMatch(/^[a-z0-9-]+$/)
  })

  it('is made of themes the model keeps as they are: one explicit appearance, a base colour, no texture', () => {
    for (const t of READY_THEMES) {
      expect(cleanTheme(t.theme), t.id).toEqual(t.theme)
      expect(t.theme.baseColors, t.id).toHaveLength(1)
      expect(['light', 'dark']).toContain(t.theme.appearance)
      expect(t.theme.intensity).toBe(1)
      expect(t.theme.noise).toBe(0)
      expect(t.theme.vibrant).toBe(false)
      expect(isHex(t.background) && isHex(t.accent) && isHex(t.theme.baseColors[0]), t.id).toBe(true)
    }
  })

  it('renders every theme as exactly the background of its palette (the whole point of a ready theme)', () => {
    for (const t of READY_THEMES) expect(rendered(t), `${t.name}: base ${t.theme.baseColors[0]}`).toBe(t.background)
  })

  it('renders the same background whatever the system appearance is, since the appearance is explicit', () => {
    for (const t of READY_THEMES) {
      const other = t.theme.appearance === 'dark' ? 'light' : 'dark'
      expect(backgroundColors(t.theme, t.theme.appearance as 'light' | 'dark')[0]).toBe(t.background)
      expect(backgroundColors(t.theme, other)[0], `${t.id} would not follow its appearance`).not.toBe(t.background)
    }
  })

  it('has a light appearance for a light palette and a dark one for a dark palette', () => {
    for (const t of READY_THEMES) expect(luminance(t.background) > 0.5, t.name).toBe(t.theme.appearance === 'light')
  })

  it('has both sorts: the text of the sidebar must stay readable on each', () => {
    expect(READY_THEMES.filter((t) => t.theme.appearance === 'light').length).toBeGreaterThanOrEqual(4)
    expect(READY_THEMES.filter((t) => t.theme.appearance === 'dark').length).toBeGreaterThanOrEqual(8)
  })

  it('takes, among the base colours that render the background, the one whose hue is the closest to the accent', () => {
    // The hue tints the sidebar's text and the buttons: a grey palette with a base of hue 0 would get pink text.
    const around = (v: number) => [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((d) => Math.min(255, Math.max(0, v + d)))
    for (const t of READY_THEMES) {
      const base = hexToRgb(t.theme.baseColors[0]!)
      const accentHue = hexToHsl(t.accent).h
      let best = 360
      for (const r of around(base.r)) for (const g of around(base.g)) for (const b of around(base.b)) {
        const candidate: SpaceTheme = { ...t.theme, baseColors: [rgbToHex({ r, g, b })] }
        if (backgroundColors(candidate, candidate.appearance as 'light' | 'dark')[0] === t.background) best = Math.min(best, hueGap(hexToHsl(rgbToHex({ r, g, b })).h, accentHue))
      }
      expect(hueGap(themeHue(t.theme), accentHue), t.name).toBeLessThanOrEqual(best + 1)
    }
  })

  it('gives a grey palette a hue near its accent, not the default hue of a grey', () => {
    const gruvbox = READY_THEMES.find((t) => t.id === 'gruvbox-dark')!
    expect(hueGap(themeHue(gruvbox.theme), hexToHsl(gruvbox.accent).h)).toBeLessThanOrEqual(15)
    expect(themeHue(gruvbox.theme)).not.toBe(0)
  })

  it('goes through the code of a theme and back unchanged', () => {
    for (const t of READY_THEMES) {
      const parsed = parseThemeCode(encodeThemeCode(t.theme))
      expect(parsed.ok && parsed.kind === 'theme' && parsed.theme, t.id).toEqual(t.theme)
    }
  })

  it('knows which ready theme a theme is, and none for any other', () => {
    for (const t of READY_THEMES) expect(readyThemeOf(t.theme)?.id).toBe(t.id)
    const dracula = READY_THEMES[0]!
    expect(readyThemeOf(defaultTheme())).toBeNull()
    expect(readyThemeOf({ ...dracula.theme, intensity: 0.9 })).toBeNull()
    expect(readyThemeOf({ ...dracula.theme, appearance: 'light' })).toBeNull()
    expect(readyThemeOf({ ...dracula.theme, baseColors: ['#6a6e90'] })).toBeNull()
    // The rounding of the code is the rounding of the match: a slider that sits a hair off 100 % is still that theme.
    expect(readyThemeOf({ ...dracula.theme, intensity: 0.996 })?.id).toBe(dracula.id)
  })

  it('draws a preview from the background and the accent of the palette only', () => {
    for (const t of READY_THEMES) expect(readyThemePreview(t), t.id).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6} 0 58%, #[0-9a-f]{6} 58% 100%\)$/)
    expect(readyThemePreview(READY_THEMES[0]!)).toContain(READY_THEMES[0]!.background)
  })
})
