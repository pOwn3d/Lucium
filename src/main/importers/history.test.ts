import { describe, expect, it } from 'vitest'
import { MAX_IMPORTED_PAGES, toHistoryEntries } from './history'

const NOW = Date.UTC(2026, 9, 23)

describe('toHistoryEntries', () => {
  it('keeps web pages only, newest first, with the title or else the address', () => {
    const entries = toHistoryEntries(
      [
        { url: 'https://old.example/', title: 'Old', visits: 2, ms: NOW - 5000 },
        { url: 'https://new.example/', title: '', visits: 1, ms: NOW - 1000 },
        { url: 'file:///etc/passwd', title: 'x', visits: 1, ms: NOW - 1 },
        { url: 'chrome://settings', title: 'x', visits: 1, ms: NOW - 1 },
        { url: 42, title: 'x', visits: 1, ms: NOW - 1 }
      ],
      NOW
    )
    expect(entries.map((e) => [e.url, e.title, e.visitCount])).toEqual([['https://new.example/', 'https://new.example/', 1], ['https://old.example/', 'Old', 2]])
  })

  it('merges a page that appears twice: visits added, latest visit and a real title kept', () => {
    const [entry] = toHistoryEntries(
      [
        { url: 'https://a.example/', title: 'Titre', visits: 3, ms: NOW - 9000 },
        { url: 'https://a.example/', title: '', visits: 2, ms: NOW - 100 }
      ],
      NOW
    )
    expect(entry).toEqual({ url: 'https://a.example/', title: 'Titre', visitCount: 5, lastVisitAt: NOW - 100 })
  })

  it('drops rows without a usable date and never dates a visit in the future', () => {
    const entries = toHistoryEntries(
      [
        { url: 'https://a.example/', title: 'a', visits: 1, ms: 'soon' },
        { url: 'https://b.example/', title: 'b', visits: 1, ms: 0 },
        { url: 'https://c.example/', title: 'c', visits: 1, ms: NOW + 86_400_000 },
        { url: 'https://d.example/', title: 'd', visits: 'many', ms: NOW - 1 }
      ],
      NOW
    )
    expect(entries.map((e) => [e.url, e.lastVisitAt, e.visitCount])).toEqual([['https://c.example/', NOW, 1], ['https://d.example/', NOW - 1, 1]])
  })

  it('refuses an address that only has the prefix of a web page, one of 2 MB, and cuts a long title', () => {
    const entries = toHistoryEntries(
      [
        { url: 'https://', title: 'x', visits: 1, ms: NOW - 1 },
        { url: 'http://exa mple/', title: 'x', visits: 1, ms: NOW - 1 },
        { url: 'https://a.example/\n<x>', title: 'x', visits: 1, ms: NOW - 1 },
        { url: 'https://big.example/' + 'a'.repeat(2_000_000), title: 'x', visits: 1, ms: NOW - 1 },
        { url: 'https://ok.example/', title: 't'.repeat(5000), visits: 1, ms: NOW - 1 }
      ],
      NOW
    )
    expect(entries.map((e) => e.url)).toEqual(['https://ok.example/'])
    expect(entries[0]!.title).toHaveLength(1000)
  })

  it('keeps no more than the history store can hold', () => {
    const rows = Array.from({ length: MAX_IMPORTED_PAGES + 10 }, (_, i) => ({ url: `https://e.example/${i}`, title: 't', visits: 1, ms: NOW - i }))
    const entries = toHistoryEntries(rows, NOW)
    expect(entries).toHaveLength(MAX_IMPORTED_PAGES)
    expect(entries[0]!.url).toBe('https://e.example/0')
  })
})
