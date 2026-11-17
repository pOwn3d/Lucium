// The file that holds the lock's phrase: `lock.json` in the data folder, next to state.json but never part of it. It holds a hash, never the
// phrase: scrypt (the cost of an export, see export-crypto.ts) over the NFKC-normalised phrase and a random salt. No export, no copy of the
// session and no backup reads it, so a file shared or restored cannot bring a phrase along nor take one away.
//
// This is the whole of what the phrase protects: the way into the interface. Someone who can read the data folder can read what Chromium
// keeps there; deleting this file removes the lock (and is how a forgotten phrase is recovered).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { replaceFileDurably } from './durable-write'
import { readTextBounded, SMALL_FILE_MAX_BYTES } from './persist'
import { SCRYPT_DEFAULT, paramsAllowed, type ScryptParams } from './export-crypto'

const VERSION = 1
const SALT_BYTES = 16
const HASH_BYTES = 32

interface LockRecord {
  version: typeof VERSION
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  hash: string
}

/** What the lock service needs of the file; the tests of the service put a stand-in. */
export interface LockFiles {
  exists(): boolean
  /** Replaces the phrase. */
  setPhrase(phrase: string): Promise<void>
  /** Whether `phrase` is the one stored. */
  verify(phrase: string): Promise<boolean>
  /** Forgets the phrase. */
  clear(): void
}

function derive(phrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const maxmem = 128 * params.N * params.r + 128 * params.r * params.p + 4 * 1024 * 1024
    scrypt(Buffer.from(phrase.normalize('NFKC'), 'utf8'), salt, HASH_BYTES, { N: params.N, r: params.r, p: params.p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

const isBase64Of = (value: unknown, bytes: number): value is string => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === bytes

/** The record of a file, or null when it is not one this version wrote (its cost is bounded like an export's: a file is hostile input). */
function parseRecord(text: string): LockRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const params = { N: r['N'] as number, r: r['r'] as number, p: r['p'] as number }
  if (r['version'] !== VERSION || r['kdf'] !== 'scrypt' || !paramsAllowed(params) || !isBase64Of(r['salt'], SALT_BYTES) || !isBase64Of(r['hash'], HASH_BYTES)) return null
  return { version: VERSION, kdf: 'scrypt', ...params, salt: r['salt'], hash: r['hash'] }
}

export class LockStore implements LockFiles {
  private known: LockRecord | null | undefined

  constructor(
    private readonly path: string,
    private readonly params: ScryptParams = SCRYPT_DEFAULT
  ) {}

  /** The record on disk, read once. A file that cannot be read (damaged, hostile, from a newer version) counts as no phrase and is logged: the lock is then off. */
  private record(): LockRecord | null {
    if (this.known !== undefined) return this.known
    this.known = null
    if (!existsSync(this.path)) return this.known
    try {
      this.known = parseRecord(readTextBounded(this.path, SMALL_FILE_MAX_BYTES))
    } catch (error) {
      console.error(`[lock] cannot read ${this.path}:`, error)
    }
    if (this.known === null && existsSync(this.path)) console.error(`[lock] ${this.path} is not a lock file this version can use: the lock is off`)
    return this.known
  }

  exists(): boolean {
    return this.record() !== null
  }

  async setPhrase(phrase: string): Promise<void> {
    const salt = randomBytes(SALT_BYTES)
    const hash = await derive(phrase, salt, this.params)
    const record: LockRecord = { version: VERSION, kdf: 'scrypt', ...this.params, salt: salt.toString('base64'), hash: hash.toString('base64') }
    // Only the user reads it (the hash is a way to test guesses offline), whatever a crash left under that name; on the disk before the rename, so that a power cut cannot leave an empty file, which would switch the lock off.
    replaceFileDurably(this.path, `${JSON.stringify(record)}\n`)
    this.known = record
  }

  async verify(phrase: string): Promise<boolean> {
    const record = this.record()
    if (!record) return false
    const key = await derive(phrase, Buffer.from(record.salt, 'base64'), record)
    const expected = Buffer.from(record.hash, 'base64')
    return key.length === expected.length && timingSafeEqual(key, expected)
  }

  clear(): void {
    rmSync(this.path, { force: true })
    this.known = null
  }
}
