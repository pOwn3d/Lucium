// The pages a closed tab keeps: what is kept when it is archived, what is rebuilt when it comes from a file, and the reducer's side of it.

import { describe, expect, it } from 'vitest'
import { CLOSED_HISTORY_MAX, CLOSED_TITLE_MAX, CLOSED_URL_MAX, cleanClosedHistory, closedHistoryOf, isClosedPageUrl } from './closed-history'
import { defaultSettings, type ArchivedTab, type ClosedHistory, type SidebarState } from './model'
import { createInitialState, normalize, parseSavedState, reduce, type Ctx } from './sidebar'

const page = (n: number) => ({ url: `https://site.example/p${n}`, title: `Page ${n}` })
const pages = (count: number) => Array.from({ length: count }, (_, i) => page(i))

describe('isClosedPageUrl (the rule the engine applies again before it replays a list)', () => {
  it('accepts http and https addresses of a bounded length, and nothing else', () => {
    expect(isClosedPageUrl('https://a.example/x')).toBe(true)
    expect(isClosedPageUrl('http://127.0.0.1:8080/')).toBe(true)
    for (const bad of ['file:///etc/hosts', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'javascript:alert(1)', 'data:text/html,x', 'view-source:https://a.example/', 'ftp://a.example/', 'not a url', '', 42, null, undefined, `https://a.example/${'a'.repeat(CLOSED_URL_MAX)}`]) {
      expect(isClosedPageUrl(bad), String(bad).slice(0, 40)).toBe(false)
    }
  })
})

describe('closedHistoryOf', () => {
  it('keeps the pages of the tab, oldest first, and the one it is on', () => {
    const kept = closedHistoryOf(pages(4), 3, 'https://site.example/p3')
    expect(kept).toEqual({ entries: pages(4), index: 3 })
  })

  it('keeps the Forward list too when the user had gone back', () => {
    expect(closedHistoryOf(pages(5), 2, 'https://site.example/p2')).toEqual({ entries: pages(5), index: 2 })
  })

  it('is undefined when there is nothing to bring back: one page, no page, or an index out of the list', () => {
    expect(closedHistoryOf(pages(1), 0, 'https://site.example/p0')).toBeUndefined()
    expect(closedHistoryOf([], 0, 'https://site.example/p0')).toBeUndefined()
    expect(closedHistoryOf(pages(3), 7, 'https://site.example/p2')).toBeUndefined()
    expect(closedHistoryOf(pages(3), -1, 'https://site.example/p2')).toBeUndefined()
    expect(closedHistoryOf(pages(3), 1.5, 'https://site.example/p1')).toBeUndefined()
  })

  it('keeps web addresses only: the other entries are left out and the index follows (this fails if the filter is removed)', () => {
    const mixed = [page(0), { url: 'file:///etc/passwd', title: 'fichier' }, { url: 'javascript:alert(1)', title: 'x' }, { url: 'chrome-extension://abc/page.html', title: 'ext' }, page(1), { url: 'about:blank', title: '' }, page(2)]
    const kept = closedHistoryOf(mixed, 6, 'https://site.example/p2')!
    expect(kept.entries.map((e) => e.url)).toEqual(['https://site.example/p0', 'https://site.example/p1', 'https://site.example/p2'])
    expect(kept.index).toBe(2)
  })

  it('is undefined when the page the tab is on is not the address the tab is archived at, or is not a web page', () => {
    expect(closedHistoryOf(pages(3), 2, 'https://site.example/autre')).toBeUndefined()
    expect(closedHistoryOf([page(0), page(1), { url: 'about:blank', title: '' }], 2, 'about:blank')).toBeUndefined()
  })

  it('keeps at most 20 pages, the window holding the page the tab is on (this fails if the bound is removed)', () => {
    const long = pages(100)
    const atEnd = closedHistoryOf(long, 99, 'https://site.example/p99')!
    expect(atEnd.entries).toHaveLength(CLOSED_HISTORY_MAX)
    expect(atEnd.entries.at(-1)!.url).toBe('https://site.example/p99')
    expect(atEnd.entries[atEnd.index]!.url).toBe('https://site.example/p99')
    const inMiddle = closedHistoryOf(long, 50, 'https://site.example/p50')!
    expect(inMiddle.entries).toHaveLength(CLOSED_HISTORY_MAX)
    expect(inMiddle.entries[inMiddle.index]!.url).toBe('https://site.example/p50')
    expect(inMiddle.entries.length - 1 - inMiddle.index).toBeLessThanOrEqual(5)
    const atStart = closedHistoryOf(long, 0, 'https://site.example/p0')!
    expect(atStart.entries[0]!.url).toBe('https://site.example/p0')
    expect(atStart.index).toBe(0)
    for (let at = 0; at < 100; at++) {
      const kept = closedHistoryOf(long, at, `https://site.example/p${at}`)!
      expect(kept.entries[kept.index]!.url).toBe(`https://site.example/p${at}`)
    }
  })

  it('bounds the length of an address and of a title, and cleans the title', () => {
    const tooLong = { url: `https://site.example/${'a'.repeat(CLOSED_URL_MAX)}`, title: 'long' }
    const kept = closedHistoryOf([tooLong, { url: 'https://site.example/ok', title: `a\nb${'x'.repeat(1000)}` }, page(9)], 2, 'https://site.example/p9')!
    expect(kept.entries.map((e) => e.url)).toEqual(['https://site.example/ok', 'https://site.example/p9'])
    expect(kept.entries[0]!.title.startsWith('a b')).toBe(true)
    expect(kept.entries[0]!.title).toHaveLength(CLOSED_TITLE_MAX)
  })
})

