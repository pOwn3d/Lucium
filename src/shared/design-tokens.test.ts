// The design tokens (src/renderer/tokens.css), measured: every pair of tokens that sits text on a surface reaches 4.5:1, every control or icon 3:1, in both
// schemes, at every hue of a space, with "Increase contrast" on, and with "Reduce transparency" on. The test reads the stylesheet itself:
// a token changed there and no longer readable fails here, naming the pair, the scheme and the hue.

import { describe, expect, it } from 'vitest'
import tokensCss from '../renderer/tokens.css?raw'
import { AA_CONTROL, AA_TEXT } from './contrast'
import { TOKEN_PAIRS, colorOf, pairRatio, tokenValues, type Scheme, type TokenContext } from './design-tokens'

const css = tokensCss

const SCHEMES: readonly Scheme[] = ['light', 'dark']
/** Every half degree: a hue the colour wheel can give is not always a whole number. */
const HUES = Array.from({ length: 720 }, (_, i) => i / 2)

/** The pairs under their minimum for a context, as readable lines. */
function failures(context: TokenContext): string[] {
  const values = tokenValues(css, context)
  const lines: string[] = []
  for (const pair of TOKEN_PAIRS) {
    const ratio = pairRatio(values, pair, context.scheme)
    if (ratio < pair.min) lines.push(`${context.scheme} hue ${context.hue}${context.contrast ? ` +contrast ${context.contrast}` : ''}${context.transparency ? ` +transparency ${context.transparency}` : ''}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1, needs ${pair.min} (${pair.use})`)
  }
  return lines
}

