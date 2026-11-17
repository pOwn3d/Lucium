import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { foldedQuery, foldedText, scoreFolded } from '@shared/command-bar'
import type { HistoryEntry } from '@shared/model'
import { isProfileId } from '@shared/profiles'
import { hostBelongsToSite } from '@shared/site-data'
import { HISTORY_URL_MAX, cleanHistory, cleanId } from '@shared/state-clean'
import { isRecord } from '@shared/record'
import { getLockService } from './lock-service'
import { reportPersistenceNotice } from './persistence-notices'
import { DATA_FILE_MAX_BYTES, HeldFileError, readJsonBounded, setAsideOrHold, sideFiles, writeFileAtomic, writeFileAtomicAsync } from './persist'

const MAX_ENTRIES = 20_000
/** How long after a visit the page may still give its history entry a new title (see `retitle`). */
export const RETITLE_WINDOW_MS = 15_000
const SAVE_DELAY_MS = 2000
/** After a failed save the history is written again this long afterwards. */
const RETRY_DELAY_MS = 5000
/**
 * How long a page forgotten with a way back (`removeKept`) can still be put back: the 8 seconds the interface offers « Annuler », which a pointer or
 * the focus can hold, with room to spare (the maintainer's choice of 12 Nov. 2026: 30 s). The page is kept in memory only (the file loses it at once), and is dropped for good when the time is up.
 */
export const FORGOTTEN_KEPT_MS = 30_000
/** How many forgotten pages wait for their way back at once: past it the oldest is dropped for good. */
export const FORGOTTEN_KEPT_MAX = 20

const sameEntry = (a: HistoryEntry, b: HistoryEntry): boolean => a.title === b.title && a.visitCount === b.visitCount && a.lastVisitAt === b.lastVisitAt

/** How many spaces an entry remembers it was visited in (the most recent first). */
export const HISTORY_SPACES_MAX = 8

/**
 * An entry as the store keeps it and writes it: the page, and the spaces it was visited in. The history is
 * the profile's, shared by its spaces: the tags are what lets a locked space keep its pages to itself. An entry without tags (written by an earlier
 * version, or imported from another browser) belongs to no space in particular. The tags never leave the store: what it answers is a `HistoryEntry`.
 */
type StoredEntry = HistoryEntry & { spaces?: readonly string[] }

/** The tags of an entry read from a file: space ids, each once, at most `HISTORY_SPACES_MAX`; undefined when there is none. */
function cleanSpaceTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const value of raw) {
    const id = cleanId(value)
    if (id !== null && !out.includes(id)) out.push(id)
    if (out.length >= HISTORY_SPACES_MAX) break
  }
  return out.length > 0 ? out : undefined
}

/** The tags after a visit in `spaceId`: that space first. A visit that names no space leaves the tags as they were. */
function tagsAfterVisit(before: readonly string[] | undefined, spaceId: string | undefined): readonly string[] | undefined {
  const id = cleanId(spaceId)
  if (id === null) return before
  if (before?.[0] === id) return before
  return [id, ...(before ?? []).filter((other) => other !== id)].slice(0, HISTORY_SPACES_MAX)
}

/** The entry as it leaves the store: without its tags. */
function bare(entry: StoredEntry): HistoryEntry {
  if (entry.spaces === undefined) return entry
  const { spaces: _spaces, ...rest } = entry
  return rest
}

/**
 * What the lock lets be read of a history at this moment: everything (`all` false, no space), nothing at all (`all`: the whole application is
 * locked), or everything but the pages visited only in these locked `spaces`. A page visited in a locked space and in another one stays visible:
 * it is the other space's too. An entry without tags stays visible (nothing says which space it was visited in).
 */
export interface HistoryVeil {
  all: boolean
  spaces: ReadonlySet<string>
}

export const NO_VEIL: HistoryVeil = { all: false, spaces: new Set() }

/** The veil of the lock of the application (lock-service.ts): what is locked now. No lock service (a test, a smoke run before it exists): no veil. */
export function lockVeil(): HistoryVeil {
  const lock = getLockService()
  if (!lock) return NO_VEIL
  if (lock.isAppLocked()) return { all: true, spaces: new Set() }
  const locked = lock.lockedSpaces()
  return locked.length === 0 ? NO_VEIL : { all: false, spaces: new Set(locked) }
}

