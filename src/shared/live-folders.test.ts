import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import type { Folder } from './model'
import {
  LIVE_FOLDERS_MAX,
  LIVE_INTERVAL_MS,
  LIVE_ITEMS_MAX,
  LIVE_RETRY_MS,
  afterFailure,
  afterLook,
  cleanLiveFolder,
  cleanLiveItems,
  cleanLiveSource,
  defaultLiveName,
  dueAt,
  isGithubRepo,
  liveFolders,
  liveItemDate,
  liveRequestHeaders,
  liveRequestUrl,
  nextDueFolder,
  nextWakeAt,
  parseLiveSource,
  type LiveFolder
} from './live-folders'

const live = (over: Partial<LiveFolder> = {}): LiveFolder => ({ source: { kind: 'feed', url: 'https://a.example/feed' }, items: [], ...over })
const folder = (id: string, over: Partial<LiveFolder> | null = {}): Folder => ({ id, spaceId: 's', name: id, collapsed: false, ...(over === null ? {} : { live: live(over) }) })

describe('what a person types for a source', () => {
  it('takes owner/name, or a github.com address, for a repository, and the page it is on says what to follow', () => {
    expect(parseLiveSource('owner/repo')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'releases' })
    expect(parseLiveSource('owner/repo', 'commits')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'commits' })
    expect(parseLiveSource('https://github.com/owner/repo')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'releases' })
    expect(parseLiveSource('github.com/owner/repo.git')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'releases' })
    expect(parseLiveSource('https://github.com/owner/repo/issues?q=is%3Aopen')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'issues' })
    expect(parseLiveSource('https://github.com/owner/repo/pull/12')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'pulls' })
    expect(parseLiveSource('https://www.github.com/owner/repo/commits/main', 'releases')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'commits' })
    expect(parseLiveSource('https://github.com/owner/repo/tags')).toEqual({ kind: 'github', repo: 'owner/repo', what: 'tags' })
  })

  it('takes any other http(s) address for a feed, written as the URL parser prints it', () => {
    expect(parseLiveSource(' https://Blog.example/feed.xml ')).toEqual({ kind: 'feed', url: 'https://blog.example/feed.xml' })
    expect(parseLiveSource('http://blog.example/rss')).toEqual({ kind: 'feed', url: 'http://blog.example/rss' })
  })

  it('refuses what is neither: another scheme, a login in the address, a path, a github address with no repository', () => {
    for (const bad of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.example/feed', 'data:text/xml,<rss/>', 'https://user:pass@a.example/feed', 'https://github.com/', 'https://github.com/owner', 'owner/../repo', '../etc/passwd', 'a/b/c', 'pas une adresse', 'x'.repeat(5000), 'https://a.example/' + 'x'.repeat(3000)]) {
      expect(parseLiveSource(bad), bad.slice(0, 40)).toBeNull()
    }
  })

  it('knows a repository name from a path', () => {
    for (const ok of ['o/r', 'Owner-1/repo.name_x', 'a/b.js']) expect(isGithubRepo(ok), ok).toBe(true)
    for (const bad of ['', 'o', 'o/', '/r', 'o/r/x', 'o/.', 'o/..', 'o/r.git', '-o/r', 'o o/r', 'o/r\n', 'o/r?x=1', 7, null]) expect(isGithubRepo(bad), String(bad)).toBe(false)
  })

  it('names a new folder after its source', () => {
    expect(defaultLiveName({ kind: 'feed', url: 'https://www.blog.example/feed' })).toBe('blog.example')
    expect(defaultLiveName({ kind: 'github', repo: 'o/r', what: 'issues' })).toBe('o/r · tickets ouverts')
    // An address that names nothing: a word of the language in use.
    expect(defaultLiveName({ kind: 'feed', url: '' })).toBe('Flux')
    setLanguage('en')
    try {
      expect(defaultLiveName({ kind: 'feed', url: '' })).toBe('Feed')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('the source as a state holds it', () => {
  it('is cleaned: kind, address and repository checked again', () => {
    expect(cleanLiveSource({ kind: 'feed', url: 'https://a.example/x' })).toEqual({ kind: 'feed', url: 'https://a.example/x' })
    expect(cleanLiveSource({ kind: 'github', repo: 'o/r', what: 'pulls', extra: 1 })).toEqual({ kind: 'github', repo: 'o/r', what: 'pulls' })
    for (const bad of [null, 'x', [], {}, { kind: 'feed' }, { kind: 'feed', url: 'javascript:1' }, { kind: 'github', repo: 'o/r', what: 'secrets' }, { kind: 'github', repo: '../x', what: 'releases' }, { kind: 'ftp', url: 'https://a.example/' }]) {
      expect(cleanLiveSource(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('asks GitHub for the public API of the repository only, with no login, and a feed for the address itself', () => {
    expect(liveRequestUrl({ kind: 'feed', url: 'https://a.example/f' })).toBe('https://a.example/f')
    for (const what of ['releases', 'tags', 'commits', 'issues', 'pulls'] as const) {
      expect(liveRequestUrl({ kind: 'github', repo: 'o/r', what }), what).toMatch(/^https:\/\/api\.github\.com\/repos\/o\/r\/(releases|tags|commits|issues|pulls)\?/)
    }
    expect(Object.keys(liveRequestHeaders({ kind: 'github', repo: 'o/r', what: 'tags' })).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'x-github-api-version'])
    for (const source of [{ kind: 'feed', url: 'https://a.example/f' }, { kind: 'github', repo: 'o/r', what: 'tags' }] as const) {
      expect(Object.keys(liveRequestHeaders(source)).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['authorization']))
      expect(Object.keys(liveRequestHeaders(source)).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie']))
    }
  })
})

describe('the live part of a saved folder', () => {
  it('keeps a good one as it is', () => {
    const good: LiveFolder = { source: { kind: 'github', repo: 'o/r', what: 'releases' }, items: [{ title: 'v1', url: 'https://github.com/o/r/releases/tag/v1', at: 5 }], checkedAt: 9, failure: 'HTTP 500' }
    expect(cleanLiveFolder(good)).toEqual(good)
  })

  it('is null when the source is unusable (the folder is then an ordinary one), and repairs the rest', () => {
    expect(cleanLiveFolder({ source: { kind: 'feed', url: 'file:///x' }, items: [] })).toBeNull()
    expect(cleanLiveFolder(null)).toBeNull()
    const out = cleanLiveFolder({ source: { kind: 'feed', url: 'https://a.example/f' }, items: [{ title: 'ok', url: 'https://a.example/1' }, { title: 'dup', url: 'https://a.example/1' }, { title: '', url: 'https://a.example/2' }, { title: 'js', url: 'javascript:1' }, 'x', null], checkedAt: 'hier', failure: '\u0000  ' })
    expect(out).toEqual({ source: { kind: 'feed', url: 'https://a.example/f' }, items: [{ title: 'ok', url: 'https://a.example/1' }] })
  })

  it('keeps at most LIVE_ITEMS_MAX items', () => {
    const many = Array.from({ length: LIVE_ITEMS_MAX + 9 }, (_, i) => ({ title: `T${i}`, url: `https://a.example/${i}` }))
    expect(cleanLiveItems(many)).toHaveLength(LIVE_ITEMS_MAX)
    expect(cleanLiveItems('x')).toEqual([])
  })

  it('looks only at the first LIVE_FOLDERS_MAX live folders', () => {
    const folders = Array.from({ length: LIVE_FOLDERS_MAX + 5 }, (_, i) => folder(`f${i}`))
    expect(liveFolders([folder('plain', null), ...folders])).toHaveLength(LIVE_FOLDERS_MAX)
  })
})

describe('when a folder is due', () => {
  it('is due at once when never looked at, an interval after a look, a longer one after a failure', () => {
    expect(dueAt(live())).toBe(0)
    expect(dueAt(live({ checkedAt: 1000 }))).toBe(1000 + LIVE_INTERVAL_MS)
    expect(dueAt(live({ checkedAt: 1000, failure: 'HTTP 500' }))).toBe(1000 + LIVE_RETRY_MS)
    expect(LIVE_RETRY_MS).toBeGreaterThan(LIVE_INTERVAL_MS)
  })

  it('picks the folder most overdue, and none when none is due', () => {
    const folders = [folder('a', { checkedAt: 5000 }), folder('b', { checkedAt: 1000 }), folder('plain', null), folder('c', { checkedAt: 3000 })]
    expect(nextDueFolder(folders, 1000 + LIVE_INTERVAL_MS)?.id).toBe('b')
    expect(nextDueFolder(folders, 1000 + LIVE_INTERVAL_MS - 1)).toBeNull()
    expect(nextDueFolder([folder('new', {})], 0)?.id).toBe('new')
    expect(nextDueFolder([folder('plain', null)], 10 ** 12)).toBeNull()
  })

  it('has no moment to wake at without a live folder, so that no timer is armed at all', () => {
    expect(nextWakeAt([])).toBeNull()
    expect(nextWakeAt([folder('plain', null)])).toBeNull()
    expect(nextWakeAt([folder('a', { checkedAt: 5000 }), folder('b', { checkedAt: 1000 })])).toBe(1000 + LIVE_INTERVAL_MS)
  })

  it('records a look that worked (no failure left) and one that failed (the last items stay, the reason is told)', () => {
    const before = live({ items: [{ title: 'ancien', url: 'https://a.example/old' }], failure: 'HTTP 500', checkedAt: 1 })
    const worked = afterLook(before, [{ title: 'neuf', url: 'https://a.example/new' }], 99)
    expect(worked).toEqual({ source: before.source, items: [{ title: 'neuf', url: 'https://a.example/new' }], checkedAt: 99 })
    const failed = afterFailure(before, 'Délai dépassé\u0000', 100)
    expect(failed).toMatchObject({ items: before.items, checkedAt: 100, failure: 'Délai dépassé' })
    expect(afterFailure(before, '   ', 100).failure).toBe('Lecture impossible.')
  })
})

describe('the date of an item, in the tooltip of its row', () => {
  const at = new Date(2026, 9, 24, 12).getTime()

  it('is written in figures in French, and with the month as a word in English, where figures alone do not say which is the day', () => {
    expect(liveItemDate(at)).toBe('24/10/2026')
    setLanguage('en')
    try {
      expect(liveItemDate(at)).toBe('24 Oct 2026')
    } finally {
      setLanguage('fr')
    }
  })

  it('is nothing for an item that has none', () => {
    expect(liveItemDate(undefined)).toBe('')
  })
})
