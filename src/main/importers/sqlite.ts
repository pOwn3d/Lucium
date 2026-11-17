// Reads the SQLite files other browsers keep (history, Firefox bookmarks) with the SQLite that comes with Node. The browser may be
// running and holding its file: the file is copied first (with its write-ahead log), and only the copy is opened, never the original.
// The copy is removed when the read ends; one that a killed process left behind is removed at the next launch, and again before the next
// import (`sweepStaleCopies`).

import { copyFileSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FirefoxBookmarkRow } from './firefox'
import type { HistoryRow } from './history'
import { MAX_URL_LENGTH } from './limits'
import { ImportReadError } from './read-error'
import { t } from '@shared/i18n'

/** Most pages one import reads: a bit more than the history store keeps, so merging duplicates still fills it. */
const ROW_LIMIT = 30_000
/** Most rows of moz_bookmarks one import reads. A profile holds a few thousand (tags and folders included); this only stops a damaged file. */
export const BOOKMARK_ROW_LIMIT = 100_000

/**
 * Biggest database (with its write-ahead log) the import copies. A real history weighs a few hundred megabytes at the very most; a file
 * beyond this is not what it claims to be, and copying it would fill the disk before a single row was read.
 */
export const MAX_DB_BYTES = 1024 * 1024 * 1024

const SIDE_FILES = ['-wal', '-shm', '-journal']

/** The folders of the copies, in the temporary folder: `lucium-import-<random>`. The engine names its own short-lived copy of a database the same way, for the same sweep. */
export const COPY_PREFIX = 'lucium-import-'
/** A copy untouched for this long is the leftover of an import that was cut short (a read takes seconds): a copy in use is never this old. */
export const STALE_COPY_MS = 60 * 60 * 1000

/**
 * Removes the copies that an import cut short (the process killed in the middle of a read) left in the temporary folder `dir`: up to a gigabyte of
 * another browser's history each. Only the folders of this name, of this user, not followed through a link, and untouched for `STALE_COPY_MS`, so that
 * the copy of an import running beside this one (another instance, a test) is never touched. Answers how many went; never throws.
 */
export function sweepStaleCopies(dir: string, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const uid = process.getuid?.()
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(COPY_PREFIX)) continue
    const path = join(dir, name)
    try {
      const info = lstatSync(path)
      if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue
      // The folder's time is the one of the last file made in it (the copy, then SQLite's own side files): a read in progress keeps it recent.
      if (now - info.mtimeMs < STALE_COPY_MS) continue
      rmSync(path, { recursive: true, force: true })
      removed++
    } catch (error) {
      console.warn(`[import] a copy left by an earlier import cannot be removed (${name}):`, error instanceof Error ? error.message : error)
    }
  }
  return removed
}

/** How long after the launch the leftovers are looked for: once the window is up and its first pages load, not before it shows. */
export const STALE_SWEEP_DELAY_MS = 30_000

/**
 * `sweepStaleCopies` a little later, for the launch: listing the whole temporary folder of the system is not something to do before the first
 * window shows, for an import most launches never make (an import sweeps by itself before it copies). The timer never keeps the application alive.
 */
export function sweepStaleCopiesSoon(dir: string, delayMs = STALE_SWEEP_DELAY_MS): NodeJS.Timeout {
  const timer = setTimeout(() => void sweepStaleCopies(dir), delayMs)
  timer.unref()
  return timer
}

/**
 * What SQLite asks of an application that opens a database it did not write, set before the first query: the functions a view, a trigger, a
 * default value or a computed column of the file may call are the harmless ones only, and a row whose size does not fit its page is an error
 * instead of a read past the end of it.
 */
export function distrustDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA trusted_schema = OFF; PRAGMA cell_size_check = ON')
}

/**
 * Nothing is written to the database from here on. Set after the first read and not at the opening: that first read is when SQLite rolls back
 * the journal of a transaction the browser was in the middle of, which it cannot do to a database it may not write (see `withCopy`).
 */
export function stopWrites(db: DatabaseSync): void {
  db.exec('PRAGMA query_only = ON')
}

/**
 * Opens a copy of the database and hands it to `read`. The file is hostile input: it must be an ordinary file of a bounded
 * size, and the tables the query uses must be real tables (a view of that name could run a computation of any length).
 */
