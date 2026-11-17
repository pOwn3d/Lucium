import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASSWORD_LIMITS } from '@shared/passwords'
import { encryptExport, ExportCryptoError } from './export-crypto'
import { PasswordVault, VaultError, openExport, parseStoredEntries } from './password-vault'
import { VAULT_FORMAT, seal, newSealKeys } from './vault-crypto'

const PHRASE = 'une phrase maître assez longue'
// The cheapest cost a file may ask for: the tests are about the construction, not about how slow it is.
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const LOGIN = { origin: 'https://example.com', username: 'ana@example.com', password: 'S3CRET-p4ss-VALUE' }

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-vault-'))
  path = join(dir, 'passwords.vault')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const vault = () => new PasswordVault({ path, params: PARAMS })
const modeOf = (file: string): number => statSync(file).mode & 0o777
const errorOf = async (job: Promise<unknown>): Promise<unknown> => {
  try {
    await job
  } catch (error) {
    return error
  }
  return undefined
}

describe('the file', () => {
  it('keeps the copy of the previous vault when a change of phrase could not be written: it goes only once the new vault is in place', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    expect(existsSync(`${path}.bak`)).toBe(true)
    // A folder where the temporary file goes: the write of the vault under the new phrase fails.
    mkdirSync(`${path}.tmp`)
    expect(await errorOf(v.changePhrase(PHRASE, 'another long enough phrase'))).toBeDefined()
    expect(existsSync(`${path}.bak`)).toBe(true)
    rmSync(`${path}.tmp`, { recursive: true })
    await v.changePhrase(PHRASE, 'another long enough phrase')
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  it('is private to the user: 0600, whatever the umask, and even over a temporary file an earlier crash left open to everyone', async () => {
    const before = process.umask(0)
    try {
      writeFileSync(`${path}.tmp`, 'left behind', { mode: 0o666 })
      chmodSync(`${path}.tmp`, 0o666)
      const v = vault()
      await v.create(PHRASE)
      expect(modeOf(path)).toBe(0o600)
      await v.save(LOGIN)
      expect(modeOf(path)).toBe(0o600)
      await v.changePhrase(PHRASE, 'another long enough phrase')
      expect(modeOf(path)).toBe(0o600)
      expect(existsSync(`${path}.tmp`)).toBe(false)
    } finally {
      process.umask(before)
    }
  })

  it('holds no login in the clear', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    const text = readFileSync(path, 'utf8')
    for (const secret of [LOGIN.password, LOGIN.username, 'example.com', PHRASE]) expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({ format: 'lucium-passwords', version: 1, kdf: { name: 'scrypt', N: 2 ** 14 }, cipher: { name: 'aes-256-gcm' } })
  })

  it('is written again with a new nonce at each save, and the salt stays until the phrase changes', async () => {
    const v = vault()
    await v.create(PHRASE)
    const read = () => JSON.parse(readFileSync(path, 'utf8')) as { kdf: { salt: string }; cipher: { nonce: string } }
    const first = read()
    await v.save(LOGIN)
    const second = read()
    await v.save({ ...LOGIN, username: 'bob' })
    const third = read()
    expect(new Set([first.cipher.nonce, second.cipher.nonce, third.cipher.nonce]).size).toBe(3)
    expect(new Set([first.kdf.salt, second.kdf.salt, third.kdf.salt]).size).toBe(1)
    await v.changePhrase(PHRASE, 'another long enough phrase')
    expect(read().kdf.salt).not.toBe(first.kdf.salt)
  })

  it('is not made where it cannot be written: the vault is not created, and the error says no more than a kind', async () => {
    const v = new PasswordVault({ path: join(dir, 'missing', 'passwords.vault'), params: PARAMS })
    const error = await errorOf(v.create(PHRASE))
    expect(error).toBeInstanceOf(VaultError)
    expect((error as VaultError).kind).toBe('write')
    expect((error as VaultError).message).not.toContain(PHRASE)
    expect(v.isUnlocked()).toBe(false)
  })

  it('leaves the vault as it was when a save fails', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    rmSync(dir, { recursive: true, force: true })
    const error = await errorOf(v.save({ ...LOGIN, username: 'bob', password: 'NEVER-STORED' }))
    expect((error as VaultError).kind).toBe('write')
    expect(JSON.stringify(error)).not.toContain('NEVER-STORED')
    expect(v.rows().map((row) => row.username)).toEqual(['ana@example.com'])
  })
})

