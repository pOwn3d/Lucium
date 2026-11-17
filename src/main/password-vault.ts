// The password vault: the file `passwords.vault` of the data folder, and the logins while it is open. The logins and their passwords live in
// this object, in the main process, and nowhere else: what the interface is given is `rows()` (no password), what a page is given is one
// `secret(id)` at the moment of a fill, decided by shell/password-service.ts.
//
// The file is the envelope of vault-crypto.ts (AES-256-GCM, a key from the master phrase by scrypt), written atomically and in 0600, and it is
// not part of the state: no export of the data, no copy of the session and no backup reads it (they read `persistableState` only, which holds
// no more than the switch of the feature). Locking wipes the key; the logins are dropped. Nothing here logs a value: an error carries a kind, and
// the one line written when logins are left out says how many, never which.
//
// The wrong master phrases are counted on the disk, beside the vault (`passwords.vault.attempts`, vault-attempts.ts): every place that checks the
// phrase (opening, change of phrase, deleting the vault, handing the key to Touch ID) counts a wrong one and refuses to try while the wait lasts.
//
// A login this version does not accept (a rule made stricter by a later version, a duplicate) is left out on its own, never the whole vault
// the others open, the sealed file as it was is kept first as `passwords.vault.dropped-<time>` (0600, still under its phrase), and the
// service says how many were left out.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { exportText, mergeLogins, parseExportText, type ParsedLogins } from '@shared/password-csv'
import { writeDurableFile } from './durable-write'
import { pruneSideFiles, readTextBounded, sideFiles } from './persist'
import { ExportCryptoError, SCRYPT_DEFAULT, deriveKeys, type ScryptParams } from './export-crypto'
import { ATTEMPTS_FILE_MAX, NO_ATTEMPTS, afterWrongPhrase, attemptsText, parseAttempts, waitMs, type Attempts } from './vault-attempts'
import { PASSWORD_LIMITS, checkedLogin, cleanPassword, cleanUsername, eligibleOriginOf, entriesForPage, captureKind, rowOf, sameLogin, type ImportReport, type PasswordEntry, type PasswordRow } from '@shared/passwords'
import { PASSWORD_EXPORT_FORMAT, SEALED_FILE_MAX, VAULT_FORMAT, keyMaterialOf, newSealKeys, openSealed, parseSealed, seal, sealKeysFor, sealKeysFromMaterial, zeroKeys, type ParsedSealed, type SealKeys } from './vault-crypto'
import { isRecord } from '@shared/record'

export type VaultErrorKind = 'exists' | 'missing' | 'locked' | 'phrase' | 'full' | 'corrupt' | 'write' | 'invalid' | 'wait'

/** An error of the vault with a kind the service turns into a sentence. Its message never holds a login or a phrase. */
export class VaultError extends Error {
  /** `retryInMs` is for the kind 'wait' (too many wrong phrases): how long before the phrase can be tried again. */
  constructor(readonly kind: VaultErrorKind, message: string, readonly retryInMs = 0) {
    super(message)
    this.name = 'VaultError'
  }
}

export interface VaultOptions {
  path: string
  params?: ScryptParams
  now?: () => number
  newId?: () => string
  /** The source of the salt and the nonces; a test puts its own. */
  random?: (bytes: number) => Buffer
}

/** The login of one stored entry, or null when this version does not accept it. Every field is checked again: the file may be a hand-made one that someone sealed with the right phrase. */
function storedEntry(item: unknown): PasswordEntry | null {
  if (!isRecord(item)) return null
  const { id, origin, username, password, createdAt, updatedAt } = item
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
  if (typeof origin !== 'string' || eligibleOriginOf(origin) !== origin) return null
  if (typeof username !== 'string' || cleanUsername(username) !== username) return null
  if (cleanPassword(password) === null || typeof password !== 'string') return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  return { id, origin, username, password, createdAt, updatedAt }
}

/**
 * The logins of an opened vault, and how many of its entries were left out; null when the text is not what this version writes (not a vault of
 * format 1). An entry this version does not accept, the second of two with one id or one login, and those beyond the limit are left out one by
 * one: the others are kept.
 */
export function parseStoredEntries(text: string): { entries: PasswordEntry[]; dropped: number } | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw['v'] !== 1 || !Array.isArray(raw['entries'])) return null
  const entries: PasswordEntry[] = []
  const ids = new Set<string>()
  let dropped = 0
  for (const item of raw['entries']) {
    const entry = storedEntry(item)
    if (entry === null || ids.has(entry.id) || entries.length >= PASSWORD_LIMITS.entries || entries.some((kept) => sameLogin(kept, entry))) {
      dropped++
      continue
    }
    ids.add(entry.id)
    entries.push(entry)
  }
  return { entries, dropped }
}

