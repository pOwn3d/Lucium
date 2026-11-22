// The motion of the demos of « Découvrir Lucium » (discover-demos.css), measured on its stylesheet: a loop of 6 to 8 seconds, started only while the card is
// on screen and not paused, cut by « Réduire les animations » (the system's and the application's) so that the scene stays on its final picture, drawn with
// the tokens and the pairs of colours that are checked, light and heavy to nothing.

import { describe, expect, it } from 'vitest'
import { TOKEN_PAIRS } from '@shared/design-tokens'
import sheet from './discover-demos.css?raw'

const code = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...code.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((rule) => ({ selector: rule[1]!.trim().replace(/\s+/g, ' '), body: rule[2]!.trim() }))
const rule = (selector: string) => rules.find((r) => r.selector === selector)
const animated = rules.filter((r) => /(^|[;\s])animation\s*:/.test(r.body) && !/animation\s*:\s*none/.test(r.body))

describe('the loop', () => {
  it('lasts 6 to 8 seconds, in one place, and every animation reads it', () => {
    const loop = /--dvd-loop:\s*([\d.]+)s/.exec(code)
    expect(loop).not.toBeNull()
    expect(Number(loop![1])).toBeGreaterThanOrEqual(6)
    expect(Number(loop![1])).toBeLessThanOrEqual(8)
    expect(animated.length).toBeGreaterThanOrEqual(5)
    for (const r of animated) expect(r.body, r.selector).toContain('var(--dvd-loop)')
  })

  it('has keyframes, and starts every animation from the scope of a demo (`.dvd`), so that nothing else of the interface moves', () => {
    expect(code.match(/@keyframes/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    for (const r of animated) expect(r.selector, r.selector).toMatch(/^\.dvd[ \[.]/)
  })

  it('flashes nothing: no animation shorter than a second, no loop of its own faster than the demo', () => {
    expect(code).not.toMatch(/animation(-duration)?\s*:[^;]*\b0?\.\d+m?s\b/)
    expect(code).not.toMatch(/infinite[^;]*steps\(\d{3,}/)
  })
})

describe('the pause and the view', () => {
  it('stops every animation unless the demo is playing, that is on screen and not paused', () => {
    const body = rule(".dvd:not([data-playing='true']) [data-step]")?.body ?? ''
    expect(body).toMatch(/animation-play-state:\s*paused/)
  })
})

describe('less motion', () => {
  it('shows the final picture, with no animation, when the system asks for less motion; and hides the pause that would pause nothing', () => {
    const media = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    expect(media).toMatch(/\.dvd \[data-step\][^{}]*\{[^}]*animation:\s*none/)
    expect(media).toMatch(/\.dvd-pause[^{}]*\{[^}]*display:\s*none/)
  })

  it('does the same when the application forces it (« Réduire les animations »), which would otherwise leave a loop on its last, empty frame', () => {
    expect(code).toMatch(/:root\[data-motion='reduce'\] \.dvd \[data-step\][^{}]*\{[^}]*animation:\s*none/)
    expect(code).toMatch(/:root\[data-motion='reduce'\] \.dvd-pause[^{}]*\{[^}]*display:\s*none/)
  })

  it('draws every element on its final state at rest: the keyframes hide an element on the way, the rule of the element never does', () => {
    for (const r of rules.filter((x) => x.selector.includes('[data-step'))) expect(r.body, r.selector).not.toMatch(/opacity:\s*0\b/)
  })
})

describe('the colours', () => {
  it('are tokens, never written', () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  })

  it('make text only on the pairs of the tokens that are measured (4,5 : 1 at least in both schemes)', () => {
    const has = (fg: string, bg: string): boolean => TOKEN_PAIRS.some((pair) => pair.fg === `var(--${fg})` && pair.bg === `var(--${bg})`)
    const withText = rules.filter((r) => /(^|[;\s])color:\s*var\(--/.test(r.body))
    expect(withText.length).toBeGreaterThanOrEqual(5)
    for (const r of withText) {
      const fg = /(?:^|[;\s])color:\s*var\(--([a-z0-9-]+)\)/.exec(r.body)![1]!
      const bg = /background(?:-color)?:\s*var\(--([a-z0-9-]+)\)/.exec(r.body)?.[1] ?? 'surface'
      expect(has(fg, bg), `${r.selector}: ${fg} on ${bg}`).toBe(true)
    }
  })

  it('draws the frame of the stage with a real border, which stays when the colours are forced, and 2 px thick with more contrast', () => {
    expect(rule('.dvd-stage')?.body).toMatch(/border:\s*1px solid var\(--text-3\)/)
    expect(code).toMatch(/@media \(prefers-contrast: more\)\s*\{\s*\.dvd-stage\s*\{[^}]*border-width:\s*2px/)
    expect(code).toMatch(/:root\[data-contrast='more'\] \.dvd-stage\s*\{[^}]*border-width:\s*2px/)
  })
})

describe('the weight', () => {
  it('stays light: the eight scenes, their frame and their keyframes, in a few kilobytes of CSS', () => {
    expect(sheet.length).toBeLessThan(12_000)
  })
})
