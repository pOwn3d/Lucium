import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { onWindows } from '../windows.test-support'
import { toHistoryEntries } from './history'
import { BOOKMARK_ROW_LIMIT, MAX_DB_BYTES, STALE_COPY_MS, STALE_SWEEP_DELAY_MS, distrustDatabase, readChromiumHistory, readFirefoxBookmarks, readFirefoxHistory, readSafariHistory, stopWrites, sweepStaleCopies, sweepStaleCopiesSoon } from './sqlite'

// Synthetic databases with the tables and columns of the real ones, and dates as each browser writes them.
const dir = mkdtempSync(join(tmpdir(), 'lucium-sqlite-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const make = (name: string, sql: string): string => {
  const path = join(dir, name)
  const db = new DatabaseSync(path)
  db.exec(sql)
  db.close()
  return path
}

const WHEN = Date.UTC(2026, 3, 2, 10, 30, 0)
const chromeMicros = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 1000n

describe('history readers', () => {
  it('Chromium: microseconds since 1601 (beyond 2^53) come out as epoch milliseconds', () => {
    const path = make('History', `CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, 'https://chrome.example/a', 'A', 4, 0, ${chromeMicros(WHEN)}, 0), (2, 'https://chrome.example/never', 'N', 1, 0, 0, 0);`)
    const rows = readChromiumHistory(path)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.ms)).toBe(WHEN)
    expect(toHistoryEntries(rows, WHEN + 1000)[0]).toEqual({ url: 'https://chrome.example/a', title: 'A', visitCount: 4, lastVisitAt: WHEN })
  })

  it('Safari: seconds since 2001, the title of the latest visit, one row per page', () => {
    const apple = (ms: number) => (ms - Date.UTC(2001, 0, 1)) / 1000
    const path = make('History.db', `CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, domain_expansion TEXT, visit_count INTEGER);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
      INSERT INTO history_items VALUES (1, 'https://safari.example/', NULL, 3), (2, 'https://safari.example/lonely', NULL, 1);
      INSERT INTO history_visits VALUES (1, 1, ${apple(WHEN - 5000)}, 'Ancien titre'), (2, 1, ${apple(WHEN)}, 'Titre récent'), (3, 1, ${apple(WHEN - 9000)}, 'Plus ancien');`)
    const rows = readSafariHistory(path)
    expect(rows).toHaveLength(1)
    expect(toHistoryEntries(rows, WHEN + 1000)[0]).toEqual({ url: 'https://safari.example/', title: 'Titre récent', visitCount: 3, lastVisitAt: WHEN })
  })

  it('Firefox: microseconds since the epoch, places never visited left out', () => {
    const path = make('places.sqlite', `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
      INSERT INTO moz_places VALUES (1, 'https://fox.example/', 'Fox', 2, ${WHEN * 1000}), (2, 'https://fox.example/bookmarked-only', 'B', 0, NULL);`)
    const rows = readFirefoxHistory(path)
    expect(toHistoryEntries(rows, WHEN + 1000)).toEqual([{ url: 'https://fox.example/', title: 'Fox', visitCount: 2, lastVisitAt: WHEN }])
  })

  it('Firefox bookmarks: rows joined with their place', () => {
    const path = make('places-bookmarks.sqlite', `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
      INSERT INTO moz_places VALUES (1, 'https://fox.example/b');
      INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 0, 'toolbar'), (10, 1, 1, 3, 0, 'Signet');`)
    expect(readFirefoxBookmarks(path)).toEqual([
      { id: 3, type: 2, parent: 1, position: 0, title: 'toolbar', url: null },
      { id: 10, type: 1, parent: 3, position: 0, title: 'Signet', url: 'https://fox.example/b' }
    ])
  })

  it('Firefox bookmarks: reads no more rows than the limit, structure first (a damaged file cannot fill the memory)', () => {
    const inserts = Array.from({ length: 50 }, (_, i) => `(${100 + i}, 1, 1, 3, ${i}, 'B${i}')`).join(',')
    const path = make('places-many.sqlite', `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
      INSERT INTO moz_places VALUES (1, 'https://fox.example/b');
      INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 0, 'toolbar'), ${inserts};`)
    expect(readFirefoxBookmarks(path)).toHaveLength(51)
    const rows = readFirefoxBookmarks(path, 10)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({ id: 3, type: 2 })
    expect(BOOKMARK_ROW_LIMIT).toBeGreaterThan(10_000)
  })

  it('reads a database that its browser still holds open (it works on a copy)', () => {
    const path = join(dir, 'History-locked')
    const writer = new DatabaseSync(path)
    writer.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      BEGIN IMMEDIATE; INSERT INTO urls VALUES (1, 'https://locked.example/', 'L', 1, 0, ${chromeMicros(WHEN)}, 0);`)
    // The transaction is still open on the writer's connection, as when the browser is mid-write.
    expect(() => readChromiumHistory(path)).not.toThrow()
    writer.exec('COMMIT')
    writer.close()
    expect(readChromiumHistory(path)).toHaveLength(1)
  })

  it('reads the rows that are still only in the write-ahead log of a browser that is running (the log is copied with the database)', () => {
    const path = join(dir, 'places-wal.sqlite')
    const writer = new DatabaseSync(path)
    // No checkpoint: the rows stay in the -wal file, as when Firefox has not folded them in yet.
    writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
      INSERT INTO moz_places VALUES (1, 'https://wal.example/', 'Dans le journal', 2, ${WHEN * 1000});`)
    try {
      expect(existsSync(`${path}-wal`)).toBe(true)
      expect(readFirefoxHistory(path)).toMatchObject([{ url: 'https://wal.example/', title: 'Dans le journal', visits: 2 }])
      // The browser can still write: nothing was taken from it.
      writer.exec("INSERT INTO moz_places VALUES (2, 'https://wal.example/apres', 'Après', 1, " + WHEN * 1000 + ')')
      expect(readFirefoxHistory(path)).toHaveLength(2)
    } finally {
      writer.close()
    }
  })

  it('reads the last committed state of a database its browser is in the middle of writing (a hot rollback journal), instead of failing on a "readonly database"', () => {
    const path = join(dir, 'History-hot')
    const writer = new DatabaseSync(path)
    writer.exec(`PRAGMA journal_mode = DELETE; PRAGMA cache_size = 2; PRAGMA synchronous = OFF;
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, 'https://committed.example/', 'Validé', 1, 0, ${chromeMicros(WHEN)}, 0);
      BEGIN;`)
    try {
      // A long transaction: its pages spill into the database file and the original ones are kept in the journal.
      for (let i = 2; i < 2000; i++) writer.exec(`INSERT INTO urls VALUES (${i}, 'https://pending${i}.example/', '${'t'.repeat(300)}', 1, 0, ${chromeMicros(WHEN)}, 0);`)
      expect(existsSync(`${path}-journal`)).toBe(true)
      expect(readChromiumHistory(path).map((r) => r.url)).toEqual(['https://committed.example/'])
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })

  it('does not write to what it reads: the original and its side files are as they were', () => {
    const path = join(dir, 'History-intact')
    const writer = new DatabaseSync(path)
    writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, 'https://intact.example/', 'I', 1, 0, ${chromeMicros(WHEN)}, 0);`)
    try {
      const sizes = () => [path, `${path}-wal`].map((p) => statSync(p).size)
      const before = sizes()
      expect(readChromiumHistory(path)).toHaveLength(1)
      expect(sizes()).toEqual(before)
    } finally {
      writer.close()
    }
  })

  // Windows: a named pipe is made with mkfifo, which Windows does not have.
  it.skipIf(onWindows)('does not wait for a pipe left where the log should be, and does not fail for a log that is gone (a browser that closes removes it)', () => {
    const base = make('History-sides', `CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, 'https://sides.example/', 'S', 1, 0, ${chromeMicros(WHEN)}, 0);`)
    execFileSync('/usr/bin/mkfifo', [`${base}-wal`])
    // A link whose target is gone: it exists as a name and has nothing behind it, as a log removed under the reader's feet does.
    symlinkSync(join(dir, 'nowhere'), `${base}-shm`)
    expect(readChromiumHistory(base).map((r) => r.url)).toEqual(['https://sides.example/'])
  })

  it('says what happened when the file is missing, instead of an empty history', () => {
    expect(() => readChromiumHistory(join(dir, 'absent'))).toThrow(/ENOENT/)
  })
})

describe('files that are not what they claim to be', () => {
  const urlsTable = 'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);'
  const row = (id: number, url: string, extra: { title?: string; visits?: string; when?: string | bigint; hidden?: number } = {}) =>
    `INSERT INTO urls VALUES (${id}, '${url}', '${extra.title ?? 't'}', ${extra.visits ?? '1'}, 0, ${extra.when ?? chromeMicros(WHEN)}, ${extra.hidden ?? 0});`
  const sparse = (path: string, bytes: number) => truncateSync(path, bytes)

  it('refuses a database larger than the bound, before copying a byte of it', () => {
    const path = make('History-huge', urlsTable)
    sparse(path, MAX_DB_BYTES + 1)
    expect(() => readChromiumHistory(path)).toThrow(/trop volumineux/)
  })

  it('counts the write-ahead log with the database: a log that fills the disk is as much a refusal', () => {
    const path = make('History-biglog', urlsTable)
    writeFileSync(`${path}-wal`, '')
    sparse(`${path}-wal`, MAX_DB_BYTES + 1)
    expect(() => readChromiumHistory(path)).toThrow(/trop volumineux/)
  })

  it('refuses a folder in place of the file', () => {
    const folder = join(dir, 'History-folder')
    mkdirSync(folder)
    expect(() => readChromiumHistory(folder)).toThrow(/pas un fichier ordinaire/)
  })

  // Windows: a named pipe is made with mkfifo, which Windows does not have.
  it.skipIf(onWindows)('refuses a pipe, which reports a size of zero and would never end', () => {
    const pipe = join(dir, 'History-pipe')
    execFileSync('/usr/bin/mkfifo', [pipe])
    expect(() => readChromiumHistory(pipe)).toThrow(/pas un fichier ordinaire/)
  })

  it('refuses a view in place of the table: a view can run a computation of any length', () => {
    const path = make('History-view', 'CREATE TABLE real (url TEXT); CREATE VIEW urls AS SELECT url, url AS title, 1 AS visit_count, 1 AS last_visit_time, 0 AS hidden FROM real;')
    expect(() => readChromiumHistory(path)).toThrow(/table «\u00a0urls\u00a0» manque/)
  })

  it('names the table that is missing when the file is a database of something else', () => {
    const path = make('History-other', 'CREATE TABLE notes (id INTEGER);')
    expect(() => readChromiumHistory(path)).toThrow(/table «\u00a0urls\u00a0» manque/)
    expect(() => readSafariHistory(path)).toThrow(/table «\u00a0history_items\u00a0» manque/)
    expect(() => readFirefoxHistory(path)).toThrow(/table «\u00a0moz_places\u00a0» manque/)
    expect(() => readFirefoxBookmarks(path)).toThrow(/table «\u00a0moz_bookmarks\u00a0» manque/)
  })

  it('leaves out the addresses Chromium keeps for itself (frames loaded in a page)', () => {
    const path = make('History-hidden', `${urlsTable}${row(1, 'https://visible.example/')}${row(2, 'https://frame-de-pub.example/', { hidden: 1 })}`)
    expect(readChromiumHistory(path).map((r) => r.url)).toEqual(['https://visible.example/'])
  })

  it('cuts a title of any length at the source, and an address one character past what is kept (so that it is refused, not cut into another address)', () => {
    const path = make('History-long', `${urlsTable}${row(1, `https://long.example/${'a'.repeat(100_000)}`, { title: 'T'.repeat(5_000_000) })}`)
    const [only] = readChromiumHistory(path)
    expect(String(only!.title).length).toBe(4096)
    expect(String(only!.url).length).toBe(8193)
    expect(toHistoryEntries([only!], WHEN + 1000)).toEqual([])
  })

  it('does not let one absurd number fail the whole read: a visit count past 2^53 is capped, a date past the year 3000 leaves its row out', () => {
    const path = make(
      'History-absurd',
      `${urlsTable}${row(1, 'https://sane.example/')}${row(2, 'https://many.example/', { visits: '9000000000000000000' })}${row(3, 'https://future.example/', { when: '9000000000000000000' })}${row(4, 'https://past.example/', { when: '5' })}`
    )
    const rows = readChromiumHistory(path)
    expect(rows.map((r) => r.url).sort()).toEqual(['https://many.example/', 'https://sane.example/'])
    expect(rows.find((r) => r.url === 'https://many.example/')!.visits).toBe(1_000_000_000)
  })

  it('applies the same bounds to Firefox and Safari', () => {
    const fox = make(
      'places-absurd.sqlite',
      `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
       INSERT INTO moz_places VALUES (1, 'https://ok.example/', 'ok', 9000000000000000000, ${WHEN * 1000}), (2, 'https://future.example/', 'f', 1, 9000000000000000000);`
    )
    expect(readFirefoxHistory(fox)).toMatchObject([{ url: 'https://ok.example/', visits: 1_000_000_000 }])
    const apple = (ms: number) => (ms - Date.UTC(2001, 0, 1)) / 1000
    const safari = make(
      'History-absurd.db',
      `CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, domain_expansion TEXT, visit_count INTEGER);
       CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
       INSERT INTO history_items VALUES (1, 'https://ok.example/', NULL, 2), (2, 'https://future.example/', NULL, 1);
       INSERT INTO history_visits VALUES (1, 1, ${apple(WHEN)}, 'ok'), (2, 2, 1e30, 'future');`
    )
    expect(readSafariHistory(safari).map((r) => r.url)).toEqual(['https://ok.example/'])
  })

  it('leaves no copy behind, whether the file is refused after the copy or fails to open', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lucium-sqlite-scratch-'))
    // The folder of temporary files is TMPDIR where there is one, TEMP then TMP on Windows (os.tmpdir()).
    const names = ['TMPDIR', 'TEMP', 'TMP']
    const previous = names.map((name) => process.env[name])
    for (const name of names) process.env[name] = scratch
    try {
      const wrongTables = make('History-nocopy', 'CREATE TABLE notes (id INTEGER);')
      const notDatabase = join(dir, 'History-text')
      writeFileSync(notDatabase, 'ceci n’est pas une base SQLite, '.repeat(200))
      expect(() => readChromiumHistory(wrongTables)).toThrow(/manque/)
      expect(() => readChromiumHistory(notDatabase)).toThrow()
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      names.forEach((name, i) => {
        if (previous[i] === undefined) delete process.env[name]
        else process.env[name] = previous[i]
      })
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('a database somebody else wrote', () => {
  const pragma = (db: DatabaseSync, name: string): unknown => (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name]

  it('is opened without trust in its schema, and with the size of each row checked against its page', () => {
    const db = new DatabaseSync(make('Distrust', 'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT);'))
    try {
      expect([pragma(db, 'trusted_schema'), pragma(db, 'cell_size_check')]).toEqual([1, 0])
      distrustDatabase(db)
      expect([pragma(db, 'trusted_schema'), pragma(db, 'cell_size_check')]).toEqual([0, 1])
    } finally {
      db.close()
    }
  })

  it('is not written to once its first read is done', () => {
    const db = new DatabaseSync(make('NoWrites', 'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT);'))
    try {
      db.exec("INSERT INTO urls VALUES (1, 'https://a.example/')")
      stopWrites(db)
      expect(() => db.exec("INSERT INTO urls VALUES (2, 'https://b.example/')")).toThrow(/readonly/)
      expect(db.prepare('SELECT count(*) AS n FROM urls').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('gets both from every reader, the first before any query and the second before the rows are read', () => {
    const path = make('Guarded', `CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      INSERT INTO urls VALUES (1, 'https://chrome.example/a', 'A', 4, 0, ${chromeMicros(WHEN)}, 0);`)
    const steps: string[] = []
    const realExec = DatabaseSync.prototype.exec
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      steps.push(sql)
      realExec.call(this, sql)
    })
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      expect(readChromiumHistory(path)).toHaveLength(1)
      const queries = prepare.mock.calls.map(([sql]) => (String(sql).includes('sqlite_master') ? 'schema' : 'rows'))
      expect(steps).toEqual(['PRAGMA trusted_schema = OFF; PRAGMA cell_size_check = ON', 'PRAGMA query_only = ON'])
      expect(queries).toEqual(['schema', 'rows'])
      // The order: distrust, the schema, no more writes, the rows.
      const order = [exec.mock.invocationCallOrder[0]!, prepare.mock.invocationCallOrder[0]!, exec.mock.invocationCallOrder[1]!, prepare.mock.invocationCallOrder[1]!]
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    } finally {
      exec.mockRestore()
      prepare.mockRestore()
    }
  })
})

describe('the copies an import cut short left behind', () => {
  it('removes them at the next import, and only them: a recent copy (an import running beside this one), a link and other folders stay', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lucium-sqlite-stale-'))
    const previous = process.env['TMPDIR']
    process.env['TMPDIR'] = scratch
    try {
      const old = (Date.now() - STALE_COPY_MS - 60_000) / 1000
      const stale = join(scratch, 'lucium-import-Stale1')
      mkdirSync(stale)
      writeFileSync(join(stale, 'History'), 'une copie de 1 Go, ici quelques octets')
      utimesSync(join(stale, 'History'), old, old)
      utimesSync(stale, old, old)
      const recent = join(scratch, 'lucium-import-Recent')
      mkdirSync(recent)
      const other = join(scratch, 'lucium-sqlite-autre')
      mkdirSync(other)
      utimesSync(other, old, old)
      const target = join(scratch, 'cible')
      mkdirSync(target)
      symlinkSync(target, join(scratch, 'lucium-import-Link'))
      const path = make('History-sweep', `CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
        INSERT INTO urls VALUES (1, 'https://sweep.example/', 'S', 1, 0, ${chromeMicros(WHEN)}, 0);`)
      expect(readChromiumHistory(path)).toHaveLength(1)
      expect(readdirSync(scratch).sort()).toEqual(['cible', 'lucium-import-Link', 'lucium-import-Recent', 'lucium-sqlite-autre'])
    } finally {
      if (previous === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = previous
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('never throws, for a folder that cannot be listed', () => {
    expect(sweepStaleCopies(join(dir, 'nowhere'))).toBe(0)
  })

  it('waits a little at launch, so that the temporary folder is not listed before the window shows, and never keeps the application alive', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lucium-sqlite-later-'))
    vi.useFakeTimers()
    try {
      const stale = join(scratch, 'lucium-import-Stale2')
      mkdirSync(stale)
      const old = new Date(Date.now() - STALE_COPY_MS - 60_000)
      utimesSync(stale, old, old)
      const timer = sweepStaleCopiesSoon(scratch)
      expect(timer.hasRef()).toBe(false)
      expect(STALE_SWEEP_DELAY_MS).toBeGreaterThanOrEqual(10_000)
      vi.advanceTimersByTime(STALE_SWEEP_DELAY_MS - 1)
      expect(existsSync(stale)).toBe(true)
      vi.advanceTimersByTime(1)
      expect(existsSync(stale)).toBe(false)
    } finally {
      vi.useRealTimers()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
