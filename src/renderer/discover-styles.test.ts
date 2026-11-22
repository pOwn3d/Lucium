// The look of « Découvrir Lucium » (discover.css), measured on its stylesheet: a field, a chip and a button take the contour `--text-3` (3 : 1 at least, WCAG
// 1.4.11), never `--line-strong` (1,5 : 1 in the light scheme, kept for what only decorates); the focus ring of the panel is not taken away; nothing moves by
// itself; and the transitions that exist are cut by « Réduire les animations ».

import { describe, expect, it } from 'vitest'
import { TOKEN_PAIRS } from '@shared/design-tokens'
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

describe('the pairs of colours the panel relies on', () => {
  it('stay in the checked pairs of the tokens: the header text and the contour on the gradient of the space, the badge of a switched-off card', () => {
    const has = (fg: string, bg: string): boolean => TOKEN_PAIRS.some((pair) => pair.fg === `var(--${fg})` && pair.bg === `var(--${bg})`)
    for (const [fg, bg] of [['text', 'space-a'], ['text', 'space-b'], ['text-3', 'space-a'], ['text-3', 'space-b'], ['warn-ink', 'surface']] as const) expect(has(fg, bg), `${fg} on ${bg}`).toBe(true)
  })

  it('are the ones the sheet draws: the header is on the gradient of the space, the status and the label are `text`, the contour is `text-3`', () => {
    expect(rule('.dv-head')?.body).toMatch(/linear-gradient\([^)]*var\(--space-a\)[^)]*var\(--space-b\)/)
    expect(rule('.dv-status')?.body).toContain('color: var(--text)')
    expect(rule('.dv-chips .dv-label')?.body).toContain('color: var(--text)')
    expect(rule('.dv .tk-field')?.body).toContain('var(--text-3)')
    expect(rule('.dv-badge.off')?.body).toContain('var(--warn-ink)')
  })
})

describe('the focus of the search field', () => {
  it('takes the accent contour and a ring of the focus width, which outweigh the template (it gives the field only a soft halo and « outline: 0 » on :focus)', () => {
    expect(rule('.dv .tk-field:focus')?.body).toMatch(/border-color:\s*var\(--accent\)/)
    const ring = rule('.dv .tk-field:focus-visible')?.body ?? ''
    expect(ring).toMatch(/outline:\s*var\(--focus-width\)\s+solid\s+var\(--focus\)/)
    // A ring of its own, drawn by a selector heavier than `.tk-field:focus` (0,2,0) of the template: `.dv .tk-field:focus-visible` is 0,3,0.
    expect(primitives).toMatch(/\.tk-field:focus \{[^}]*outline:\s*0/)
  })

  it('keeps the ring of the list that scrolls inside the panel, which would be cut at its edges', () => {
    expect(rule('.dv-body:focus-visible')?.body).toMatch(/outline-offset:\s*-/)
  })
})

describe('the count of a chip', () => {
  it('is drawn without opacity: the colour of a pressed chip on the accent must keep 4,5 : 1 (an 85 % fill gave 3,75 : 1 in the light scheme)', () => {
    const body = rule('.dv .dv-n')?.body ?? ''
    expect(body).not.toMatch(/opacity/)
    expect(code).not.toMatch(/\.dv-n[^{]*\{[^}]*opacity/)
  })
})

describe('a short window and the forced colours', () => {
  it('lets the panel scroll as one on a short window or at a large text, so that the cards stay reachable', () => {
    expect(code).toMatch(/@media \(max-height: 640px\)\s*\{\s*\.dv \{ overflow-y: auto; \}\s*\.dv-body \{ overflow: visible; \}/)
  })

  it('tells the pressed chip from the others when the colours are forced', () => {
    expect(code).toMatch(/@media \(forced-colors: active\)\s*\{[^}]*aria-pressed='true'\][^}]*Highlight/)
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
    const media = code.match(/@media \(prefers-contrast: more\)\s*\{\s*([^{}]+)\{([^{}]*)\}\s*\}/)
    expect(media?.[1]?.trim()).toBe('.dv-card')
    expect(media?.[2]).toMatch(/border-color:\s*var\(--text-3\)/)
    expect(media?.[2]).toMatch(/border-width:\s*2px/)
    const forced = rule(":root[data-contrast='more'] .dv-card")?.body ?? ''
    expect(forced).toMatch(/border-color:\s*var\(--text-3\)/)
    expect(forced).toMatch(/border-width:\s*2px/)
  })
})