describe('cleanClosedHistory (what comes from a file)', () => {
  const good: ClosedHistory = { entries: pages(3), index: 2 }
  const url = 'https://site.example/p2'

  it('gives back a good history as it is', () => {
    expect(cleanClosedHistory(good, url)).toEqual(good)
  })

  it('refuses what is not a history: the shape, the index, the count', () => {
    const hostile: unknown[] = [null, 'x', [], 3, {}, { entries: 'x', index: 0 }, { entries: pages(3) }, { entries: pages(3), index: 3 }, { entries: pages(3), index: -1 }, { entries: pages(3), index: 1.5 }, { entries: pages(3), index: '2' }, { entries: pages(1), index: 0 }, { entries: pages(CLOSED_HISTORY_MAX + 1), index: 2 }]
    for (const raw of hostile) expect(cleanClosedHistory(raw, url), JSON.stringify(raw)?.slice(0, 60)).toBeUndefined()
  })

  it('refuses a history with an address that is not a web address, or too long (this fails if the file is trusted)', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'ftp://x.example/', `https://x.example/${'a'.repeat(CLOSED_URL_MAX)}`, 42, null]) {
      const raw = { entries: [page(0), { url: bad, title: 'x' }, page(2)], index: 2 }
      expect(cleanClosedHistory(raw, url), String(bad).slice(0, 40)).toBeUndefined()
    }
  })

  it('refuses a history that does not end on the address of its entry', () => {
    expect(cleanClosedHistory(good, 'https://site.example/ailleurs')).toBeUndefined()
  })

  it('rebuilds each page: nothing the model does not know is kept, the title is bounded and cleaned', () => {
    const raw = { entries: [{ ...page(0), extra: 'POLLUTED', pageState: 'x' }, { url: page(1).url, title: 3 }, { ...page(2), title: `a\u0000b${'y'.repeat(900)}` }], index: 2, extra: 1 }
    const clean = cleanClosedHistory(raw, url)!
    expect(JSON.stringify(clean)).not.toContain('POLLUTED')
    expect(clean.entries[1]!.title).toBe('')
    expect(clean.entries[2]!.title).toHaveLength(CLOSED_TITLE_MAX)
    expect(clean.entries[2]!.title).not.toContain('\u0000')
    expect(Object.keys(clean)).toEqual(['entries', 'index'])
  })
})