describe('the design tokens', () => {
  it('reach 4.5:1 for text and 3:1 for controls in both schemes at every hue', () => {
    const lines = SCHEMES.flatMap((scheme) => HUES.flatMap((hue) => failures({ scheme, hue })))
    // A hundred identical failures would hide the first; the first few say what to fix.
    expect(lines.slice(0, 8)).toEqual([])
    // 1 440 contexts, every token worked out in each: close to a second of processor, which a machine with every core taken stretches past the 5 s default.
  }, 30_000)

  it('stay readable with "Increase contrast" on and with "Reduce transparency" on', () => {
    const lines = SCHEMES.flatMap((scheme) =>
      [0, 39, 60, 140, 190, 222, 250, 275, 330].flatMap((hue) => [true, 'forced' as const].flatMap((on) => [...failures({ scheme, hue, contrast: on }), ...failures({ scheme, hue, transparency: on })]))
    )
    expect(lines.slice(0, 8)).toEqual([])
  })

  it.each([true, 'forced' as const])('make "Increase contrast" help, asked by the system or forced by the setting (%s): the secondary text becomes the main text, the help text and the lines get stronger', (on) => {
    for (const scheme of SCHEMES) {
      const normal = tokenValues(css, { scheme, hue: 222 })
      const more = tokenValues(css, { scheme, hue: 222, contrast: on })
      expect(more.get('--text-2'), scheme).toBe(more.get('--text'))
      expect(more.get('--text-2')).not.toBe(normal.get('--text-2'))
      const ratio = (values: ReadonlyMap<string, string>): number => pairRatio(values, { fg: 'var(--text-3)', bg: 'var(--surface)', min: AA_TEXT, use: '' }, scheme)
      expect(ratio(more)).toBeGreaterThan(ratio(normal))
      expect(more.get('--focus-width')).toBe('3px')
      expect(more.get('--line-strong')).not.toBe(normal.get('--line-strong'))
    }
  })

  it.each([true, 'forced' as const])('make "Reduce transparency" opaque, asked by the system or forced by the setting (%s): the floating surface is the plain surface', (on) => {
    for (const scheme of SCHEMES) {
      const values = tokenValues(css, { scheme, hue: 222, transparency: on })
      expect(values.get('--overlay')).toBe(values.get('--surface'))
      expect(colorOf(values, 'var(--overlay)', scheme).a).toBe(1)
      expect(colorOf(tokenValues(css, { scheme, hue: 222 }), 'var(--overlay)', scheme).a).toBeLessThan(1)
    }
  })

  it('give the two schemes different surfaces and the same rhythm', () => {
    const light = tokenValues(css, { scheme: 'light', hue: 222 })
    const dark = tokenValues(css, { scheme: 'dark', hue: 222 })
    expect(light.get('--surface')).toBe('#ffffff')
    expect(dark.get('--surface')).toBe('#1e2027')
    for (const name of ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--r-s', '--r-m', '--r-l', '--r-xl', '--target', '--t-xs', '--t-2xl']) expect(light.get(name), name).toBe(dark.get(name))
  })

  it('hold the scales of the design: spacings 4 8 12 16 24, radii 8 10 14 18, text 11 to 22, targets of 28 px', () => {
    const values = tokenValues(css, { scheme: 'light', hue: 222 })
    const of = (...names: string[]): string[] => names.map((name) => values.get(name) ?? `missing ${name}`)
    expect(of('--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5')).toEqual(['4px', '8px', '12px', '16px', '24px'])
    expect(of('--r-s', '--r-m', '--r-l', '--r-xl')).toEqual(['8px', '10px', '14px', '18px'])
    expect(of('--t-xs', '--t-s', '--t-m', '--t-l', '--t-xl', '--t-2xl')).toEqual(['11px', '12px', '13px', '15px', '17px', '22px'])
    expect(values.get('--target')).toBe('28px')
    expect(values.get('--r-inner')).toBe('6px')
    expect(of('--w-regular', '--w-semibold')).toEqual(['400', '600'])
  })

  it('derive the accent and the background of a space from its hue', () => {
    const blue = tokenValues(css, { scheme: 'light', hue: 222 })
    const green = tokenValues(css, { scheme: 'light', hue: 140 })
    for (const name of ['--accent', '--accent-strong', '--accent-text', '--accent-soft', '--space-a', '--space-b', '--surface-2']) expect(blue.get(name), name).not.toBe(green.get(name))
    expect(blue.get('--surface')).toBe(green.get('--surface'))
    expect(blue.get('--accent')).toMatch(/^hsl\(222 /)
  })

  it('dim the accent where a light hue would not carry white text, and only there', () => {
    const lightness = (hue: number): number => parseFloat(tokenValues(css, { scheme: 'light', hue }).get('--accent-l')!)
    expect(lightness(250)).toBe(44)
    expect(lightness(0)).toBe(44)
    expect(lightness(60)).toBeLessThan(30)
    expect(lightness(140)).toBeLessThan(30)
    expect(lightness(190)).toBeLessThan(lightness(222))
  })

  it('name every token that a pair speaks of, in both schemes', () => {
    for (const scheme of SCHEMES) {
      const values = tokenValues(css, { scheme, hue: 222 })
      for (const pair of TOKEN_PAIRS) for (const name of `${pair.fg} ${pair.bg} ${pair.over ?? ''}`.match(/--[a-z0-9-]+/g) ?? []) expect(values.has(name), `${name} in ${pair.use}`).toBe(true)
    }
  })

  it('carry a pair for every text and every control kind that the stylesheets use', () => {
    const texts = TOKEN_PAIRS.filter((pair) => pair.min === AA_TEXT).length
    const controls = TOKEN_PAIRS.filter((pair) => pair.min === AA_CONTROL).length
    expect(texts).toBeGreaterThanOrEqual(30)
    expect(controls).toBeGreaterThanOrEqual(7)
  })

  it('measure what they say: a token made too pale makes the test fail', () => {
    // The two greys as they were before their correction, put back: 4.4:1 and 4.3:1, below AA.
    const regressed = css.replace('--text-3: light-dark(#62677a,', '--text-3: light-dark(#6e7383,').replace('rgb(26 29 43 / 0.74)', 'rgb(26 29 43 / 0.66)')
    expect(regressed).not.toBe(css)
    const lines = failures({ scheme: 'light', hue: 222 }).length
    expect(lines).toBe(0)
    const values = tokenValues(regressed, { scheme: 'light', hue: 222 })
    const bad = TOKEN_PAIRS.filter((pair) => pairRatio(values, pair, 'light') < pair.min).map((pair) => `${pair.fg} on ${pair.bg}`)
    expect(bad).toContain('var(--text-3) on var(--surface-2)')
    expect(bad).toContain('var(--text-on-space-2) on var(--space-a)')
  })
})

describe('the reader of the stylesheet', () => {
  const read = (source: string, context: TokenContext = { scheme: 'light', hue: 100 }): Map<string, string> => tokenValues(source, context)

  it('picks the side of light-dark() that the scheme asks for', () => {
    const source = ':root { --a: light-dark(#111111, #eeeeee); }'
    expect(read(source, { scheme: 'light', hue: 0 }).get('--a')).toBe('#111111')
    expect(read(source, { scheme: 'dark', hue: 0 }).get('--a')).toBe('#eeeeee')
  })

  it('resolves var() through other variables, with a fallback for one that is not set', () => {
    const source = ':root { --a: #123456; --b: var(--a); --c: var(--missing, var(--b)); }'
    expect(read(source).get('--c')).toBe('#123456')
    expect(() => read(':root { --a: var(--missing); }')).toThrow(/--missing is not defined/)
  })

  it('works out calc(), min(), max(), clamp() and abs() with units', () => {
    const source = ':root { --h: 100; --a: calc(var(--h) + 40); --b: min(44%, calc(10% + 20%)); --c: max(1, 2, 3); --d: clamp(0, calc(1 - abs(var(--h) - 110) / 95), 1); --e: calc(14px - 8px); --f: calc(min(44, 51 - var(--h) * 0.43) * 1%); }'
    const values = read(source)
    expect([values.get('--a'), values.get('--b'), values.get('--c'), values.get('--e')]).toEqual(['140', '30%', '3', '6px'])
    expect(parseFloat(values.get('--d')!)).toBeCloseTo(1 - 10 / 95, 10)
    expect(values.get('--f')).toBe('8%')
  })

  it('refuses an expression it does not know instead of guessing a number', () => {
    expect(() => read(':root { --a: calc(10px + 2%); }')).toThrow(/not understood/)
    expect(() => read(':root { --a: calc(10px * 2px); }')).toThrow(/not understood/)
  })

  it('mixes colours in sRGB with the alpha of CSS Color 5', () => {
    const source = ':root { --a: color-mix(in srgb, #ff0000 16%, transparent); --b: color-mix(in srgb, #000000 50%, #ffffff); }'
    const values = read(source)
    expect(colorOf(values, 'var(--a)', 'light')).toMatchObject({ r: 255, g: 0, b: 0 })
    expect(colorOf(values, 'var(--a)', 'light').a).toBeCloseTo(0.16, 10)
    expect(colorOf(values, 'var(--b)', 'light')).toMatchObject({ r: 127.5, g: 127.5, b: 127.5, a: 1 })
  })

  it('reads the rule that follows an @import: the statement is not taken for the start of its selector', () => {
    const source = "@import './palette.css';\n@import url('other.css') screen;\n:root { --a: #123456; }"
    expect(read(source).get('--a')).toBe('#123456')
  })

  it('applies the rules of a media query only when the preference is on', () => {
    const source = ':root { --a: 1; } @media (prefers-contrast: more) { :root { --a: 2; } } :root[data-contrast=\'more\'] { --b: 3; }'
    expect(read(source).get('--a')).toBe('1')
    // The system's preference is the media query alone; the forced setting is the attribute alone.
    expect(read(source, { scheme: 'light', hue: 0, contrast: true }).get('--a')).toBe('2')
    expect(read(source, { scheme: 'light', hue: 0, contrast: true }).has('--b')).toBe(false)
    expect(read(source, { scheme: 'light', hue: 0, contrast: 'forced' }).get('--b')).toBe('3')
    expect(read(source, { scheme: 'light', hue: 0, contrast: 'forced' }).get('--a')).toBe('1')
    expect(read(source).has('--b')).toBe(false)
  })

  it('reads several sheets in the order given, as one sheet made of them end to end: a later one answers over an earlier one, and each can use what another declares', () => {
    const sheets = [':root { --a: #111111; --b: var(--c); }', '.shell { --a: #222222; --c: var(--a); }', ':root { --d: #444444; }']
    const values = read(sheets.join('\n'))
    expect([...tokenValues(sheets, { scheme: 'light', hue: 100 })]).toEqual([...values])
    expect([values.get('--a'), values.get('--b'), values.get('--d')]).toEqual(['#222222', '#222222', '#444444'])
    // The order is the cascade: the same sheets the other way round give the other answer.
    expect(tokenValues([sheets[1]!, sheets[0]!], { scheme: 'light', hue: 100 }).get('--a')).toBe('#111111')
  })

  it('keeps nothing of a sheet for another one: the same text read again gives the same values, a text one character away gives its own', () => {
    const first = ':root { --a: light-dark(#111111, #eeeeee); --b: var(--a); }'
    expect(read(first).get('--b')).toBe('#111111')
    expect(read(first.replace('#111111', '#111112')).get('--b')).toBe('#111112')
    expect(read(first).get('--b')).toBe('#111111')
    // The context is no part of what is kept either.
    expect(read(first, { scheme: 'dark', hue: 100 }).get('--b')).toBe('#eeeeee')
    // More sheets than are kept: the first one is read again, and reads the same.
    for (let i = 0; i < 80; i++) expect(read(`:root { --a: ${i}px; --b: var(--a); }`).get('--b')).toBe(`${i}px`)
    expect(read(first).get('--b')).toBe('#111111')
  })

  it('works a variable out once for all the others that use it, and still refuses one that refers to itself', () => {
    const values = read(':root { --z: 1; --a: calc(var(--z) + 2); --b: var(--a) var(--a); --c: var(--b) var(--a); }')
    expect([values.get('--a'), values.get('--b'), values.get('--c')]).toEqual(['3', '3 3', '3 3 3'])
    expect(() => read(':root { --a: var(--b); --b: var(--a); }')).toThrow(/refers to itself/)
  })

  it('reads the real stylesheet without a gap: no value is left unresolved', () => {
    for (const scheme of SCHEMES) for (const [name, value] of tokenValues(css, { scheme, hue: 222 })) expect(value, `${scheme} ${name}`).not.toMatch(/var\(|light-dark\(|calc\(/)
  })
})
