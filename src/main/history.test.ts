import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchScore } from '@shared/command-bar'
import type { HistoryEntry } from '@shared/model'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { FORGOTTEN_KEPT_MAX, FORGOTTEN_KEPT_MS, HistoryBook, HistoryStore, firstOf, historyFileName, profileOfHistoryFile } from './history'
import { takePersistenceNotices } from './persistence-notices'
import { tempDir } from './temp-dir'

const dir = () => tempDir('lucium-history-')
afterEach(() => {
  vi.restoreAllMocks()
  takePersistenceNotices()
})

// The notice that offers « Annuler » lasts 8 s and waits while the pointer or the focus is on it: the page must still be there when its click
// comes, or « Annuler » answers « Remise impossible ».
it('keeps a forgotten page well past the notice that offers to put it back', () => {
  expect(FORGOTTEN_KEPT_MS).toBeGreaterThanOrEqual(3 * ACTION_NOTICE_MS)
})

describe('HistoryStore', () => {
  it('counts repeat visits, keeps the last title and ignores non-web URLs', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A', 1)
    h.record('https://a.fr/', '', 2)
    h.record('chrome-extension://x/page.html', 'ext', 3)
    h.record('javascript:alert(1)', 'bad', 4)
    // The Extensions page (a tab at lucium-ui://extensions/) is a visit to no site: it never enters the history.
    for (const page of ['lucium-ui://extensions/', 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${'a'.repeat(32)}`]) h.record(page, 'Extensions', 5)
    expect(h.size()).toBe(1)
    expect(h.search('')[0]).toMatchObject({ url: 'https://a.fr/', title: 'A', visitCount: 2, lastVisitAt: 2 })
  })

  it('merges pages from another browser without counting them twice when imported again', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'Ma page', 100)
    const imported = [
      { url: 'https://a.fr/', title: 'Titre de Chrome', visitCount: 1, lastVisitAt: 50 },
      { url: 'https://b.fr/', title: 'B', visitCount: 7, lastVisitAt: 300 },
      { url: 'javascript:alert(1)', title: 'bad', visitCount: 1, lastVisitAt: 1 }
    ]
    expect(h.merge(imported)).toBe(1)
    expect(h.search('').map((e) => [e.url, e.title, e.visitCount, e.lastVisitAt])).toEqual([['https://b.fr/', 'B', 7, 300], ['https://a.fr/', 'Ma page', 1, 100]])
    expect(h.merge(imported)).toBe(0)
    expect(h.size()).toBe(2)
  })

  it('ranks matches and falls back to recency for an empty query', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://news.example/', 'Actualités', 1)
    h.record('https://docs.example/news', 'Documentation', 2)
    expect(h.search('actu').map((e) => e.url)).toEqual(['https://news.example/'])
    expect(h.search('').map((e) => e.url)).toEqual(['https://docs.example/news', 'https://news.example/'])
  })

  it('searches loosely: the letters of a query in order are enough, so “is this address recorded?” is read off the entries, not asked of search()', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://decoy.example/p1x-secret-notes', 'Autre chose', 1)
    expect(h.search('P1-secret').map((e) => e.url)).toEqual(['https://decoy.example/p1x-secret-notes'])
    expect(h.search('', 100).some((e) => e.url.includes('P1-secret'))).toBe(false)
  })

  it('forgets one page and says whether it was there', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    h.record('https://a.fr/', 'A', 1)
    h.record('https://b.fr/', 'B', 2)
    expect(h.remove('https://a.fr/')).toBe(true)
    expect(h.remove('https://a.fr/')).toBe(false)
    h.flush()
    expect(new HistoryStore(path).search('').map((e) => e.url)).toEqual(['https://b.fr/'])
  })

  it('returns as many entries as asked for', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    for (let i = 0; i < 30; i++) h.record(`https://a.fr/${i}`, `Page ${i}`, i)
    expect(h.search('')).toHaveLength(20)
    expect(h.search('', 25)).toHaveLength(25)
  })

  it('round-trips through the file', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    h.record('https://a.fr/', 'A', 1)
    h.flush()
    expect(new HistoryStore(path).search('a')).toHaveLength(1)
  })

  it('reads a file an editor saved with a byte-order mark: the pages are there and nothing is put aside', () => {
    const folder = dir()
    const path = join(folder, 'h.json')
    writeFileSync(path, `\uFEFF${JSON.stringify([{ url: 'https://a.fr/', title: 'A', visitCount: 1, lastVisitAt: 5 }])}`)
    expect(new HistoryStore(path).search('a')).toHaveLength(1)
    expect(readdirSync(folder)).toEqual(['h.json'])
  })

  it('moves an unreadable file aside and logs, instead of crashing or wiping it', () => {
    const folder = dir()
    const path = join(folder, 'h.json')
    writeFileSync(path, '{ nope')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = new HistoryStore(path)
    expect(h.size()).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(folder).some((f) => f.includes('.corrupt-'))).toBe(true)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable'))
  })

  it('forgets every page of a span of time, its start included and its end not, and says how many', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    h.record('https://before.fr/', 'Avant', 99)
    h.record('https://first.fr/', 'Premier', 100)
    h.record('https://middle.fr/', 'Milieu', 150)
    h.record('https://end.fr/', 'Fin', 200)
    expect(h.removeBetween(100, 200)).toBe(2)
    expect(h.search('').map((e) => e.url).sort()).toEqual(['https://before.fr/', 'https://end.fr/'])
    expect(h.removeBetween(100, 200)).toBe(0)
    h.flush()
    expect(new HistoryStore(path).search('').map((e) => e.url).sort()).toEqual(['https://before.fr/', 'https://end.fr/'])
  })

  it('forgets the pages of one site and no other, subdomains only when asked', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    for (const url of ['https://example.com/', 'http://example.com/a', 'https://www.example.com/', 'https://example.com:8080/', 'https://badexample.com/', 'https://other.org/example.com']) h.record(url, url, 1)
    expect(h.removeSite('example.com')).toBe(2)
    expect(h.search('').map((e) => e.url).sort()).toEqual(['https://badexample.com/', 'https://example.com:8080/', 'https://other.org/example.com', 'https://www.example.com/'])
    expect(h.removeSite('example.com', true)).toBe(1)
    expect(h.search('').map((e) => e.url).sort()).toEqual(['https://badexample.com/', 'https://example.com:8080/', 'https://other.org/example.com'])
    expect(h.removeSite('example.com', true)).toBe(0)
    h.flush()
    expect(new HistoryStore(path).size()).toBe(3)
  })

  it('refuses to match a site by something that is not a valid host', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://example.com/', 'A', 1)
    expect(h.removeSite('')).toBe(0)
    expect(h.removeSite('example.com/')).toBe(0)
    expect(h.size()).toBe(1)
  })

  it('lists the hosts it knows once each, ports included', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    for (const url of ['https://a.example.com/1', 'https://a.example.com/2', 'http://localhost:3000/x']) h.record(url, 'x', 1)
    expect(h.hosts().sort()).toEqual(['a.example.com', 'localhost:3000'])
  })

  it('clear forgets everything', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A')
    h.clear()
    expect(h.size()).toBe(0)
  })
})