describe('archiving with the pages of the tab', () => {
  const tab = (id: string, url: string) => ({ id, spaceId: 'sp', url, title: id, pinned: false, createdAt: 1, lastActiveAt: 1 })
  const state = (): SidebarState => {
    const base = createInitialState({ now: 1, newId: () => 'sp' })
    return { ...base, tabs: [tab('a', 'https://site.example/p2'), tab('b', 'https://autre.example/')], activeTabBySpace: { sp: 'a' }, settings: { ...defaultSettings(), reopenHistory: true } }
  }
  const lookup = (id: string): ClosedHistory | undefined => (id === 'a' ? { entries: pages(3), index: 2 } : undefined)
  const ctx = (closedHistory?: Ctx['closedHistory']): Ctx => ({ now: 5, newId: () => 'n', ...(closedHistory ? { closedHistory } : {}) })

  it('keeps the pages next to the archive entry when the context knows them', () => {
    const next = reduce(state(), { type: 'tab/archive', id: 'a' }, ctx(lookup))
    expect(next.archive[0]).toMatchObject({ id: 'a', url: 'https://site.example/p2', history: { entries: pages(3), index: 2 } })
  })

  it('keeps nothing when the context knows nothing (every caller but the main process, and the setting off)', () => {
    const next = reduce(state(), { type: 'tab/archive', id: 'a' }, ctx())
    expect(next.archive[0]).toBeDefined()
    expect(next.archive[0]).not.toHaveProperty('history')
  })

  it('gives each tab of a group its own pages, and nothing to the one that has none', () => {
    const next = reduce(state(), { type: 'tabs/archive-many', ids: ['a', 'b'] }, ctx(lookup))
    const byId = Object.fromEntries(next.archive.map((entry) => [entry.id, entry]))
    expect(byId['a']).toHaveProperty('history')
    expect(byId['b']).not.toHaveProperty('history')
  })

  it('lets go of every list when the setting goes off, and costs nothing once it is off (this fails if the pages are kept)', () => {
    const archived = reduce(state(), { type: 'tab/archive', id: 'a' }, ctx(lookup))
    const off = reduce(archived, { type: 'settings/update', patch: { reopenHistory: false } }, ctx())
    expect(off.archive).toHaveLength(1)
    expect(off.archive[0]).not.toHaveProperty('history')
    expect(JSON.stringify(off)).not.toContain('p1')
    const still = reduce(archived, { type: 'settings/update', patch: { hoverCards: false } }, ctx())
    expect(still.archive[0]).toHaveProperty('history')
  })

  it('is read back from a saved state, and a hostile list in it costs only itself', () => {
    const archived = reduce(state(), { type: 'tab/archive', id: 'a' }, ctx(lookup))
    expect(parseSavedState(JSON.stringify(archived)).archive[0]!.history).toEqual({ entries: pages(3), index: 2 })
    const hostile = { ...archived, archive: [{ ...archived.archive[0]!, history: { entries: [{ url: 'file:///etc/passwd', title: 'x' }, page(2)], index: 1 } }] }
    const loaded = normalize(hostile as unknown as SidebarState)
    expect(loaded.archive).toHaveLength(1)
    expect(loaded.archive[0]).not.toHaveProperty('history')
  })

  it('does not change what reopening an entry does in the reducer: the tab opens at the address of the entry', () => {
    const archived = reduce(state(), { type: 'tab/archive', id: 'a' }, ctx(lookup))
    const reopened = reduce(archived, { type: 'archive/restore-last' }, ctx())
    expect(reopened.tabs.at(-1)).toMatchObject({ url: 'https://site.example/p2' })
    expect(reopened.archive.some((e: ArchivedTab) => e.id === 'a')).toBe(false)
  })
})
