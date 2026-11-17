// « Toujours augmenter le contraste » (Réglages › Général) puts `data-contrast="more"` on the root of every document: it must give what the
// preference of the system gives. A stylesheet cannot ask « this media query, or that attribute » in one rule, so each rule of a
// `@media (prefers-contrast: more)` block is written a second time under `:root[data-contrast='more']`. This test keeps the two equal, in every
// sheet of the interface: a variant added for the system alone, or changed on one side only, fails here.

import { describe, expect, it } from 'vitest'
import { tokenValues } from '@shared/design-tokens'

const sheets = {
  ...(import.meta.glob('./*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>),
  ...(import.meta.glob('./templates/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>),
  ...(import.meta.glob('./components/**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
}

const MEDIA = '@media (prefers-contrast: more)'
const FORCED = ":root[data-contrast='more']"

/** Splits on a separator that is not inside parentheses or brackets (`:is(.a, .b)` holds a comma of its own). */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(' || char === '[') depth++
    if (char === ')' || char === ']') depth--
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  return [...parts, current].map((part) => part.trim()).filter(Boolean)
}

const normal = (text: string): string => text.replace(/\s+/g, ' ').trim()
const declarationsOf = (body: string): string => splitTop(body, ';').map(normal).sort().join('; ')
/** The rules of a text, as `selector { declarations }` with one selector each and the declarations in order of name. */
const rulesOf = (text: string): Array<{ selector: string; declarations: string }> =>
  [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => splitTop(selectors!, ',').map((selector) => ({ selector: normal(selector), declarations: declarationsOf(body!) })))

/** A sheet cut in two: the bodies of its « Increase contrast » blocks, and the rest with every `@media` block taken out. */
function cut(css: string): { media: string; outside: string } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let media = ''
  let outside = ''
  let from = 0
  for (;;) {
    const start = text.indexOf('@media', from)
    if (start < 0) return { media, outside: outside + text.slice(from) }
    const open = text.indexOf('{', start)
    // `end` stops just after the brace that closes the block.
    let depth = 0
    let end = open
    do {
      if (text[end] === '{') depth++
      else if (text[end] === '}') depth--
      end++
    } while (depth > 0)
    if (normal(text.slice(start, open)) === MEDIA) media += text.slice(open + 1, end - 1)
    outside += text.slice(from, start)
    from = end
  }
}

/** The selector a rule of the media block has under the attribute: the root itself, or the same element inside that root. */
const forcedSelector = (selector: string): string => (selector === ':root' ? FORCED : `${FORCED} ${selector}`)

/** What the two variants of a sheet do not share, as lines. */
function mismatches(css: string): string[] {
  const { media, outside } = cut(css)
  const system = rulesOf(media).map((rule) => `${forcedSelector(rule.selector)} { ${rule.declarations} }`)
  const forced = rulesOf(outside).filter((rule) => rule.selector.startsWith(FORCED)).map((rule) => `${rule.selector} { ${rule.declarations} }`)
  return [...system.filter((rule) => !forced.includes(rule)).map((rule) => `only for the system: ${rule}`), ...forced.filter((rule) => !system.includes(rule)).map((rule) => `only for the setting: ${rule}`)]
}

describe('« Toujours augmenter le contraste »', () => {
  const withVariant = Object.entries(sheets).filter(([, css]) => css.includes(MEDIA))

  it('finds the sheets that answer « Increase contrast »: the tokens, the sidebar, the Settings, the panels', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(60)
    expect(withVariant.length).toBeGreaterThanOrEqual(13)
    for (const name of ['./tokens.css', './sidebar.css', './settings.css', './command-bar.css', './split-bar.css', './little.css', './templates/primitives.css']) expect(withVariant.map(([file]) => file), name).toContain(name)
  })

  it('gives in every sheet what the preference of the system gives: each rule of the media block is there a second time under the attribute', () => {
    for (const [name, css] of Object.entries(sheets)) expect(mismatches(css), name).toEqual([])
  })

  it('measures what it says: a rule for the system alone, a value changed on one side, and a rule for the setting alone are each reported', () => {
    const sheet = `.a { color: red; }\n@media (prefers-contrast: more) {\n  .a, .b:is(.c, .d) { border-width: 2px; color: var(--text); }\n}\n${FORCED} .a, ${FORCED} .b:is(.c, .d) { color: var(--text); border-width: 2px; }`
    expect(mismatches(sheet)).toEqual([])
    expect(mismatches(sheet.replace(`, ${FORCED} .b:is(.c, .d)`, ''))).toEqual([`only for the system: ${FORCED} .b:is(.c, .d) { border-width: 2px; color: var(--text) }`])
    expect(mismatches(sheet.replace('border-width: 2px; }', 'border-width: 3px; }'))).toHaveLength(4)
    expect(mismatches(`${sheet}\n${FORCED} .e { outline: 1px solid; }`)).toEqual([`only for the setting: ${FORCED} .e { outline: 1px solid }`])
    // A rule of another media query is not a variant of contrast.
    expect(mismatches('@media (prefers-reduced-motion: reduce) { .a { animation: none; } }')).toEqual([])
  })

  it('reaches the greys of the sidebar and the secondary inks of the space: forced, they are the text of the space itself, as when the system asks', () => {
    const sidebar = sheets['./sidebar.css']!.replace(/\s*!important/g, '')
    for (const contrast of [true, 'forced'] as const) {
      const values = tokenValues(`${sheets['./tokens.css']}\n${sidebar}`, { scheme: 'dark', hue: 250, contrast })
      for (const name of ['--sb-dim', '--sb-dim-tile', '--sb-dim-hover', '--sb-faint', '--sb-glyph', '--muted', '--text-on-space-2', '--text-on-tile-2', '--glyph-on-space']) expect(values.get(name), `${name} ${contrast}`).toBe(values.get('--text-on-space'))
    }
    const plain = tokenValues(`${sheets['./tokens.css']}\n${sidebar}`, { scheme: 'dark', hue: 250 })
    expect(plain.get('--sb-dim')).not.toBe(plain.get('--text-on-space'))
  })
})