describe('a page forgotten with a way back', () => {
  const stored = (path: string): unknown[] => JSON.parse(readFileSync(path, 'utf8')) as unknown[]

  it('leaves the history and the file at once, and comes back as it was: title, visits, date and the spaces it was visited in', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    h.record('https://a.fr/', 'A', 1, 'space-1')
    h.record('https://a.fr/', 'A bis', 5, 'space-2')
    h.record('https://b.fr/', 'B', 2)
    h.flush()
    const before = stored(path)
    expect(h.removeKept('https://a.fr/', 10)).toBe(true)
    expect(h.get('https://a.fr/')).toBeUndefined()
    h.flush()
    // What is kept aside is in memory only: the file has lost the page.
    expect(readFileSync(path, 'utf8')).not.toContain('a.fr')
    expect(h.putBack('https://a.fr/', 20)).toBe(true)
    expect(h.get('https://a.fr/')).toEqual({ url: 'https://a.fr/', title: 'A bis', visitCount: 2, lastVisitAt: 5 })
    h.flush()
    expect(stored(path)).toEqual(expect.arrayContaining(before))
    expect(stored(path)).toHaveLength(before.length)
    // Once back, there is nothing left to put back.
    expect(h.putBack('https://a.fr/', 21)).toBe(false)
  })

  it('says whether the page was there, and puts back nothing that was not just forgotten that way', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A', 1)
    expect(h.removeKept('https://nowhere.fr/', 2)).toBe(false)
    expect(h.putBack('https://nowhere.fr/', 3)).toBe(false)
    // A page forgotten for good does not come back by this door.
    expect(h.remove('https://a.fr/')).toBe(true)
    expect(h.putBack('https://a.fr/', 3)).toBe(false)
    expect(h.size()).toBe(0)
  })

  it('does not come back once its time is up, by the date given or by the clock', () => {
    vi.useFakeTimers()
    try {
      const h = new HistoryStore(join(dir(), 'h.json'))
      h.record('https://a.fr/', 'A', 1)
      h.record('https://b.fr/', 'B', 2)
      h.removeKept('https://a.fr/', 100)
      expect(h.putBack('https://a.fr/', 100 + FORGOTTEN_KEPT_MS + 1)).toBe(false)
      expect(h.get('https://a.fr/')).toBeUndefined()
      // The clock drops the page by itself: a late request, even one that lies about the time, finds nothing.
      h.removeKept('https://b.fr/', 200)
      vi.advanceTimersByTime(FORGOTTEN_KEPT_MS)
      expect(h.putBack('https://b.fr/', 200)).toBe(false)
      expect(h.size()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never comes back after a wider forgetting: the page forgotten for good, its site, its day, the whole history or its file', () => {
    const wider: Array<[string, (h: HistoryStore) => unknown]> = [
      ['remove', (h) => h.remove('https://a.fr/')],
      ['removeSite', (h) => h.removeSite('a.fr')],
      ['removeBetween', (h) => h.removeBetween(0, 10)],
      ['clear', (h) => h.clear()],
      ['erase', (h) => h.erase()]
    ]
    for (const [name, forget] of wider) {
      const h = new HistoryStore(join(dir(), 'h.json'))
      h.record('https://a.fr/', 'A', 1)
      h.removeKept('https://a.fr/', 2)
      forget(h)
      expect(h.putBack('https://a.fr/', 3), name).toBe(false)
      expect(h.size(), name).toBe(0)
    }
  })

  it('keeps the visit made in the meantime when the page comes back', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A', 1, 'space-1')
    h.record('https://a.fr/', 'A', 2, 'space-1')
    h.removeKept('https://a.fr/', 10)
    h.record('https://a.fr/', 'A again', 12, 'space-2')
    expect(h.putBack('https://a.fr/', 13)).toBe(true)
    expect(h.get('https://a.fr/')).toEqual({ url: 'https://a.fr/', title: 'A again', visitCount: 3, lastVisitAt: 12 })
  })

  it('keeps a bounded number of pages aside: past it the oldest is dropped for good', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    for (let i = 0; i <= FORGOTTEN_KEPT_MAX; i++) h.record(`https://p${i}.fr/`, 'P', i + 1)
    for (let i = 0; i <= FORGOTTEN_KEPT_MAX; i++) h.removeKept(`https://p${i}.fr/`, 100)
    expect(h.putBack('https://p0.fr/', 101)).toBe(false)
    expect(h.putBack('https://p1.fr/', 101)).toBe(true)
    expect(h.putBack(`https://p${FORGOTTEN_KEPT_MAX}.fr/`, 101)).toBe(true)
  })

  it('is each profile’s own: a page forgotten in one profile is not put back in another', () => {
    const book = new HistoryBook(dir())
    book.of('default').record('https://a.fr/', 'A', 1)
    book.of('travail').record('https://a.fr/', 'A pro', 2)
    book.of('travail').removeKept('https://a.fr/')
    expect(book.of('default').putBack('https://a.fr/')).toBe(false)
    expect(book.of('default').get('https://a.fr/')?.title).toBe('A')
    expect(book.of('travail').putBack('https://a.fr/')).toBe(true)
    expect(book.of('travail').get('https://a.fr/')).toMatchObject({ title: 'A pro', visitCount: 1, lastVisitAt: 2 })
  })
})

