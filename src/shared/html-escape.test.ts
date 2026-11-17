import { describe, expect, it } from 'vitest'
import { escapeHtml } from './html-escape'
import { escapeHtml as bookmarksEscape } from './bookmarks-html'
import { escapeText } from './error-page-template'
import { escapeHtml as errorPagesEscape } from './error-pages'
import { escapeHtml as pdfEscape } from './pdf-source'

describe('the escape of a text put into HTML', () => {
  it('replaces the five characters HTML reads, and only them', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;')
    expect(escapeHtml('déjà vu — 🎉')).toBe('déjà vu — 🎉')
    expect(escapeHtml('')).toBe('')
  })

  it('escapes an ampersand once, even in a text that already holds an entity', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  it('is the escape of the error pages, of the reader (through error-pages.ts) and of the PDF foot', () => {
    expect(escapeText).toBe(escapeHtml)
    expect(errorPagesEscape).toBe(escapeHtml)
    expect(pdfEscape).toBe(escapeHtml)
  })

  it('is the escape of the bookmarks file too, which first turns the control characters into spaces', () => {
    expect(bookmarksEscape('a\u0000b\n<c>')).toBe('a b &lt;c&gt;')
    expect(bookmarksEscape(`"'&`)).toBe(escapeHtml(`"'&`))
  })
})
