import { setLanguage } from './i18n'
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from './model'
import {
  BOOKMARK_FAVORITES,
  BOOKMARK_PINNED,
  BOOKMARK_ROOT,
  BROWSING_ORIGINS_MAX,
  DATA_API_EVENTS,
  DATA_API_METHODS,
  HISTORY_DEFAULT_WINDOW_MS,
  HISTORY_MAX_RESULTS,
  bare,
  bookmarkIds,
  bookmarkIndex,
  bookmarkTree,
  browsingDataSettings,
  historyUrl,
  parseBrowsingData,
  parseHistoryQuery,
  recentBookmarks,
  searchBookmarks,
  searchHistory,
  visitsOf,
  type BookmarkSource
} from './extension-data'

const NOW = 1_800_000_000_000
const entry = (url: string, title: string, minutesAgo: number, visitCount = 1): HistoryEntry => ({ url, title, visitCount, lastVisitAt: NOW - minutesAgo * 60_000 })

describe('parseHistoryQuery', () => {
  it('reads a query with the defaults of the API: the last 24 hours and 100 results unless told otherwise', () => {
    expect(parseHistoryQuery({ text: 'git' }, NOW)).toEqual({ text: 'git', startTime: NOW - HISTORY_DEFAULT_WINDOW_MS, endTime: NOW + 1, maxResults: 100 })
    expect(parseHistoryQuery({ text: '', startTime: 5, endTime: 9, maxResults: 3 }, NOW)).toEqual({ text: '', startTime: 5, endTime: 9, maxResults: 3 })
  })

  it('refuses what is not a query, and bounds the number of results', () => {
    for (const bad of [undefined, null, 'text', [], {}, { text: 3 }, { text: 'x'.repeat(501) }]) expect(parseHistoryQuery(bad, NOW)).toBeNull()
    expect(parseHistoryQuery({ text: '', maxResults: 1e9 }, NOW)!.maxResults).toBe(HISTORY_MAX_RESULTS)
    expect(parseHistoryQuery({ text: '', maxResults: -4 }, NOW)!.maxResults).toBe(100)
    expect(parseHistoryQuery({ text: '', startTime: 'yesterday', endTime: Infinity }, NOW)).toMatchObject({ endTime: NOW + 1 })
  })
})

describe('searchHistory', () => {
  const entries = [
    entry('https://github.com/anthropics', 'Anthropic on GitHub', 5, 4),
    entry('https://example.com/git-guide', 'A guide', 30),
    entry('https://news.example/today', 'News', 90),
    entry('https://old.example/', 'Old page', 60 * 48)
  ]
  const query = (over: Record<string, unknown> = {}) => parseHistoryQuery({ text: '', ...over }, NOW)!

  it('lists the last day, most recent first, in the API\'s item shape', () => {
    const found = searchHistory(entries, query())
    expect(found.map((item) => item.url)).toEqual(['https://github.com/anthropics', 'https://example.com/git-guide', 'https://news.example/today'])
    expect(found[0]).toMatchObject({ title: 'Anthropic on GitHub', visitCount: 4, typedCount: 0, lastVisitTime: NOW - 5 * 60_000 })
    expect(typeof found[0]!.id).toBe('string')
  })

  it('matches every word in the title or the address, not letters scattered in order', () => {
    expect(searchHistory(entries, query({ text: 'git' })).map((item) => item.url)).toEqual(['https://github.com/anthropics', 'https://example.com/git-guide'])
    expect(searchHistory(entries, query({ text: 'GITHUB anthropic' })).map((item) => item.url)).toEqual(['https://github.com/anthropics'])
    expect(searchHistory(entries, query({ text: 'gtb' }))).toEqual([])
  })

  it('keeps to the time range and the number of results', () => {
    expect(searchHistory(entries, query({ startTime: 0, endTime: NOW + 1 }))).toHaveLength(4)
    expect(searchHistory(entries, query({ maxResults: 1 }))).toHaveLength(1)
    expect(searchHistory(entries, query({ maxResults: 0 }))).toEqual([])
    // The end of the range is exclusive, as in the API.
    expect(searchHistory(entries, query({ startTime: NOW - 5 * 60_000, endTime: NOW - 5 * 60_000 }))).toEqual([])
  })

  it('includes a page visited in the very millisecond of the search when no end is given, and leaves one out at an explicit end', () => {
    const now = [entry('https://now.example/', 'Now', 0)]
    expect(searchHistory(now, query())).toHaveLength(1)
    expect(searchHistory(now, query({ endTime: NOW }))).toEqual([])
  })

  it('gives the same id to the same page, and another to another page', () => {
    const [a, b] = searchHistory(entries, query())
    expect(searchHistory(entries, query())[0]!.id).toBe(a!.id)
    expect(a!.id).not.toBe(b!.id)
  })
})