describe('taking an import back', () => {
  const page = (url: string, visitCount = 1, lastVisitAt = 100, title = url) => ({ url, title, visitCount, lastVisitAt })
  const dump = (h: HistoryStore) => JSON.stringify(h.search('', 100_000).sort((a, b) => a.url.localeCompare(b.url)))

  it('counts what a merge would change without changing anything', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A', 100)
    const incoming = [page('https://a.fr/', 1, 50), page('https://b.fr/', 3, 200), page('https://b.fr/', 3, 200), page('javascript:1')]
    const before = dump(h)
    expect(h.wouldChange(incoming)).toBe(1)
    expect(dump(h)).toBe(before)
    expect(h.isDirty()).toBe(true)
    h.flush()
    expect(h.wouldChange(incoming)).toBe(1)
    expect(h.isDirty()).toBe(false)
    expect(h.merge(incoming)).toBe(1)
    expect(h.wouldChange(incoming)).toBe(0)
  })

  it('removes the pages the import added and puts back the ones it changed', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A', 100)
    const before = dump(h)
    const merged = h.mergeTracked([page('https://a.fr/', 9, 400, 'Titre de Chrome'), page('https://b.fr/', 3, 200, 'B')])
    expect(merged.touched).toBe(2)
    expect(h.search('b.fr')).toHaveLength(1)
    expect(h.search('a.fr')[0]).toMatchObject({ visitCount: 9, lastVisitAt: 400 })
    expect(merged.undo()).toBe(2)
    expect(dump(h)).toBe(before)
  })

  it('changes nothing, and has nothing to undo, when the pages were all there already', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.merge([page('https://a.fr/', 2, 100)])
    h.flush()
    const merged = h.mergeTracked([page('https://a.fr/', 2, 100)])
    expect(merged.touched).toBe(0)
    expect(h.isDirty()).toBe(false)
    expect(merged.undo()).toBe(0)
    expect(h.size()).toBe(1)
  })

  it('leaves alone a page the user has visited since: it is theirs now', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    const merged = h.mergeTracked([page('https://b.fr/', 3, 200, 'B'), page('https://c.fr/', 1, 150, 'C')])
    h.record('https://b.fr/', 'B', 900)
    expect(merged.undo()).toBe(1)
    expect(h.search('')).toMatchObject([{ url: 'https://b.fr/', visitCount: 4, lastVisitAt: 900 }])
  })

  it('does not bring back a page the user forgot after the import', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.fr/', 'A', 100)
    const merged = h.mergeTracked([page('https://a.fr/', 9, 400)])
    h.remove('https://a.fr/')
    expect(merged.undo()).toBe(0)
    expect(h.size()).toBe(0)
  })

  it('puts back the oldest pages an import pushed out of a full history, and does not keep the imported pages that were pushed out at once', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.merge(Array.from({ length: 20_000 }, (_, i) => page(`https://existing.example/${i}`, 1, 10_000 + i)))
    expect(h.size()).toBe(20_000)
    const before = dump(h)
    // 5 newer pages push out the 5 oldest; 3 older ones are pushed out at once (the oldest of all).
    const incoming = [...Array.from({ length: 5 }, (_, i) => page(`https://new.example/${i}`, 1, 90_000 + i)), ...Array.from({ length: 3 }, (_, i) => page(`https://ancient.example/${i}`, 1, 1 + i))]
    const merged = h.mergeTracked(incoming)
    expect(h.size()).toBe(20_000)
    const urls = new Set(h.search('', 30_000).map((e) => e.url))
    expect([...urls].some((u) => u.includes('ancient.example'))).toBe(false)
    expect(urls.has('https://existing.example/0') || urls.has('https://existing.example/4')).toBe(false)
    expect(urls.has('https://new.example/4')).toBe(true)
    merged.undo()
    expect(dump(h)).toBe(before)
  })

  it('writes the history again after an undo, like after any change', () => {
    const file = join(dir(), 'h.json')
    const h = new HistoryStore(file)
    const merged = h.mergeTracked([page('https://b.fr/', 3, 200)])
    h.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1)
    merged.undo()
    expect(h.isDirty()).toBe(true)
    h.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
  })
})

