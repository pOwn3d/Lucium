// Small texts that were under 4.5:1, measured where they are declared: the letter that stands for a missing icon, the texts of an extension that is
// off, and the detail of the highlighted row of a list of results. Each was readable on some hues or in one scheme only.

import { describe, expect, it } from 'vitest'
import { AA_TEXT, contrastRatio } from '@shared/contrast'
import { MONOGRAM_CONTRAST_MIN, monogramGround } from '@shared/favicon'
import { hslToHex } from '@shared/theme'
import commandBar from './command-bar.css?raw'
import extensionsPage from './extensions-page.css?raw'
import sidebar from './sidebar.css?raw'
import styles from './styles.css?raw'
import tokens from './tokens.css?raw'

/** The declarations of the rules whose selector ends with `selector`. */
const rulesOf = (css: string, selector: string): string[] => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors!.split(',').some((one) => one.trim().endsWith(selector))).map(([, , body]) => body!)

describe('the letter that stands for a missing icon', () => {
  const ink = /--tone-on-dark:\s*rgb\((\d+) (\d+) (\d+)\)/.exec(tokens)!
  const inkHex = `#${[ink[1], ink[2], ink[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
  const groundHex = (hue: number): string => {
    const [, h, s, l] = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(monogramGround(hue))!
    return hslToHex({ h: Number(h), s: Number(s) / 100, l: Number(l) / 100 })
  }

  it('is drawn in the light ink, in both schemes (the ink of the accent is dark in the dark scheme)', () => {
    expect(rulesOf(sidebar, '.favicon.monogram').join(' ')).toMatch(/(?:^|[\s;])color: var\(--tone-on-dark\)/)
  })

  it('is readable on the ground of every hue: at one lightness, the yellows and the greens were under 3:1', () => {
    expect(MONOGRAM_CONTRAST_MIN).toBe(AA_TEXT)
    const low = Array.from({ length: 360 }, (_, hue) => hue).filter((hue) => contrastRatio(inkHex, groundHex(hue)) < AA_TEXT)
    expect(low).toEqual([])
  })

  it('keeps the lightness the blues always had, and darkens only the hues that need it', () => {
    expect(monogramGround(240)).toBe('hsl(240 45% 42%)')
    expect(Number(/(\d+)%\)$/.exec(monogramGround(60))![1])).toBeLessThan(42)
    expect(monogramGround(60)).toBe(monogramGround(60))
  })
})

describe('an extension that is off, on the page of the extensions', () => {
  it('dims its icon and none of its texts: no rule lowers the opacity of the card', () => {
    expect(rulesOf(extensionsPage, '.xp-card.off').join(' ')).not.toMatch(/opacity/)
    expect(rulesOf(extensionsPage, '.xp-card.off .xp-glyph')[0]).toMatch(/opacity: 0\.6/)
  })
})

describe('the detail of the highlighted row, where the highlight is the accent', () => {
  it('takes the whole ink of the accent, in the mini window and in the lists that keep the plain highlight', () => {
    const little = rulesOf(commandBar, '.palette.cb-little .results li.selected .detail')
    const plain = rulesOf(styles, '.results li.selected .detail')
    expect(little).toHaveLength(1)
    expect(plain).toHaveLength(1)
    for (const rule of [...little, ...plain]) expect(rule.trim()).toBe('color: var(--on-accent);')
  })
})