describe('opening', () => {
  it('opens with the phrase and gives back what was saved, by host and username', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ origin: 'https://a.example', username: 'z', password: 'pw' })
    v.lock()
    expect(v.isUnlocked()).toBe(false)
    const again = vault()
    await again.unlock(PHRASE)
    expect(again.rows().map((row) => `${row.host}|${row.username}`)).toEqual(['a.example|z', 'example.com|ana@example.com'])
    expect(again.secret(again.rows()[1]!.id)?.password).toBe(LOGIN.password)
  })

  it('stays locked on a wrong phrase, and says nothing of the phrase or the logins', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    v.lock()
    const error = await errorOf(v.unlock('une mauvaise phrase tout aussi longue'))
    expect(error).toBeInstanceOf(ExportCryptoError)
    expect((error as ExportCryptoError).kind).toBe('wrong-passphrase')
    expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain('mauvaise')
    expect(v.isUnlocked()).toBe(false)
    expect(() => v.rows()).toThrow(VaultError)
  })

  it('refuses to read or change anything while locked', async () => {
    const v = vault()
    await v.create(PHRASE)
    const id = (await v.save(LOGIN), v.rows()[0]!.id)
    v.lock()
    expect(() => v.rows()).toThrow(/locked/)
    expect(() => v.secret(id)).toThrow(/locked/)
    expect(() => v.rowsForPage('https://example.com/')).toThrow(/locked/)
    expect((await errorOf(v.save(LOGIN)) as VaultError).kind).toBe('locked')
    expect((await errorOf(v.remove(id)) as VaultError).kind).toBe('locked')
    expect((await errorOf(v.exportSealed('an export phrase long')) as VaultError).kind).toBe('locked')
  })

  it('wipes its key when it locks', async () => {
    const v = vault()
    await v.create(PHRASE)
    const keys = (v as unknown as { keys: { key: Buffer; macKey: Buffer } }).keys
    expect(keys.key.some((byte) => byte !== 0)).toBe(true)
    v.lock()
    expect([...keys.key, ...keys.macKey].every((byte) => byte === 0)).toBe(true)
  })

  it('does not create a second vault over the first, nor open one that is not there', async () => {
    const v = vault()
    await v.create(PHRASE)
    expect((await errorOf(vault().create('another long enough phrase')) as VaultError).kind).toBe('exists')
    rmSync(path)
    expect((await errorOf(vault().unlock(PHRASE)) as VaultError).kind).toBe('missing')
  })
})