// ---------- one history per profile ----------

const LEGACY = [
  { url: 'https://a.fr/', title: 'A', visitCount: 3, lastVisitAt: 30 },
  { url: 'https://b.fr/', title: 'B', visitCount: 1, lastVisitAt: 20 }
]
const urlsOf = (store: HistoryStore) => store.search('', 100).map((e) => e.url).sort()

describe('the history file of earlier versions', () => {
  it('is the default profile\'s history, found again without being moved or rewritten', () => {
    const folder = dir()
    // Pretty-printed, so that a rewrite (which is compact) could not go unnoticed.
    const text = JSON.stringify(LEGACY, null, 2)
    writeFileSync(join(folder, 'history.json'), text)
    const book = new HistoryBook(folder)
    expect(urlsOf(book.of('default'))).toEqual(['https://a.fr/', 'https://b.fr/'])
    expect(book.of('default').search('')[0]).toMatchObject({ url: 'https://a.fr/', visitCount: 3, lastVisitAt: 30 })
    // Nothing was changed, so nothing is written back, and no other file appears for the profiles that were only looked at.
    expect(book.of('travail').size()).toBe(0)
    expect(book.flush()).toBe(true)
    expect(readFileSync(join(folder, 'history.json'), 'utf8')).toBe(text)
    expect(readdirSync(folder)).toEqual(['history.json'])
  })

  it('stays the same on a second start and after a start with new pages (idempotent, nothing lost)', () => {
    const folder = dir()
    writeFileSync(join(folder, 'history.json'), JSON.stringify(LEGACY))
    const first = new HistoryBook(folder)
    first.of('travail').record('https://pro.example/', 'Pro', 50)
    first.of('default').record('https://c.fr/', 'C', 60)
    expect(first.flush()).toBe(true)
    const second = new HistoryBook(folder)
    expect(urlsOf(second.of('default'))).toEqual(['https://a.fr/', 'https://b.fr/', 'https://c.fr/'])
    expect(urlsOf(second.of('travail'))).toEqual(['https://pro.example/'])
    expect(second.flush()).toBe(true)
    const third = new HistoryBook(folder)
    expect(urlsOf(third.of('default'))).toEqual(urlsOf(second.of('default')))
    expect(readdirSync(folder).sort()).toEqual(['history-travail.json', 'history.json'])
  })

  it('stays a plain array of pages, which the previous version reads', () => {
    const folder = dir()
    const book = new HistoryBook(folder)
    book.of('default').record('https://a.fr/', 'A', 1)
    book.flush()
    const parsed: unknown = JSON.parse(readFileSync(join(folder, 'history.json'), 'utf8'))
    expect(parsed).toEqual([{ url: 'https://a.fr/', title: 'A', visitCount: 1, lastVisitAt: 1 }])
    // A file of the previous version is read by a store of one file, as the previous version did.
    expect(new HistoryStore(join(folder, 'history.json')).size()).toBe(1)
  })
})

