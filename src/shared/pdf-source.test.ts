import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { PDF_ADDRESS_MAX, PDF_HEADER_TEMPLATE, escapeHtml, pdfFileName, pdfFooterTemplate, pdfPrintOptions, pdfSourceAddress } from './pdf-source'

const date = new Date(2026, 9, 24, 12)

describe('pdfSourceAddress', () => {
  it('is the address of a web page', () => {
    expect(pdfSourceAddress('https://example.org/a/b?q=1')).toBe('https://example.org/a/b?q=1')
    expect(pdfSourceAddress('http://example.org')).toBe('http://example.org/')
  })

  it('never carries a password, a user name or the fragment', () => {
    expect(pdfSourceAddress('https://moi:secret@example.org/p?x=1#section-3')).toBe('https://example.org/p?x=1')
    expect(pdfSourceAddress('https://token@example.org/')).toBe('https://example.org/')
  })

  it('is nothing for a page that is not on the web, or for something that is not an address', () => {
    for (const url of ['file:///etc/hosts', 'about:blank', 'data:text/html,<b>', 'javascript:alert(1)', 'chrome-extension://abc/page.html', 'view-source:https://a.example/', '', 'not a url', undefined, null, 5]) expect(pdfSourceAddress(url), String(url)).toBeNull()
  })

  it('cuts a very long address', () => {
    const out = pdfSourceAddress(`https://example.org/${'a'.repeat(5000)}`)!
    expect(out.length).toBe(PDF_ADDRESS_MAX + 1)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('pdfFooterTemplate', () => {
  it('holds the address, the date in French and the page counters', () => {
    const html = pdfFooterTemplate('https://example.org/article?id=3', date)!
    expect(html).toContain('https://example.org/article?id=3')
    expect(html).toContain('24 octobre 2026')
    expect(html).toContain('class="pageNumber"')
    expect(html).toContain('class="totalPages"')
    expect(html).toContain('font:8px')
  })

  it('writes the date in English for an interface in English', () => {
    setLanguage('en')
    try {
      const html = pdfFooterTemplate('https://example.org/article?id=3', date)!
      expect(html).toContain('24 October 2026')
      expect(html).not.toContain('octobre')
    } finally {
      setLanguage('fr')
    }
  })

  it('escapes the address: a page cannot put markup in the foot', () => {
    const html = pdfFooterTemplate('https://example.org/?q="><img src=x onerror=alert(1)>&a=\'b\'', date)!
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror=alert(1)>')
    expect(html).toContain('&amp;a=')
    // The URL parser percent-encodes quotes and angle brackets of a query; the escaping still holds for what it lets through.
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })

  it('is null for a page that is not on the web', () => {
    expect(pdfFooterTemplate('about:blank', date)).toBeNull()
  })
})

describe('pdfPrintOptions', () => {
  it('asks for a foot with the address, no header, and a margin that has room for it', () => {
    const options = pdfPrintOptions('https://example.org/', date)!
    expect(options.displayHeaderFooter).toBe(true)
    expect(options.headerTemplate).toBe(PDF_HEADER_TEMPLATE)
    expect(options.footerTemplate).toContain('https://example.org/')
    expect(options.margins.bottom).toBeGreaterThanOrEqual(0.6)
  })

  it('prints nothing for a page without a web address', () => {
    expect(pdfPrintOptions('file:///x.html', date)).toBeNull()
  })
})

describe('pdfFileName on Windows', () => {
  it('holds the rules of Windows when asked: no forbidden character, no device name, a name that fits the folder', () => {
    expect(pdfFileName('Quoi ? "Rien" <ici>', { platform: 'win32' })).toBe('Quoi _ _Rien_ _ici_.pdf')
    expect(pdfFileName('CON', { platform: 'win32' })).toBe('_CON.pdf')
    // The folder is 203 units: 259 - 203 - 1 - 8 leaves 47 for the name, and ".pdf" is added after.
    expect(pdfFileName('a'.repeat(300), { platform: 'win32', folder: `C:\\${'d'.repeat(200)}` })).toBe(`${'a'.repeat(47)}.pdf`)
    // Without a platform nothing changes (macOS).
    expect(pdfFileName('Quoi ? <ici>')).toBe('Quoi ? <ici>.pdf')
  })
})

describe('pdfFileName', () => {
  it('is the title, cleaned, with .pdf once', () => {
    expect(pdfFileName('Rapport 2026')).toBe('Rapport 2026.pdf')
    expect(pdfFileName('déjà.PDF')).toBe('déjà.PDF')
  })

  it('keeps the whole title: a slash or a colon becomes a dash, not the start of a path', () => {
    expect(pdfFileName('AC/DC')).toBe('AC-DC.pdf')
    expect(pdfFileName('Mon article / v2')).toBe('Mon article - v2.pdf')
    expect(pdfFileName('Note : réunion 12:30')).toBe('Note - réunion 12-30.pdf')
    // The rest of the cleaning still applies: a backslash is still a separator, control and reordering characters still go.
    expect(pdfFileName('a\\b')).toBe('b.pdf')
    expect(pdfFileName('AC/DC\u202Efdp.exe')).toBe('AC-DCfdp.exe.pdf')
  })

  it('has a name for a blank or odd title', () => {
    for (const title of ['', '   ', '..', undefined, 3]) expect(pdfFileName(title)).toMatch(/\.pdf$/)
    expect(pdfFileName('')).toBe('page.pdf')
  })
})