describe('a file that was changed or made by someone else', () => {
  async function make(): Promise<string> {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    v.lock()
    return readFileSync(path, 'utf8')
  }
  const rewrite = (edit: (envelope: Record<string, any>) => void): void => {
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    edit(envelope)
    writeFileSync(path, JSON.stringify(envelope))
  }
  const kindOf = async (): Promise<string> => {
    // A header that was changed answers 'wrong-passphrase', which counts as a wrong phrase: each question here starts without the count of the one before.
    rmSync(`${path}.attempts`, { force: true })
    const error = await errorOf(vault().unlock(PHRASE))
    return error instanceof ExportCryptoError ? error.kind : error instanceof VaultError ? `vault:${error.kind}` : String(error)
  }

  it('is not opened when it is not a regular file: a pipe under the name of the vault would hold the application for ever', async () => {
    // A folder stands in for the pipe, which would hold a test that opened it for ever.
    mkdirSync(path)
    expect(await kindOf()).toBe('vault:corrupt')
  })

  it('is refused when one bit of the content moved', async () => {
    await make()
    rewrite((e) => {
      const data = Buffer.from(e['data'], 'base64')
      data[10] = data[10]! ^ 1
      e['data'] = data.toString('base64')
    })
    expect(await kindOf()).toBe('tampered')
  })

  it('is refused when its header was changed (the cost, the salt, the nonce, the name of the format)', async () => {
    await make()
    const original = readFileSync(path, 'utf8')
    rewrite((e) => (e['kdf'].p = 2))
    expect(await kindOf()).toBe('wrong-passphrase')
    writeFileSync(path, original)
    rewrite((e) => (e['kdf'].salt = Buffer.alloc(16, 7).toString('base64')))
    expect(await kindOf()).toBe('wrong-passphrase')
    writeFileSync(path, original)
    rewrite((e) => (e['cipher'].nonce = Buffer.alloc(12, 7).toString('base64')))
    expect(await kindOf()).toBe('wrong-passphrase')
    writeFileSync(path, original)
    rewrite((e) => (e['format'] = 'lucium-export'))
    expect(await kindOf()).toBe('not-an-export')
  })

  it('is refused before any key is derived when it asks for a cost no vault of this application would', async () => {
    await make()
    for (const kdf of [{ N: 2 ** 30 }, { N: 2 ** 14, r: 1_000_000 }, { N: 2 ** 14, p: 1_000_000 }, { N: 3 }, { N: 2 ** 10 }, { N: 2 ** 18, r: 16, p: 4 }, { N: 'big' }, { N: -1 }, { N: 2 ** 14, r: 0 }]) {
      const original = readFileSync(path, 'utf8')
      rewrite((e) => Object.assign(e['kdf'], kdf))
      const started = Date.now()
      expect(await kindOf(), JSON.stringify(kdf)).toBe('too-costly')
      expect(Date.now() - started).toBeLessThan(1500)
      writeFileSync(path, original)
    }
  })

  it('is refused when it is not an envelope, whatever else it is', async () => {
    for (const text of ['', 'null', '[]', '{}', 'not json', '{"format":"lucium-passwords"}', '{"format":"lucium-passwords","version":1,"kdf":{},"cipher":{}}']) {
      writeFileSync(path, text)
      expect(await kindOf(), text).toMatch(/not-an-export|unsupported/)
    }
    writeFileSync(path, JSON.stringify({ format: 'lucium-passwords', version: 9 }))
    expect(await kindOf()).toBe('unsupported')
  })

  it('is refused when it is too large to be one, without being read', async () => {
    writeFileSync(path, Buffer.alloc(17 * 1024 * 1024, 32))
    expect(await kindOf()).toBe('too-large')
  })

  it('is refused from its size alone when it is huge: it is not read at all', async () => {
    // A sparse file of 700 MiB: reading it into a string would fail with another error (and take its memory first).
    writeFileSync(path, '')
    truncateSync(path, 700 * 1024 * 1024)
    expect(await kindOf()).toBe('too-large')
  })

  it('is refused when it was sealed by the right phrase around a list that is not what this version writes', async () => {
    const keys = await newSealKeys(PHRASE, { params: PARAMS })
    for (const content of ['not json', '{}', JSON.stringify({ v: 1, entries: 'x' }), JSON.stringify({ v: 2, entries: [] })]) {
      writeFileSync(path, seal(VAULT_FORMAT, content, keys))
      expect(await kindOf(), content).toBe('vault:corrupt')
    }
  })

  it('is not an exportation of the data, and an exportation of the data is not a vault', async () => {
    writeFileSync(path, await encryptExport('{"x":1}', PHRASE, { params: PARAMS }))
    expect(await kindOf()).toBe('not-an-export')
  })
})

