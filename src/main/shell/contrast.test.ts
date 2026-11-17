// Contrast of the interface's text, calculated on the real colours: the themes of the sidebar (both appearances), and the Settings window.
// WCAG 2.2 AA asks 4.5 : 1 for normal text (1.4.3). The base greys do not reach it on every theme (docs/accessibilite.md); the
// "Increase contrast" variant of the stylesheets does, and these tests read the variant's own values so that they cannot drift apart.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { composite, contrastRatio, parseColor, requiredContrast, type Rgba } from '@shared/a11y-audit'
import { colorOf, pairRatio, tokenValues } from '@shared/design-tokens'
import tokensCss from '../../renderer/tokens.css?raw'
import { backgroundColors, resolveAppearance, themeFromHue, themeVars, type ResolvedAppearance, type SpaceTheme } from '@shared/theme'
import { READY_THEMES } from '@shared/theme-presets'

const css = (file: string) => readFileSync(new URL(`../../renderer/${file}`, import.meta.url), 'utf8')

/** The declarations of the `@media (prefers-contrast: more)` block of a stylesheet, by selector. */
function highContrastRules(source: string): Record<string, Record<string, string>> {
  const start = source.indexOf('@media (prefers-contrast: more)')
  if (start === -1) return {}
  let depth = 0
  let end = start
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = source.slice(source.indexOf('{', start) + 1, end)
  const rules: Record<string, Record<string, string>> = {}
  for (const [, selector, declarations] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules[selector!.trim()] = Object.fromEntries([...declarations!.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)(?:\s*!important)?\s*(?:;|$)/g)].map(([, name, value]) => [name!, value!.trim()]))
  }
  return rules
}

const THEMES: Array<{ id: string; theme: SpaceTheme }> = [
  ...Array.from({ length: 72 }, (_, i) => ({ id: `teinte ${i * 5}`, theme: themeFromHue(i * 5) })),
  ...READY_THEMES.map((ready) => ({ id: ready.name, theme: ready.theme }))
]

/** Every background a theme paints, in each appearance it can have (a ready theme has its own). */
function backgrounds(): Array<{ id: string; appearance: ResolvedAppearance; background: Rgba }> {
  const out: Array<{ id: string; appearance: ResolvedAppearance; background: Rgba }> = []
  for (const { id, theme } of THEMES) {
    for (const systemDark of [true, false]) {
      const appearance = resolveAppearance(theme, systemDark)
      if (out.some((o) => o.id === id && o.appearance === appearance)) continue
      for (const color of backgroundColors(theme, appearance)) out.push({ id, appearance, background: parseColor(color)! })
    }
  }
  return out
}

