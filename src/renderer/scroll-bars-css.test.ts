// « Toujours afficher les barres de défilement »: every list of the interface that hides its scroll bar has a rule that gives it back while the system always
// shows the bars (`:root[data-scrollbars='always']`, set from the snapshot by `useSnapshot`). The sheets are read as text: a list that hides its bar and has no such rule
// is found here, not by a person who needs the bar.

import { describe, expect, it } from 'vitest'

const sheets = import.meta.glob('./*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

interface Rule {
  selector: string
  body: string
}

const rulesOf = (css: string): Rule[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim().replace(/\s+/g, ' '), body: body!.replace(/\s+/g, ' ') }))

const ALWAYS = ":root[data-scrollbars='always'] "

/** The selectors that hide their own scroll bar: `scrollbar-width: none`, or the bar of the pseudo-element taken to nothing. */
function hiddenIn(rules: Rule[]): string[] {
  const hidden = new Set<string>()
  for (const { selector, body } of rules) {
    if (selector.startsWith(ALWAYS)) continue
    if (/scrollbar-width:\s*none/.test(body)) hidden.add(selector)
    else if (selector.endsWith('::-webkit-scrollbar') && /display:\s*none|(?:^|[ ;])width:\s*0(?:px)?\s*(?:;|$)/.test(body)) hidden.add(selector.slice(0, -'::-webkit-scrollbar'.length))
  }
  return [...hidden]
}

describe('the lists that hide their scroll bar', () => {
  const all = Object.entries(sheets).map(([file, css]) => ({ file, rules: rulesOf(css) }))

  it('are found in the sheets (the sidebar, the tab switcher, the command bar of the mini window…), so that this test is not about nothing', () => {
    const found = all.flatMap(({ rules }) => hiddenIn(rules))
    expect(found.length).toBeGreaterThanOrEqual(8)
    expect(found).toContain('.sidebar .scroll')
  })

  // Guard: a list that hides its bar and has no counterpart under the attribute would stay without a bar for a person who asked the system to always show them.
  it.each(all.map(({ file, rules }) => [file, rules] as const).filter(([, rules]) => hiddenIn(rules).length > 0))('%s gives each of them its bar back while the system always shows the bars', (_file, rules) => {
    for (const selector of hiddenIn(rules)) {
      const back = rules.find((rule) => rule.selector === `${ALWAYS}${selector}`)
      expect(back, selector).toBeDefined()
      // The standard property decides: Chromium ignores `::-webkit-scrollbar` while `scrollbar-width` is not `auto`, so « thin » shows the system's bar. The colours are tokens.
      expect(back!.body, selector).toMatch(/scrollbar-width:\s*thin/)
      expect(back!.body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    }
  })

  it('give back a bar the sheet of the lists draws in a colour of its tokens', () => {
    for (const { rules } of all) for (const rule of rules.filter((one) => one.selector.startsWith(ALWAYS))) expect(rule.body).toMatch(/scrollbar-color:\s*var\(--[a-z0-9-]+\)\s+transparent/)
  })
})
