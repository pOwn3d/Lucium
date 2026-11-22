// The key of the one-time codes of an entry (docs/gestionnaire-mots-de-passe.md, « Codes à usage unique »): sealed in the vault with the rest of
// the entry, never in a row, gone from the disk when it is removed or replaced, carried by the encrypted export, and checked again when the
// vault is opened.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TotpConfig } from '@shared/totp'
import { PasswordVault, VaultError, openExport, parseStoredEntries } from './password-vault'
import { VAULT_FORMAT, newSealKeys, seal } from './vault-crypto'

const PHRASE = 'une phrase maître assez longue'
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const LOGIN = { origin: 'https://example.com', username: 'ana@example.com', password: 'S3CRET-p4ss-VALUE' }
const KEY: TotpConfig = { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30 }
const OTHER: TotpConfig = { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60 }

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-vault-totp-'))
  path = join(dir, 'passwords.vault')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const vault = () => new PasswordVault({ path, params: PARAMS })
const idOf = (v: PasswordVault, username = LOGIN.username): string => v.rows().find((row) => row.username === username)!.id
const errorOf = async (job: Promise<unknown>): Promise<unknown> => {
  try {
    await job
  } catch (error) {
    return error
  }
  return undefined
}
const sideCopies = (): string[] => readdirSync(dir).filter((name) => name.startsWith('passwords.vault.'))

describe('the key of the one-time codes in the vault', () => {
  it('is sealed with the entry: not in the clear on the disk, and back after the vault is opened again', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    expect(await v.setTotp(idOf(v), KEY)).toBe(true)
    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).not.toContain(KEY.secret)
    expect(onDisk).not.toContain('SHA1')
    v.lock()
    const again = vault()
    await again.unlock(PHRASE)
    expect(again.totpOf(idOf(again))).toEqual(KEY)
  })

  it('is told to the interface as a fact, never as a key: the rows say that an entry has one', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, username: 'bob' })
    await v.setTotp(idOf(v), KEY)
    expect(v.rows().map((row) => [row.username, row.totp])).toEqual([[LOGIN.username, true], ['bob', false]])
    expect(JSON.stringify(v.rows())).not.toContain(KEY.secret)
    expect(JSON.stringify(v.rowsForPage('https://example.com/login'))).not.toContain(KEY.secret)
  })

  it('belongs to its entry: an unknown entry has none to give and takes none, and a locked vault gives and takes nothing', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    expect(v.totpOf('f'.repeat(32))).toBeNull()
    expect(v.totpOf(idOf(v))).toBeNull()
    expect(await v.setTotp('f'.repeat(32), KEY)).toBe(false)
    expect(await v.removeTotp(idOf(v))).toBe(false)
    const id = idOf(v)
    v.lock()
    expect(() => v.totpOf(id)).toThrow(VaultError)
    expect(((await errorOf(v.setTotp(id, KEY))) as VaultError).kind).toBe('locked')
    expect(((await errorOf(v.removeTotp(id))) as VaultError).kind).toBe('locked')
  })

  it('stays when the password of the login is changed', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.setTotp(idOf(v), KEY)
    expect(await v.save({ ...LOGIN, password: 'a-new-password' })).toBe('update')
    expect(v.totpOf(idOf(v))).toEqual(KEY)
  })

  it('is replaced by another, and the vault that held the old one does not stay beside the new', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.setTotp(idOf(v), KEY)
    // The first key: the copy of the vault before it holds none, and stays.
    expect(existsSync(`${path}.bak`)).toBe(true)
    await v.setTotp(idOf(v), OTHER)
    expect(v.totpOf(idOf(v))).toEqual(OTHER)
    // The copy that would hold the old key is gone.
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  it('is removed from the entry, and from the disk: no copy of the vault keeps it', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.setTotp(idOf(v), KEY)
    // A later change leaves the vault that holds the key beside the new one, as every change does.
    await v.save({ ...LOGIN, password: 'a-new-password' })
    expect(existsSync(`${path}.bak`)).toBe(true)
    expect(await v.removeTotp(idOf(v))).toBe(true)
    expect(v.totpOf(idOf(v))).toBeNull()
    expect(v.rows()[0]!.totp).toBe(false)
    expect(existsSync(`${path}.bak`)).toBe(false)
    v.lock()
    const again = vault()
    await again.unlock(PHRASE)
    expect(again.totpOf(idOf(again))).toBeNull()
    expect(again.secret(idOf(again))?.password).toBe('a-new-password')
  })

  it('goes with the entry when the entry is deleted', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    const id = idOf(v)
    await v.setTotp(id, KEY)
    await v.remove(id)
    expect(v.count()).toBe(0)
    expect(readFileSync(path, 'utf8')).not.toContain(KEY.secret)
    expect(existsSync(`${path}.bak`)).toBe(false)
  })
})