describe('the sidebar text, on every theme and both appearances', () => {
  it('has a main text above 7 : 1 (AAA)', () => {
    for (const { id, theme } of THEMES) {
      for (const systemDark of [true, false]) {
        const appearance = resolveAppearance(theme, systemDark)
        const text = parseColor(themeVars(theme, appearance)['--text'])!
        for (const color of backgroundColors(theme, appearance)) expect(contrastRatio(text, parseColor(color)!), `${id} ${appearance}`).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('reaches 4.5 : 1 with its greys of the "Increase contrast" variant', () => {
    // The sidebar is on the tokens: the variant makes every grey the text colour of the space itself, and the tokens give that colour per scheme.
    const more = highContrastRules(css('sidebar.css'))['.shell'] ?? {}
    for (const name of ['--sb-dim', '--sb-faint', '--sb-glyph', '--muted']) expect(more[name], name).toBe('var(--text-on-space)')
    for (const { id, appearance, background } of backgrounds()) {
      const text = colorOf(tokenValues(tokensCss, { scheme: appearance, hue: 250, contrast: true }), 'var(--text-on-space)', appearance)
      expect(contrastRatio(text, background), `${id} ${appearance}`).toBeGreaterThanOrEqual(requiredContrast(13, 400))
    }
  })

  it('reads its secondary text (the greys of the labels, the glyphs and the counts) at 4.5 : 1 or more on every theme without the variant too', () => {
    for (const { id, appearance, background } of backgrounds()) {
      const grey = colorOf(tokenValues(tokensCss, { scheme: appearance, hue: 250 }), 'var(--text-on-space-2)', appearance)
      expect(contrastRatio(grey, background), `${id} ${appearance}`).toBeGreaterThanOrEqual(requiredContrast(13, 400))
    }
  })

  it('shows, on the lightest and darkest themes, that the base greys are under 4.5 : 1 (the reason for the variant)', () => {
    const dim = { dark: parseColor('rgb(255 255 255 / 0.52)')!, light: parseColor('rgb(28 28 34 / 0.55)')! }
    const worst = Math.min(...backgrounds().map(({ appearance, background }) => contrastRatio(dim[appearance], background)))
    expect(worst).toBeLessThan(4.5)
    expect(worst).toBeGreaterThan(2.9)
  })
})

describe('the Settings window text', () => {
  /** What the Settings window paints text on: its window, its cards and its buttons, for the tokens of a context. */
  const grounds = ['var(--surface-2)', 'var(--surface)', 'var(--surface-3)']

  // That the sheet forces no dark scheme is checked for every sheet in renderer/stylesheets.test.ts.
  it('is made of tokens: its --s-* names come to the colour of the token they stand for, in both schemes and with "Increase contrast" on or off', () => {
    const sheet = `${tokensCss}\n${css('settings.css')}`
    for (const scheme of ['light', 'dark'] as const) {
      for (const contrast of [false, true, 'forced' as const]) {
        const values = tokenValues(sheet, { scheme, hue: 250, contrast })
        const label = `${scheme}${contrast ? ' +contrast' : ''}`
        expect(colorOf(values, 'var(--s-muted)', scheme), `${label} --s-muted`).toEqual(colorOf(values, 'var(--text-3)', scheme))
        expect(colorOf(values, 'var(--s-text)', scheme), `${label} --s-text`).toEqual(colorOf(values, 'var(--text)', scheme))
      }
    }
  })

  it('reaches 4.5 : 1 for its text and its secondary text, light and dark, with "Increase contrast" on or off (AA)', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const contrast of [false, true, 'forced' as const]) {
        const values = tokenValues(tokensCss, { scheme, hue: 250, contrast })
        for (const name of ['--text', '--text-2', '--text-3']) {
          for (const ground of grounds) {
            const pair = { fg: `var(${name})`, bg: ground, min: 4.5, use: 'Settings window' }
            // The help text is for a plain ground (a card or the window), not for a hovered button.
            if (name === '--text-3' && ground === 'var(--surface-3)') continue
            expect(pairRatio(values, pair, scheme), `${scheme}${contrast ? ' +contrast' : ''} ${name} on ${ground}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })

  it('makes its secondary text stronger when the person asks for more contrast', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const normal = tokenValues(tokensCss, { scheme, hue: 250 })
      const more = tokenValues(tokensCss, { scheme, hue: 250, contrast: true })
      const ratio = (values: ReadonlyMap<string, string>): number => pairRatio(values, { fg: 'var(--text-3)', bg: 'var(--surface)', min: 4.5, use: '' }, scheme)
      expect(ratio(more), scheme).toBeGreaterThan(ratio(normal))
      expect(ratio(more), scheme).toBeGreaterThanOrEqual(7)
    }
  })
})

describe('the colour maths', () => {
  it('knows the extremes and a known pair', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21, 5)
    expect(contrastRatio(parseColor('#fff')!, parseColor('#fff')!)).toBeCloseTo(1, 5)
    // WCAG's own example: #767676 on white is the lightest grey that passes AA.
    expect(contrastRatio(parseColor('#767676')!, parseColor('#fff')!)).toBeGreaterThan(4.5)
    expect(contrastRatio(parseColor('#777')!, parseColor('#fff')!)).toBeLessThan(4.5)
  })

  it('lays a translucent text over its background before comparing', () => {
    const half = parseColor('rgb(255 255 255 / 0.5)')!
    const black = parseColor('#000')!
    expect(composite(half, black).r).toBeCloseTo(127.5, 1)
    expect(contrastRatio(half, black)).toBeCloseTo(contrastRatio(parseColor('#808080')!, black), 1)
  })

  it('reads the spellings Chromium computes, and refuses the rest', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseColor('rgba(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('#aabbcc80')?.a).toBeCloseTo(0.5, 2)
    for (const bad of ['red', 'rgb(1 2)', '', null, 12, 'hsl(0 0% 0%)']) expect(parseColor(bad)).toBeNull()
  })

  it('asks 3 : 1 of large text and 4.5 : 1 of the rest', () => {
    expect([requiredContrast(24, 400), requiredContrast(18.66, 700), requiredContrast(18.66, 400), requiredContrast(13, 700)]).toEqual([3, 3, 4.5, 4.5])
  })
})
