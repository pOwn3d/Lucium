// The sites that really hold storage in a profile, read from the profile's folder. The engine has no call that lists them: its erasures take
// exact origins, and a subdomain nobody saw in a tab could not be named. Three records the engine keeps are read here, without writing to any:
// the keys of local storage (a LevelDB folder), the names of the IndexedDB folders, and the table of the quota manager (a SQLite file), which
// names every origin with IndexedDB, cache storage, service workers, sandboxed files or licences of protected video.
// What these do not hold: the HTTP cache (the engine keeps no list of its origins) and what a page wrote in the last seconds, which the engine
// may not have put on disk yet.

import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { COPY_PREFIX, distrustDatabase, stopWrites } from '../importers/sqlite'
import { readLevelDbKeys } from './leveldb-keys'

/** What a profile's folder says: the hosts (`host[:port]`) that hold storage, and the records that could not be read. */
export interface StorageHosts {
  hosts: string[]
  /** The names of the records that failed (see `STORAGE_RECORDS`). Not empty: the list of hosts may miss some. */
  unread: string[]
}

/** The records read, by the name the engine gives them on disk. */
export const STORAGE_RECORDS = ['Local Storage', 'IndexedDB', 'QuotaManager'] as const

/** Biggest quota database copied: it holds one short row per origin. */
export const QUOTA_DB_MAX = 64 * 1024 * 1024
/** Most rows read from it. */
const QUOTA_ROWS_MAX = 100_000

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/**
 * The host of a storage key as the engine writes it: an origin, then for storage kept apart inside another site, `^` and what tells it
 * apart. Null for anything that is not a web origin (an extension, a file).
 */
export function hostOfStorageKey(key: string): string | null {
  const origin = key.split('^', 1)[0]!
  if (!/^https?:\/\//.test(origin) || !URL.canParse(origin)) return null
  return new URL(origin).host || null
}

/**
 * The host of an IndexedDB folder, named `<scheme>_<host>_<port>.indexeddb.leveldb` (port 0 for the scheme's own; `.blob` for its files, and any
 * other word the engine may give a database kept another way). Null for any other name.
 */
export function hostOfIndexedDbFolder(name: string): string | null {
  const match = /^(https?)_(.+)_(\d{1,5})\.indexeddb\.[a-z]+$/.exec(name)
  if (!match) return null
  const [, scheme, host, port] = match
  const origin = `${scheme}://${host}${port === '0' ? '' : `:${port}`}`
  return URL.canParse(origin) ? new URL(origin).host || null : null
}

/** Local storage: one `META:` key (and one `METAACCESS:` key) per storage key that holds something. */
async function localStorageHosts(folder: string): Promise<Array<string | null>> {
  const keys = await readLevelDbKeys(join(folder, 'Local Storage', 'leveldb'), ['META:', 'METAACCESS:'])
  return keys.map((key) => hostOfStorageKey(key.slice(key.indexOf(':') + 1)))
}

async function indexedDbHosts(folder: string): Promise<Array<string | null>> {
  try {
    return (await readdir(join(folder, 'IndexedDB'))).map(hostOfIndexedDbFolder)
  } catch (error) {
    // No folder: no site ever opened a database.
    if (isMissing(error)) return []
    throw error
  }
}

/**
 * The quota manager's table of buckets. The engine holds the file open: it is copied (with its journal) to a folder of the temporary folder that
 * only this user reads, and only the copy is opened. The folder is named as the copies of the imports are, so that one left by a killed process
 * is removed at the next launch by the same sweep.
 */
async function quotaHosts(folder: string): Promise<Array<string | null>> {
  const source = join(folder, 'WebStorage', 'QuotaManager')
  let size: number
  try {
    size = (await stat(source)).size
  } catch (error) {
    // No file: nothing was stored under a quota yet.
    if (isMissing(error)) return []
    throw error
  }
  if (size > QUOTA_DB_MAX) throw new Error(`the quota database is too big to be read (${size} bytes)`)
  const dir = await mkdtemp(join(tmpdir(), COPY_PREFIX))
  try {
    const target = join(dir, 'QuotaManager')
    await copyFile(source, target)
    for (const suffix of ['-wal', '-journal']) {
      try {
        await copyFile(source + suffix, target + suffix)
      } catch (error) {
        // No journal: the database holds everything.
        if (!isMissing(error)) throw error
      }
    }
    const db = new DatabaseSync(target)
    try {
      distrustDatabase(db)
      const table = db.prepare("SELECT type FROM sqlite_master WHERE name = 'buckets'").get() as { type?: unknown } | undefined
      if (table?.type !== 'table') throw new Error('the quota database has no table of buckets')
      stopWrites(db)
      const rows = db.prepare(`SELECT DISTINCT substr(storage_key, 1, 2048) AS key FROM buckets LIMIT ${QUOTA_ROWS_MAX}`).all() as Array<{ key?: unknown }>
      return rows.map((row) => (typeof row.key === 'string' ? hostOfStorageKey(row.key) : null))
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const READERS: Record<(typeof STORAGE_RECORDS)[number], (folder: string) => Promise<Array<string | null>>> = {
  'Local Storage': localStorageHosts,
  IndexedDB: indexedDbHosts,
  QuotaManager: quotaHosts
}

/**
 * The hosts that hold storage in the profile kept in `folder`. A record that cannot be read does not stop the others: it is named in `unread`
 * and logged with its reason, and the caller says that its list is not whole.
 */
export async function listStorageHosts(folder: string): Promise<StorageHosts> {
  const hosts = new Set<string>()
  const unread: string[] = []
  for (const record of STORAGE_RECORDS) {
    try {
      for (const host of await READERS[record](folder)) if (host !== null) hosts.add(host)
    } catch (error) {
      console.warn(`[site] cannot list the sites that hold storage (${record}):`, error instanceof Error ? error.message : error)
      unread.push(record)
    }
  }
  return { hosts: [...hosts].sort(), unread }
}