/** Whether two files hold the same bytes (a copy already made of this very file is not made again). An unreadable one is not the same. */
function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}


/**
 * Writes a file only its owner can read: a temporary file next to it in 0600 (whatever the umask, and whatever an earlier crash left behind
 * under that name), complete and on the disk (a write that stops short is an error, not a smaller file), then a rename, then a check of the
 * mode. With `keepPrevious` the file it replaces stays as `<file>.bak`. Throws `VaultError('write')`; the message holds an error code,
 * never a path or a value.
 */
export function writePrivateFile(path: string, text: string, options: { keepPrevious?: boolean } = {}): void {
  const temporary = `${path}.tmp`
  try {
    writeDurableFile(temporary, text)
    if (options.keepPrevious) keepPreviousVault(path)
    renameSync(temporary, path)
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
    if ((statSync(path).mode & 0o777) !== 0o600) throw new VaultError('write', 'the file is not private')
  } catch (error) {
    rmSync(temporary, { force: true })
    if (error instanceof VaultError) throw error
    throw new VaultError('write', `the file could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  }
}

/**
 * The vault about to be replaced stays beside it as `.bak`, the one before the last change. A hard link, so that the file is never copied
 * (no space needed, no moment when `path` is missing); a copy where links are not possible.
 */
function keepPreviousVault(path: string): void {
  if (!existsSync(path)) return
  const backup = `${path}.bak`
  rmSync(backup, { force: true })
  try {
    linkSync(path, backup)
  } catch {
    copyFileSync(path, backup)
    chmodSync(backup, 0o600)
  }
}

export class PasswordVault {
  private keys: SealKeys | null = null
  private entries: PasswordEntry[] | null = null
  /** How many logins of the file the last opening left out; 0 when none, or while the vault is locked. */
  private droppedAtOpen = 0
  /** Operations run one after the other: two saves must never interleave, and a save must not start under a phrase being changed. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The wrong phrases since the last right one: read from the file at the first need (a closed vault reads nothing), then kept here and written at each change. */
  private attempts: Attempts | null = null

  constructor(private readonly options: VaultOptions) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private newId(): string {
    return this.options.newId ? this.options.newId() : randomBytes(16).toString('hex')
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** A vault file is there (readable or not). */
  exists(): boolean {
    return existsSync(this.options.path)
  }

  isUnlocked(): boolean {
    return this.entries !== null
  }

  /** How many logins of the file this version left out when it opened the vault (a copy of the file was kept first). */
  droppedAtOpening(): number {
    return this.entries === null ? 0 : this.droppedAtOpen
  }

  private open(): PasswordEntry[] {
    if (this.entries === null) throw new VaultError('locked', 'the vault is locked')
    return this.entries
  }

  // ---------- the file ----------

  /**
   * Writes the sealed logins (see `writePrivateFile`). The vault it replaces stays beside it as `.bak`, except when the phrase changes: a copy
   * under the old phrase would defeat the change, so it goes. And except when a login is removed (`keepDropped`): the vault before the removal
   * is the one file that still holds that login, so it goes too, while the copies kept for logins this version could not open (`.dropped-<time>`)
   * stay, being the only place those logins are.
   */
  private write(entries: readonly PasswordEntry[], keys: SealKeys, options: { keepPrevious: boolean; keepDropped?: boolean } = { keepPrevious: true }): void {
    const text = seal(VAULT_FORMAT, JSON.stringify({ v: 1, entries }), keys, this.options.random)
    if (text.length > SEALED_FILE_MAX) throw new VaultError('full', 'the vault would be too large')
    writePrivateFile(this.options.path, text, options)
    // Only once the vault under the new phrase is in place: a failed write leaves the copies as they were, under the phrase that still opens the file.
    if (!options.keepPrevious) for (const copy of [`${this.options.path}.bak`, ...(options.keepDropped ? [] : sideFiles(this.options.path, 'dropped'))]) rmSync(copy, { force: true })
  }

  /**
   * Logins left out when the vault was opened would vanish at its next write: the sealed file as it was (still under its phrase, nothing in the
   * clear) is kept first as `.dropped-<time>`, 0600, unless the newest such copy is this very file; the three most recent are kept (persist.ts).
   */
  private keepDropped(dropped: number): void {
    const path = this.options.path
    try {
      const newest = sideFiles(path, 'dropped')[0]
      if (newest !== undefined && sameBytes(newest, path)) return
      const copy = `${path}.dropped-${this.now()}`
      copyFileSync(path, copy)
      chmodSync(copy, 0o600)
      pruneSideFiles(path, 'dropped')
      console.error(`[passwords] ${dropped} login(s) of the vault are not accepted by this version and were left out; the file as it was is kept in ${basename(copy)}`)
    } catch (error) {
      console.error(`[passwords] ${dropped} login(s) of the vault were left out and the file could not be copied first (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
    }
  }

  /** Seals and writes `next`, and only then makes it the open list: a failed write leaves the vault as it was. */
  private commit(next: PasswordEntry[], options?: { keepPrevious: boolean; keepDropped?: boolean }): void {
    this.write(next, this.keys!, options)
    this.entries = next
  }

  // ---------- the wrong phrases ----------

  private get attemptsPath(): string {
    return `${this.options.path}.attempts`
  }

  /** The count, from the file the first time: a file that is missing, too large, unreadable or damaged is no failure at all (the owner is never shut out by it). */
  private attemptsNow(): Attempts {
    if (this.attempts !== null) return this.attempts
    let read: Attempts = NO_ATTEMPTS
    try {
      read = parseAttempts(readTextBounded(this.attemptsPath, ATTEMPTS_FILE_MAX))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error(`[passwords] the count of wrong phrases could not be read and is taken as none (${code ?? 'error'})`)
    }
    return (this.attempts = read)
  }

  /** Keeps the count, in memory and on the disk. A disk that refuses it is logged (a code, nothing else): the count of this run still holds, the vault is not shut for it. */
  private keepAttempts(next: Attempts): void {
    this.attempts = next
    try {
      if (next.failures === 0) rmSync(this.attemptsPath, { force: true })
      else writePrivateFile(this.attemptsPath, attemptsText(next))
    } catch (error) {
      console.error(`[passwords] the count of wrong phrases could not be saved (${error instanceof VaultError ? error.message : ((error as NodeJS.ErrnoException).code ?? 'error')})`)
    }
  }

  /** How long, in milliseconds, before a phrase can be tried (0: now). */
  retryInMs(): number {
    return waitMs(this.attemptsNow(), this.now())
  }

  /** Refuses a phrase to check while the wait after the wrong ones lasts: nothing is derived and nothing is compared. */
  private requireNoWait(): void {
    const wait = this.retryInMs()
    if (wait > 0) throw new VaultError('wait', 'too many wrong phrases', wait)
  }

  private wrongPhrase(): void {
    this.keepAttempts(afterWrongPhrase(this.attemptsNow(), this.now()))
  }

  /** A right phrase (or the key Touch ID released) clears the count; nothing is written when there was none. */
  private rightPhrase(): void {
    if (this.attemptsNow().failures !== 0) this.keepAttempts(NO_ATTEMPTS)
  }

  /** A new vault, or none any more, has no past: the file of an earlier one is removed whatever it said. */
  private forgetAttempts(): void {
    this.attempts = NO_ATTEMPTS
    try {
      rmSync(this.attemptsPath, { force: true })
    } catch (error) {
      console.error(`[passwords] the count of wrong phrases could not be removed (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
    }
  }

  // ---------- opening and closing ----------

  /** A new vault under `phrase` (the caller checked its length). Opens it. */
  create(phrase: string): Promise<void> {
    return this.serial(async () => {
      if (this.exists()) throw new VaultError('exists', 'a vault exists already')
      const keys = await newSealKeys(phrase, { params: this.options.params ?? SCRYPT_DEFAULT, random: this.options.random })
      try {
        this.write([], keys)
      } catch (error) {
        zeroKeys(keys)
        throw error
      }
      this.keys = keys
      this.entries = []
      this.forgetAttempts()
    })
  }

  /** Opens the vault with `phrase`. Throws `ExportCryptoError` ('wrong-passphrase', 'tampered', 'too-costly'…) or a `VaultError` ('missing', 'corrupt'). */
  unlock(phrase: string): Promise<void> {
    return this.serial(async () => {
      if (this.entries !== null) return
      this.requireNoWait()
      let opened: { keys: SealKeys; entries: PasswordEntry[] }
      try {
        opened = await this.read((parsed) => sealKeysFor(phrase, parsed))
      } catch (error) {
        if (error instanceof ExportCryptoError && error.kind === 'wrong-passphrase') this.wrongPhrase()
        throw error
      }
      this.keys = opened.keys
      this.entries = opened.entries
      this.rightPhrase()
    })
  }

  /**
   * Opens the vault with the 64 bytes the keychain gave back after Touch ID (vault-keychain.ts), instead of a phrase. Nothing is derived:
   * the bytes are the key itself, checked by the file's MAC like a phrase is. Throws `ExportCryptoError('wrong-passphrase')` when they are
   * not this file's key (the phrase changed since they were stored). `material` stays the caller's: it wipes it.
   */
  unlockWithKey(material: Buffer): Promise<void> {
    return this.serial(async () => {
      if (this.entries !== null) return
      const { keys, entries } = await this.read(async (parsed) => sealKeysFromMaterial(material, parsed))
      this.keys = keys
      this.entries = entries
      // The fingerprint stands for the phrase here, and a failed key is not a guess at the phrase: it neither counts nor is held back by the wait.
      this.rightPhrase()
    })
  }

  /** The salt of the vault on the disk, read without deriving anything: a key kept in the keychain belongs to one salt. Throws like `unlock`. */
  saltOnDisk(): Buffer {
    return Buffer.from(this.parsed().salt)
  }

  /**
   * A copy of the key that opened the vault, for the keychain (Touch ID), after the phrase was asked again: having the vault open is not
   * enough to hand its key to another program. The caller wipes `material`.
   */
  keyMaterial(phrase: string): Promise<{ material: Buffer; salt: Buffer }> {
    return this.serial(async () => {
      this.open()
      if (!(await this.confirms(phrase))) throw new ExportCryptoError('wrong-passphrase', 'check mismatch')
      return { material: keyMaterialOf(this.keys!), salt: Buffer.from(this.keys!.salt) }
    })
  }

  private parsed(): ParsedSealed {
    if (!this.exists()) throw new VaultError('missing', 'there is no vault')
    // The size is looked at before the file is read: a file of any size is not read whole.
    const info = statSync(this.options.path)
    // A pipe or a device under the name of the vault is never opened: reading it would hold the application for ever.
    if (!info.isFile()) throw new VaultError('corrupt', 'the vault is not a regular file')
    if (info.size > SEALED_FILE_MAX) throw new ExportCryptoError('too-large', 'file too large')
    return parseSealed(VAULT_FORMAT, readFileSync(this.options.path, 'utf8'))
  }

  private async read(keysOf: (parsed: ParsedSealed) => Promise<SealKeys>): Promise<{ keys: SealKeys; entries: PasswordEntry[] }> {
    const parsed = this.parsed()
    const keys = await keysOf(parsed)
    try {
      const stored = parseStoredEntries(openSealed(parsed, keys))
      if (stored === null) throw new VaultError('corrupt', 'the vault holds something this version cannot use')
      // THE GUARD: the logins left out are kept in a copy of the file before any write could lose them.
      if (stored.dropped > 0) this.keepDropped(stored.dropped)
      this.droppedAtOpen = stored.dropped
      return { keys, entries: stored.entries }
    } catch (error) {
      zeroKeys(keys)
      throw error
    }
  }

  /** Forgets the logins and wipes the key. The file stays. */
  lock(): void {
    if (this.keys) zeroKeys(this.keys)
    this.keys = null
    this.entries = null
    this.droppedAtOpen = 0
  }

  // ---------- reading ----------

  /** The logins without their passwords, by host then username. */
  rows(): PasswordRow[] {
    return this.open()
      .map(rowOf)
      .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username))
  }

  count(): number {
    return this.entries?.length ?? 0
  }

  /** The rows whose origin is exactly the page's. */
  rowsForPage(pageUrl: string | null | undefined): PasswordRow[] {
    return entriesForPage(this.open(), pageUrl).map(rowOf)
  }

  /** The kind of change a login seen on a page would make. */
  captureKind(login: { origin: string; username: string; password: string }): 'new' | 'update' | 'same' {
    return captureKind(this.open(), login)
  }

  /** One login with its password. For the fill only (shell/password-service.ts), never for the interface. */
  secret(id: string): PasswordEntry | null {
    return this.open().find((entry) => entry.id === id) ?? null
  }

  // ---------- changing ----------

  /** Adds a login, or changes the password of the entry with that origin and username. Answers what it did. */
  save(login: { origin: string; username: string; password: string }): Promise<'new' | 'update' | 'same'> {
    return this.serial(async () => {
      const entries = this.open()
      const checked = checkedLogin({ address: login.origin, username: login.username, password: login.password })
      if (!checked.ok || checked.origin !== login.origin) throw new VaultError('invalid', 'the login is not valid')
      const known = entries.find((entry) => sameLogin(entry, checked))
      if (known) {
        if (known.password === checked.password) return 'same'
        this.commit(entries.map((entry) => (entry === known ? { ...entry, password: checked.password, updatedAt: this.now() } : entry)))
        return 'update'
      }
      if (entries.length >= PASSWORD_LIMITS.entries) throw new VaultError('full', 'the vault is full')
      const now = this.now()
      this.commit([...entries, { id: this.newId(), origin: checked.origin, username: checked.username, password: checked.password, createdAt: now, updatedAt: now }])
      return 'new'
    })
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const entries = this.open()
      if (!entries.some((entry) => entry.id === id)) return false
      this.commit(entries.filter((entry) => entry.id !== id), { keepPrevious: false, keepDropped: true })
      return true
    })
  }

  /** Adds the logins of an import that the vault does not have yet (never replacing one), in one write. */
  addMany(parsed: ParsedLogins): Promise<ImportReport> {
    return this.serial(async () => {
      const entries = this.open()
      const { toAdd, report } = mergeLogins(entries, parsed)
      if (toAdd.length > 0) {
        const now = this.now()
        this.commit([...entries, ...toAdd.map((login) => ({ id: this.newId(), ...login, createdAt: now, updatedAt: now }))])
      }
      return report
    })
  }

  // ---------- the phrase ----------

  /**
   * Whether `phrase` is the one that opened the vault: the key it gives with the file's salt is the key held. Every check of the phrase of an open
   * vault comes through here (change of phrase, deleting the vault, the key for Touch ID): it refuses while the wait lasts, counts a wrong one and clears the count on a right one.
   */
  private async confirms(phrase: string): Promise<boolean> {
    const keys = this.keys
    if (!keys) return false
    this.requireNoWait()
    const { key, macKey } = await deriveKeys(phrase, keys.salt, keys.params)
    const same = key.length === keys.key.length && timingSafeEqual(key, keys.key)
    key.fill(0)
    macKey.fill(0)
    if (same) this.rightPhrase()
    else this.wrongPhrase()
    return same
  }

  /** A new phrase (and a new salt) for the same logins. The current phrase is asked again. */
  changePhrase(current: string, next: string): Promise<void> {
    return this.serial(async () => {
      const entries = this.open()
      if (!(await this.confirms(current))) throw new ExportCryptoError('wrong-passphrase', 'check mismatch')
      const fresh = await newSealKeys(next, { params: this.options.params ?? SCRYPT_DEFAULT, random: this.options.random })
      try {
        this.write(entries, fresh, { keepPrevious: false })
      } catch (error) {
        zeroKeys(fresh)
        throw error
      }
      zeroKeys(this.keys!)
      this.keys = fresh
    })
  }

  /** Deletes the vault file, after the phrase was asked again. Locks. */
  destroy(phrase: string): Promise<void> {
    return this.serial(async () => {
      this.open()
      if (!(await this.confirms(phrase))) throw new ExportCryptoError('wrong-passphrase', 'check mismatch')
      // The file and what it kept of itself: the vault is gone, not just its newest version (nor the copies of logins left out).
      for (const file of [this.options.path, `${this.options.path}.bak`, `${this.options.path}.tmp`, ...sideFiles(this.options.path, 'dropped')]) rmSync(file, { force: true })
      this.forgetAttempts()
      this.lock()
    })
  }

  // ---------- files ----------

  /** The text of an encrypted export of every login, under its own phrase (not the master phrase's key: a new salt). */
  exportSealed(phrase: string): Promise<string> {
    return this.serial(async () => {
      const entries = this.open()
      const keys = await newSealKeys(phrase, { params: this.options.params ?? SCRYPT_DEFAULT, random: this.options.random })
      try {
        return seal(PASSWORD_EXPORT_FORMAT, exportText(entries), keys, this.options.random)
      } finally {
        zeroKeys(keys)
      }
    })
  }
}

/** The logins inside the text of an encrypted export, under its phrase. Throws `ExportCryptoError`; a text that opens but is not a list of logins throws a `VaultError('corrupt')`. */
export async function openExport(text: string, phrase: string): Promise<ParsedLogins> {
  const parsed = parseSealed(PASSWORD_EXPORT_FORMAT, text)
  const keys = await sealKeysFor(phrase, parsed)
  try {
    const inside = parseExportText(openSealed(parsed, keys))
    if (!inside.ok) throw new VaultError('corrupt', 'the export holds something this version cannot use')
    return inside.parsed
  } finally {
    zeroKeys(keys)
  }
}