describe('the history of each profile', () => {
  it('shows a profile only its own pages: record, search, hosts, forget and clear', () => {
    const book = new HistoryBook(dir())
    book.of('default').record('https://alpha.example/', 'Alpha', 1)
    book.of('default').record('https://both.example/', 'Les deux', 1)
    book.of('travail').record('https://zulu.example/', 'Zulu', 2)
    book.of('travail').record('https://both.example/', 'Les deux', 2)
    expect(urlsOf(book.of('default'))).toEqual(['https://alpha.example/', 'https://both.example/'])
    expect(urlsOf(book.of('travail'))).toEqual(['https://both.example/', 'https://zulu.example/'])
    expect(book.of('default').search('zulu')).toEqual([])
    expect(book.of('travail').search('alpha')).toEqual([])
    expect(book.of('default').hosts().sort()).toEqual(['alpha.example', 'both.example'])

    // A visit in one profile does not count in the other.
    book.of('travail').record('https://both.example/', 'Les deux', 3)
    expect(book.of('travail').search('both')[0]!.visitCount).toBe(2)
    expect(book.of('default').search('both')[0]!.visitCount).toBe(1)

    // Forgetting a page, a site or everything acts on one profile.
    expect(book.of('travail').remove('https://both.example/')).toBe(true)
    expect(book.of('default').search('both')).toHaveLength(1)
    expect(book.of('travail').removeSite('zulu.example')).toBe(1)
    expect(book.of('default').removeSite('zulu.example')).toBe(0)
    expect(book.of('default').removeSite('alpha.example')).toBe(1)
    expect(book.of('travail').size()).toBe(0)
    book.of('default').clear()
    expect(book.of('default').size()).toBe(0)
    book.of('travail').record('https://zulu.example/2', 'Zulu 2', 4)
    expect(book.of('travail').size()).toBe(1)
  })

  it('merges an import into the profile it is given, and importing again changes nothing', () => {
    const book = new HistoryBook(dir())
    const imported = [{ url: 'https://chrome.example/', title: 'Chrome', visitCount: 4, lastVisitAt: 10 }]
    expect(book.of('travail').merge(imported)).toBe(1)
    expect(book.of('travail').merge(imported)).toBe(0)
    expect(book.of('default').size()).toBe(0)
  })

  it('shares one history between the spaces of a profile (the same object answers for the same profile)', () => {
    const book = new HistoryBook(dir())
    book.of('travail').record('https://pro.example/', 'Pro', 1)
    expect(book.of('travail')).toBe(book.of('travail'))
    expect(book.of('travail').search('pro')).toHaveLength(1)
  })

  it('keeps each profile in a file of its own that survives a restart', () => {
    const folder = dir()
    const book = new HistoryBook(folder)
    book.of('default').record('https://perso.example/', 'Perso', 1)
    book.of('travail').record('https://pro.example/', 'Pro', 1)
    book.of('Travail').record('https://capitale.example/', 'Capitale', 1)
    expect(book.flush()).toBe(true)
    expect(readdirSync(folder).sort()).toEqual(['history-travail.json', 'history-~travail.json', 'history.json'])
    const again = new HistoryBook(folder)
    expect(urlsOf(again.of('default'))).toEqual(['https://perso.example/'])
    expect(urlsOf(again.of('travail'))).toEqual(['https://pro.example/'])
    expect(urlsOf(again.of('Travail'))).toEqual(['https://capitale.example/'])
  })

  it('writes only the profiles that changed', () => {
    const folder = dir()
    writeFileSync(join(folder, 'history.json'), JSON.stringify(LEGACY, null, 2))
    const book = new HistoryBook(folder)
    book.of('default').search('')
    book.of('travail').record('https://pro.example/', 'Pro', 1)
    book.flush()
    expect(readdirSync(folder).sort()).toEqual(['history-travail.json', 'history.json'])
    expect(readFileSync(join(folder, 'history.json'), 'utf8')).toBe(JSON.stringify(LEGACY, null, 2))
  })
})

describe('the names of the history files', () => {
  it('keeps history.json for the default profile and never lets two profiles share a file, even on a file system that ignores case', () => {
    expect(historyFileName('default')).toBe('history.json')
    expect(historyFileName('travail')).toBe('history-travail.json')
    expect(historyFileName('Travail')).toBe('history-~travail.json')
    expect(historyFileName('a_B-c')).toBe('history-a_~b-c.json')
    const names = ['default', 'Default', 'travail', 'Travail', 'TRAVAIL', 'a_b', 'A_b', 'a_B'].map(historyFileName)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
  })

  it('reads a profile back from its file name, and only from the names it writes', () => {
    for (const id of ['default', 'travail', 'Travail', 'a_B-c', 'x'.repeat(32)]) expect(profileOfHistoryFile(historyFileName(id))).toBe(id)
    for (const name of ['history-.json', 'history-default.json', 'history-Travail.json', 'history-a b.json', 'history-../x.json', 'history-travail.json.tmp', 'history-travail.json.corrupt-12', 'history-~.json', 'history-~1.json', `history-${'x'.repeat(33)}.json`, 'history.json.bak', 'state.json', 'Xhistory-a.json'])
      expect(profileOfHistoryFile(name), name).toBeNull()
  })
})