function withCopy<T>(path: string, tables: readonly string[], read: (db: DatabaseSync) => T): T {
  // Throws EPERM/EACCES/ENOENT: the caller tells those apart.
  const info = statSync(path)
  // A pipe or a device reports a size of zero and would never end.
  if (!info.isFile()) throw new ImportReadError(t('import.ce-n-est-pas-un-fichier-ordinaire'))
  // The log and the other side files that sit next to the database. A browser that closes folds its log into the database and removes it,
  // so one that is gone by the time it is looked at is no failure; one that is not an ordinary file (a pipe someone left there) is not copied.
  const sides: string[] = []
  let total = info.size
  for (const suffix of SIDE_FILES) {
    try {
      const side = statSync(path + suffix)
      if (!side.isFile()) continue
      sides.push(suffix)
      total += side.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (total > MAX_DB_BYTES) throw new ImportReadError(t('import.fichier-trop-volumineux', { size: Math.round(total / 1024 / 1024), max: MAX_DB_BYTES / 1024 / 1024 }))

  // What an import cut short left goes first (the launch looks too, src/main/index.ts: this is the moment a copy is made).
  sweepStaleCopies(tmpdir())
  const dir = mkdtempSync(join(tmpdir(), COPY_PREFIX))
  try {
    const target = join(dir, basename(path))
    copyFileSync(path, target)
    // The most recent visits live in the log until the browser folds them in.
    for (const suffix of sides) {
      try {
        copyFileSync(path + suffix, target + suffix)
      } catch (error) {
        // Removed between the check and the copy: the browser folded it in, and the database now holds what it held.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    // The copy is ours, so it is opened for writing: a browser that was in the middle of a transaction leaves a "hot" journal, which SQLite
    // rolls back before it reads, and it cannot do that to a database opened read-only (the error was "attempt to write a readonly
    // database", for a file that was only being written). The queries below are fixed SELECTs, and only the copy is ever opened.
    const db = new DatabaseSync(target)
    try {
      distrustDatabase(db)
      for (const table of tables) {
        const found = db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table) as { type?: unknown } | undefined
        if (found?.type !== 'table') throw new ImportReadError(t('sqlite.la-table-table-manque-ce-n-est-pas-le-fichier', { table }))
      }
      // The journal a browser left is rolled back by now: the rest only reads.
      stopWrites(db)
      return read(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// What a query asks for is bounded in SQL, before a cell becomes a JavaScript value: a title of 100 MB would be read whole otherwise, and an
// integer beyond 2^53 makes the whole query fail. The bounds match what the importers keep (limits.ts: 8192 characters of address; titles are cut at 4096 by the state).
const URL_SQL = (column: string) => `substr(${column}, 1, ${MAX_URL_LENGTH + 1})`
const TITLE_SQL = (column: string) => `substr(${column}, 1, 4096)`
const VISITS_SQL = (column: string) => `MIN(MAX(${column}, 0), 1000000000)`
/** Latest date taken as one: the year 3000 in microseconds. Beyond it (or before 1970) a row is a damaged one. */
const MAX_MICROS = 32_503_680_000_000_000

/** Chromium browsers: `urls`, with dates in microseconds since 1601-01-01. */
export function readChromiumHistory(path: string): HistoryRow[] {
  // `hidden` marks the addresses Chromium keeps for itself (frames loaded inside a page): they are not in its history page, nor here.
  return withCopy(path, ['urls'], (db) =>
    db
      .prepare(
        `SELECT ${URL_SQL('url')} AS url, ${TITLE_SQL('title')} AS title, ${VISITS_SQL('visit_count')} AS visits, (last_visit_time / 1000 - 11644473600000) AS ms
         FROM urls WHERE last_visit_time > 11644473600000000 AND last_visit_time < ${MAX_MICROS + 11_644_473_600_000_000} AND hidden = 0 ORDER BY last_visit_time DESC LIMIT ${ROW_LIMIT}`
      )
      .all() as unknown as HistoryRow[]
  )
}

/** Safari: one row per page in `history_items`, one per visit in `history_visits` (dates in seconds since 2001-01-01). */
export function readSafariHistory(path: string): HistoryRow[] {
  return withCopy(path, ['history_items', 'history_visits'], (db) =>
    db
      .prepare(
        `SELECT ${URL_SQL('i.url')} AS url, ${TITLE_SQL('v.title')} AS title, ${VISITS_SQL('i.visit_count')} AS visits, CAST((MAX(v.visit_time) + 978307200) * 1000 AS INTEGER) AS ms
         FROM history_items i JOIN history_visits v ON v.history_item = i.id WHERE v.visit_time > -978307200 AND v.visit_time < ${MAX_MICROS / 1_000_000 - 978_307_200} GROUP BY i.id ORDER BY ms DESC LIMIT ${ROW_LIMIT}`
      )
      .all() as unknown as HistoryRow[]
  )
}

/** Firefox: `moz_places`, with dates in microseconds since the epoch. */
export function readFirefoxHistory(path: string): HistoryRow[] {
  return withCopy(path, ['moz_places'], (db) =>
    db
      .prepare(
        `SELECT ${URL_SQL('url')} AS url, ${TITLE_SQL('title')} AS title, ${VISITS_SQL('visit_count')} AS visits, (last_visit_date / 1000) AS ms
         FROM moz_places WHERE visit_count > 0 AND last_visit_date > 0 AND last_visit_date < ${MAX_MICROS} ORDER BY last_visit_date DESC LIMIT ${ROW_LIMIT}`
      )
      .all() as unknown as HistoryRow[]
  )
}

export function readFirefoxBookmarks(path: string, limit = BOOKMARK_ROW_LIMIT): FirefoxBookmarkRow[] {
  return withCopy(path, ['moz_bookmarks', 'moz_places'], (db) =>
    db
      .prepare(
        `SELECT b.id AS id, b.type AS type, b.parent AS parent, b.position AS position, ${TITLE_SQL('b.title')} AS title, ${URL_SQL('p.url')} AS url
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.id LIMIT ?`
      )
      .all(limit) as unknown as FirefoxBookmarkRow[]
  )
}
