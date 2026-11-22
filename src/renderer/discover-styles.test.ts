// The look of « Découvrir Lucium » (discover.css), measured on its stylesheet: a field, a chip and a button take the contour `--text-3` (3 : 1 at least, WCAG
// 1.4.11), never `--line-strong` (1,5 : 1 in the light scheme, kept for what only decorates); the focus ring of the panel is not taken away; nothing moves by
// itself; and the transitions that exist are cut by « Réduire les animations ».

import { describe, expect, it } from 'vitest'
import sheet from './discover.css?raw'
import primitives from './templates/primitives.css?raw'

const code = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({ selector: rule[1]!.trim().replace(/\s+/g, ' '), body: rule[2]!.trim() }))
const rule = (selector: string) => rules.find((r) => r.selector === selector)

describe('the contours of the controls', () => {
  it('give the search field, the buttons and the chips the contour text-3, and never line-strong', () => {
    for (const selector of ['.dv .tk-field', '.dv .tk-btn', '.dv .tk-chip']) {
      const body = rule(selector)?.body ?? ''
      expect(body, selector).toMatch(/border(-color)?:[^;]*var\(--text-3\)/)
      expect(body, selector).not.toContain('--line-strong')
    }
  })

  it('leave line-strong to what only decorates: the card and the capsule of a key, never a control that carries a function', () => {
    const using = rules.filter((r) => r.body.includes('--line-strong')).map((r) => r.selector)
    expect(using).toEqual(['.dv-card'])
  })

  it('beat the template, which still draws its fields and buttons with line-strong: the panel overrides it for its own controls', () => {
    expect(primitives).toMatch(/\.tk-field \{[^}]*--line-strong/)
    expect(code.indexOf('.dv .tk-field')).toBeGreaterThan(-1)
  })

  it('keep the accent contour of the primary button and none on the quiet close button', () => {
    expect(rule('.dv .tk-btn.primary')?.body).toContain('var(--accent)')
    expect(rule('.dv .tk-btn.quiet')?.body).toContain('transparent')
  })
})

describe('the motion', () => {
  it('has no animation of its own, and cuts its transitions for « Réduire les animations »', () => {
    expect(code).not.toMatch(/@keyframes|animation\s*:/)
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/)
  })

  it('does not take the focus ring away', () => {
    expect(code).not.toMatch(/outline\s*:\s*(none|0)/)
  })

  it('draws the cards at 2 px with more contrast, as the other panels do, and by the setting that forces it', () => {
    expect(code).toMatch(/@media \(prefers-contrast: more\)\s*\{[^}]*\.dv-card/)
    expect(code).toMatch(/:root\[data-contrast='more'\] \.dv-card/)
  })
})
