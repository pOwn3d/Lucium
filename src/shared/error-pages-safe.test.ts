import { describe, expect, it } from 'vitest'
import { parseErrorAction, renderErrorPage } from './error-pages'
import { setLanguage } from './i18n'

describe('the warning page of safe browsing', () => {
  const unsafe = { kind: 'unsafe', url: 'https://phish.example/a?x=<b>', nonce: 'abc-1', canGoBack: true, category: 'phishing' } as const

  it('says phishing, says nothing was sent, and offers the way back and the way through', () => {
    setLanguage('en')
    const page = renderErrorPage(unsafe)
    expect(page.body).toContain('Deceptive site')
    expect(page.body).toContain('nothing was sent')
    expect(page.body).toContain('lucium-error:back?n=abc-1')
    expect(page.body).toContain('lucium-error:unsafe-continue?n=abc-1')
  })

  it('says malware for the other list, and has no way back when there is no page to go back to', () => {
    setLanguage('en')
    expect(renderErrorPage({ ...unsafe, category: 'malware' }).body).toContain('malware')
    expect(renderErrorPage({ ...unsafe, canGoBack: false }).body).not.toContain('lucium-error:back')
  })

  it('escapes the address, and says it in French', () => {
    setLanguage('fr')
    const page = renderErrorPage(unsafe)
    expect(page.body).not.toContain('<b>')
    expect(page.body).toContain('Continuer quand même')
    setLanguage('en')
  })

  it('knows the button as an action', () => {
    expect(parseErrorAction('lucium-error:unsafe-continue?n=abc')).toEqual({ action: 'unsafe-continue', nonce: 'abc' })
  })
})
