import { describe, expect, it } from 'vitest'
import { PAGE_INDEX_PAGES_MAX, PAGE_INDEX_SCRIPT, PAGE_INDEX_TEXT_MAX, PAGE_INDEX_TITLE_MAX, PAGE_INDEX_TOTAL_MAX, cleanIndex, cleanIndexText, indexableUrl, searchIndex, withPage, type IndexedPage } from './page-index'

const text = (s: string): string => `${s} ${'lorem ipsum dolor sit amet '.repeat(3)}`
const page = (url: string, body: string, at = 1, title = 'T'): IndexedPage => ({ url, title, text: text(body), at })

describe('indexableUrl', () => {
  it('accepts web pages only, without a login in the address', () => {
    expect(indexableUrl('https://example.org/a')).toBe(true)
    expect(indexableUrl('http://example.org/')).toBe(true)
    expect(indexableUrl('https://user:pw@example.org/')).toBe(false)
    expect(indexableUrl('file:///etc/passwd')).toBe(false)
    expect(indexableUrl('lucium://settings')).toBe(false)
    expect(indexableUrl('not a url')).toBe(false)
    expect(indexableUrl(`https://example.org/${'a'.repeat(3000)}`)).toBe(false)
  })
})

describe('cleanIndexText', () => {
  it('folds whitespace and control characters and cuts at the bound', () => {
    expect(cleanIndexText('a \n\t b\u0000c')).toBe('a b c')
    expect(cleanIndexText('x'.repeat(PAGE_INDEX_TEXT_MAX + 50))).toHaveLength(PAGE_INDEX_TEXT_MAX)
    expect(cleanIndexText(42)).toBe('')
  })
})

