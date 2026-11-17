// The title of a tab that sleeps stays readable: it takes the secondary text of the space, measured at 4.5:1 on
// the colours of a space, instead of 55 % of the text laid over it after the measure (3.1:1 in the light appearance).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import sidebarCss from './sidebar.css?raw'
import tokensCss from './tokens.css?raw'
import { AA_TEXT, compositeOver, contrastRatio, parseColor, type Rgba } from '@shared/contrast'
import { TOKEN_PAIRS, colorOf, pairRatio, tokenValues, type Scheme } from '@shared/design-tokens'
import { presetTheme } from '@shared/space-creation'
import { backgroundColors, themeVars } from '@shared/theme'
import { NAMED_COLORS } from '@shared/theme-colors'

/** The declarations of every rule whose selector names a sleeping tab and this part of its row. */
const declarationsFor = (part: string): string[] =>
  [...sidebarCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    // A text colour the user chose for a media background is the user's: it is not measured on the tokens (and keeps its own rule).
    .filter(([, selector]) => /\.(tab|split-pill)\.asleep/.test(selector!) && selector!.includes(part) && !selector!.includes('.custom-text'))
    .map(([, , body]) => body!.trim())

describe('the title of a tab that sleeps', () => {
  it('is drawn in the secondary text of the space, not faded by an opacity', () => {
    const rules = declarationsFor('.tab-title')
    expect(rules.length).toBeGreaterThan(0)
    for (const body of rules) expect(body, body).not.toMatch(/opacity/)
    expect(rules.join(' ')).toContain('color: var(--sb-dim)')
    expect(sidebarCss).toMatch(/--sb-dim:\s*var\(--text-on-space-2\)/)
  })

  it('reaches 4.5:1 on the colours of a space, in both appearances and at every hue', () => {
    const pairs = TOKEN_PAIRS.filter((pair) => pair.fg === 'var(--text-on-space-2)' && (pair.bg === 'var(--space-a)' || pair.bg === 'var(--space-b)'))
    expect(pairs.length).toBe(2)
    const low: string[] = []
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      for (let hue = 0; hue < 360; hue += 5) {
        const values = tokenValues(tokensCss, { scheme, hue })
        for (const pair of pairs) {
          const ratio = pairRatio(values, pair, scheme)
          if (ratio < AA_TEXT) low.push(`${scheme} ${hue}: ${pair.bg} ${ratio.toFixed(2)}`)
        }
      }
    }
    expect(low).toEqual([])
  })

  // The tokens above are the colours of a hue. A person picks one of the named colours, whose background is not one of them: the window then
  // writes the ink itself (shared/theme.ts), raised where the one of the tokens does not read (« Sable » and « Jaune » in the dark appearance).
  it('reaches 4.5:1 on both ends of the background of every colour a space can be given by name, in both appearances', () => {
    expect(NAMED_COLORS.map((color) => color.id)).toEqual(expect.arrayContaining(['sand', 'yellow']))
    const measured: string[] = []
    const low: string[] = []
    for (const appearance of ['light', 'dark'] as const) {
      for (const color of NAMED_COLORS) {
        const theme = presetTheme(color.hex)
        // What `--sb-dim` is on the shell of a window that wears this theme.
        const ink = themeVars(theme, appearance)['--text-on-space-2']!
        for (const ground of backgroundColors(theme, appearance)) {
          const ratio = contrastRatio(ink, ground)
          measured.push(`${appearance} ${color.id}`)
          if (ratio < AA_TEXT) low.push(`${color.id}, ${appearance}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`)
        }
      }
    }
    expect(measured.length).toBe(NAMED_COLORS.length * 2 * 2)
    expect(low).toEqual([])
  })

  // Under the pointer the row is washed (`--tile-hover`), more than a tile at rest: the title is measured on that ground too.
  const hoverRules = (): string[] =>
    [...sidebarCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => /\.(tab|split-pill)\.asleep[^ ]*:hover \.tab-title/.test(selector!) && !selector!.includes('.custom-text'))
      .map(([, selector, body]) => `${selector!.trim()} { ${body!.trim()} }`)

  it('takes, under the pointer, the ink measured on the wash of a hovered row: a tab of the list and a pane of a split view', () => {
    expect(hoverRules()).toEqual([
      '.sidebar .tab.asleep:not(.active):not(.selected):hover .tab-title { color: var(--sb-dim-hover); }',
      '.sidebar .split-pill.asleep:hover .tab-title { color: var(--sb-dim-hover); }'
    ])
    expect(sidebarCss).toMatch(/--sb-dim-hover:\s*var\(--text-on-tile-hover-2\)/)
    // The ground the ink is measured on is the one these rows really take.
    expect(sidebarCss).toContain('.sidebar .tab:hover { background: var(--tile-hover); }')
    expect(sidebarCss).toContain('.sidebar .split-pill:hover { background: var(--tile-hover); }')
  })

  /** The ratio of an ink on a colour of a space once the wash of a hovered row is laid over it. */
  const underThePointer = (ink: string | Rgba, ground: string | Rgba, scheme: Scheme): number => {
    const values = tokenValues(tokensCss, { scheme, hue: 250 })
    return contrastRatio(ink, compositeOver(colorOf(values, 'var(--tile-hover)', scheme), typeof ground === 'string' ? parseColor(ground)! : ground))
  }

  it('reaches 4.5:1 under the pointer on the colours of a space, in both appearances and at every hue', () => {
    const low: string[] = []
    const atRest: string[] = []
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      for (let hue = 0; hue < 360; hue += 5) {
        const values = tokenValues(tokensCss, { scheme, hue })
        for (const ground of ['var(--space-a)', 'var(--space-b)']) {
          const ratio = underThePointer(colorOf(values, 'var(--text-on-tile-hover-2)', scheme), colorOf(values, ground, scheme), scheme)
          if (ratio < AA_TEXT) low.push(`${scheme} ${hue}: ${ground} ${ratio.toFixed(2)}`)
          if (underThePointer(colorOf(values, 'var(--text-on-space-2)', scheme), colorOf(values, ground, scheme), scheme) < AA_TEXT) atRest.push(`${scheme} ${hue}`)
        }
      }
    }
    expect(low).toEqual([])
    // The ink of a title at rest does not read there: the hovered row needs its own.
    expect(atRest.length).toBeGreaterThan(0)
  })

  it('reaches 4.5:1 under the pointer on both ends of the background of every colour a space can be given by name, in both appearances', () => {
    const measured: string[] = []
    const low: string[] = []
    const atRest: string[] = []
    for (const appearance of ['light', 'dark'] as const) {
      for (const color of NAMED_COLORS) {
        const theme = presetTheme(color.hex)
        // What `--sb-dim-hover` is on the shell of a window that wears this theme.
        const vars = themeVars(theme, appearance)
        const ink = vars['--text-on-tile-hover-2']!
        for (const ground of backgroundColors(theme, appearance)) {
          const ratio = underThePointer(ink, ground, appearance)
          measured.push(`${appearance} ${color.id}`)
          if (ratio < AA_TEXT) low.push(`${color.id}, ${appearance}: ${ink} on ${ground} under the pointer is ${ratio.toFixed(2)}:1`)
          if (underThePointer(vars['--text-on-space-2']!, ground, appearance) < AA_TEXT) atRest.push(`${color.id}, ${appearance}`)
        }
      }
    }
    expect(measured.length).toBe(NAMED_COLORS.length * 2 * 2)
    expect(low).toEqual([])
    // With the ink of a title at rest, several dark colours were under the minimum once the pointer was on the row.
    expect(new Set(atRest).size).toBeGreaterThanOrEqual(6)
  })

  it('keeps its icon faded: only the title had to be readable', () => {
    expect(declarationsFor('.tab-icon').join(' ')).toMatch(/opacity:\s*0\.55/)
  })
})

