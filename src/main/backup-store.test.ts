import { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASKED_COPIES_KEPT, COPY_BYTES_MAX, backupId, copyDataOf, serializeCopy, type SessionCopy } from '@shared/session-backups'
import { createInitialState, reduce } from '@shared/sidebar'
import { BackupFiles } from './backup-store'
import { tempDir } from './temp-dir'
import { expectMode, expectNoOtherAccess, onWindows } from './windows.test-support'

// A rename that can be made to fail: the copy is written under another name first, so a failure there must leave no copy and no half of one.
const renaming = vi.hoisted(() => ({ fail: false, reads: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renaming.fail) throw new Error('forced: the rename failed')
      return actual.renameSync(from, to)
    },
    // Counts the files that are really read (a file too big must not be).
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      renaming.reads++
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync
  }
})

const ctx = { now: 1_700_000_000_000, newId: (() => { let n = 0; return () => `id${++n}` })() }
const withTabs = (urls: string[]) => urls.reduce((s, url) => reduce(s, { type: 'tab/open', url, background: true }, ctx), createInitialState(ctx))
const copy = (urls: string[], createdAt: number): SessionCopy => ({ createdAt, reason: 'auto', data: copyDataOf(withTabs(urls)) })
const folder = () => tempDir('lucium-backups-')
const names = (dir: string) => readdirSync(dir).sort()

let errors: unknown[][]
beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
})
afterEach(() => vi.restoreAllMocks())

