// The file of the lock's phrase: a hash and never the phrase, readable by its owner only, bounded when read.

import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScryptParams } from './export-crypto'
import { LockStore } from './lock-store'
import { tempDir } from './temp-dir'

const CHEAP: ScryptParams = { N: 2 ** 14, r: 8, p: 1 }
const PHRASE = 'la phrase du verrou'
let path = ''
let logged: string[] = []
beforeEach(() => {
  path = join(tempDir('lucium-lock-'), 'lock.json')
  logged = []
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('LockStore', () => {
  it('does not read a lock file larger than the small files the application reads', () => {
    writeFileSync(path, ' '.repeat(1024 * 1024 + 1))
    expect(new LockStore(path, CHEAP).exists()).toBe(false)
    // The bound is what refuses it: the refusal names the size, the text is never parsed.
    expect(logged.some((line) => line.includes('more than the 1048576 this application reads'))).toBe(true)
  })

  it('has no phrase until one is set, and says so without writing anything', () => {
    const store = new LockStore(path, CHEAP)
    expect(store.exists()).toBe(false)
    expect(() => readFileSync(path)).toThrow()
  })

  it('stores a hash of the phrase and a salt, never the phrase, in a file only its owner reads', async () => {
    const store = new LockStore(path, CHEAP)
    await store.setPhrase(PHRASE)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(PHRASE)
    expect(text).not.toContain('verrou')
    expect(JSON.parse(text)).toMatchObject({ version: 1, kdf: 'scrypt', N: 2 ** 14, r: 8, p: 1 })
    expect(statSync(path).mode & 0o077).toBe(0)
    expect(store.exists()).toBe(true)
  })

  it('keeps the file private even when a crash left a file readable by others under the name it is written to', async () => {
    writeFileSync(`${path}.tmp`, 'left by a crash', { mode: 0o644 })
    chmodSync(`${path}.tmp`, 0o644)
    await new LockStore(path, CHEAP).setPhrase(PHRASE)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('tells the right phrase from a wrong one, from another store reading the same file', async () => {
    await new LockStore(path, CHEAP).setPhrase(PHRASE)
    const other = new LockStore(path, CHEAP)
    expect(await other.verify(PHRASE)).toBe(true)
    expect(await other.verify(`${PHRASE} `)).toBe(false)
    expect(await other.verify('')).toBe(false)
    expect(await other.verify('autre phrase du verrou')).toBe(false)
  })

  it('takes the same letters typed in another form for the same phrase', async () => {
    const store = new LockStore(path, CHEAP)
    await store.setPhrase('café du matin')
    expect(await store.verify('café du matin')).toBe(true)
  })

  it('does not write the same hash twice for the same phrase (a new salt each time)', async () => {
    const store = new LockStore(path, CHEAP)
    await store.setPhrase(PHRASE)
    const first = readFileSync(path, 'utf8')
    await store.setPhrase(PHRASE)
    expect(readFileSync(path, 'utf8')).not.toBe(first)
    expect(await store.verify(PHRASE)).toBe(true)
  })

  it('replaces the phrase, and forgets it', async () => {
    const store = new LockStore(path, CHEAP)
    await store.setPhrase(PHRASE)
    await store.setPhrase('une nouvelle phrase')
    expect(await store.verify(PHRASE)).toBe(false)
    expect(await store.verify('une nouvelle phrase')).toBe(true)
    store.clear()
    expect(store.exists()).toBe(false)
    expect(await store.verify('une nouvelle phrase')).toBe(false)
    expect(() => readFileSync(path)).toThrow()
  })

  it('counts a file it cannot use as no phrase, and logs why (the lock is then off)', () => {
    for (const content of ['not json', '[]', '{"version":2}', '{}']) {
      logged.length = 0
      writeFileSync(path, content)
      const store = new LockStore(path, CHEAP)
      expect(store.exists(), content).toBe(false)
      expect(logged.some((line) => line.includes('[lock]')), content).toBe(true)
    }
  })

  it('refuses a file whose cost is out of bounds, or whose fields are not what they should be (it is hostile input)', async () => {
    await new LockStore(path, CHEAP).setPhrase(PHRASE)
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const hostile: Array<Record<string, unknown>> = [{ ...record, N: 2 ** 30 }, { ...record, N: 3 }, { ...record, r: 1_000_000 }, { ...record, p: 99 }, { ...record, salt: 'AAAA' }, { ...record, hash: 42 }, { ...record, kdf: 'md5' }]
    for (const value of hostile) {
      writeFileSync(path, JSON.stringify(value))
      expect(new LockStore(path, CHEAP).exists(), JSON.stringify(value).slice(0, 80)).toBe(false)
    }
  })
})
