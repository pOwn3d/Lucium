import { describe, expect, it } from 'vitest'
import { parseErrorAction, renderErrorPage } from './error-pages'
import { setLanguage } from './i18n'

describe('the page of « HTTPS seul »', () => {
  const only = { kind: 'https-only', url: 'http://exemple.fr:8080/a?x=<b>', http: 'http://exemple.fr:8080/a?x=<b>', nonce: 'abc-1', canGoBack: true } as const

  it('names the site, says what continuing costs, and offers the way back and the click on http', () => {
    setLanguage('en')
    const page = renderErrorPage(only)
    expect(page.body).toContain('This site is not available over HTTPS')
    expect(page.body).toContain('exemple.fr')
    expect(page.body).toContain('without encryption')
    expect(page.body).toContain('lucium-error:http?n=abc-1')
    expect(page.body).toContain('lucium-error:back?n=abc-1')
    expect(page.body).not.toContain('lucium-error:proceed')
  })

  it('offers to try again when there is no page to go back to', () => {
    const page = renderErrorPage({ ...only, canGoBack: false })
    expect(page.body).not.toContain('lucium-error:back')
    expect(page.body).toContain('lucium-error:retry?n=abc-1')
  })

  it('escapes the address, and says it in French', () => {
    setLanguage('fr')
    const page = renderErrorPage(only)
    expect(page.body).not.toContain('<b>')
    expect(page.body).toContain('Continuer en HTTP (non sécurisé)')
    setLanguage('en')
  })

  it('knows the http button as an action', () => {
    expect(parseErrorAction('lucium-error:http?n=abc')).toEqual({ action: 'http', nonce: 'abc' })
  })
})
