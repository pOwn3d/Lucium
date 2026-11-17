// The history is the profile's, shared by its spaces, so each page remembers the spaces it was visited in and a
// locked space keeps its pages to itself; the whole application locked, the history answers nothing. Against real files.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HISTORY_SPACES_MAX, HistoryBook, HistoryStore, NO_VEIL, lockVeil, type HistoryVeil } from './history'
import { LockService, NO_TOUCH_ID, setLockService } from './lock-service'
import { defaultSettings, type Settings } from '@shared/model'
import { tempDir } from './temp-dir'

const dir = () => tempDir('lucium-history-lock-')
afterEach(() => setLockService(null))

/** A veil that can be changed during a test, as the lock changes while the application runs. */
function switchable(initial: HistoryVeil = NO_VEIL): { veil: () => HistoryVeil; set(next: HistoryVeil): void } {
  let current = initial
  return { veil: () => current, set: (next) => (current = next) }
}
const lockedSpaces = (...ids: string[]): HistoryVeil => ({ all: false, spaces: new Set(ids) })
const appLocked: HistoryVeil = { all: true, spaces: new Set() }

/** A history with a page of the locked space only, one of the open space, one of both, and one of no space (an earlier version, an import). */
function visited(veil: () => HistoryVeil, path = join(dir(), 'h.json')): HistoryStore {
  const h = new HistoryStore(path, { veil })
  h.record('https://banque.example/compte', 'Mon compte bancaire', 1, 'work')
  h.record('https://news.example/', 'Actualités', 2, 'home')
  h.record('https://search.example/', 'Recherche', 3, 'work')
  h.record('https://search.example/', 'Recherche', 4, 'home')
  h.record('https://old.example/', 'Page d’avant', 5)
  return h
}

const urls = (entries: readonly { url: string }[]) => entries.map((entry) => entry.url).sort()

describe('a locked space keeps its pages to itself', () => {
  it('leaves out of the search, an address, a time range and the hosts the pages visited only in a locked space', () => {
    const lock = switchable(lockedSpaces('work'))
    const h = visited(lock.veil)
    expect(urls(h.search(''))).toEqual(['https://news.example/', 'https://old.example/', 'https://search.example/'])
    expect(h.search('bancaire')).toEqual([])
    expect(h.get('https://banque.example/compte')).toBeUndefined()
    expect(urls(h.between(0, 100))).toEqual(['https://news.example/', 'https://old.example/', 'https://search.example/'])
    expect(h.hosts().sort()).toEqual(['news.example', 'old.example', 'search.example'])
    // A page visited in the locked space and in another one is the other space's too; one of no space says nothing of a space.
    expect(h.get('https://search.example/')).toMatchObject({ title: 'Recherche', visitCount: 2 })
    expect(h.get('https://old.example/')).toBeDefined()
  })

  it('shows them again once the space is unlocked: the veil is asked at each reading', () => {
    const lock = switchable(lockedSpaces('work'))
    const h = visited(lock.veil)
    expect(h.get('https://banque.example/compte')).toBeUndefined()
    lock.set(NO_VEIL)
    expect(h.get('https://banque.example/compte')).toMatchObject({ title: 'Mon compte bancaire' })
    expect(h.search('bancaire').map((entry) => entry.url)).toEqual(['https://banque.example/compte'])
  })

  it('answers nothing at all while the whole application is locked', () => {
    const h = visited(() => appLocked)
    expect(h.search('')).toEqual([])
    expect(h.search('recherche')).toEqual([])
    expect(h.get('https://old.example/')).toBeUndefined()
    expect(h.between(0, 100)).toEqual([])
    expect(h.hosts()).toEqual([])
  })

  it('never lets the spaces of a page out of the store: what it answers is a page of the history', () => {
    const h = visited(() => NO_VEIL)
    for (const entry of [...h.search(''), ...h.search('recherche'), ...h.between(0, 100), h.get('https://search.example/')!]) {
      expect(Object.keys(entry).sort()).toEqual(['lastVisitAt', 'title', 'url', 'visitCount'])
    }
  })

  it('forgets, with a day, only the pages the panel could list: the ones visited only in a locked space stay', () => {
    const lock = switchable(lockedSpaces('work'))
    const h = visited(lock.veil)
    // Every page of the store was visited between 0 and 100; the bank's, of the locked space alone, is not listed and does not go.
    expect(h.removeBetween(0, 100)).toBe(3)
    lock.set(NO_VEIL)
    expect(urls(h.search(''))).toEqual(['https://banque.example/compte'])
  })

  it('still forgets a page of a locked space when asked (a write is not a reading), and still counts the pages', () => {
    const lock = switchable(lockedSpaces('work'))
    const h = visited(lock.veil)
    expect(h.size()).toBe(4)
    expect(h.removeSite('banque.example')).toBe(1)
    lock.set(NO_VEIL)
    expect(h.get('https://banque.example/compte')).toBeUndefined()
  })
})