describe('the logins', () => {
  it('knows a new login, a new password for a login, and one it has', async () => {
    const v = vault()
    await v.create(PHRASE)
    expect(await v.save(LOGIN)).toBe('new')
    expect(await v.save(LOGIN)).toBe('same')
    expect(await v.save({ ...LOGIN, password: 'changed' })).toBe('update')
    expect(v.rows()).toHaveLength(1)
    expect(v.secret(v.rows()[0]!.id)?.password).toBe('changed')
    expect(await v.save({ ...LOGIN, username: 'bob' })).toBe('new')
    expect(await v.save({ ...LOGIN, origin: 'https://example.com:8443' })).toBe('new')
    expect(v.rows()).toHaveLength(3)
  })

  it('refuses a login that is not one', async () => {
    const v = vault()
    await v.create(PHRASE)
    for (const bad of [{ ...LOGIN, origin: 'http://remote.test' }, { ...LOGIN, origin: 'https://example.com/path' }, { ...LOGIN, password: '' }, { ...LOGIN, username: 'a\nb' }, { ...LOGIN, origin: 'example.com' }]) {
      expect((await errorOf(v.save(bad)) as VaultError).kind, JSON.stringify(bad)).toBe('invalid')
    }
    expect(v.count()).toBe(0)
  })

  it('removes one by its id', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, username: 'bob' })
    const bob = v.rows().find((row) => row.username === 'bob')!
    expect(await v.remove(bob.id)).toBe(true)
    expect(await v.remove(bob.id)).toBe(false)
    v.lock()
    await v.unlock(PHRASE)
    expect(v.rows().map((row) => row.username)).toEqual(['ana@example.com'])
  })

  it('keeps no copy of the vault from before a removal: the file that still held the removed login goes, the copies of logins left out at opening stay', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, username: 'bob' })
    // The vault before the last change stays beside it, as after any other change.
    expect(existsSync(`${path}.bak`)).toBe(true)
    writeFileSync(`${path}.dropped-1`, 'a sealed copy from an opening')
    await v.remove(v.rows().find((row) => row.username === 'bob')!.id)
    expect(existsSync(`${path}.bak`)).toBe(false)
    expect(existsSync(`${path}.dropped-1`)).toBe(true)
    // The next change keeps a previous vault again, and it is one without the removed login.
    await v.save({ ...LOGIN, username: 'cleo' })
    expect(existsSync(`${path}.bak`)).toBe(true)
    // A removal that removes nothing writes nothing and touches no copy.
    expect(await v.remove('f'.repeat(32))).toBe(false)
    expect(existsSync(`${path}.bak`)).toBe(true)
  })

  it('gives the rows of the page and no password in any row', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, origin: 'https://example.com:8443', password: 'OTHER-PASSWORD' })
    expect(v.rowsForPage('https://example.com/login').map((row) => row.origin)).toEqual(['https://example.com'])
    expect(v.rowsForPage('https://example.com.evil.test/')).toEqual([])
    const everything = JSON.stringify([v.rows(), v.rowsForPage('https://example.com/')])
    expect(everything).not.toContain(LOGIN.password)
    expect(everything).not.toContain('OTHER-PASSWORD')
  })

  it('is full at the limit, for a save and for an import, and says so', async () => {
    const v = vault()
    await v.create(PHRASE)
    const logins = Array.from({ length: PASSWORD_LIMITS.entries + 3 }, (_, i) => ({ origin: `https://h${i}.example`, username: 'u', password: 'p' }))
    const report = await v.addMany({ format: 'chrome', logins, counts: { read: logins.length, unsupported: 0, empty: 0, invalid: 0 } })
    expect(report).toMatchObject({ added: PASSWORD_LIMITS.entries, overCapacity: 3 })
    expect(v.count()).toBe(PASSWORD_LIMITS.entries)
    expect((await errorOf(v.save(LOGIN)) as VaultError).kind).toBe('full')
    v.lock()
    await v.unlock(PHRASE)
    expect(v.count()).toBe(PASSWORD_LIMITS.entries)
  })

  it('does not replace a login by an import', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    const report = await v.addMany({ format: 'chrome', logins: [{ ...LOGIN, password: 'FROM-THE-FILE' }, { ...LOGIN, username: 'new' }], counts: { read: 2, unsupported: 0, empty: 0, invalid: 0 } })
    expect(report).toMatchObject({ added: 1, duplicates: 1 })
    expect(v.secret(v.rows().find((row) => row.username === LOGIN.username)!.id)?.password).toBe(LOGIN.password)
  })
})

