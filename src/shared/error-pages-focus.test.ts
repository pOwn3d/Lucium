import { describe, expect, it } from 'vitest'
import { parseErrorAction, renderErrorPage } from './error-pages'
import { setLanguage } from './i18n'

describe('the focus page', () => {
  const focus = { kind: 'focus', url: 'https://news.example.com/a?x=<b>', nonce: 'abc-1', canGoBack: true, until: null, slotEnd: 18 * 60 } as const

  it('names the site, says when focus ends, and offers the pause and the way back', () => {
    setLanguage('en')
    const page = renderErrorPage(focus)
    expect(page.body).toContain('Focus mode')
    expect(page.body).toContain('Focus until 18:00.')
    expect(page.body).toContain('lucium-error:end-focus?n=abc-1')
    expect(page.body).toContain('lucium-error:back?n=abc-1')
  })

  it('has no way back when there is no page to go back to', () => {
    expect(renderErrorPage({ ...focus, canGoBack: false }).body).not.toContain('lucium-error:back')
  })

  it('escapes the address, and says it in French', () => {
    setLanguage('fr')
    const page = renderErrorPage(focus)
    expect(page.body).not.toContain('<b>')
    expect(page.body).toContain('Faire une pause de 15 minutes')
    setLanguage('en')
  })

  it('knows the end-focus button as an action', () => {
    expect(parseErrorAction('lucium-error:end-focus?n=abc')).toEqual({ action: 'end-focus', nonce: 'abc' })
  })
})