describe('the spaces a page was visited in', () => {
  it('are kept in the file and read back after a restart, so that the lock holds after a restart too', () => {
    const path = join(dir(), 'h.json')
    visited(() => NO_VEIL, path).flush()
    const file = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>
    // Still a plain array of pages, which the previous version reads (it ignores the field it does not know).
    expect(Array.isArray(file)).toBe(true)
    expect(file.find((entry) => entry['url'] === 'https://search.example/')?.['spaces']).toEqual(['home', 'work'])
    expect(file.find((entry) => entry['url'] === 'https://old.example/')).not.toHaveProperty('spaces')
    const again = new HistoryStore(path, { veil: () => lockedSpaces('work') })
    expect(again.get('https://banque.example/compte')).toBeUndefined()
    expect(urls(again.search(''))).toEqual(['https://news.example/', 'https://old.example/', 'https://search.example/'])
  })

  it('are the most recent first, each once, and at most a few', () => {
    const path = join(dir(), 'h.json')
    const h = new HistoryStore(path)
    for (let n = 0; n < HISTORY_SPACES_MAX + 3; n++) h.record('https://a.example/', 'A', n, `s${n}`)
    h.record('https://a.example/', 'A', 100, 's3')
    h.flush()
    const [entry] = JSON.parse(readFileSync(path, 'utf8')) as Array<{ spaces: string[] }>
    expect(entry!.spaces).toHaveLength(HISTORY_SPACES_MAX)
    expect(entry!.spaces[0]).toBe('s3')
    expect(new Set(entry!.spaces).size).toBe(HISTORY_SPACES_MAX)
  })

  it('are read from a file as ids only: what is not one is dropped, and a page whose tags are all hostile is a page of no space', () => {
    const path = join(dir(), 'h.json')
    const hostile = [
      { url: 'https://a.example/', title: 'A', visitCount: 1, lastVisitAt: 1, spaces: ['work', 5, null, '__proto__', 'work', ''] },
      { url: 'https://b.example/', title: 'B', visitCount: 1, lastVisitAt: 2, spaces: [{ id: 'work' }] },
      { url: 'https://c.example/', title: 'C', visitCount: 1, lastVisitAt: 3, spaces: 'work' }
    ]
    writeFileSync(path, JSON.stringify(hostile))
    const loaded = new HistoryStore(path, { veil: () => lockedSpaces('work') })
    expect(urls(loaded.search(''))).toEqual(['https://b.example/', 'https://c.example/'])
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('stay with a page an import touches, and an imported page is of no space', () => {
    const h = new HistoryStore(join(dir(), 'h.json'), { veil: () => lockedSpaces('work') })
    h.record('https://banque.example/compte', 'Mon compte', 10, 'work')
    expect(h.merge([{ url: 'https://banque.example/compte', title: 'Chrome', visitCount: 9, lastVisitAt: 50 }, { url: 'https://chrome.example/', title: 'C', visitCount: 1, lastVisitAt: 5 }])).toBe(2)
    expect(h.get('https://banque.example/compte')).toBeUndefined()
    expect(h.get('https://chrome.example/')).toBeDefined()
  })

  it('stay with a page that takes its final title', () => {
    const h = new HistoryStore(join(dir(), 'h.json'), { veil: () => lockedSpaces('work') })
    h.record('https://banque.example/compte', '', 10, 'work')
    expect(h.retitle('https://banque.example/compte', 'Mon compte', 11)).toBe(true)
    expect(h.search('compte')).toEqual([])
  })
})

describe('the lock of the application as the veil of every history', () => {
  function lockService(settings: Partial<Settings>): LockService {
    const all = { ...defaultSettings(), ...settings }
    return new LockService({
      settings: () => all,
      spaceIds: () => ['home', 'work'],
      files: { exists: () => true } as never,
      touchId: NO_TOUCH_ID,
      power: { on: () => undefined, off: () => undefined },
      update: () => undefined
    })
  }

  it('is no veil without a lock service, the locked spaces with one, everything while the application is locked', () => {
    expect(lockVeil()).toEqual(NO_VEIL)
    setLockService(lockService({ lockEnabled: true, lockApp: false, lockedSpaces: ['work'] }))
    expect(lockVeil()).toEqual(lockedSpaces('work'))
    const app = lockService({ lockEnabled: true, lockApp: true, lockedSpaces: [] })
    app.start()
    setLockService(app)
    expect(lockVeil().all).toBe(true)
  })

  it('is what a book gives each of its histories by default, so ⌘Y, the command bar and chrome.history are all veiled', () => {
    setLockService(lockService({ lockEnabled: true, lockApp: false, lockedSpaces: ['work'] }))
    const book = new HistoryBook(dir())
    book.of('default').record('https://banque.example/compte', 'Mon compte', 1, 'work')
    book.of('default').record('https://news.example/', 'Actualités', 2, 'home')
    expect(urls(book.of('default').search(''))).toEqual(['https://news.example/'])
    expect(book.of('default').between(0, 10).map((entry) => entry.url)).toEqual(['https://news.example/'])
    setLockService(null)
    expect(urls(book.of('default').search(''))).toEqual(['https://banque.example/compte', 'https://news.example/'])
  })

  it('names the space of a visit made through the history of that space (how the browser records a tab’s visit), the pages being the profile’s', () => {
    const lock = switchable()
    const book = new HistoryBook(dir(), () => true, false, lock.veil)
    const ofWork = book.of('default', 'work')
    expect(book.of('default', 'work')).toBe(ofWork)
    ofWork.record('https://banque.example/compte', 'Mon compte')
    book.of('default', 'home').record('https://news.example/', 'Actualités')
    // One history: the profile's view and each space's see the same pages.
    expect(urls(book.of('default').search(''))).toEqual(['https://banque.example/compte', 'https://news.example/'])
    expect(book.of('default', 'home').get('https://banque.example/compte')).toBeDefined()
    lock.set(lockedSpaces('work'))
    expect(urls(book.of('default').search(''))).toEqual(['https://news.example/'])
    expect(book.of('default', 'home').get('https://banque.example/compte')).toBeUndefined()
    expect(ofWork.size()).toBe(2)
  })

  it('also veils the history of a profile that was erased before it was ever read', () => {
    const book = new HistoryBook(dir(), () => true, false, () => lockedSpaces('work'))
    book.erase('travail')
    book.of('travail').record('https://banque.example/compte', 'Mon compte', 1, 'work')
    expect(book.of('travail').search('')).toEqual([])
  })
})
