// Files written whole, owner-only and on the disk: the loop over a write that stops short, the check of the size, and the callers that
// matter (the password vault, the state files, the download records). `writeSync` is wrapped so that a test can make it stop short, as a
// full disk or a quota does, or lie about what it wrote.

import * as nodeFs from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceFileDurably, writeAllSync, writeDurableFile } from './durable-write'
import { expectMode, onWindows } from './windows.test-support'
import { LockStore } from './lock-store'
import { PasswordVault, VaultError } from './password-vault'
import { writeFileAtomic } from './persist'
import { ExtensionLedger } from './engine/extension-ledger'
import { writeSession } from './shell/session'
import { ResumeStore, realResumeFs } from './engine/download-resume'
import { record } from '@shared/download-resume-support'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeSync: vi.fn(actual.writeSync), linkSync: vi.fn(actual.linkSync) }
})
const real = await vi.importActual<typeof nodeFs>('node:fs')

/** `writeSync` takes at most `atMost` bytes per call (a short write), or, with `lie`, reports everything written and writes nothing. */
const shortWrites = (mode: { atMost: number } | 'lie' | 'none') => {
  vi.mocked(nodeFs.writeSync).mockImplementation(((fd: number, data: Uint8Array, offset: number, length: number) => {
    if (mode === 'lie') return length
    if (mode === 'none') return 0
    return real.writeSync(fd, data, offset, Math.min(length, mode.atMost))
  }) as typeof nodeFs.writeSync)
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-durable-'))
  vi.mocked(nodeFs.writeSync).mockImplementation(real.writeSync)
  vi.mocked(nodeFs.linkSync).mockImplementation(real.linkSync)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const TEXT = 'x'.repeat(5000) + 'é'.repeat(300)

describe('writeDurableFile', () => {
  it('writes a file of its owner alone, whatever the umask and whatever an earlier crash left under that name', () => {
    const before = process.umask(0)
    try {
      const path = join(dir, 'a.json.tmp')
      writeFileSync(path, 'left behind that is longer than what comes', { mode: 0o666 })
      chmodSync(path, 0o666)
      writeDurableFile(path, 'new')
      expect(readFileSync(path, 'utf8')).toBe('new')
      expectMode(path, 0o600)
    } finally {
      process.umask(before)
    }
  })

  it('goes on after a write that stopped short: every byte arrives, multi-byte characters included', () => {
    shortWrites({ atMost: 7 })
    const path = join(dir, 'a.json')
    writeDurableFile(path, TEXT)
    expect(readFileSync(path, 'utf8')).toBe(TEXT)
  })

  it('throws, rather than leave a short file, when the file system takes nothing more', () => {
    shortWrites('none')
    expect(() => writeDurableFile(join(dir, 'a.json'), TEXT)).toThrow(/short write/)
  })

  it('throws when the file on the disk is shorter than what was written, whatever the write said', () => {
    shortWrites('lie')
    expect(() => writeDurableFile(join(dir, 'a.json'), TEXT)).toThrow(/short write: 0 bytes on the disk/)
  })

  // Windows: there is no O_NOFOLLOW there (it is undefined, so it adds no flag): the link is followed and the target written.
  it.skipIf(onWindows)('does not follow a link left in the place of the temporary file', () => {
    const target = join(dir, 'target')
    writeFileSync(target, 'precious')
    const path = join(dir, 'a.json.tmp')
    symlinkSync(target, path)
    expect(() => writeDurableFile(path, 'new')).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  it('writeAllSync gives up with a code, so that the caller can name the failure', () => {
    shortWrites('none')
    const fd = real.openSync(join(dir, 'b'), 'w')
    try {
      expect(() => writeAllSync(fd, Buffer.from('abc'))).toThrow(expect.objectContaining({ code: 'EIO' }))
    } finally {
      real.closeSync(fd)
    }
  })
})

describe('the files that go through it', () => {
  it('state and history files (writeFileAtomic): complete over short writes, 0600, no temporary file left', () => {
    shortWrites({ atMost: 11 })
    const path = join(dir, 'state.json')
    writeFileSync(path, 'old', { mode: 0o644 })
    writeFileAtomic(path, TEXT)
    expect(readFileSync(path, 'utf8')).toBe(TEXT)
    expectMode(path, 0o600)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('a state file that cannot be written whole keeps the previous one', () => {
    const path = join(dir, 'state.json')
    writeFileAtomic(path, 'previous')
    shortWrites('lie')
    expect(() => writeFileAtomic(path, TEXT)).toThrow(/short write/)
    expect(readFileSync(path, 'utf8')).toBe('previous')
  })

  it('the windows file: complete and 0600', () => {
    shortWrites({ atMost: 13 })
    const path = join(dir, 'windows.json')
    writeSession(path, { main: { x: 1, y: 2, width: 900, height: 700 }, windows: [] })
    expect(JSON.parse(readFileSync(path, 'utf8')).main).toEqual({ x: 1, y: 2, width: 900, height: 700 })
    expectMode(path, 0o600)
  })

  it('the extension ledger: complete and 0600', () => {
    shortWrites({ atMost: 5 })
    const path = join(dir, 'versions.json')
    new ExtensionLedger(path).record('default', 'ext', '1.2.3')
    expect(new ExtensionLedger(path).versionOf('default', 'ext')).toBe('1.2.3')
    expectMode(path, 0o600)
  })

  it('the download records: complete over short writes, and the previous file kept when the new one is short', () => {
    const path = join(dir, 'download-resume.json')
    shortWrites({ atMost: 9 })
    const store = new ResumeStore(path, realResumeFs, () => 0, () => undefined)
    store.put(record(), new Set())
    expect(JSON.parse(readFileSync(path, 'utf8')).records).toHaveLength(1)
    const before = readFileSync(path, 'utf8')
    shortWrites('lie')
    expect(() => realResumeFs.writeText(path, before.replace('1', '2'))).toThrow(/short write/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('the password vault', () => {
  const PHRASE = 'une phrase maître assez longue'
  const params = { N: 2 ** 14, r: 8, p: 1 }
  const LOGIN = { origin: 'https://example.com', username: 'ana@example.com', password: 'S3CRET-p4ss-VALUE' }
  const vaultAt = (path: string) => new PasswordVault({ path, params })

  it('is written whole even when the disk takes it in pieces', async () => {
    shortWrites({ atMost: 64 })
    const path = join(dir, 'passwords.vault')
    const v = vaultAt(path)
    await v.create(PHRASE)
    await v.save(LOGIN)
    v.lock()
    shortWrites('none')
    const reopened = vaultAt(path)
    await reopened.unlock(PHRASE)
    expect(reopened.rows().map((row) => row.username)).toEqual([LOGIN.username])
  })

  it('keeps the vault it had, untouched and with no temporary file, when a write comes up short; the error is a write error with a code only', async () => {
    const path = join(dir, 'passwords.vault')
    const v = vaultAt(path)
    await v.create(PHRASE)
    await v.save(LOGIN)
    const before = readFileSync(path, 'utf8')
    shortWrites('lie')
    const failure = await v.save({ ...LOGIN, username: 'bob@example.com' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(VaultError)
    expect(failure).toMatchObject({ kind: 'write', message: expect.stringMatching(/EIO/) })
    expect(String((failure as Error).message)).not.toContain(dir)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    // The vault in memory is the one on the disk: the failed login is not there.
    expect(v.rows().map((row) => row.username)).toEqual([LOGIN.username])
  })

  it('keeps the vault it replaced as .bak, in 0600, and drops it with the vault', async () => {
    const path = join(dir, 'passwords.vault')
    const v = vaultAt(path)
    await v.create(PHRASE)
    expect(existsSync(`${path}.bak`)).toBe(false)
    const empty = readFileSync(path, 'utf8')
    await v.save(LOGIN)
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(empty)
    expectMode(`${path}.bak`, 0o600)
    const one = readFileSync(path, 'utf8')
    await v.save({ ...LOGIN, username: 'bob@example.com' })
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(one)
    // The previous version opens with the same phrase: it is a vault, not debris.
    const old = vaultAt(`${path}.bak`)
    await old.unlock(PHRASE)
    expect(old.count()).toBe(1)
    await v.destroy(PHRASE)
    expect([path, `${path}.bak`, `${path}.tmp`].filter((file) => existsSync(file))).toEqual([])
  })

  it('copies the vault it replaces where a hard link is not possible, and says so by failing when even the copy fails', async () => {
    const path = join(dir, 'passwords.vault')
    const v = vaultAt(path)
    await v.create(PHRASE)
    vi.mocked(nodeFs.linkSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    const empty = readFileSync(path, 'utf8')
    await v.save(LOGIN)
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(empty)
    expectMode(`${path}.bak`, 0o600)
    // The copy cannot be made either (a folder stands where the file should go): the save fails and the vault is as it was.
    rmSync(`${path}.bak`)
    mkdirSync(`${path}.bak`)
    mkdirSync(join(`${path}.bak`, 'x'))
    const one = readFileSync(path, 'utf8')
    const failure = await v.save({ ...LOGIN, username: 'bob@example.com' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ kind: 'write' })
    expect(readFileSync(path, 'utf8')).toBe(one)
    expect(v.count()).toBe(1)
  })

  it('keeps no copy under the old phrase when the phrase changes', async () => {
    const path = join(dir, 'passwords.vault')
    const v = vaultAt(path)
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, username: 'bob@example.com' })
    expect(existsSync(`${path}.bak`)).toBe(true)
    await v.changePhrase(PHRASE, 'another long enough phrase')
    expect(existsSync(`${path}.bak`)).toBe(false)
    await v.save({ ...LOGIN, username: 'carl@example.com' })
    const old = vaultAt(`${path}.bak`)
    await expect(old.unlock(PHRASE)).rejects.toMatchObject({ kind: 'wrong-passphrase' })
  })
})

describe('replaceFileDurably, and the writers that go through it', () => {
  it('puts the new content in place of the file, for its owner alone, and leaves nothing beside it', () => {
    const path = join(dir, 'index.json')
    writeFileSync(path, 'old', { mode: 0o644 })
    replaceFileDurably(path, TEXT)
    expect(readFileSync(path, 'utf8')).toBe(TEXT)
    expectMode(path, 0o600)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('takes its temporary file away when the file cannot be put in place, and says why by throwing', () => {
    // A folder that is not empty stands where the file goes: the rename is refused after the temporary file was written whole.
    const path = join(dir, 'taken')
    mkdirSync(path)
    writeFileSync(join(path, 'inside'), 'x')
    expect(() => replaceFileDurably(path, TEXT)).toThrow()
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  // Windows: there is no O_NOFOLLOW there (it is undefined, so it adds no flag): the link is followed and the target written.
  it.skipIf(onWindows)('does not write through a link left under the temporary name, and leaves the link as it found it', () => {
    const path = join(dir, 'index.json')
    const elsewhere = join(dir, 'elsewhere.txt')
    writeFileSync(elsewhere, 'not ours')
    symlinkSync(elsewhere, `${path}.tmp`)
    expect(() => replaceFileDurably(path, TEXT)).toThrow(/ELOOP/)
    expect(readFileSync(elsewhere, 'utf8')).toBe('not ours')
    expect(existsSync(path)).toBe(false)
  })

  const taken = (name: string): string => {
    const path = join(dir, name)
    mkdirSync(path)
    writeFileSync(join(path, 'inside'), 'x')
    return path
  }

  it('the windows file: a save that fails leaves no copy of the session under another name', () => {
    const path = taken('windows.json')
    expect(() => writeSession(path, { main: { x: 1, y: 2, width: 900, height: 700 }, windows: [] })).toThrow()
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('the extension ledger: a save that fails is said in the journal and leaves no temporary file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = taken('versions.json')
    new ExtensionLedger(path).record('default', 'ext', '1.2.3')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot save'), expect.anything())
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('the lock: a phrase that cannot be saved leaves no copy of its hash under another name', async () => {
    const path = taken('lock.json')
    await expect(new LockStore(path, { N: 2 ** 10, r: 8, p: 1 }).setPhrase('une phrase assez longue')).rejects.toThrow()
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })
})
