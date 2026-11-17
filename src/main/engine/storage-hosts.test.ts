import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPY_PREFIX } from '../importers/sqlite'
import { batch, logFile, tableFile } from './leveldb-fixture'
import { QUOTA_DB_MAX, hostOfIndexedDbFolder, hostOfStorageKey, listStorageHosts } from './storage-hosts'
import { onWindows } from '../windows.test-support'

let profile: string
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'storage-hosts-'))
  copiesBefore = new Set(copies())
})
afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** The quota manager's database as the engine lays it out, reduced to the columns that are read. */
function writeQuota(keys: string[], table = 'buckets'): void {
  mkdirSync(join(profile, 'WebStorage'), { recursive: true })
  const db = new DatabaseSync(join(profile, 'WebStorage', 'QuotaManager'))
  db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key TEXT NOT NULL, host TEXT NOT NULL, name TEXT NOT NULL)`)
  const insert = db.prepare(`INSERT INTO ${table}(storage_key, host, name) VALUES (?, '', '_default')`)
  for (const key of keys) insert.run(key)
  db.close()
}

function writeLocalStorage(origins: string[]): void {
  const dir = join(profile, 'Local Storage', 'leveldb')
  mkdirSync(dir, { recursive: true })
  const [first, ...rest] = origins
  if (first !== undefined) writeFileSync(join(dir, '000003.log'), logFile([batch(1, [{ key: `META:${first}`, value: 'm' }])]))
  writeFileSync(join(dir, '000005.ldb'), tableFile(rest.map((origin, i) => ({ key: `META:${origin}`, sequence: i + 2, value: 'm' })), { compress: true }))
}

/** The copies of a quota database in the temporary folder (other tests make folders of the same prefix for their own files). */
const copies = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith(COPY_PREFIX) && existsSync(join(tmpdir(), name, 'QuotaManager')))
let copiesBefore: Set<string>
/** The copies made since the test began and still there. */
const leftovers = (): string[] => copies().filter((name) => !copiesBefore.has(name))

describe('hostOfStorageKey', () => {
  it('gives the host of an origin, with its port, whether the key is a site’s own or kept apart inside another site', () => {
    expect(hostOfStorageKey('https://app.example.com/')).toBe('app.example.com')
    expect(hostOfStorageKey('https://app.example.com')).toBe('app.example.com')
    expect(hostOfStorageKey('http://localhost:3000/')).toBe('localhost:3000')
    expect(hostOfStorageKey('https://cdn.example.com/^0https://other.test')).toBe('cdn.example.com')
  })

  it('answers nothing for what is not a web origin', () => {
    for (const key of ['chrome-extension://abcdefghijklmnop/', 'file:///', 'devtools://devtools/', '', 'example.com', 'https://']) expect(hostOfStorageKey(key), key).toBeNull()
  })
})

describe('hostOfIndexedDbFolder', () => {
  it('reads the host out of the name of the folder, with a port that is not the scheme’s own', () => {
    expect(hostOfIndexedDbFolder('https_mail.example.com_0.indexeddb.leveldb')).toBe('mail.example.com')
    expect(hostOfIndexedDbFolder('https_mail.example.com_0.indexeddb.blob')).toBe('mail.example.com')
    expect(hostOfIndexedDbFolder('http_localhost_3000.indexeddb.leveldb')).toBe('localhost:3000')
    expect(hostOfIndexedDbFolder('https_my_host.example.com_0.indexeddb.leveldb')).toBe('my_host.example.com')
  })

  it('answers nothing for the folder of an extension or any other name', () => {
    for (const name of ['chrome-extension_abcdefghijklmnop_0.indexeddb.leveldb', '.DS_Store', 'https_example.com_0', 'https__0.indexeddb.leveldb']) expect(hostOfIndexedDbFolder(name), name).toBeNull()
  })
})

describe('listStorageHosts', () => {
  it('answers an empty list, with nothing unread, for a profile that stored nothing yet', async () => {
    expect(await listStorageHosts(profile)).toEqual({ hosts: [], unread: [] })
  })

  it('puts together local storage, the IndexedDB folders and the quota manager’s table, each host once', async () => {
    writeLocalStorage(['https://local.example.com', 'https://both.example.com', 'https://framed.example.com/^0https://other.test'])
    mkdirSync(join(profile, 'IndexedDB', 'https_idb.example.com_0.indexeddb.leveldb'), { recursive: true })
    mkdirSync(join(profile, 'IndexedDB', 'chrome-extension_abcdefghijklmnop_0.indexeddb.leveldb'))
    writeQuota(['https://cache.example.com/', 'https://both.example.com/', 'https://worker.example.com:8443/', 'chrome-extension://abcdefghijklmnop/'])
    expect(await listStorageHosts(profile)).toEqual({
      hosts: ['both.example.com', 'cache.example.com', 'framed.example.com', 'idb.example.com', 'local.example.com', 'worker.example.com:8443'],
      unread: []
    })
  })

  it('reads a copy of the quota database, never the file the engine holds, and leaves no copy behind', async () => {
    writeQuota(['https://cache.example.com/'])
    await listStorageHosts(profile)
    // Nothing was made next to the original (a journal, a lock), and the copy is gone.
    expect(readdirSync(join(profile, 'WebStorage'))).toEqual(['QuotaManager'])
    expect(leftovers()).toEqual([])
  })

  it('names the record it could not read, logs why, and still answers what the others hold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeLocalStorage(['https://local.example.com'])
    writeFileSync(join(profile, 'Local Storage', 'leveldb', '000009.ldb'), Buffer.alloc(100, 1))
    writeQuota(['https://cache.example.com/'])
    expect(await listStorageHosts(profile)).toEqual({ hosts: ['cache.example.com'], unread: ['Local Storage'] })
    expect(warn).toHaveBeenCalledWith('[site] cannot list the sites that hold storage (Local Storage):', expect.stringMatching(/mark of a table/))
  })

  it('says the quota database is unread when it is not one, or has no table of buckets, and removes its copy all the same', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeQuota(['https://cache.example.com/'], 'other')
    expect(await listStorageHosts(profile)).toEqual({ hosts: [], unread: ['QuotaManager'] })
    expect(warn).toHaveBeenLastCalledWith('[site] cannot list the sites that hold storage (QuotaManager):', 'the quota database has no table of buckets')

    writeFileSync(join(profile, 'WebStorage', 'QuotaManager'), 'not a database at all, only some text that is long enough to be read')
    expect((await listStorageHosts(profile)).unread).toEqual(['QuotaManager'])
    expect(leftovers()).toEqual([])
  })

  it('does not copy a quota database too big to be one, and says it is unread', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeQuota(['https://cache.example.com/'])
    // A hole of that size takes no room on the disk; a copy of it would.
    truncateSync(join(profile, 'WebStorage', 'QuotaManager'), QUOTA_DB_MAX + 1)
    expect(await listStorageHosts(profile)).toEqual({ hosts: [], unread: ['QuotaManager'] })
    expect(warn).toHaveBeenLastCalledWith('[site] cannot list the sites that hold storage (QuotaManager):', expect.stringMatching(/too big to be read/))
    expect(leftovers()).toEqual([])
  })

  it('refuses a view named like the table: a query over it could compute anything', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mkdirSync(join(profile, 'WebStorage'))
    const db = new DatabaseSync(join(profile, 'WebStorage', 'QuotaManager'))
    db.exec("CREATE VIEW buckets AS SELECT 'https://forged.example.com/' AS storage_key")
    db.close()
    expect(await listStorageHosts(profile)).toEqual({ hosts: [], unread: ['QuotaManager'] })
  })

  // Windows: `chmod 000` does not make a folder unlistable there (it only sets the read-only flag).
  it.skipIf(onWindows)('says the IndexedDB folder is unread when it cannot be listed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dir = join(profile, 'IndexedDB')
    mkdirSync(dir)
    chmodSync(dir, 0o000)
    try {
      expect(await listStorageHosts(profile)).toEqual({ hosts: [], unread: ['IndexedDB'] })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(existsSync(dir)).toBe(true)
  })
})
