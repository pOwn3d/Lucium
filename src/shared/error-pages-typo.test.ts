import { describe, expect, it } from 'vitest'
import { parseErrorAction, renderErrorPage } from './error-pages'
import { setLanguage } from './i18n'

describe('the page of a lookalike address', () => {
  const typo = { kind: 'typo', url: 'https://gogle.com/a?x=<b>', similar: 'google.com<i>', nonce: 'abc-1', canGoBack: true } as const

  it('names both sites, and offers the way back and the click on « Continuer »', () => {
    setLanguage('en')
    const page = renderErrorPage(typo)
    expect(page.body).toContain('This address looks like a site you know')
    expect(page.body).toContain('gogle.com')
    expect(page.body).toContain('google.com')
    expect(page.body).toContain('lucium-error:typo-continue?n=abc-1')
    expect(page.body).toContain('lucium-error:back?n=abc-1')
    expect(page.body).not.toContain('lucium-error:proceed')
  })

  it('offers no way back when there is no page to go back to', () => {
    expect(renderErrorPage({ ...typo, canGoBack: false }).body).not.toContain('lucium-error:back')
  })

  it('escapes the address and the name of the site, and says it in French', () => {
    setLanguage('fr')
    const page = renderErrorPage(typo)
    expect(page.body).not.toContain('<b>')
    expect(page.body).not.toContain('<i>')
    expect(page.body).toContain('Continuer vers ce site')
    setLanguage('en')
  })

  it('knows the button as an action', () => {
    expect(parseErrorAction('lucium-error:typo-continue?n=abc')).toEqual({ action: 'typo-continue', nonce: 'abc' })
  })
})