describe('getVisits', () => {
  it('shows the last visit of a page it knows, nothing for one it does not', () => {
    const visits = visitsOf(entry('https://a.example/', 'A', 3))
    expect(visits).toHaveLength(1)
    expect(visits[0]).toMatchObject({ visitTime: NOW - 3 * 60_000, transition: 'link', referringVisitId: '0' })
    expect(visitsOf(undefined)).toEqual([])
  })

  it('takes only a web address', () => {
    expect(historyUrl({ url: 'https://a.example/x' })).toBe('https://a.example/x')
    for (const bad of [undefined, {}, { url: 3 }, { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'https://' }, { url: `https://a.example/${'x'.repeat(9000)}` }]) expect(historyUrl(bad)).toBeNull()
  })
})

// ---------- bookmarks ----------

const source = (): BookmarkSource => ({
  favorites: [
    { id: 'f1', url: 'https://mail.example/', title: 'Mail', profileId: 'default' },
    { id: 'f2', url: 'https://cal.example/', title: 'Agenda', profileId: 'default' },
    { id: 'f3', url: 'https://work-mail.example/', title: 'Courrier pro', profileId: 'work' }
  ],
  spaces: [
    { id: 's1', name: 'Maison', emoji: '🏠', profileId: 'default' },
    { id: 's2', name: 'Travail', emoji: '💼', profileId: 'work' }
  ],
  folders: [
    { id: 'd1', spaceId: 's1', name: 'Docs' },
    { id: 'd2', spaceId: 's1', name: 'Sous-dossier', parentId: 'd1' },
    { id: 'd3', spaceId: 's2', name: 'Secret' }
  ],
  tabs: [
    { id: 't1', spaceId: 's1', url: 'https://loose.example/', title: 'Loose', pinned: true, createdAt: 30 },
    { id: 't2', spaceId: 's1', url: 'https://doc.example/', title: 'Doc', customTitle: ' Mon doc ', pinned: true, folderId: 'd1', createdAt: 20 },
    { id: 't3', spaceId: 's1', url: 'https://deep.example/', title: 'Deep', pinned: true, folderId: 'd2', createdAt: 10 },
    { id: 't4', spaceId: 's1', url: 'https://today.example/', title: 'Today', pinned: false, createdAt: 40 },
    { id: 't5', spaceId: 's2', url: 'https://work-only.example/', title: 'Work only', pinned: true, folderId: 'd3', createdAt: 50 },
    { id: 't6', spaceId: 's1', url: 'https://orphan.example/', title: 'Orphan', pinned: true, folderId: 'gone', createdAt: 5 }
  ]
})

