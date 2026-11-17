// A document that answered an error status (404, 503…) with nothing to show: Chromium puts its own page there, Electron leaves it blank.
// The rules that decide when our page covers it, and what the page says.

import { afterEach, describe, expect, it } from 'vitest'
import { DOCUMENT_FACTS_SCRIPT, describeStatus, documentFacts, errorActionUrl, homeOf, isBlankDocument, isStatusFailure, parseErrorAction, renderErrorPage, statusLine } from './error-pages'
import { setLanguage } from './i18n'

afterEach(() => setLanguage('fr'))

describe('which answers get the page', () => {
  it('are the 4xx and 5xx, and nothing else', () => {
    expect([399, 400, 401, 403, 404, 410, 500, 502, 503, 599, 600].map(isStatusFailure)).toEqual([false, true, true, true, true, true, true, true, true, true, false])
    expect([200, 204, 301, 304, 0, -1, 404.5, Number.NaN].map(isStatusFailure)).toEqual([false, false, false, false, false, false, false, false])
  })
})

describe('a document that shows nothing', () => {
  it('is covered only when it has no text, no content and no script', () => {
    expect(isBlankDocument({ textLength: 0, hasContent: false, hasScript: false })).toBe(true)
    expect(isBlankDocument({ textLength: 12, hasContent: false, hasScript: false })).toBe(false)
    expect(isBlankDocument({ textLength: 0, hasContent: true, hasScript: false })).toBe(false)
    // An application answers 404 with its shell, and draws the page itself.
    expect(isBlankDocument({ textLength: 0, hasContent: false, hasScript: true })).toBe(false)
  })

  it('reads the answer of the page as data: what is not what was asked for is a page with something in it', () => {
    expect(documentFacts({ textLength: 0, hasContent: false, hasScript: false })).toEqual({ textLength: 0, hasContent: false, hasScript: false })
    for (const raw of [null, undefined, 'blank', 42, [], {}, { textLength: '0', hasContent: false, hasScript: false }, { textLength: Number.NaN, hasContent: false, hasScript: false }, { textLength: 0, hasContent: 0, hasScript: false }, { textLength: 0, hasContent: false, hasScript: 'no' }]) {
      expect(isBlankDocument(documentFacts(raw)), JSON.stringify(raw)).toBe(false)
    }
  })

  it('is looked at by a script that asks for exactly these three facts', () => {
    // The script is run here against a document of its own, as the engine runs it in the page that answered.
    const facts = (document: unknown): unknown => new Function('document', `return ${DOCUMENT_FACTS_SCRIPT}`)(document)
    const none = () => null
    // A word between spaces: its text, trimmed, and nothing else.
    expect(facts({ body: { innerText: '  Introuvable  ', querySelector: none }, querySelector: none })).toEqual({ textLength: 11, hasContent: false, hasScript: false })
    // The shell of an application: no text, but an element to show and a script that draws the page.
    expect(facts({ body: { innerText: '', querySelector: () => ({}) }, querySelector: (selector: string) => (selector === 'script' ? {} : null) })).toEqual({ textLength: 0, hasContent: true, hasScript: true })
    // No body at all.
    expect(facts({ body: null, querySelector: none })).toEqual({ textLength: 0, hasContent: false, hasScript: false })
  })
})

describe('the page of an error status', () => {
  const page = (status: number, url = 'https://exemple.fr/chemin', extra: { canGoBack?: boolean } = {}) =>
    renderErrorPage({ kind: 'status', url, status, nonce: 'n0nce', canGoBack: extra.canGoBack ?? false, at: Date.UTC(2026, 9, 27, 10, 42) })

  it('names the site and the status, and has a retry button that carries its nonce', () => {
    const { body, title } = page(404)
    expect(title).toBe('exemple.fr')
    expect(body).toContain('exemple.fr ne trouve pas cette page')
    expect(body).toContain('<span>404</span><small>page introuvable</small>')
    expect(body).toContain('404 Not Found')
    expect(body).toContain(`href="${errorActionUrl('retry', 'n0nce')}"`)
    expect(parseErrorAction(errorActionUrl('retry', 'n0nce'))).toEqual({ action: 'retry', nonce: 'n0nce' })
    expect(parseErrorAction(errorActionUrl('home', 'n0nce'))).toEqual({ action: 'home', nonce: 'n0nce' })
    expect(body).not.toContain('proceed')
  })

  it('says what the site did, not that it cannot be reached: not found, refused, a problem of the site, or another failure', () => {
    expect(describeStatus(404, 'S')).toMatchObject({ family: 'missing', title: 'S ne trouve pas cette page', text: 'Le site a répondu, mais il n’a rien à cette adresse.' })
    expect(describeStatus(410, 'S').family).toBe('missing')
    expect(describeStatus(403, 'S')).toMatchObject({ family: 'refused', title: 'S refuse l’accès à cette page' })
    expect(describeStatus(401, 'S').family).toBe('refused')
    expect(describeStatus(503, 'S')).toMatchObject({ family: 'server', title: 'S rencontre un problème et n’a pas pu répondre' })
    expect(describeStatus(418, 'S')).toMatchObject({ family: 'other', title: 'S n’a pas pu fournir cette page' })
    expect(statusLine(404)).toBe('404 Not Found')
    expect(statusLine(418)).toBe('418')
  })

  it('is amber for what the address got wrong and red for the site', () => {
    expect(page(404).body).toContain('ep-pill warn')
    expect(page(403).body).toContain('ep-pill warn')
    expect(page(503).body).toContain('ep-pill danger')
  })

  it('offers "Page précédente" only when there is a page to go back to, and "Accueil du site" only when the address is not the home already', () => {
    expect(page(404).body).not.toContain(errorActionUrl('back', 'n0nce'))
    expect(page(404, undefined, { canGoBack: true }).body).toContain(`href="${errorActionUrl('back', 'n0nce')}"`)
    expect(page(404).body).toContain(`href="${errorActionUrl('home', 'n0nce')}"`)
    expect(page(404, 'https://exemple.fr/').body).not.toContain(errorActionUrl('home', 'n0nce'))
    // A file has no home.
    expect(page(404, 'file:///tmp/a.html').body).not.toContain(errorActionUrl('home', 'n0nce'))
    expect(homeOf('https://exemple.fr:8443/a/b?c#d')).toBe('https://exemple.fr:8443/')
    expect(homeOf('chrome://flags')).toBeNull()
  })

  it('writes the address of a page as text, never as markup', () => {
    expect(page(404, 'http://<img src=x onerror=alert(1)>/').body).not.toContain('<img')
  })

  it('is in English when the interface is', () => {
    setLanguage('en')
    expect(describeStatus(404, 'S').title).toBe('S can’t find this page')
    expect(describeStatus(502, 'S').title).toBe('S has a problem and could not answer')
    expect(page(503).body).not.toMatch(/problème|Réessayer|Rechargez|précédente/)
  })
})
