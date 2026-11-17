// The foot of the panel of the site holds a line that can be long (« Non sécurisé : certificat non valide accepté ») beside « Réglages du site… »
// and the round button. It used to be a row of fixed 32 px pills: the long line wrapped into two lines inside 32 px and overflowed, and the button
// wrapped beside it. The rules below are the ones that keep it readable at any panel width.

import { describe, expect, it } from 'vitest'
import panelCss from './site-panel.css?raw'

/** The declarations of the rule written exactly with this selector. */
function rule(selector: string): string {
  const start = panelCss.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`site-panel.css has no rule "${selector}"`)
  return panelCss.slice(start, panelCss.indexOf('}', start))
}

describe('the foot of the panel of the site', () => {
  it('lets its items go to a second row when they do not fit one', () => {
    expect(rule('body.overlay .scc-footer')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('grows the security line with its text instead of fixing its height', () => {
    const secure = rule('body.overlay .scc-secure')
    expect(secure).toMatch(/min-height:\s*32px/)
    expect(secure).not.toMatch(/(^|[\s;{])height:/)
    expect(secure).toMatch(/min-width:\s*0/)
  })

  it('keeps « Réglages du site… » and the round button on one line each, at their size', () => {
    expect(rule('body.overlay .scc-site-settings')).toMatch(/white-space:\s*nowrap/)
    expect(rule('body.overlay .scc-site-settings')).toMatch(/flex:\s*none/)
    expect(rule('body.overlay .scc-more')).toMatch(/flex:\s*none/)
  })

  it('leaves air between the row of the extensions and the line above the foot', () => {
    // The rows of settings above carry a 10 px margin; the row of tiles carries none, so the line of the foot used to touch it.
    expect(rule('body.overlay .scc-extensions')).toMatch(/padding:\s*6px 0 var\(--sp-3\) 1px/)
  })
})