describe('bookmarkTree', () => {
  it('has the favourites in a bar and the pinned tabs of the profile in folders, nothing of another profile', () => {
    const tree = bookmarkTree(source(), 'default')
    expect(tree.id).toBe(BOOKMARK_ROOT)
    expect(tree.children!.map((node) => node.id)).toEqual([BOOKMARK_FAVORITES, BOOKMARK_PINNED])
    const [bar, pinned] = tree.children!
    expect(bar!.children!.map((node) => [node.title, node.url])).toEqual([['Mail', 'https://mail.example/'], ['Agenda', 'https://cal.example/']])
    expect(pinned!.children!.map((node) => node.title)).toEqual(['🏠 Maison'])
    const urls = [...bookmarkIndex(tree).values()].map((node) => node.url).filter(Boolean)
    expect(urls).not.toContain('https://work-only.example/')
    expect(urls).not.toContain('https://today.example/')
    expect(JSON.stringify(tree)).not.toContain('Secret')
  })

  it('names its two folders in the language in use', () => {
    expect(bookmarkTree(source(), 'default').children!.map((node) => node.title)).toEqual(['Favoris', 'Onglets épinglés'])
    setLanguage('en')
    try {
      expect(bookmarkTree(source(), 'default').children!.map((node) => node.title)).toEqual(['Favorites', 'Pinned tabs'])
    } finally {
      setLanguage('fr')
    }
  })

  it('nests the folders of a space, titles a tab by the name the user gave it, and leaves an orphan loose', () => {
    const space = bookmarkTree(source(), 'default').children![1]!.children![0]!
    const titles = (node: { children?: Array<{ title: string; children?: unknown[] }> }) => (node.children ?? []).map((child) => child.title)
    expect(titles(space)).toEqual(['Docs', 'Loose', 'Orphan'])
    const docs = space.children![0]!
    expect(titles(docs)).toEqual(['Sous-dossier', 'Mon doc'])
    expect(titles(docs.children![0]!)).toEqual(['Deep'])
  })

  it('numbers children and points each at its parent', () => {
    const index = bookmarkIndex(bookmarkTree(source(), 'default'))
    for (const node of index.values()) {
      if (node.id === BOOKMARK_ROOT) continue
      const parent = index.get(node.parentId!)
      expect(parent?.children?.[node.index!]).toBe(node)
    }
  })

  it('shows the other profile its own pinned tabs and its own favourites, nothing of the first one\'s', () => {
    const tree = bookmarkTree(source(), 'work')
    const urls = [...bookmarkIndex(tree).values()].map((node) => node.url).filter(Boolean)
    expect(urls).toContain('https://work-only.example/')
    expect(urls).toContain('https://work-mail.example/')
    expect(urls).not.toContain('https://mail.example/')
    expect(urls).not.toContain('https://loose.example/')
  })

  it('survives a loop of folders, and is bounded', () => {
    const looped = source()
    looped.folders = [
      { id: 'a', spaceId: 's1', name: 'A', parentId: 'b' },
      { id: 'b', spaceId: 's1', name: 'B', parentId: 'a' }
    ]
    looped.tabs = [{ id: 'tl', spaceId: 's1', url: 'https://in-loop.example/', title: 'In a loop', pinned: true, folderId: 'a', createdAt: 1 }]
    // The folders of a loop hang from nothing: they are not listed, and the tree is still finite.
    expect(() => bookmarkTree(looped, 'default')).not.toThrow()
    expect(JSON.stringify(bookmarkTree(looped, 'default'))).not.toContain('in-loop.example')
    const huge = source()
    huge.favorites = Array.from({ length: 20_000 }, (_, i) => ({ id: `f${i}`, url: `https://x.example/${i}`, title: String(i) }))
    expect(bookmarkIndex(bookmarkTree(huge, 'default')).size).toBeLessThanOrEqual(5010)
  })
})

describe('reading bookmarks', () => {
  const tree = bookmarkTree(source(), 'default')

  it('searches links by words, by exact address and by exact title, and never returns a folder', () => {
    expect(searchBookmarks(tree, 'mail')!.map((node) => node.title)).toEqual(['Mail'])
    expect(searchBookmarks(tree, { url: 'https://cal.example/' })!.map((node) => node.title)).toEqual(['Agenda'])
    expect(searchBookmarks(tree, { title: 'Mon doc' })!).toHaveLength(1)
    expect(searchBookmarks(tree, 'Docs')).toEqual([])
    expect(searchBookmarks(tree, 'mail')![0]).not.toHaveProperty('children')
  })

  it('refuses a search that is neither a text nor an object', () => {
    for (const bad of [undefined, null, 3, ['mail']]) expect(searchBookmarks(tree, bad)).toBeNull()
  })

  it('lists the most recently added first and bounds the count', () => {
    expect(recentBookmarks(tree, 2)!.map((node) => node.title)).toEqual(['Loose', 'Mon doc'])
    for (const bad of [0, -1, 1.5, '3', 2000, undefined]) expect(recentBookmarks(tree, bad)).toBeNull()
  })

  it('takes one id or a list of ids, a bounded list', () => {
    expect(bookmarkIds('1')).toEqual(['1'])
    expect(bookmarkIds(['1', '2'])).toEqual(['1', '2'])
    for (const bad of [[], 3, [3], null, Array.from({ length: 101 }, () => 'x')]) expect(bookmarkIds(bad)).toBeNull()
  })

  it('hands a node out without its children', () => {
    expect(bare(tree.children![0]!)).not.toHaveProperty('children')
    expect(tree.children![0]).toHaveProperty('children')
  })
})

// ---------- browsingData ----------