/** Whether an entry may be read under `veil`; null when every entry may (nothing to check). */
function visibleUnder(veil: HistoryVeil): ((entry: StoredEntry) => boolean) | null {
  if (veil.all) return () => false
  if (veil.spaces.size === 0) return null
  return (entry) => entry.spaces === undefined || entry.spaces.length === 0 || !entry.spaces.every((id) => veil.spaces.has(id))
}

/** What is worked out once for an entry and kept with it: its title and address as the search compares them, and its line in the file. */
interface Derived {
  title?: string
  url?: string
  line?: string
}

/** Above this many results the whole list is sorted (the insertion below moves items around, which costs more than sorting when many are kept). */
const SELECT_LIMIT = 64

/**
 * The `limit` first of `items` by `compare`, without sorting the rest: the same items in the same order as a stable sort followed by
 * `slice(0, limit)` (equal items keep the order they came in), at the cost of a pass and a few insertions.
 */
export function firstOf<T>(items: Iterable<T>, size: number, limit: number, compare: (a: T, b: T) => number): T[] {
  // Not a positive number (0, a negative, NaN): nothing was asked for.
  if (!(limit > 0)) return []
  if (limit >= size || limit > SELECT_LIMIT) return [...items].sort(compare).slice(0, limit)
  const best: T[] = []
  for (const item of items) {
    if (best.length === limit && compare(item, best[limit - 1]!) >= 0) continue
    // The first place whose item is strictly worse than this one: after the items it ties with.
    let low = 0
    let high = best.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (compare(item, best[middle]!) < 0) high = middle
      else low = middle + 1
    }
    best.splice(low, 0, item)
    if (best.length > limit) best.pop()
  }
  return best
}

const byRecency = (a: HistoryEntry, b: HistoryEntry): number => b.lastVisitAt - a.lastVisitAt

/**
 * The visited pages of one profile, one entry per URL. Local file, never synced, trimmed to the most recent MAX_ENTRIES.
 * `HistoryBook` (below) holds one of these per profile.
 */
export class HistoryStore {
  private readonly entries = new Map<string, StoredEntry>()
  /** Entries are replaced, never changed in place, so what was worked out for one is thrown away with it. */
  private readonly derived = new WeakMap<HistoryEntry, Derived>()
  private timer: NodeJS.Timeout | null = null
  /** Something changed since the last write: a store that was only read is never written back. */
  private dirty = false
  /** The last write failed (the notice was given once, not at each retry). */
  private failing = false
  /** Counts the changes; `onDisk` is the count the file holds. Together they tell a write in flight whether what it carries is still wanted. */
  private version = 0
  private onDisk = 0
  /** A write that does not hold the process is in flight. */
  private writing = false
  /** The timed writes do not hold the process (the flush at quit, an erasure and a restoration still do: they must be done when they answer). */
  private readonly asyncWrites: boolean

  /** Answers whether a visit is to be kept (the setting « Garder l’historique des pages visitées »); read at each visit, so a change applies at once. */
  private readonly recording: () => boolean
  /** What may be read now (see `HistoryVeil`); asked at each reading, so a lock or an unlock applies at once. */
  private readonly veil: () => HistoryVeil
  /** The views of this history for the visits of each space (see `inSpace`). */
  private readonly spaceViews = new Map<string, HistoryStore>()
  /** The pages forgotten with a way back, as they were (their spaces included), until `until`; the clock drops each one when its time is up. */
  private readonly forgotten = new Map<string, { entry: StoredEntry; until: number; clock: NodeJS.Timeout }>()

  /** `load: false` is for a store that is about to be erased: the file is not read (nor set aside if it cannot be). */
  constructor(
    private readonly path: string,
    options: { load?: boolean; recording?: () => boolean; asyncWrites?: boolean; veil?: () => HistoryVeil } = {}
  ) {
    this.recording = options.recording ?? (() => true)
    this.asyncWrites = options.asyncWrites === true
    this.veil = options.veil ?? (() => NO_VEIL)
    if (options.load !== false) this.load()
  }

  /**
   * This history as the visits of one space reach it: the same pages and the same file, with a `record` that names the space (see `StoredEntry`).
   * The same object for the same space.
   */
  inSpace(spaceId: string): HistoryStore {
    let view = this.spaceViews.get(spaceId)
    if (!view) {
      view = new Proxy(this, {
        get: (target, prop) => {
          if (prop === 'record') return (url: string, title: string, now?: number) => target.record(url, title, now, spaceId)
          const value = Reflect.get(target, prop, target) as unknown
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        }
      })
      this.spaceViews.set(spaceId, view)
    }
    return view
  }

