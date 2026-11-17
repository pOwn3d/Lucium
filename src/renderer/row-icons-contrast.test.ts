// The coloured tiles of the rows of the Settings (`RowIcon`): Apple's system colours, a white glyph on them. They are decorative (the label of
// the row says what it is), and the glyph is under 3:1 on most of them; with « Augmenter le contraste » each takes the accessible variant of its
// colour, as macOS does, so that the glyph reads as a control's part must.

import { describe, expect, it } from 'vitest'
import { AA_CONTROL, contrastRatio } from '@shared/contrast'
import settings from './settings.css?raw'

const code = settings.replace(/\/\*[\s\S]*?\*\//g, '')
/** The background of each colour of the tiles, in the rules outside any `@media` and under the forced contrast. */
const tiles = (prefix: string): Record<string, string> =>
  Object.fromEntries([...code.matchAll(new RegExp(`(?:^|\\n)${prefix.replace(/[[\]()'.]/g, '\\$&')}\\.pref-icon\\.([a-z]+) \\{ background: (#[0-9a-f]{6}); \\}`, 'g'))].map(([, colour, value]) => [colour!, value!]))

describe('the coloured tiles of the rows of the Settings', () => {
  const plain = tiles('')
  const more = tiles(":root[data-contrast='more'] ")
  const glyph = /\.pref-icon \{[^}]*color: (#[0-9a-f]+);/.exec(code)![1]!

  it('are four colours, each with its variant for « Augmenter le contraste »', () => {
    expect(Object.keys(plain).sort()).toEqual(['blue', 'green', 'purple', 'red'])
    expect(Object.keys(more).sort()).toEqual(Object.keys(plain).sort())
  })

  it('give the white glyph 3:1 or more on every variant for « Augmenter le contraste »', () => {
    for (const [colour, value] of Object.entries(more)) expect(contrastRatio(glyph, value), colour).toBeGreaterThanOrEqual(AA_CONTROL)
  })
})