describe('writing a copy', () => {
  it('creates the folder, writes the file under the name of the time, and reads it back as it was', () => {
    const dir = join(folder(), 'sessions', 'copies')
    const files = new BackupFiles(dir)
    const one = copy(['https://a.example/'], 1_700_000_000_000)
    const id = files.write(one, 5)
    expect(id).toBe('copie-1700000000000')
    expect(names(dir)).toEqual(['copie-1700000000000.json'])
    expect(files.read(id)).toStrictEqual(one)
    expect(files.ids()).toEqual([id])
  })

  it('keeps the copy private to the user: the file and the folder are not readable by others', () => {
    const dir = join(folder(), 'copies')
    new BackupFiles(dir).write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    expectNoOtherAccess(dir)
    expectNoOtherAccess(join(dir, 'copie-1700000000000.json'))
  })

  it('closes the folder an earlier version made readable by others (with the umask) when it writes the next copy', () => {
    const dir = join(folder(), 'copies')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    new BackupFiles(dir).write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    expectMode(dir, 0o700)
  })

  it('keeps the copy private even when a crash left a file readable by others under the name it is written to', () => {
    const dir = folder()
    // The name the next copy is written under (copie-<time>.json.tmp): a file that was there keeps its own mode when it is opened again.
    const partial = join(dir, 'copie-1700000000000.json.tmp')
    writeFileSync(partial, 'left by a crash', { mode: 0o644 })
    chmodSync(partial, 0o644)
    new BackupFiles(dir).write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    expectNoOtherAccess(join(dir, 'copie-1700000000000.json'))
  })

  // Windows has no O_NOFOLLOW: the look for a link before the open (durable-write.ts) refuses it there.
  it('never writes through a link left under the name it is written to, and writes again once the link is gone', () => {
    const dir = folder()
    const elsewhere = join(folder(), 'victim.txt')
    writeFileSync(elsewhere, 'untouched')
    symlinkSync(elsewhere, join(dir, 'copie-1700000000000.json.tmp'))
    const files = new BackupFiles(dir)
    expect(() => files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)).toThrow()
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
    expect(names(dir)).toEqual([])
    expect(files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)).toBe('copie-1700000000000')
  })

  it('leaves no half-written file: the copy is written under another name and renamed', () => {
    const dir = folder()
    new BackupFiles(dir).write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    expect(names(dir).every((n) => !n.endsWith('.tmp'))).toBe(true)
  })

  it('is atomic: when the last step fails there is no copy of that name at all, nothing half-written, and the error comes out', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    renaming.fail = true
    try {
      expect(() => files.write(copy(['https://b.example/'], 1_700_000_001_000), 5)).toThrow(/forced: the rename failed/)
    } finally {
      renaming.fail = false
    }
    expect(names(dir)).toEqual(['copie-1700000000000.json'])
    expect(files.ids()).toEqual(['copie-1700000000000'])
  })

  it('keeps the newest N and deletes the oldest, copy after copy', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    for (let i = 0; i < 9; i++) files.write(copy([`https://a${i}.example/`], 1_700_000_000_000 + i * 1000), 3)
    expect(files.ids()).toEqual([1_700_000_008_000, 1_700_000_007_000, 1_700_000_006_000].map((t) => backupId(t)))
    expect(names(dir)).toHaveLength(3)
    expect(files.read(files.ids()[0]!).data.tabs[0]!.url).toBe('https://a8.example/')
  })

  it('keeps a copy made by hand and the one made before a restoration while the automatic ones rotate', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    const manual = files.write({ ...copy(['https://manual.example/'], 1_700_000_000_000), reason: 'manual' }, 3)
    const before = files.write({ ...copy(['https://before.example/'], 1_700_000_001_000), reason: 'before-restore' }, 3)
    for (let i = 2; i < 9; i++) files.write({ ...copy([`https://a${i}.example/`], 1_700_000_000_000 + i * 1000), reason: i % 2 ? 'auto' : 'quit' }, 3)
    expect(files.ids()).toEqual([...[8, 7, 6].map((n) => backupId(1_700_000_000_000 + n * 1000)), before, manual])
    expect(files.read(manual).data.tabs[0]!.url).toBe('https://manual.example/')
  })

  it('keeps the ten newest of the copies somebody asked for: they do not pile up for ever', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    for (let i = 0; i < ASKED_COPIES_KEPT + 3; i++) files.write({ ...copy(['https://a.example/'], 1_700_000_000_000 + i * 1000), reason: 'manual' }, 3)
    expect(files.ids()).toHaveLength(ASKED_COPIES_KEPT)
    expect(files.ids().at(-1)).toBe(backupId(1_700_000_003_000))
  })

  it('keeps the automatic copies made before a state file was set aside apart from those made since', () => {
    const dir = folder()
    let setAsideAt: number | undefined
    const files = new BackupFiles(dir, () => setAsideAt)
    for (let i = 0; i < 3; i++) files.write(copy([`https://lost${i}.example/`], 1_700_000_000_000 + i * 1000), 3)
    setAsideAt = 1_700_000_005_000
    for (let i = 6; i < 12; i++) files.write(copy([`https://fresh${i}.example/`], 1_700_000_000_000 + i * 1000), 3)
    expect(files.ids()).toEqual([11, 10, 9, 2, 1, 0].map((n) => backupId(1_700_000_000_000 + n * 1000)))
  })

  // Windows: `chmod 000` does not make a file unreadable there (it only sets the read-only flag).
  it.skipIf(onWindows)('rotates with the automatic ones a copy whose file cannot be opened, and says why in the journal', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    const closed = files.write({ ...copy(['https://a.example/'], 1_700_000_000_000), reason: 'manual' }, 1)
    chmodSync(join(dir, `${closed}.json`), 0o000)
    files.write(copy(['https://b.example/'], 1_700_000_001_000), 1)
    expect(files.ids()).toEqual([backupId(1_700_000_001_000)])
    expect(errors.some(([line]) => String(line).includes(`cannot read why the copy ${closed} was made`))).toBe(true)
  })

  it('does not open what is not a regular file under the name of a copy to learn why it was made: a pipe there would hold the application for ever', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    // A folder stands in for the pipe, as for `read`: opened and read, it fails, and the journal would say so.
    mkdirSync(join(dir, 'copie-1700000001000.json'))
    files.prune(5)
    expect(errors).toEqual([])
    expect(files.ids()).toHaveLength(2)
  })

  it('never keeps fewer than one copy, whatever it is told', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    for (let i = 0; i < 3; i++) files.write(copy(['https://a.example/'], 1_700_000_000_000 + i), 0)
    expect(files.ids()).toHaveLength(1)
    expect(files.read(files.ids()[0]!).createdAt).toBe(1_700_000_000_002)
  })

  it('does not overwrite a copy made in the same millisecond, nor lose the new one when the clock went back', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    const a = files.write(copy(['https://a.example/'], 5_000), 3)
    const b = files.write(copy(['https://b.example/'], 5_000), 3)
    const c = files.write(copy(['https://c.example/'], 1_000), 3)
    expect(new Set([a, b, c]).size).toBe(3)
    expect(files.ids()[0]).toBe(c)
    expect(files.read(c).data.tabs[0]!.url).toBe('https://c.example/')
    expect(files.read(a).data.tabs[0]!.url).toBe('https://a.example/')
  })

  it('touches nothing in the folder that is not a copy', () => {
    const dir = folder()
    writeFileSync(join(dir, 'notes.json'), 'mine')
    writeFileSync(join(dir, 'copie-12.json'), 'not a copy name')
    const files = new BackupFiles(dir)
    for (let i = 0; i < 4; i++) files.write(copy(['https://a.example/'], 1_700_000_000_000 + i), 1)
    expect(names(dir)).toEqual(['copie-12.json', 'copie-1700000000003.json', 'notes.json'])
  })

  it('survives a copy it cannot delete: the new copy is there, the old one stays, and the log names the folder', () => {
    const dir = folder()
    // A folder with something in it where an old copy should be: it cannot be removed as a file.
    mkdirSync(join(dir, 'copie-1600000000000.json'))
    writeFileSync(join(dir, 'copie-1600000000000.json', 'inside'), 'x')
    const files = new BackupFiles(dir)
    const id = files.write(copy(['https://a.example/'], 1_700_000_000_000), 1)
    expect(id).toBe('copie-1700000000000')
    expect(names(dir)).toContain('copie-1700000000000.json')
    expect(errors.map((e) => String(e[0])).join()).toContain(`cannot clean up the old copies in ${dir}`)
  })

  it('removes the half-written files a crash left, and only those', () => {
    const dir = folder()
    writeFileSync(join(dir, 'copie-1700000000000.json.tmp'), '{ half')
    writeFileSync(join(dir, 'other.tmp'), 'not ours')
    new BackupFiles(dir).write(copy(['https://a.example/'], 1_700_000_001_000), 5)
    expect(names(dir)).toEqual(['copie-1700000001000.json', 'other.tmp'])
  })

  // Windows: `chmod 500` does not make a folder refuse a new file there (it only sets the read-only flag, which a folder's contents ignore).
  it.skipIf(onWindows)('throws when the copy cannot be written, leaves the copies already there alone, and leaves nothing half-written', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    files.write(copy(['https://a.example/'], 1_700_000_000_000), 1)
    chmodSync(dir, 0o500)
    try {
      expect(() => files.write(copy(['https://b.example/'], 1_700_000_001_000), 1)).toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(names(dir)).toEqual(['copie-1700000000000.json'])
    expect(files.read('copie-1700000000000').data.tabs[0]!.url).toBe('https://a.example/')
  })

  it('throws when the folder cannot be created', () => {
    const dir = folder()
    writeFileSync(join(dir, 'blocked'), 'a file where the folder should be')
    expect(() => new BackupFiles(join(dir, 'blocked', 'copies')).write(copy(['https://a.example/'], 1), 5)).toThrow()
  })
})