  /** A visit, in the space `spaceId` when it is given (the entry remembers it: see `StoredEntry`). */
  record(url: string, title: string, now = Date.now(), spaceId?: string): void {
    // Nothing is recorded, and what is already there stays: the setting only stops new visits.
    if (!this.recording()) return
    if (!/^https?:\/\//i.test(url) || url.length > HISTORY_URL_MAX) return
    const existing = this.entries.get(url)
    const spaces = tagsAfterVisit(existing?.spaces, spaceId)
    this.entries.set(url, {
      url,
      title: title || existing?.title || url,
      visitCount: (existing?.visitCount ?? 0) + 1,
      lastVisitAt: now,
      ...(spaces ? { spaces } : {})
    })
    if (this.entries.size > MAX_ENTRIES) this.trim()
    this.scheduleSave()
  }

  /**
   * A page names itself after its load has ended (a single-page site changes its title after its address, a script sets it a moment later): the page
   * just recorded takes the title it now has. Not a visit, and only for the page of the visit being made: a page that changes its title all day (an
   * unread count, a timer) must not rewrite the file for as long as it is open. Answers whether the title changed. Nothing while visits are not kept.
   */
  retitle(url: string, title: string, now = Date.now()): boolean {
    if (!this.recording()) return false
    const existing = this.entries.get(url)
    if (!existing || title === '' || title === existing.title || now - existing.lastVisitAt > RETITLE_WINDOW_MS) return false
    this.entries.set(url, { ...existing, title })
    this.scheduleSave()
    return true
  }