describe('a history that cannot be trusted', () => {
  it('treats what is not a profile id as the default profile, and never builds a path from it', () => {
    const folder = dir()
    const book = new HistoryBook(folder)
    for (const bad of ['../x', '', 'a/b', '__proto__', 'x'.repeat(33), 'é']) {
      expect(book.of(bad)).toBe(book.of('default'))
      expect(historyFileName(bad)).toBe('history.json')
    }
    book.of('../x').record('https://a.fr/', 'A', 1)
    book.flush()
    expect(readdirSync(folder)).toEqual(['history.json'])
  })

  it('refuses to erase what is not a profile id instead of erasing the default profile in its place', () => {
    const book = new HistoryBook(dir())
    book.of('default').record('https://a.fr/', 'A', 1)
    expect(() => book.erase('../x')).toThrow('Invalid profile id')
    expect(() => book.erase('')).toThrow('Invalid profile id')
    expect(book.of('default').size()).toBe(1)
  })

  it('sets an unreadable profile file aside alone: the other profiles keep their pages and the user is told which file', () => {
    const folder = dir()
    writeFileSync(join(folder, 'history.json'), JSON.stringify(LEGACY))
    writeFileSync(join(folder, 'history-travail.json'), '{ nope')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    takePersistenceNotices()
    const book = new HistoryBook(folder)
    expect(book.of('travail').size()).toBe(0)
    expect(book.of('default').size()).toBe(2)
    expect(readdirSync(folder).filter((f) => f.startsWith('history-travail.json.corrupt-'))).toHaveLength(1)
    expect(existsSync(join(folder, 'history-travail.json'))).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('history-travail.json'))
    expect(takePersistenceNotices()).toMatchObject([{ kind: 'set-aside', file: 'history-travail.json' }])
  })

  it('rebuilds hostile entries of a profile file as the default file always was: bad ones dropped, the rest bounded and printable', () => {
    const folder = dir()
    writeFileSync(
      join(folder, 'history-travail.json'),
      JSON.stringify([
        { url: 'javascript:alert(1)', title: 'x', visitCount: 1, lastVisitAt: 1 },
        { url: 'https://ok.example/', title: 't'.repeat(10_000) + '\u0000', visitCount: -5, lastVisitAt: 5, profile: 'default', extra: { a: 1 } },
        { url: 'https://nan.example/', title: 'n', visitCount: 1, lastVisitAt: 'now' },
        'text',
        null
      ])
    )
    const book = new HistoryBook(folder)
    const entries = book.of('travail').search('')
    expect(entries.map((e) => e.url)).toEqual(['https://ok.example/'])
    expect(entries[0]!.title.length).toBeLessThanOrEqual(1000)
    expect(entries[0]!.title).not.toContain('\u0000')
    expect(entries[0]!.visitCount).toBe(1)
    expect(entries[0]).not.toHaveProperty('extra')
    expect(entries[0]).not.toHaveProperty('profile')
    // The profile named inside an entry is not believed: the file decides.
    expect(book.of('default').size()).toBe(0)
  })

  it('bounds the pages of a profile, each profile having its own bound', () => {
    const folder = dir()
    const many = Array.from({ length: 20_050 }, (_, i) => ({ url: `https://a.example/${i}`, title: `p${i}`, visitCount: 1, lastVisitAt: i }))
    writeFileSync(join(folder, 'history-travail.json'), JSON.stringify(many))
    const book = new HistoryBook(folder)
    book.of('default').record('https://perso.example/', 'Perso', 1)
    expect(book.of('travail').size()).toBe(20_000)
    expect(book.of('default').size()).toBe(1)
  })
})