describe('the phrase', () => {
  it('is asked again to change it, and the old one stops working', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    expect(((await errorOf(v.changePhrase('not the phrase at all', 'a brand new long phrase'))) as ExportCryptoError).kind).toBe('wrong-passphrase')
    await v.changePhrase(PHRASE, 'a brand new long phrase')
    v.lock()
    expect(((await errorOf(vault().unlock(PHRASE))) as ExportCryptoError).kind).toBe('wrong-passphrase')
    const again = vault()
    await again.unlock('a brand new long phrase')
    expect(again.count()).toBe(1)
  })

  it('is asked again to delete the vault, which locks and removes the file', async () => {
    const v = vault()
    await v.create(PHRASE)
    expect(((await errorOf(v.destroy('not the phrase at all'))) as ExportCryptoError).kind).toBe('wrong-passphrase')
    expect(existsSync(path)).toBe(true)
    await v.destroy(PHRASE)
    expect(existsSync(path)).toBe(false)
    expect(v.isUnlocked()).toBe(false)
  })
})

describe('the encrypted export', () => {
  it('opens under its own phrase and gives the logins back; the master phrase does not open it', async () => {
    const v = vault()
    await v.create(PHRASE)
    await v.save(LOGIN)
    await v.save({ ...LOGIN, username: 'bob', password: 'bob-pw' })
    const text = await v.exportSealed('a phrase for the export')
    for (const secret of [LOGIN.password, 'bob-pw', LOGIN.username, 'example.com']) expect(text).not.toContain(secret)
    const logins = await openExport(text, 'a phrase for the export')
    expect(logins.logins.map((l) => `${l.username}|${l.password}`).sort()).toEqual(['ana@example.com|S3CRET-p4ss-VALUE', 'bob|bob-pw'])
    expect(((await errorOf(openExport(text, PHRASE))) as ExportCryptoError).kind).toBe('wrong-passphrase')
  })

  it('is not a vault, and a vault is not an export', async () => {
    const v = vault()
    await v.create(PHRASE)
    const text = await v.exportSealed('a phrase for the export')
    writeFileSync(path, text)
    expect(((await errorOf(vault().unlock('a phrase for the export'))) as ExportCryptoError).kind).toBe('not-an-export')
    expect(((await errorOf(openExport(readFileSync(path, 'utf8').replace('lucium-passwords-export', 'lucium-passwords'), 'a phrase for the export'))) as ExportCryptoError).kind).toBe('not-an-export')
  })

  it('is refused when it was changed, or asks for a cost beyond the limits', async () => {
    const v = vault()
    await v.create(PHRASE)
    const envelope = JSON.parse(await v.exportSealed('a phrase for the export')) as Record<string, any>
    const data = Buffer.from(envelope['data'], 'base64')
    data[3] = data[3]! ^ 1
    expect(((await errorOf(openExport(JSON.stringify({ ...envelope, data: data.toString('base64') }), 'a phrase for the export'))) as ExportCryptoError).kind).toBe('tampered')
    expect(((await errorOf(openExport(JSON.stringify({ ...envelope, kdf: { ...envelope['kdf'], N: 2 ** 30 } }), 'a phrase for the export'))) as ExportCryptoError).kind).toBe('too-costly')
  })
})