describe('parseBrowsingData', () => {
  const ok = (options: unknown, types: unknown) => {
    const parsed = parseBrowsingData(options, types)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.request
  }
  const error = (options: unknown, types: unknown) => {
    const parsed = parseBrowsingData(options, types)
    return parsed.ok ? null : parsed.error
  }

  it('erases the named sites\' data: one entry per site, with the origins that were named', () => {
    const request = ok({ origins: ['https://a.example', 'http://a.example', 'https://b.example:8443'] }, { cookies: true, localStorage: true, cache: false })
    expect(request.types).toEqual(['cookies', 'localStorage'])
    expect(request.sites).toEqual([
      { host: 'a.example', origins: ['https://a.example', 'http://a.example'] },
      { host: 'b.example:8443', origins: ['https://b.example:8443'] }
    ])
  })

  it('refuses a call without origins, which would mean everything: Lucium never erases that for an extension', () => {
    expect(error({}, { cookies: true })).toMatch(/origins/)
    expect(error(undefined, { cookies: true })).toMatch(/origins/)
    expect(error({ origins: [] }, { cookies: true })).toMatch(/origins/)
    expect(error({ since: 0 }, { cache: true })).toMatch(/origins/)
  })

  it('refuses a start time, because the storage cannot be erased by date', () => {
    expect(error({ origins: ['https://a.example'], since: 1_700_000_000_000 }, { cache: true })).toMatch(/since/)
    expect(ok({ origins: ['https://a.example'], since: 0 }, { cache: true }).types).toEqual(['cache'])
  })

  it('refuses what is not a plain web origin', () => {
    for (const origin of ['https://a.example/', 'https://a.example/path', 'ftp://a.example', 'file:///', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'javascript:1', 'a.example', 3, null, 'https://', `https://${'a'.repeat(300)}.example`]) {
      expect(error({ origins: [origin] }, { cookies: true }), String(origin)).not.toBeNull()
    }
  })

  it('refuses the kinds of data it does not erase, and an empty choice', () => {
    for (const name of ['passwords', 'formData', 'downloads', 'fileSystems', 'webSQL', 'appcache', 'pluginData', 'unknown', '__proto__', 'constructor', 'toString']) {
      expect(error({ origins: ['https://a.example'] }, { [name]: true }), name).toMatch(/does not erase/)
    }
    expect(error({ origins: ['https://a.example'] }, { passwords: false, cookies: false })).toMatch(/No data type/)
    expect(error({ origins: ['https://a.example'] }, {})).toMatch(/No data type/)
    expect(error({ origins: ['https://a.example'] }, 'cookies')).toMatch(/Invalid data types/)
    expect(error('x', { cookies: true })).toMatch(/Invalid options/)
  })

  it('bounds the number of origins', () => {
    const many = Array.from({ length: BROWSING_ORIGINS_MAX + 1 }, (_, i) => `https://s${i}.example`)
    expect(error({ origins: many }, { cookies: true })).toMatch(/At most/)
    expect(ok({ origins: many.slice(0, BROWSING_ORIGINS_MAX) }, { cookies: true }).sites).toHaveLength(BROWSING_ORIGINS_MAX)
  })

  it('leaves out the origins that are excluded, and refuses an exclusion that leaves nothing', () => {
    expect(ok({ origins: ['https://a.example', 'https://b.example'], excludeOrigins: ['https://b.example'] }, { cookies: true }).sites.map((site) => site.host)).toEqual(['a.example'])
    expect(error({ origins: ['https://a.example'], excludeOrigins: ['https://a.example'] }, { cookies: true })).toMatch(/excluded/)
    expect(error({ excludeOrigins: ['https://a.example'] }, { cookies: true })).toMatch(/origins/)
  })

  it('knows the history of a site as a kind of data', () => {
    expect(ok({ origins: ['https://a.example'] }, { history: true, cache: true }).types).toEqual(['history', 'cache'])
  })

  it('says what can be removed and what cannot', () => {
    const settings = browsingDataSettings()
    expect(settings.dataRemovalPermitted).toMatchObject({ cookies: true, cache: true, history: true, passwords: false, downloads: false })
    expect(Object.values(settings.dataToRemove).every((v) => v === false)).toBe(true)
  })
})

describe('the methods of each API', () => {
  it('list the same APIs as the events', () => {
    expect(Object.keys(DATA_API_METHODS).sort()).toEqual(Object.keys(DATA_API_EVENTS).sort())
    for (const names of Object.values(DATA_API_METHODS)) expect(new Set(names).size).toBe(names.length)
  })
})
