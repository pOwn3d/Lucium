import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: class {} }))

const { MAX_COVER_URL_CHARS, coverUrl } = await import('./page-cover')

const decoded = (url: string): string => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8')

describe('coverUrl', () => {
  it('gives back the document as it is, accents and markup included', () => {
    const html = '<!doctype html><meta charset="utf-8"><p class="x">Été — « déjà » 🙂</p>'
    const url = coverUrl(html)
    expect(url.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true)
    expect(decoded(url)).toBe(html)
  })

  it('fits a long article in French that the percent-encoding put past the limit of Chromium', () => {
    const paragraph = '<p>Le été dernier, à la mer, les élèves ont étudié « l’écume » et la côte.</p>\n'
    const html = `<!doctype html><article>${paragraph.repeat(Math.ceil(900_000 / paragraph.length))}</article>`
    expect(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`.length).toBeGreaterThan(MAX_COVER_URL_CHARS)
    expect(coverUrl(html).length).toBeLessThanOrEqual(MAX_COVER_URL_CHARS)
  })

  it('refuses, with its size, a document that no address can hold', () => {
    expect(() => coverUrl('x'.repeat(2_000_000))).toThrow(/too large to be shown \(\d+ KB as an address, 2048 KB at most\)/)
  })
})