describe('withPage', () => {
  it('puts the page first and replaces the one at the same address', () => {
    const first = withPage([], page('https://a.org/', 'alpha', 1))
    const second = withPage(first, page('https://b.org/', 'beta', 2))
    const again = withPage(second, page('https://a.org/', 'gamma', 3))
    expect(again.map((p) => p.url)).toEqual(['https://a.org/', 'https://b.org/'])
    expect(again[0]!.text).toContain('gamma')
  })
  it('leaves out a page with almost no text and an address that is not indexable', () => {
    expect(withPage([], { url: 'https://a.org/', title: '', text: 'ok', at: 1 })).toEqual([])
    expect(withPage([], page('file:///x', 'alpha'))).toEqual([])
  })
  it('drops the oldest pages past the count bound', () => {
    let pages: IndexedPage[] = []
    for (let i = 0; i < PAGE_INDEX_PAGES_MAX + 5; i++) pages = withPage(pages, page(`https://a.org/${i}`, `p${i}`, i))
    expect(pages).toHaveLength(PAGE_INDEX_PAGES_MAX)
    expect(pages[0]!.url).toBe(`https://a.org/${PAGE_INDEX_PAGES_MAX + 4}`)
    expect(pages.some((p) => p.url === 'https://a.org/0')).toBe(false)
  })
  it('drops the oldest pages past the size bound', () => {
    const big = 'x'.repeat(PAGE_INDEX_TEXT_MAX - 10)
    let pages: IndexedPage[] = []
    const count = Math.ceil(PAGE_INDEX_TOTAL_MAX / PAGE_INDEX_TEXT_MAX) + 20
    for (let i = 0; i < count; i++) pages = withPage(pages, { url: `https://a.org/${i}`, title: '', text: big, at: i })
    expect(pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(PAGE_INDEX_TOTAL_MAX)
    expect(pages.length).toBeLessThan(count)
    expect(pages[0]!.url).toBe(`https://a.org/${count - 1}`)
  })
})

describe('cleanIndex', () => {
  it('rebuilds each page and leaves out the invalid ones and the duplicates', () => {
    const raw = page('https://a.org/', 'alpha')
    const good = { ...raw, text: cleanIndexText(raw.text) }
    expect(cleanIndex([good, good, { url: 'file:///x', text: good.text, at: 1 }, null, 'x', { url: 'https://b.org/', text: 'short', at: 1 }])).toEqual([good])
    expect(cleanIndex({ not: 'a list' })).toEqual([])
  })
  // A file on the disk is read back as hostile: the bounds the writes keep are applied again, whatever the file says.
  it('keeps at most PAGE_INDEX_PAGES_MAX pages of a file that holds more, the first ones', () => {
    const raw = Array.from({ length: PAGE_INDEX_PAGES_MAX + 25 }, (_, i) => ({ url: `https://a.org/${i}`, title: '', text: `page number ${i} with enough text to be kept`, at: i }))
    const pages = cleanIndex(raw)
    expect(pages).toHaveLength(PAGE_INDEX_PAGES_MAX)
    expect(pages[0]!.url).toBe('https://a.org/0')
    expect(pages.at(-1)!.url).toBe(`https://a.org/${PAGE_INDEX_PAGES_MAX - 1}`)
  })
  it('drops the oldest pages of a file whose text is past PAGE_INDEX_TOTAL_MAX characters in all', () => {
    const text = 'x'.repeat(PAGE_INDEX_TEXT_MAX)
    const count = Math.ceil(PAGE_INDEX_TOTAL_MAX / PAGE_INDEX_TEXT_MAX) + 20
    const pages = cleanIndex(Array.from({ length: count }, (_, i) => ({ url: `https://a.org/${i}`, title: '', text, at: i })))
    expect(pages.length).toBeLessThan(count)
    expect(pages.reduce((n, p) => n + p.text.length + p.url.length + p.title.length, 0)).toBeLessThanOrEqual(PAGE_INDEX_TOTAL_MAX)
    expect(pages[0]!.url).toBe('https://a.org/0')
  })
  it('cuts the text of one page of a file at PAGE_INDEX_TEXT_MAX characters, and its title at PAGE_INDEX_TITLE_MAX', () => {
    const [only] = cleanIndex([{ url: 'https://a.org/', title: 't'.repeat(PAGE_INDEX_TITLE_MAX * 3), text: 'y'.repeat(PAGE_INDEX_TEXT_MAX * 5), at: 1 }])
    expect(only!.text).toHaveLength(PAGE_INDEX_TEXT_MAX)
    expect(only!.title).toHaveLength(PAGE_INDEX_TITLE_MAX)
  })
})

describe('searchIndex', () => {
  const pages = [page('https://a.org/', 'Le château de Chambord au bord de la Loire', 1, 'Voyage'), page('https://b.org/', 'Recette de la tarte Tatin aux pommes', 2, 'Cuisine'), page('https://c.org/', 'Loire et château: pas la même phrase', 3, 'Autre')]
  it('finds a page by a phrase it holds, accents and case ignored', () => {
    expect(searchIndex(pages, 'CHATEAU chambord').map((m) => m.url)).toEqual(['https://a.org/'])
    expect(searchIndex(pages, 'tarte tatin')[0]!.snippet).toContain('tarte Tatin')
  })
  it('asks for every word, ranks the exact phrase first then the most recent', () => {
    expect(searchIndex(pages, 'loire château').map((m) => m.url)).toEqual(['https://c.org/', 'https://a.org/'])
    expect(searchIndex(pages, 'château de chambord')[0]!.url).toBe('https://a.org/')
  })
  it('lists nothing for an empty search or a word nobody holds', () => {
    expect(searchIndex(pages, '   ')).toEqual([])
    expect(searchIndex(pages, 'zzzz')).toEqual([])
  })
  it('honours the limit', () => {
    expect(searchIndex(pages, 'loire', 1)).toHaveLength(1)
  })
})

describe('PAGE_INDEX_SCRIPT', () => {
  it('skips password pages and takes fields out of the text', () => {
    expect(PAGE_INDEX_SCRIPT).toContain('input[type="password"]')
    expect(PAGE_INDEX_SCRIPT).toContain('textarea')
    expect(PAGE_INDEX_SCRIPT).toContain('[contenteditable]')
  })
})

describe('snippets', () => {
  it('are cut where the words are, even after many accented letters', () => {
    const lead = 'été éléphant à côté '.repeat(400)
    const [match] = searchIndex([page('https://a.org/', `${lead}la tarte Tatin finale`)], 'tatin')
    expect(match!.snippet).toContain('tarte Tatin')
    const [decomposed] = searchIndex([page('https://b.org/', `${'été '.repeat(500)}la tarte Tatin finale`)], 'tatin')
    expect(decomposed!.snippet).toContain('tarte Tatin')
  })
  it('finds an accented word by its plain spelling and the reverse', () => {
    expect(searchIndex([page('https://a.org/', 'Un été à Besançon')], 'besancon')).toHaveLength(1)
    expect(searchIndex([page('https://a.org/', 'Un ete a Besancon')], 'été')).toHaveLength(1)
  })
})