describe('reading the copies', () => {
  it('lists them newest first, with their date, tabs and spaces', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    files.write(copy(['https://a.example/', 'https://b.example/'], 1_700_000_100_000), 5)
    const { entries, unreadable } = files.list()
    expect(unreadable).toBe(0)
    expect(entries.map((e) => [e.createdAt, e.tabs, e.spaces])).toEqual([[1_700_000_100_000, 2, 1], [1_700_000_000_000, 1, 1]])
  })

  it('ignores a copy that cannot be read, says so in the log with its name, counts it, and still lists the others', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    writeFileSync(join(dir, 'copie-1700000050000.json'), '{ truncated')
    writeFileSync(join(dir, 'copie-1700000060000.json'), JSON.stringify({ format: 'another', version: 1 }))
    writeFileSync(join(dir, 'copie-1700000070000.json'), '')
    files.write(copy(['https://b.example/'], 1_700_000_100_000), 5)
    const { entries, unreadable } = files.list()
    expect(entries.map((e) => e.createdAt)).toEqual([1_700_000_100_000, 1_700_000_000_000])
    expect(unreadable).toBe(3)
    expect(errors.map((e) => String(e[0]))).toEqual(expect.arrayContaining([expect.stringContaining('copie-1700000050000'), expect.stringContaining('copie-1700000060000'), expect.stringContaining('copie-1700000070000')]))
  })

  it('refuses to read a copy that is too big, without reading it', () => {
    const dir = folder()
    const big = join(dir, 'copie-1700000000000.json')
    writeFileSync(big, '')
    // A sparse file as big as the limit plus one byte: statSync tells its size without anything being read.
    const fd = openSync(big, 'r+')
    ftruncateSync(fd, COPY_BYTES_MAX + 1)
    closeSync(fd)
    renaming.reads = 0
    expect(() => new BackupFiles(dir).read('copie-1700000000000')).toThrow(/more than the \d+ this application reads/)
    expect(renaming.reads).toBe(0)
  })

  it('refuses what is not a regular file under the name of a copy, without opening it: a pipe there would hold the application for ever', () => {
    const dir = folder()
    // A folder stands in for the pipe: it is not a regular file either, and a test that opened it would fail instead of never ending.
    mkdirSync(join(dir, 'copie-1700000000000.json'))
    renaming.reads = 0
    const files = new BackupFiles(dir)
    expect(() => files.read('copie-1700000000000')).toThrow(/not a regular file/)
    expect(files.edit(() => ({ kind: 'unchanged' }))).toEqual({ rewritten: 0, left: 1 })
    expect(renaming.reads).toBe(0)
    expect(errors.some((line) => String(line[0]).includes('not a regular file'))).toBe(true)
  })

  it('reads only what is named like a copy: an id that points elsewhere is refused before any file is opened', () => {
    const dir = folder()
    writeFileSync(join(dir, 'secret.json'), serializeCopy(copy(['https://a.example/'], 1)))
    const files = new BackupFiles(join(dir, 'copies'))
    for (const hostile of ['../secret', '..', '/etc/passwd', 'copie-1700000000000/../../secret', '']) expect(() => files.read(hostile), hostile).toThrow(/not the name of a copy/)
  })

  it('answers the newest copy that can be read, skipping a damaged one with a line in the log', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    expect(files.newest()).toBeNull()
    files.write(copy(['https://a.example/'], 1_700_000_000_000), 5)
    writeFileSync(join(dir, 'copie-1700000090000.json'), 'damaged')
    expect(files.newest()!.data.tabs[0]!.url).toBe('https://a.example/')
    expect(errors.map((e) => String(e[0])).join()).toContain('copie-1700000090000')
  })

  it('gives an empty list for a folder that does not exist yet', () => {
    expect(new BackupFiles(join(folder(), 'nope')).list()).toEqual({ entries: [], unreadable: 0 })
  })

  // Windows: `chmod 000` does not make a folder unlistable there (it only sets the read-only flag).
  it.skipIf(onWindows)('does not choke on a folder it cannot list: no copy, and the log says which folder', () => {
    const dir = folder()
    const files = new BackupFiles(dir)
    files.write(copy(['https://a.example/'], 1), 5)
    chmodSync(dir, 0o000)
    try {
      expect(files.ids()).toEqual([])
      expect(files.list()).toEqual({ entries: [], unreadable: 0 })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(errors.map((e) => String(e[0])).join()).toContain(dir)
    expect(files.ids()).toHaveLength(1)
  })
})
