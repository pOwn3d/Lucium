// The glyphs of the toolbar in colour (decided on 9 Nov 2026 from a mockup): the strokes keep the ink of the bar, so that every glyph keeps its contrast
// on a light, dark or coloured bar; the colour is in fills only, from the tokens of the palette, and only in the toolbar.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const css = read('./toolbar.css')
const tsx = read('./Toolbar.tsx')
const rules = css.slice(css.indexOf('/* The other glyphs of the bar in colour'))

describe('the coloured glyphs of the toolbar', () => {
  it('mark the parts that take a colour: the pencil, the sheet of the note, the knobs of the control centre, the left pane of the split view, the card of the A of the translation', () => {
    for (const part of ['tb-tint-pen', 'tb-tint-note', 'tb-knob-1', 'tb-knob-2', 'tb-tint-pane', 'tb-tint-lang']) expect(tsx, part).toContain(`className="${part}"`)
  })

  it('colour fills only, from palette tokens: no stroke of another colour than the ink, no colour written in the rule', () => {
    expect(rules.length).toBeGreaterThan(100)
    // A stroke is either the ink (currentColor) or none.
    for (const [, value] of rules.matchAll(/(?<![-\w])stroke:\s*([^;]+);/g)) expect(['currentColor', 'none']).toContain(value!.trim())
    expect(rules).not.toMatch(/(^|[;{\s])color:/)
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    for (const token of ['--fixed-f5a524', '--fixed-ffe082', '--fixed-3e7bfa']) expect(rules).toContain(`var(${token})`)
  })

  it('applies inside the buttons of the toolbar only', () => {
    const selectors = [...rules.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1]!)
    expect(selectors.length).toBeGreaterThan(4)
    for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim(), part).toMatch(/^\.tb-button/)
  })
})
