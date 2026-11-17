import { describe, expect, it } from 'vitest'
import { MAX_ARTICLE_CHARS, MIN_ARTICLE_CHARS, canRead, cleanArticle, readerDocument, readingMinutes } from './reader'
import { frenchSpaces } from './french-typography'

const valid = { title: 'Un titre', content: '<p>Du texte.</p>', byline: 'Marie Curie', siteName: 'Le Journal', lang: 'fr', dir: 'ltr', textLength: 1200 }

describe('cleanArticle', () => {
  it('keeps what an article of a page looks like', () => {
    expect(cleanArticle(valid)).toEqual({ title: 'Un titre', content: '<p>Du texte.</p>', byline: 'Marie Curie', siteName: 'Le Journal', lang: 'fr', dir: 'ltr', textLength: 1200 })
  })

  it('refuses what is not an article: nothing, the wrong shape, no content', () => {
    for (const raw of [null, undefined, 'texte', 42, [], { ...valid, content: '' }, { ...valid, content: 12 }]) expect(cleanArticle(raw)).toBeNull()
  })

  it('refuses a page with too little text to read', () => {
    expect(cleanArticle({ ...valid, textLength: MIN_ARTICLE_CHARS - 1 })).toBeNull()
    expect(cleanArticle({ ...valid, textLength: MIN_ARTICLE_CHARS })).not.toBeNull()
    expect(cleanArticle({ ...valid, textLength: 'beaucoup' })).toBeNull()
  })

  it('refuses a content too large to be an article', () => {
    expect(cleanArticle({ ...valid, content: 'x'.repeat(MAX_ARTICLE_CHARS + 1) })).toBeNull()
  })

  it('keeps only a language tag and a direction it knows', () => {
    expect(cleanArticle({ ...valid, lang: 'en-GB' })?.lang).toBe('en-GB')
    expect(cleanArticle({ ...valid, lang: '"><script>x</script>' })?.lang).toBeNull()
    expect(cleanArticle({ ...valid, dir: 'rtl' })?.dir).toBe('rtl')
    expect(cleanArticle({ ...valid, dir: 'sideways' })?.dir).toBeNull()
  })

  it('trims and cuts the text fields, and leaves out the empty ones', () => {
    const article = cleanArticle({ ...valid, title: `  ${'t'.repeat(500)}  `, byline: '   ', siteName: undefined })!
    expect(article.title).toHaveLength(300)
    expect(article.byline).toBeNull()
    expect(article.siteName).toBeNull()
  })
})

describe('readerDocument', () => {
  const article = cleanArticle(valid)!

  it('shows the title, the site, the author and the reading time, and the article', () => {
    const html = readerDocument(article, 'https://www.lejournal.fr/a/b')
    expect(html).toContain('<h1>Un titre</h1>')
    expect(html).toContain('Le Journal')
    expect(html).toContain(frenchSpaces('Marie Curie · 1 min de lecture'))
    expect(html).toContain('<article><p>Du texte.</p></article>')
    expect(html).toContain('lang="fr"')
  })

  it('names the site after its host when the page gave no name', () => {
    expect(readerDocument({ ...article, siteName: null }, 'https://www.lejournal.fr/a')).toContain('<p class="site">lejournal.fr</p>')
  })

  it('forbids scripts, frames, forms and connections: only pictures may load', () => {
    const html = readerDocument(article, 'https://lejournal.fr/')
    const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('img-src http: https: data:')
    expect(policy).not.toMatch(/script-src|connect-src|frame-src/)
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("base-uri 'none'")
    // The policy comes before anything the page wrote.
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<article>'))
  })

  it('cleans the article before it goes in: nothing that redirects, runs or covers the reader (the policy does not cover a refresh or a style), the images the policy lets load kept', () => {
    const hostile = cleanArticle({
      ...valid,
      content: '<meta http-equiv="refresh" content="0;url=https://evil.example/"><p onclick="x()" class="rp" style="position:fixed">Texte <a href="javascript:alert(1)">lien</a></p><script>alert(1)</script><iframe src="https://evil.example/"></iframe><img src="https://exemple.org/a.png" onerror="x()"><img src="javascript:alert(2)">'
    })!
    const html = readerDocument(hostile, 'https://lejournal.fr/')
    expect(html).toContain('<article><p>Texte <a>lien</a></p><img src="https://exemple.org/a.png"></article>')
    for (const gone of ['http-equiv="refresh"', 'evil.example', 'onclick', 'onerror', 'javascript:', '<script>alert', '<iframe', 'position:fixed', 'class="rp"']) expect(html, gone).not.toContain(gone)
  })

  it('escapes the fields that are not markup', () => {
    const hostile = cleanArticle({ ...valid, title: '<img src=x onerror=alert(1)>', byline: '<script>x</script>', siteName: '"><b>' })!
    const html = readerDocument(hostile, 'https://lejournal.fr/')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>x')
    expect(html).not.toContain('"><b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('goes right to left for an article that does', () => {
    expect(readerDocument({ ...article, lang: 'ar', dir: 'rtl' }, 'https://exemple.sa/')).toContain('lang="ar" dir="rtl"')
  })

  it('follows the light and dark appearance', () => {
    const html = readerDocument(article, 'https://lejournal.fr/')
    expect(html).toContain('prefers-color-scheme:dark')
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
  })
})

describe('what can be read', () => {
  it('is a web page, not a file, a viewer or an extension page', () => {
    expect(canRead('https://exemple.fr/a')).toBe(true)
    expect(canRead('http://exemple.fr/')).toBe(true)
    for (const url of ['file:///tmp/a.html', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'data:text/html,x', '']) expect(canRead(url)).toBe(false)
  })

  it('takes about a minute for 1 300 characters, never less than one', () => {
    expect(readingMinutes(10)).toBe(1)
    expect(readingMinutes(1320)).toBe(1)
    expect(readingMinutes(13_200)).toBe(10)
  })
})