  /**
   * What merging an imported page does: the page as it will be, or null when it changes nothing (or is not a web page). A page already
   * here keeps the larger visit count (not the sum), the later visit and its own title, so that importing twice changes nothing.
   */
  private mergedWith(entry: HistoryEntry): StoredEntry | null {
    if (!/^https?:\/\//i.test(entry.url) || entry.url.length > HISTORY_URL_MAX || !Number.isFinite(entry.lastVisitAt)) return null
    const existing = this.entries.get(entry.url)
    const next: StoredEntry = {
      url: entry.url,
      title: existing && existing.title && existing.title !== existing.url ? existing.title : entry.title || existing?.title || entry.url,
      visitCount: Math.max(existing?.visitCount ?? 0, entry.visitCount, 1),
      lastVisitAt: Math.max(existing?.lastVisitAt ?? 0, entry.lastVisitAt),
      // An imported page is of no space; one that was already here keeps the spaces it was visited in.
      ...(existing?.spaces ? { spaces: existing.spaces } : {})
    }
    return existing && sameEntry(existing, next) ? null : next
  }

  /** Adds pages of another browser's history (see `mergedWith`). Answers how many pages were added or changed. */
  merge(entries: readonly HistoryEntry[]): number {
    return this.mergeTracked(entries).touched
  }

  /** How many pages `merge` would add or change, without touching the history (the preview of an import). */
  wouldChange(entries: readonly HistoryEntry[]): number {
    // The same address twice in the list counts once, as the second would find the first already merged.
    const seen = new Set<string>()
    let touched = 0
    for (const entry of entries) {
      if (seen.has(entry.url) || !this.mergedWith(entry)) continue
      seen.add(entry.url)
      touched++
    }
    return touched
  }

  /**
   * `merge`, and the way back: `undo()` takes away what this merge added and puts back what it changed or pushed out of the full history.
   * A page the user has visited, or forgotten, since is theirs now and is left as it is. Answers how many pages the undo put right.
   */
  mergeTracked(entries: readonly HistoryEntry[]): { touched: number; undo: () => number } {
    /** The page as it was before this merge first touched it (null: it was not there). */
    const before = new Map<string, StoredEntry | null>()
    const left = new Map<string, StoredEntry>()
    let touched = 0
    for (const entry of entries) {
      const next = this.mergedWith(entry)
      if (!next) continue
      if (!before.has(next.url)) before.set(next.url, this.entries.get(next.url) ?? null)
      this.entries.set(next.url, next)
      left.set(next.url, next)
      touched++
    }
    const pushedOut = this.entries.size > MAX_ENTRIES ? this.trim() : []
    // A page the import added and the trim removed at once was never kept: nothing to put back.
    const evicted = new Map<string, StoredEntry>()
    for (const entry of pushedOut) {
      const was = before.get(entry.url)
      if (was !== null) evicted.set(entry.url, was ?? entry)
      if (!before.has(entry.url)) before.set(entry.url, entry)
    }
    if (touched > 0) this.scheduleSave()
    return {
      touched,
      undo: () => {
        let changed = 0
        for (const [url, was] of before) {
          const now = this.entries.get(url)
          if (now) {
            // Only a page still exactly as the import left it goes back.
            const mine = left.get(url)
            if (!mine || !sameEntry(now, mine)) continue
            if (was === null) this.entries.delete(url)
            else this.entries.set(url, was)
            changed++
          } else if (evicted.has(url)) {
            this.entries.set(url, evicted.get(url)!)
            changed++
          }
        }
        if (this.entries.size > MAX_ENTRIES) this.trim()
        if (changed > 0) this.scheduleSave()
        return changed
      }
    }
  }

  /**
   * The entries that may be read now, and how many (THE GUARD: a page visited only in a locked space, or any page while the whole
   * application is locked, is not among them). Without a veil, the map itself.
   */
  private readable(): { items: Iterable<StoredEntry>; size: number } {
    const visible = visibleUnder(this.veil())
    if (visible === null) return { items: this.entries.values(), size: this.entries.size }
    const items = [...this.entries.values()].filter(visible)
    return { items, size: items.length }
  }

  /** Best matches first; with an empty query, the most recent visits. Only what the lock lets be read (see `HistoryVeil`). */
  search(query: string, limit = 20): HistoryEntry[] {
    const needle = foldedQuery(query)
    const { items, size } = this.readable()
    if (!needle) return firstOf(items, size, limit, byRecency).map(bare)
    const candidates: Array<{ h: StoredEntry; score: number }> = []
    for (const h of items) {
      const known = this.derivedOf(h)
      const title = (known.title ??= foldedText(h.title))
      let score = scoreFolded(title, needle)
      // 100 is the best there is: the address cannot do better.
      if (score < 100) score = Math.max(score, scoreFolded((known.url ??= foldedText(h.url)), needle))
      if (score > 0) candidates.push({ h, score })
    }
    return firstOf(candidates, candidates.length, limit, (a, b) => b.score - a.score || b.h.visitCount - a.h.visitCount || b.h.lastVisitAt - a.h.lastVisitAt).map((m) => bare(m.h))
  }

  /** The page at this address, if the history holds it and the lock lets it be read. */
  get(url: string): HistoryEntry | undefined {
    const entry = this.entries.get(url)
    if (!entry) return undefined
    const visible = visibleUnder(this.veil())
    return visible === null || visible(entry) ? bare(entry) : undefined
  }

  /** The pages last visited from `from` (included) to `to` (excluded), most recent first; only those the lock lets be read. */
  between(from: number, to: number): HistoryEntry[] {
    const found: StoredEntry[] = []
    for (const entry of this.readable().items) if (entry.lastVisitAt >= from && entry.lastVisitAt < to) found.push(entry)
    return found.sort(byRecency).map(bare)
  }

  private derivedOf(entry: HistoryEntry): Derived {
    let known = this.derived.get(entry)
    if (!known) this.derived.set(entry, (known = {}))
    return known
  }

  /** The entry as it is written in the file (written once for as long as the entry is the same). */
  private lineOf(entry: HistoryEntry): string {
    const known = this.derivedOf(entry)
    return (known.line ??= JSON.stringify(entry))
  }

  /** Forgets one page, for good: one that was kept for a way back is dropped too. Returns whether it was there. */
  remove(url: string): boolean {
    this.dropKept(url)
    const removed = this.entries.delete(url)
    if (removed) this.scheduleSave()
    return removed
  }

  /**
   * Forgets one page as `remove` does (the file loses it at the next write), and keeps it aside in memory for `FORGOTTEN_KEPT_MS`, so that `putBack`
   * can undo the forgetting. Returns whether it was there.
   */
  removeKept(url: string, now = Date.now()): boolean {
    const entry = this.entries.get(url)
    this.dropKept(url)
    if (!entry) return false
    this.entries.delete(url)
    const clock = setTimeout(() => this.dropKept(url), FORGOTTEN_KEPT_MS)
    // A page that waits must not keep the application from quitting.
    clock.unref()
    this.forgotten.set(url, { entry, until: now + FORGOTTEN_KEPT_MS, clock })
    if (this.forgotten.size > FORGOTTEN_KEPT_MAX) this.dropKept(this.forgotten.keys().next().value)
    this.scheduleSave()
    return true
  }

  /**
   * Puts back a page forgotten by `removeKept`, as it was: its title, its visits, its date and the spaces it was visited in. Only a page this
   * history just forgot can come back (what the caller sends is an address, never a page), and only in time. A page visited again in the meantime
   * keeps that visit: its count is added and its date kept. Returns whether the page is back.
   */
  putBack(url: string, now = Date.now()): boolean {
    const kept = this.forgotten.get(url)
    if (!kept) return false
    this.dropKept(url)
    if (now > kept.until) return false
    const since = this.entries.get(url)
    if (since) {
      const spaces = [...new Set([...(since.spaces ?? []), ...(kept.entry.spaces ?? [])])].slice(0, HISTORY_SPACES_MAX)
      const { spaces: _before, ...page } = kept.entry
      this.entries.set(url, { ...page, title: since.title, visitCount: kept.entry.visitCount + since.visitCount, lastVisitAt: Math.max(kept.entry.lastVisitAt, since.lastVisitAt), ...(spaces.length > 0 ? { spaces } : {}) })
    } else this.entries.set(url, kept.entry)
    if (this.entries.size > MAX_ENTRIES) this.trim()
    this.scheduleSave()
    return true
  }

  /** Drops for good one page kept for a way back, or all of them: a wider forgetting was asked for, and nothing it covers may come back. */
  private dropKept(url?: string): void {
    for (const [key, kept] of this.forgotten) {
      if (url !== undefined && key !== url) continue
      clearTimeout(kept.clock)
      this.forgotten.delete(key)
    }
  }

  /**
   * Forgets every page last visited from `from` (included) to `to` (excluded): a whole day of the history panel, not only the rows the panel
   * had loaded. Only the pages the lock lets be read go (the panel shows no other: a page it never listed is not deleted behind its back).
   * Returns how many were forgotten.
   */
  removeBetween(from: number, to: number): number {
    const gone: string[] = []
    for (const entry of this.readable().items) if (entry.lastVisitAt >= from && entry.lastVisitAt < to) gone.push(entry.url)
    for (const url of gone) this.entries.delete(url)
    this.dropKept()
    if (gone.length > 0) this.scheduleSave()
    return gone.length
  }

  /** Forgets every page of one site (its subdomains too when asked). Returns how many were forgotten. */
  removeSite(host: string, subdomains = false): number {
    this.dropKept()
    let removed = 0
    for (const url of [...this.entries.keys()]) {
      if (!URL.canParse(url) || !hostBelongsToSite(new URL(url).host, host, subdomains)) continue
      this.entries.delete(url)
      removed++
    }
    if (removed > 0) this.scheduleSave()
    return removed
  }

  /** The hosts (port included) of the pages in the history that the lock lets be read, each once. */
  hosts(): string[] {
    return [...new Set([...this.readable().items].map((entry) => entry.url).filter((url) => URL.canParse(url)).map((url) => new URL(url).host))]
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.dropKept()
    this.entries.clear()
    this.scheduleSave()
  }

  /**
   * Forgets every page and removes the file, with the copies of an unreadable file that were set aside (they hold the same pages). For a
   * profile whose data is erased: nothing of its history may stay on disk. Answers whether that is so. When the files cannot be removed
   * the empty history is written over them instead, and a failure of that is reported as any failed save (notice, log, new attempt).
   */
  erase(): boolean {
    this.dropKept()
    this.entries.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirty = false
    // A write in flight carries pages that must not come back: it sees that its count is no longer wanted and removes its file.
    this.version++
    try {
      for (const file of [this.path, `${this.path}.tmp`, `${this.path}.tmp-async`, ...sideFiles(this.path, 'corrupt')]) rmSync(file, { force: true })
      this.onDisk = this.version
      this.failing = false
      return true
    } catch (error) {
      console.error(`[history] cannot remove ${this.path}; writing it empty instead:`, error)
      this.dirty = true
      return this.flush()
    }
  }

  /** Whether the pages in memory differ from the file. */
  isDirty(): boolean {
    return this.dirty
  }

  /** Writes the history now. Answers whether it is on disk; a failure never throws (see `StateStore.flush`): the pages stay in memory and the write is tried again. */
  flush(): boolean {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const version = this.version
    try {
      // The same text as `JSON.stringify` of the list, from the lines of the entries that did not change since the last write.
      writeFileAtomic(this.path, this.text())
      this.onDisk = version
      this.dirty = false
    } catch (error) {
      this.writeFailed(error, () => this.flush())
      return false
    }
    this.writeSucceeded()
    return true
  }

  private text(): string {
    return `[${[...this.entries.values()].map((entry) => this.lineOf(entry)).join(',')}]`
  }

  /** The first failure is told once (log, and a notice unless the file is held); every failure arms a new attempt. */
  private writeFailed(error: unknown, retry: () => void): void {
    if (!this.failing) {
      this.failing = true
      console.error(`[history] cannot write ${this.path}; the pages are kept in memory and the write is tried again:`, error)
      if (!(error instanceof HeldFileError)) reportPersistenceNotice({ kind: 'save-failed', file: basename(this.path), reason: String((error as Error).message ?? error) })
    }
    this.timer = setTimeout(retry, RETRY_DELAY_MS)
  }

  private writeSucceeded(): void {
    if (this.failing) {
      this.failing = false
      console.error(`[history] ${this.path} can be written again`)
    }
  }

  /**
   * The write the timer makes. With `asyncWrites` the process is not held while the disk takes the file (a history of 20 000 pages is megabytes, and the
   * disk can be slow): the text is made at once, written aside, and put in place unless a flush or an erasure has written something newer meanwhile.
   */
  private async save(): Promise<void> {
    this.timer = null
    if (!this.asyncWrites) {
      this.flush()
      return
    }
    // A write is already in flight: when it ends it arms a new one if pages came in meanwhile.
    if (this.writing) return
    this.writing = true
    const version = this.version
    try {
      const replaced = await writeFileAtomicAsync(this.path, this.text(), () => this.onDisk < version)
      if (replaced) {
        this.onDisk = version
        this.writeSucceeded()
      }
      this.dirty = this.version !== this.onDisk
    } catch (error) {
      this.writeFailed(error, () => void this.save())
    } finally {
      this.writing = false
    }
    if (this.dirty && !this.timer) this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = readJsonBounded(this.path, DATA_FILE_MAX_BYTES)
      if (!Array.isArray(parsed)) throw new Error('history file is not an array')
      // The spaces each page was visited in: `cleanHistory` keeps the fields of a page and nothing else, so they are read here, as ids.
      const tags = new Map<string, string[]>()
      for (const item of parsed) {
        if (!isRecord(item) || typeof item['url'] !== 'string') continue
        const spaces = cleanSpaceTags(item['spaces'])
        if (spaces) tags.set(item['url'], spaces)
        else tags.delete(item['url'])
      }
      // Entries are rebuilt, not trusted: one without a title or a date would make `search` throw on every keystroke.
      for (const entry of cleanHistory(parsed)) {
        const spaces = tags.get(entry.url)
        this.entries.set(entry.url, spaces ? { ...entry, spaces } : entry)
      }
      if (this.entries.size > MAX_ENTRIES) this.trim()
    } catch (error) {
      setAsideOrHold(this.path, error, 'history')
    }
  }