describe('what a vault may hold', () => {
  const good = { id: 'a'.repeat(32), origin: 'https://example.com', username: 'ana', password: 'pw', createdAt: 1, updatedAt: 2 }
  const text = (entries: unknown[]) => JSON.stringify({ v: 1, entries })

  it('is checked entry by entry when it is opened, and an entry this version does not accept is left out on its own', () => {
    expect(parseStoredEntries(text([good]))).toEqual({ entries: [good], dropped: 0 })
    for (const bad of [
      { ...good, id: 'short' },
      { ...good, origin: 'http://remote.test' },
      { ...good, origin: 'https://example.com/' },
      { ...good, username: ' padded ' },
      { ...good, password: '' },
      { ...good, createdAt: 'x' },
      { ...good, updatedAt: Infinity },
      'text',
      null
    ]) {
      expect(parseStoredEntries(text([bad, good])), JSON.stringify(bad)).toEqual({ entries: [good], dropped: 1 })
    }
    // The second of two entries with one id, or with one login, goes; the first stays.
    expect(parseStoredEntries(text([good, good]))).toEqual({ entries: [good], dropped: 1 })
    expect(parseStoredEntries(text([good, { ...good, id: 'b'.repeat(32) }]))).toEqual({ entries: [good], dropped: 1 })
    // Beyond the limit: the first ones are kept.
    const many = Array.from({ length: PASSWORD_LIMITS.entries + 2 }, (_, i) => ({ ...good, id: i.toString(16).padStart(32, '0'), username: `user${i}` }))
    const kept = parseStoredEntries(text(many))
    expect(kept?.entries).toHaveLength(PASSWORD_LIMITS.entries)
    expect(kept?.dropped).toBe(2)
    // What is not a vault of this format at all is still refused whole.
    for (const raw of ['not json', '{}', JSON.stringify({ v: 2, entries: [] }), JSON.stringify({ v: 1, entries: {} })]) expect(parseStoredEntries(raw), raw).toBeNull()
  })

  it('opens a vault one of whose logins this version refuses, keeps the file as it was beside it first, and counts what was left out', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const keys = await newSealKeys(PHRASE, { params: PARAMS })
      const refused = { ...good, id: 'c'.repeat(32), origin: 'http://remote.test', username: 'secret-user', password: 'secret-password' }
      const sealed = seal(VAULT_FORMAT, text([good, refused]), keys)
      writeFileSync(path, sealed)
      const v = vault()
      await v.unlock(PHRASE)
      expect(v.rows().map((row) => row.username)).toEqual(['ana'])
      expect(v.droppedAtOpening()).toBe(1)
      const copies = readdirSync(dir).filter((name) => name.startsWith('passwords.vault.dropped-'))
      expect(copies).toHaveLength(1)
      // The copy is the sealed file itself (nothing in the clear), private to the user.
      expect(readFileSync(join(dir, copies[0]!), 'utf8')).toBe(sealed)
      expect(modeOf(join(dir, copies[0]!))).toBe(0o600)
      // The log says how many, never which.
      expect(errors.mock.calls.flat().join(' ')).toContain('1 login(s)')
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/secret-user|secret-password|remote\.test/)
      // A write after that loses the login in the vault, not in the copy; opening the same file again makes no second copy.
      await v.save({ origin: 'https://other.example', username: 'bo', password: 'pw' })
      v.lock()
      expect(v.droppedAtOpening()).toBe(0)
      writeFileSync(path, sealed)
      await v.unlock(PHRASE)
      expect(readdirSync(dir).filter((name) => name.startsWith('passwords.vault.dropped-'))).toHaveLength(1)
      // Deleting the vault deletes its copies too.
      await v.destroy(PHRASE)
      expect(readdirSync(dir).filter((name) => name.startsWith('passwords.vault'))).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })
})