// The title of an awake tab is written in the text of the space. Under the pointer the row takes the same wash as a sleeping one: the text is held
// at 4.5:1 there too, the ground unchanged (« Sable » in the dark appearance gave 4.46:1 with the text of the rest of the sidebar).
describe('the title of an awake tab under the pointer', () => {
  /** The ratio of an ink on a colour of a space once the wash of a hovered row is laid over it. */
  const underThePointer = (ink: string | Rgba, ground: string | Rgba, scheme: Scheme): number => {
    const values = tokenValues(tokensCss, { scheme, hue: 250 })
    return contrastRatio(ink, compositeOver(colorOf(values, 'var(--tile-hover)', scheme), typeof ground === 'string' ? parseColor(ground)! : ground))
  }

  it('takes the ink measured on the wash of a hovered row, a tab of the list and a pane of a split view, and the ground stays the wash', () => {
    const rules = [...sidebarCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector, body]) => selector!.includes(':hover .tab-title') && body!.includes('--sb-text-hover'))
      .map(([, selector, body]) => `${selector!.trim()} { ${body!.trim()} }`)
    expect(rules).toEqual([
      '.sidebar .tab:not(.asleep):not(.active):not(.selected):not(.private-tab):hover .tab-title { color: var(--sb-text-hover); }',
      '.sidebar .split-pill:not(.asleep):not(.active):hover .tab-title { color: var(--sb-text-hover); }'
    ])
    expect(sidebarCss).toMatch(/--sb-text-hover:\s*var\(--text-on-tile-hover\)/)
    expect(sidebarCss).toContain('.sidebar .tab:hover { background: var(--tile-hover); }')
    expect(sidebarCss).toContain('.sidebar .split-pill:hover { background: var(--tile-hover); }')
    // A text a person chose for a picture behind the tabs stays theirs under the pointer.
    expect(readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')).toContain(`'--sb-text-hover': ink[0]`)
  })

  it('reaches 4.5:1 on the colours of a space, in both appearances and at every hue', () => {
    const low: string[] = []
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      for (let hue = 0; hue < 360; hue += 5) {
        const values = tokenValues(tokensCss, { scheme, hue })
        for (const ground of ['var(--space-a)', 'var(--space-b)']) {
          const ratio = underThePointer(colorOf(values, 'var(--text-on-tile-hover)', scheme), colorOf(values, ground, scheme), scheme)
          if (ratio < AA_TEXT) low.push(`${scheme} ${hue}: ${ground} ${ratio.toFixed(2)}`)
        }
      }
    }
    expect(low).toEqual([])
  })

  it('reaches 4.5:1 on both ends of the background of every colour a space can be given by name, in both appearances, « Sable » in dark included', () => {
    const measured: string[] = []
    const low: string[] = []
    const before: string[] = []
    for (const appearance of ['light', 'dark'] as const) {
      for (const color of NAMED_COLORS) {
        const vars = themeVars(presetTheme(color.hex), appearance)
        for (const ground of backgroundColors(presetTheme(color.hex), appearance)) {
          const ratio = underThePointer(vars['--text-on-tile-hover']!, ground, appearance)
          measured.push(`${appearance} ${color.id}`)
          if (ratio < AA_TEXT) low.push(`${color.id}, ${appearance}: ${vars['--text-on-tile-hover']} on ${ground} under the pointer is ${ratio.toFixed(2)}:1`)
          if (underThePointer(vars['--text-on-space']!, ground, appearance) < AA_TEXT) before.push(`${color.id}, ${appearance}`)
        }
      }
    }
    expect(measured.length).toBe(NAMED_COLORS.length * 2 * 2)
    expect(low).toEqual([])
    // With the text of the rest of the sidebar, « Sable » fell short in dark.
    expect(before).toContain('sand, dark')
  })

  it('changes the text only where it has to: a colour where the text of the space reads keeps it, « Sable » in dark takes the plain white', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const color of NAMED_COLORS) {
        const theme = presetTheme(color.hex)
        const vars = themeVars(theme, appearance)
        const reads = backgroundColors(theme, appearance).every((ground) => underThePointer(vars['--text-on-space']!, ground, appearance) >= AA_TEXT + 0.05)
        if (reads) expect(vars['--text-on-tile-hover'], `${color.id}, ${appearance}`).toBe(vars['--text-on-space'])
      }
    }
    const sand = themeVars(presetTheme(NAMED_COLORS.find((color) => color.id === 'sand')!.hex), 'dark')
    expect(sand).toMatchObject({ '--text-on-space': '#f1f2f6', '--text-on-tile-hover': '#ffffff' })
  })
})