  /** Forgets the oldest pages beyond the limit; answers the ones forgotten. */
  private trim(): StoredEntry[] {
    const oldestFirst = [...this.entries.values()].sort((a, b) => a.lastVisitAt - b.lastVisitAt)
    const forgotten = oldestFirst.slice(0, this.entries.size - MAX_ENTRIES)
    for (const e of forgotten) this.entries.delete(e.url)
    return forgotten
  }

  private scheduleSave(): void {
    this.version++
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }
}

/** The profile whose history is `history.json`: the file as it was before profiles had a history of their own. */
export const DEFAULT_HISTORY_PROFILE = 'default'

/**
 * The file of a profile's history: `history.json` for the default profile (same name and format as ever, so that the previous version
 * still reads it), `history-<id>.json` for the others. A capital letter is written `~` and its lowercase: the file system of a Mac does not
 * tell `Travail` from `travail`, and two profiles must never share a file (`~` is not allowed in a profile id, so the names stay distinct).
 */
export function historyFileName(profileId: string): string {
  if (!isProfileId(profileId) || profileId === DEFAULT_HISTORY_PROFILE) return 'history.json'
  return `history-${profileId.replace(/[A-Z]/g, (letter) => `~${letter.toLowerCase()}`)}.json`
}

/** The profile a file of the user data folder holds the history of, or null when it is not one of ours (or is not a file we would write). */
export function profileOfHistoryFile(name: string): string | null {
  if (name === 'history.json') return DEFAULT_HISTORY_PROFILE
  const match = /^history-((?:[a-z0-9_-]|~[a-z])+)\.json$/.exec(name)
  if (!match) return null
  const id = match[1]!.replace(/~([a-z])/g, (_, letter: string) => letter.toUpperCase())
  // `history-default.json` is nothing we write: the default profile's history is `history.json`.
  return isProfileId(id) && id !== DEFAULT_HISTORY_PROFILE ? id : null
}

/**
 * The history of every profile, one `HistoryStore` (one file) each, loaded when the profile is first asked for. Profiles do not see each
 * other's pages: a space shows, suggests and forgets those of its own profile, and a profile shared by several spaces shares its history.
 * `history.json`, which held the pages of every profile before they were told apart, is the default profile's history: nothing is moved
 * or rewritten when this version first runs, so it can be started twice, or the previous version put back, without losing a page.
 */
export class HistoryBook {
  private readonly stores = new Map<string, HistoryStore>()

