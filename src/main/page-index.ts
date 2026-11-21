// The full-text index of the pages visited, one file per profile (`page-index.json` for the default profile, `page-index-<id>.json` for the others,
// named as the histories are: history.ts `historyFileName`), in the data folder, never part of state.json nor of an export. Nothing is read from the
// disk until a search or a page needs it, and nothing is written while the setting `pageContentIndex` is off (the caller never reaches this file then).
// The text stays on this machine: no network, no log of it. See shared/page-index.ts for what is kept and the bounds.

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PAGE_INDEX_TOTAL_MAX, cleanIndex, searchIndex, withPage, withoutSite, type IndexedPage, type PageMatch } from '@shared/page-index'
import { isProfileId } from '@shared/profiles'
import { DEFAULT_HISTORY_PROFILE, historyFileName } from './history'
import { DATA_FILE_MAX_BYTES, readJsonBounded, setAsideOrHold, writeFileAtomic } from './persist'

/** The write waits this long after a change, so that a run of pages is one write. */
export const PAGE_INDEX_SAVE_DELAY_MS = 5_000

/** `history.json` → `page-index.json`, `history-<id>.json` → `page-index-<id>.json`. */
export function pageIndexFileName(profileId: string): string {
  return historyFileName(profileId).replace(/^history/, 'page-index')
}

const isIndexFile = (name: string): boolean => name === 'page-index.json' || /^page-index-(?:[a-z0-9_-]|~[a-z])+\.json$/.test(name)

class ProfileIndex {
  private pages: IndexedPage[] | null = null
  private timer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(private readonly path: string) {}

  private load(): IndexedPage[] {
    if (this.pages !== null) return this.pages
    this.pages = []
    if (existsSync(this.path)) {
      try {
        this.pages = cleanIndex(readJsonBounded(this.path, Math.min(DATA_FILE_MAX_BYTES, PAGE_INDEX_TOTAL_MAX * 4)))
      } catch (error) {
        // An unreadable file is set aside, never written over unread; the index starts again from none.
        setAsideOrHold(this.path, error, 'page-index')
      }
    }
    return this.pages
  }

  add(page: IndexedPage): void {
    const before = this.load()
    this.pages = withPage(before, page)
    this.touch()
  }

  search(query: string, limit?: number): PageMatch[] {
    return searchIndex(this.load(), query, limit)
  }

  /** Forgets the page at this address; answers whether it was there. */
  remove(url: string): boolean {
    const before = this.load()
    const next = before.filter((page) => page.url !== url)
    if (next.length === before.length) return false
    this.pages = next
    this.touch()
    return true
  }

  /** Forgets the pages of a site; answers how many went. */
  removeSite(host: string, subdomains: boolean): number {
    const before = this.load()
    const next = withoutSite(before, host, subdomains)
    if (next.length === before.length) return 0
    this.pages = next
    this.touch()
    return before.length - next.length
  }

  size(): number {
    return this.load().length
  }

  private touch(): void {
    this.dirty = true
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), PAGE_INDEX_SAVE_DELAY_MS).unref()
  }

  /** Writes the index when it changed; answers whether the disk is up to date. A failed write is logged and tried again at the next change. */
  flush(): boolean {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty || this.pages === null) return true
    try {
      writeFileAtomic(this.path, JSON.stringify(this.pages))
      this.dirty = false
      return true
    } catch (error) {
      console.error(`[page-index] ${basename(this.path)} could not be written:`, error)
      return false
    }
  }

  /** Forgets everything, in memory and on the disk. Answers whether the file is gone. */
  erase(): boolean {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pages = []
    this.dirty = false
    try {
      rmSync(this.path, { force: true })
      return true
    } catch (error) {
      console.error(`[page-index] ${basename(this.path)} could not be removed:`, error)
      return false
    }
  }
}

export class PageIndexBook {
  private readonly indexes = new Map<string, ProfileIndex>()

  constructor(private readonly dir: string) {}

  of(profileId: string): ProfileIndex {
    const id = isProfileId(profileId) ? profileId : DEFAULT_HISTORY_PROFILE
    let index = this.indexes.get(id)
    if (!index) this.indexes.set(id, (index = new ProfileIndex(join(this.dir, pageIndexFileName(id)))))
    return index
  }

  /** Forgets the index of one profile (its history was erased). */
  erase(profileId: string): boolean {
    return this.of(profileId).erase()
  }

  /** Forgets every index, those only on the disk included (the setting went off, or « Effacer l’index » was chosen). Answers whether nothing is left. */
  eraseAll(): boolean {
    let all = true
    for (const index of this.indexes.values()) if (!index.erase()) all = false
    try {
      for (const name of readdirSync(this.dir)) {
        if (!isIndexFile(name)) continue
        try {
          rmSync(join(this.dir, name), { force: true })
        } catch (error) {
          console.error(`[page-index] ${name} could not be removed:`, error)
          all = false
        }
      }
    } catch (error) {
      console.error(`[page-index] cannot list ${this.dir}:`, error)
      all = false
    }
    return all
  }

  flush(): boolean {
    let all = true
    for (const index of this.indexes.values()) if (!index.flush()) all = false
    return all
  }
}

/**
 * Erases every index as soon as the setting goes off (and only then: not at launch, where a state that could not be read starts from the defaults and
 * must not take the index with it). Answers how to stop listening.
 */
export function eraseIndexWhenSwitchedOff(
  store: { get(): { settings: { pageContentIndex: boolean } }; subscribe(listener: (state: { settings: { pageContentIndex: boolean } }) => void): () => void },
  book: Pick<PageIndexBook, 'eraseAll'>
): () => void {
  let on = store.get().settings.pageContentIndex
  return store.subscribe((state) => {
    const now = state.settings.pageContentIndex
    if (on && !now) book.eraseAll()
    on = now
  })
}

let current: PageIndexBook | null = null

/** The book of this run (set at startup); null before it, and in a window that keeps none. */
export const getPageIndex = (): PageIndexBook | null => current
export function setPageIndex(book: PageIndexBook | null): void {
  current = book
}