describe('the key of the one-time codes when the vault is opened', () => {
  const good = { id: 'a'.repeat(32), origin: 'https://example.com', username: 'ana', password: 'pw', createdAt: 1, updatedAt: 2 }
  const text = (entries: unknown[]) => JSON.stringify({ v: 1, entries })

  it('is read as it was written', () => {
    expect(parseStoredEntries(text([{ ...good, totp: KEY }]))).toEqual({ entries: [{ ...good, totp: KEY }], dropped: 0 })
  })

  it('leaves out an entry whose key this version does not read, rather than opening it without the key (the next write would lose it)', () => {
    for (const bad of [
      { ...KEY, secret: 'not base32!' },
      { ...KEY, secret: KEY.secret.toLowerCase() },
      { ...KEY, secret: 'AAAA' },
      { ...KEY, algorithm: 'MD5' },
      { ...KEY, digits: 12 },
      { ...KEY, period: 0 },
      { ...KEY, extra: true },
      'text',
      null,
      []
    ]) {
      expect(parseStoredEntries(text([{ ...good, totp: bad }])), JSON.stringify(bad)).toEqual({ entries: [], dropped: 1 })
    }
  })

  it('keeps the file as it was beside it when a key is refused, so that nothing is lost for good', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const keys = await newSealKeys(PHRASE, { params: PARAMS })
      const sealed = seal(VAULT_FORMAT, text([good, { ...good, id: 'b'.repeat(32), username: 'bo', totp: { ...KEY, algorithm: 'MD5' } }]), keys)
      writeFileSync(path, sealed)
      const v = vault()
      await v.unlock(PHRASE)
      expect(v.rows().map((row) => row.username)).toEqual(['ana'])
      expect(v.droppedAtOpening()).toBe(1)
      const copies = sideCopies().filter((name) => name.includes('.dropped-'))
      expect(copies).toHaveLength(1)
      expect(readFileSync(join(dir, copies[0]!), 'utf8')).toBe(sealed)
      expect(errors.mock.calls.flat().join(' ')).not.toContain(KEY.secret)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('the key of the one-time codes in the encrypted export', () => {
  it('goes into the export, sealed, and comes back with the login on the other side', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, username: 'bob', password: 'bob-pw' })
    await v.setTotp(idOf(v), KEY)
    const sealed = await v.exportSealed('a phrase for the export')
    expect(sealed).not.toContain(KEY.secret)
    const opened = await openExport(sealed, 'a phrase for the export')
    expect(opened.logins.map((login) => [login.username, login.totp])).toEqual([[LOGIN.username, KEY], ['bob', undefined]])

    // Into a vault that is new: the login and its key.
    const other = new PasswordVault({ path: join(dir, 'other.vault'), params: PARAMS })
    await other.create(PHRASE)
    expect((await other.addMany(opened)).added).toBe(2)
    expect(other.totpOf(idOf(other))).toEqual(KEY)
    expect(other.totpOf(idOf(other, 'bob'))).toBeNull()
  })

  it('never replaces a login that is already there, with its key or without: the import adds, it does not change', async () => {
    const source = vault()
    await source.create(PHRASE)
    await source.save(LOGIN)
    await source.setTotp(idOf(source), KEY)
    const opened = await openExport(await source.exportSealed('a phrase for the export'), 'a phrase for the export')

    const target = new PasswordVault({ path: join(dir, 'target.vault'), params: PARAMS })
    await target.create(PHRASE)
    await target.save({ ...LOGIN, password: 'the-password-here' })
    const report = await target.addMany(opened)
    expect(report).toMatchObject({ added: 0, duplicates: 1 })
    expect(target.secret(idOf(target))?.password).toBe('the-password-here')
    expect(target.totpOf(idOf(target))).toBeNull()
  })
})
