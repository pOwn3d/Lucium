import { describe, expect, it } from 'vitest'
import { PAGES, demoSite, pageUrl } from './demo'
import { PAGE_HEADERS, PAGE_VARIANTS, PDF_HEADERS, pdfString, respond } from './pages'
import { LANGS, type Lang } from './shots'

/** The pages drawn in HTML; the PDF has tests of its own below. */
const HTML_PAGES = PAGES.filter((p) => p.kind !== 'pdf')

const site = demoSite()
const served = (key: string, lang: Lang) => {
  const url = new URL(pageUrl(key, lang))
  return respond(site, url.host, `${url.pathname}?x=1`)
}

describe('the demonstration pages', () => {
  it('are served for every page of the demonstration, in both languages, under the title the state gives the tab', () => {
    for (const lang of LANGS) {
      for (const page of HTML_PAGES) {
        const answer = served(page.key, lang)
        expect(answer.status, `${page.key} ${lang}`).toBe(200)
        expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8')
        const title = /<title>([^<]*)<\/title>/.exec(answer.body)?.[1]
        expect(title?.replace(/&amp;/g, '&')).toBe(page.title[lang])
        expect(answer.body).toContain(`<html lang="${lang}">`)
      }
    }
  })

  it('load nothing from anywhere: no script, no frame, no address outside the demonstration domain, and headers that forbid it', () => {
    for (const lang of LANGS) {
      for (const page of HTML_PAGES) {
        const html = served(page.key, lang).body
        expect(html).not.toMatch(/<script|<iframe|<object|<embed|@import|@font-face/i)
        const addresses = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!)
        for (const address of addresses) expect(address, `${page.key} ${lang}`).toMatch(/^(data:image\/svg\+xml,|https:\/\/[a-z]+\.example\/)/)
        expect(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')).not.toMatch(/https?:\/\/(?![a-z]+\.example\/)/)
        expect(html).not.toMatch(/url\(\s*["']?https?:/i)
      }
    }
    expect(PAGE_HEADERS['Content-Security-Policy']).toContain("default-src 'none'")
    expect(PAGE_HEADERS['Content-Security-Policy']).toContain('img-src data:')
    expect(PAGE_HEADERS['Content-Security-Policy']).not.toContain('script-src')
  })

  it('follow the appearance of the application, light or dark', () => {
    for (const page of HTML_PAGES) expect(served(page.key, 'fr').body).toContain('@media (prefers-color-scheme: dark)')
  })

  it('speak only English in English (no French accent outside a proper name)', () => {
    for (const page of PAGES) expect(served(page.key, 'en').body.replace(/data:image\/svg\+xml,[^"]*/g, ''), page.key).not.toMatch(/[éèêàçùôîœ]|\\3(51|50|52|40|47|71|64|56)/)
  })

  it('give the notebook the link the Glance opens, to the week’s weather in the same language', () => {
    for (const lang of LANGS) expect(served('notes', lang).body).toContain(`id="peek-link" href="${pageUrl('weather', lang)}"`)
  })

  it('have their own text for each list and each article', () => {
    for (const page of PAGES.filter((p) => p.kind === 'checklist' || p.kind === 'article')) expect(PAGE_VARIANTS[page.kind], page.key).toContain(page.key)
  })

  it('answer a page that is not there with a 404, and a site’s icon at /favicon.ico', () => {
    expect(respond(site, 'carnet.example', '/nowhere').status).toBe(404)
    expect(respond(site, 'unknown.example', '/').status).toBe(404)
    const icon = respond(site, 'meteo.example:443', '/favicon.ico')
    expect(icon.status).toBe(200)
    expect(icon.headers['Content-Type']).toBe('image/svg+xml')
    expect(icon.body.startsWith('<svg')).toBe(true)
  })

  it('give the reader mode an article long enough to be found: several sections of whole sentences', () => {
    for (const lang of LANGS) {
      const html = served('maps', lang).body
      const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      expect(html).toContain('<article>')
      expect((html.match(/<h2>/g) ?? []).length).toBeGreaterThanOrEqual(4)
      expect(text.length).toBeGreaterThan(1200)
    }
  })
})

describe('the PDF report', () => {
  const report = (lang: Lang) => served('report', lang)

  it('is served as a PDF to view, not to download, with no policy the viewer of the engine would have to live with', () => {
    for (const lang of LANGS) {
      const answer = report(lang)
      expect(answer.status).toBe(200)
      expect(answer.headers).toEqual({ ...PDF_HEADERS })
      expect(answer.headers['Content-Type']).toBe('application/pdf')
      expect(Object.keys(answer.headers)).not.toContain('Content-Security-Policy')
      expect(Object.keys(answer.headers)).not.toContain('Content-Disposition')
    }
  })

  it('is a valid one-page PDF in ASCII: each object where the cross-reference table says, and the title of the tab in its information', () => {
    for (const lang of LANGS) {
      const pdf = report(lang).body
      expect(pdf.startsWith('%PDF-1.4\n')).toBe(true)
      expect(pdf.endsWith('%%EOF\n')).toBe(true)
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(pdf)).toBe(true)
      const xref = Number(/startxref\n(\d+)\n/.exec(pdf)![1])
      expect(pdf.slice(xref, xref + 4)).toBe('xref')
      const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
      offsets.forEach((offset, i) => expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`), `objet ${i + 1}`).toBe(true))
      expect(pdf).toContain('/Count 1')
      // The title, in UTF-16 with its byte order mark: the viewer names the tab with it.
      const title = PAGES.find((p) => p.key === 'report')!.title[lang]
      const hex = [...title].map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, '0').toUpperCase()).join('')
      expect(pdf).toContain(`/Title <FEFF${hex}>`)
      // The length of the content stream is the one it declares.
      const stream = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf)!
      expect(stream[2]!.length).toBe(Number(stream[1]))
    }
  })

  it('writes its strings in WinAnsi, escaped and in octal beyond ASCII, and refuses a character the font cannot draw', () => {
    expect(pdfString('Bilan (T3)')).toBe('(Bilan \\(T3\\))')
    expect(pdfString('é’—')).toBe('(\\351\\222\\227)')
    expect(pdfString('a\\b')).toBe('(a\\\\b)')
    expect(() => pdfString('→')).toThrow(/WinAnsi/)
    expect(() => pdfString('\u0085')).toThrow(/WinAnsi/)
  })
})