describe('listing the profiles that have a history', () => {
  it('names those in memory and on disk, the default one first, and ignores files that are not ours', () => {
    const folder = dir()
    writeFileSync(join(folder, 'history.json'), JSON.stringify(LEGACY))
    writeFileSync(join(folder, 'history-zebre.json'), '[]')
    writeFileSync(join(folder, 'history-~ami.json'), '[]')
    writeFileSync(join(folder, 'history-travail.json.corrupt-1'), 'x')
    writeFileSync(join(folder, 'history-default.json'), '[]')
    writeFileSync(join(folder, 'state.json'), '{}')
    const book = new HistoryBook(folder)
    book.of('nouveau').record('https://n.example/', 'N', 1)
    book.of('vide')
    expect(book.profiles()).toEqual(['default', 'Ami', 'nouveau', 'zebre'])
  })

  it('still lists the profiles in memory, and says so in the log, when the folder cannot be read', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const book = new HistoryBook(join(dir(), 'missing'))
    book.of('travail').record('https://pro.example/', 'Pro', 1)
    expect(book.profiles()).toEqual(['travail'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot list the histories'), expect.anything())
  })
})

describe('erasing the history of a profile', () => {
  it('removes its pages, its file and the unreadable copies set aside, and touches no other profile', () => {
    const folder = dir()
    const book = new HistoryBook(folder)
    book.of('default').record('https://perso.example/', 'Perso', 1)
    book.of('travail').record('https://pro.example/', 'Pro', 1)
    book.flush()
    writeFileSync(join(folder, 'history-travail.json.corrupt-123'), 'old pages')
    expect(book.erase('travail')).toBe(true)
    expect(book.of('travail').size()).toBe(0)
    expect(readdirSync(folder).sort()).toEqual(['history.json'])
    expect(urlsOf(book.of('default'))).toEqual(['https://perso.example/'])
    // The profile can be used again afterwards.
    book.of('travail').record('https://pro.example/2', 'Pro 2', 2)
    book.flush()
    expect(urlsOf(new HistoryBook(folder).of('travail'))).toEqual(['https://pro.example/2'])
  })

  it('erases a profile that was never loaded without reading its file', () => {
    const folder = dir()
    writeFileSync(join(folder, 'history-travail.json'), '{ unreadable')
    const book = new HistoryBook(folder)
    takePersistenceNotices()
    expect(book.erase('travail')).toBe(true)
    expect(readdirSync(folder)).toEqual([])
    expect(takePersistenceNotices()).toEqual([])
  })

  it('does not write the pages back later: a save that was waiting is cancelled', () => {
    vi.useFakeTimers()
    try {
      const folder = dir()
      const book = new HistoryBook(folder)
      book.of('travail').record('https://pro.example/', 'Pro', 1)
      expect(book.erase('travail')).toBe(true)
      vi.advanceTimersByTime(60_000)
      expect(readdirSync(folder)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('erases the default profile\'s history.json too, and nothing else in the folder', () => {
    const folder = dir()
    writeFileSync(join(folder, 'history.json'), JSON.stringify(LEGACY))
    writeFileSync(join(folder, 'state.json'), '{}')
    const book = new HistoryBook(folder)
    expect(book.erase('default')).toBe(true)
    expect(readdirSync(folder)).toEqual(['state.json'])
  })

  it('says so, in the log and in a notice, when nothing can be removed or written, and keeps trying', () => {
    vi.useFakeTimers()
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const folder = dir()
      const book = new HistoryBook(folder)
      book.of('travail').record('https://pro.example/', 'Pro', 1)
      // A folder in the place of the file: it can neither be removed as a file nor be written over.
      mkdirSync(join(folder, 'history-travail.json'))
      takePersistenceNotices()
      expect(book.erase('travail')).toBe(false)
      expect(book.of('travail').size()).toBe(0)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot remove'), expect.anything())
      expect(takePersistenceNotices()).toMatchObject([{ kind: 'save-failed', file: 'history-travail.json' }])
      // The attempt goes on: the folder goes, the next try writes the empty history.
      expect(book.flush()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('not recording the history (the setting)', () => {
  it('a store told not to record keeps what it has and learns nothing, nothing is written for the visit', () => {
    const path = join(dir(), 'h.json')
    let recording = true
    const h = new HistoryStore(path, { recording: () => recording })
    h.record('https://avant.fr/', 'Avant', 1)
    recording = false
    h.record('https://pendant.fr/', 'Pendant', 2)
    h.record('https://avant.fr/', 'Avant', 3)
    expect(h.search('').map((e) => [e.url, e.visitCount])).toEqual([['https://avant.fr/', 1]])
    recording = true
    h.record('https://apres.fr/', 'Après', 4)
    expect(h.size()).toBe(2)
  })

  it('a book asks per profile at each visit, so one profile can stop recording while another goes on', () => {
    const off = new Set<string>()
    const book = new HistoryBook(dir(), (profileId) => !off.has(profileId))
    off.add('work')
    book.of('work').record('https://pro.fr/', 'Pro', 1)
    book.of('default').record('https://perso.fr/', 'Perso', 1)
    expect(book.of('work').size()).toBe(0)
    expect(book.of('default').size()).toBe(1)
    off.delete('work')
    book.of('work').record('https://pro.fr/', 'Pro', 2)
    expect(book.of('work').size()).toBe(1)
  })

  it('does not stop an import: merging another browser’s pages is the user’s explicit act', () => {
    const h = new HistoryStore(join(dir(), 'h.json'), { recording: () => false })
    expect(h.merge([{ url: 'https://b.fr/', title: 'B', visitCount: 2, lastVisitAt: 10 }])).toBe(1)
  })
})

/** A deterministic mix of titles and addresses with accents, capitals, repeated counts and equal dates, so that many results tie. */
function crowd(size: number): HistoryEntry[] {
  const words = ['Déjà', 'vu', 'Écoute', 'MAISON', 'github', 'Pull', 'requests', 'l’été', 'café', 'Zoé']
  let seed = 7
  const next = (max: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed % max
  }
  return Array.from({ length: size }, (_, i) => ({
    url: `https://${words[next(10)]!.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}${next(40)}.example/${words[next(10)]}/${i}`,
    title: `${words[next(10)]} ${words[next(10)]} ${next(5)}`,
    visitCount: 1 + next(4),
    lastVisitAt: 1000 + next(30)
  }))
}

/** The search as it was before the folded texts were kept: every entry folded again at each call. */
function searchBefore(entries: HistoryEntry[], query: string, limit: number): HistoryEntry[] {
  if (!query.trim()) return [...entries].sort((a, b) => b.lastVisitAt - a.lastVisitAt).slice(0, limit)
  return entries
    .map((h) => ({ h, score: Math.max(matchScore(h.title, query), matchScore(h.url, query)) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.h.visitCount - a.h.visitCount || b.h.lastVisitAt - a.h.lastVisitAt)
    .slice(0, limit)
    .map((m) => m.h)
}

describe('searching a long history', () => {
  const stored = (entries: HistoryEntry[]) => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.merge(entries)
    return h
  }

  it('finds what the search always found, in the same order, for any query and any number of results', () => {
    const entries = crowd(600)
    const h = stored(entries)
    const inHistory = h.search('', 1000)
    for (const query of ['', '  ', 'dej', 'DÉJÀ vu', 'ecoute', 'l\'ete', 'maison 3', 'github', 'pull req', 'zz', 'a', 'é', '/', 'cafe zoe', 'example/Déjà']) {
      for (const limit of [0, 1, 5, 20, 64, 65, 200, 1000]) {
        expect(h.search(query, limit), `${JSON.stringify(query)} x ${limit}`).toEqual(searchBefore(inHistory, query, limit))
      }
    }
  })

  it('folds the title and the address of an entry once, not at each search', () => {
    const h = stored(crowd(300))
    // A first search that matches nothing in the titles looks at every title and every address.
    h.search('zzzz')
    const folds = vi.spyOn(String.prototype, 'normalize')
    h.search('github')
    h.search('café')
    h.search('zoé 2')
    // Only the three queries are folded again: the 300 entries kept what was worked out for them.
    expect(folds.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('folds a visited page again (a new title) and keeps what it knew of the others', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.example/', 'Ancien titre', 1)
    h.record('https://b.example/', 'Autre page', 2)
    expect(h.search('ancien').map((e) => e.url)).toEqual(['https://a.example/'])
    h.record('https://a.example/', 'Nouveau titre', 3)
    expect(h.search('ancien')).toEqual([])
    expect(h.search('nouveau').map((e) => e.url)).toEqual(['https://a.example/'])
    expect(h.search('autre page').map((e) => e.url)).toEqual(['https://b.example/'])
  })

  it('answers a page by its address, and the pages of a time range most recent first', () => {
    const h = new HistoryStore(join(dir(), 'h.json'))
    h.record('https://a.example/', 'A', 100)
    h.record('https://b.example/', 'B', 300)
    h.record('https://c.example/', 'C', 200)
    expect(h.get('https://c.example/')).toMatchObject({ title: 'C', lastVisitAt: 200 })
    expect(h.get('https://nope.example/')).toBeUndefined()
    expect(h.between(100, 300).map((e) => e.url)).toEqual(['https://c.example/', 'https://a.example/'])
    expect(h.between(0, 1000).map((e) => e.url)).toEqual(['https://b.example/', 'https://c.example/', 'https://a.example/'])
    expect(h.between(301, 400)).toEqual([])
  })
})

describe('firstOf', () => {
  it('is a stable sort cut at the limit', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ i, rank: (i * 7) % 10 }))
    const compare = (a: { rank: number }, b: { rank: number }) => a.rank - b.rank
    expect(firstOf(items, items.length, NaN, compare)).toEqual([])
    expect(firstOf(items, items.length, -3, compare)).toEqual([])
    for (const limit of [0, 1, 3, 10, 64, 65, 499, 500, 900]) {
      expect(firstOf(items, items.length, limit, compare), `limit ${limit}`).toEqual([...items].sort(compare).slice(0, limit))
    }
  })
})

describe('the history file', () => {
  it('is written as the list of the pages, the lines of those that did not change being kept', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    const written = () => readFileSync(path, 'utf8')
    h.merge(crowd(50))
    h.flush()
    // Byte for byte what `JSON.stringify` of the list gives: the previous version of the file is read by this one and the other way round.
    expect(written()).toBe(JSON.stringify(readEntries(path)))
    expect(readEntries(path)).toHaveLength(50)
    h.record('https://changed.example/', 'Avant', 5)
    h.flush()
    h.record('https://changed.example/', 'Après', 6)
    h.remove(crowd(50)[3]!.url)
    h.flush()
    const entries = JSON.parse(written()) as HistoryEntry[]
    expect(entries).toHaveLength(50)
    expect(entries.find((e) => e.url === 'https://changed.example/')).toEqual({ url: 'https://changed.example/', title: 'Après', visitCount: 2, lastVisitAt: 6 })
    expect(written()).toBe(JSON.stringify(entries))
    expect(new HistoryStore(path).size()).toBe(50)
  })
})

const readEntries = (path: string): HistoryEntry[] => JSON.parse(readFileSync(path, 'utf8')) as HistoryEntry[]