  /** `recording` says, per profile, whether its visits are kept (default: always). */
  constructor(
    private readonly dir: string,
    private readonly recording: (profileId: string) => boolean = () => true,
    /** The timed writes of the histories do not hold the process (see `HistoryStore`). */
    private readonly asyncWrites = false,
    /** What the lock lets be read of every history (see `HistoryVeil`): the lock of the application, unless a test hands in its own. */
    private readonly veil: () => HistoryVeil = lockVeil
  ) {}

  /**
   * The history of a profile. What is not a profile id is the default profile, as for a space (see `cleanSpaces`). With `spaceId`, the same history
   * as the visits of that space record it (see `HistoryStore.inSpace`).
   */
  of(profileId: string, spaceId?: string): HistoryStore {
    const id = isProfileId(profileId) ? profileId : DEFAULT_HISTORY_PROFILE
    let store = this.stores.get(id)
    if (!store) this.stores.set(id, (store = new HistoryStore(join(this.dir, historyFileName(id)), { recording: () => this.recording(id), asyncWrites: this.asyncWrites, veil: this.veil })))
    return spaceId === undefined ? store : store.inSpace(spaceId)
  }

  /** Every profile that has pages, in memory or on disk (the default one first). */
  profiles(): string[] {
    const ids = new Set<string>()
    try {
      for (const name of readdirSync(this.dir)) {
        const id = profileOfHistoryFile(name)
        if (id !== null) ids.add(id)
      }
    } catch (error) {
      // Profiles that are only on disk are missed; those in memory are still listed.
      console.error(`[history] cannot list the histories in ${this.dir}:`, error)
    }
    for (const [id, store] of this.stores) if (store.size() > 0) ids.add(id)
    return [...ids].sort((a, b) => (a === DEFAULT_HISTORY_PROFILE ? -1 : b === DEFAULT_HISTORY_PROFILE ? 1 : a.localeCompare(b)))
  }

  /** Forgets the history of a profile and its file (see `HistoryStore.erase`). Throws for what is not a profile id: erasing the default profile's history in its place would be wrong. */
  erase(profileId: string): boolean {
    if (!isProfileId(profileId)) throw new Error(`Invalid profile id: ${String(profileId)}`)
    let store = this.stores.get(profileId)
    if (!store) this.stores.set(profileId, (store = new HistoryStore(join(this.dir, historyFileName(profileId)), { load: false, recording: () => this.recording(profileId), asyncWrites: this.asyncWrites, veil: this.veil })))
    return store.erase()
  }

  /** Writes the histories that changed. Answers whether all of them are on disk. */
  flush(): boolean {
    let all = true
    for (const store of this.stores.values()) if (store.isDirty() && !store.flush()) all = false
    return all
  }
}
