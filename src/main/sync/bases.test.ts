// The base of each paired device (docs/synchronisation.md §11.8, §3.3): the merged snapshot of the last session, kept beside the state, read as hostile input.
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SyncSnapshot } from '@shared/sync-snapshot'
import { tempDir } from '../temp-dir'
import { BaseStore, hashOfSnapshot } from './bases'
import { TOMBSTONE_DAYS } from './limits'

const NOW = 1_790_000_000_000
const snapshot = (name = 'A'): SyncSnapshot => ({ entities: { space: { s1: { fields: { name }, stamps: { name: '1790000000000-0000-mac' } } } }, tombstones: {}, order: { spaces: ['s1'] }, orderStamps: { spaces: '1790000000000-0000-mac' } })
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

describe('BaseStore', () => {
  it('keeps a base and gives it back with its hash and its date; none before', () => {
    const store = new BaseStore(tempDir('lucium-sync-base-'))
    expect(store.get('iphone-1', NOW)).toBeNull()
    const saved = store.save('iphone-1', snapshot(), NOW)
    const read = store.get('iphone-1', NOW + 1000)
    expect(read).toEqual({ snapshot: snapshot(), savedAt: NOW, hash: saved.hash })
    expect(saved.hash).toBe(hashOfSnapshot(snapshot()))
  })

  it('hashes what the snapshot holds, not how it was written: the keys in another order give the same hash, another value another one', () => {
    const a = snapshot()
    const reordered: SyncSnapshot = { orderStamps: a.orderStamps, order: a.order, tombstones: a.tombstones, entities: a.entities }
    expect(hashOfSnapshot(reordered)).toBe(hashOfSnapshot(a))
    expect(hashOfSnapshot(snapshot('B'))).not.toBe(hashOfSnapshot(a))
    expect(hashOfSnapshot(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps one base per device', () => {
    const store = new BaseStore(tempDir('lucium-sync-base-'))
    store.save('iphone-1', snapshot('A'), NOW)
    store.save('iphone-2', snapshot('B'), NOW)
    expect(store.get('iphone-1', NOW)?.snapshot.entities['space']?.['s1']?.fields['name']).toBe('A')
    expect(store.get('iphone-2', NOW)?.snapshot.entities['space']?.['s1']?.fields['name']).toBe('B')
  })

  it('writes a file only its owner reads, and replaces the old one whole', () => {
    const dir = tempDir('lucium-sync-base-')
    const store = new BaseStore(dir)
    store.save('iphone-1', snapshot('A'), NOW)
    store.save('iphone-1', snapshot('B'), NOW + 5)
    const path = join(dir, 'sync-base-iphone-1.json')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8')).snapshot.entities.space.s1.fields.name).toBe('B')
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('does not use a base older than thirty days (the tombstones that told the deletions are purged), and uses one of exactly thirty', () => {
    const store = new BaseStore(tempDir('lucium-sync-base-'))
    store.save('iphone-1', snapshot(), NOW)
    expect(store.get('iphone-1', NOW + TOMBSTONE_DAYS * 86_400_000)).not.toBeNull()
    expect(store.get('iphone-1', NOW + TOMBSTONE_DAYS * 86_400_000 + 1)).toBeNull()
  })

  it('forgets a base', () => {
    const store = new BaseStore(tempDir('lucium-sync-base-'))
    store.save('iphone-1', snapshot(), NOW)
    store.remove('iphone-1')
    expect(store.get('iphone-1', NOW)).toBeNull()
    expect(() => store.remove('iphone-1')).not.toThrow()
  })

  it.each(['../x', 'a/b', 'a b', '', 'x'.repeat(65), '..'])('refuses the device identifier %j: it is not a file name', (id) => {
    const store = new BaseStore(tempDir('lucium-sync-base-'))
    expect(() => store.save(id, snapshot(), NOW)).toThrow(/not a file name/)
    expect(() => store.get(id, NOW)).toThrow(/not a file name/)
    expect(() => store.remove(id)).toThrow(/not a file name/)
  })

  it.each([
    ['not JSON', 'nope'],
    ['another version', JSON.stringify({ version: 2, savedAt: NOW, snapshot: snapshot() })],
    ['no date', JSON.stringify({ version: 1, snapshot: snapshot() })],
    ['a date that is not a number', JSON.stringify({ version: 1, savedAt: 'now', snapshot: snapshot() })],
    ['a snapshot that is not one', JSON.stringify({ version: 1, savedAt: NOW, snapshot: { entities: 3 } })],
    ['a snapshot with a mark that is not a mark', JSON.stringify({ version: 1, savedAt: NOW, snapshot: { entities: { space: { s1: { fields: { name: 'A' }, stamps: { name: 'yesterday' } } } }, tombstones: {}, order: {}, orderStamps: {} } })]
  ])('uses no base from a file with %s, says so, and starts the merge empty', (_name, text) => {
    const log = quiet()
    const dir = tempDir('lucium-sync-base-')
    writeFileSync(join(dir, 'sync-base-iphone-1.json'), text)
    expect(new BaseStore(dir).get('iphone-1', NOW)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the next merge starts from an empty one'), expect.anything())
    log.mockRestore()
  })

  it('throws, and leaves the old base, when the file cannot be written: the session says `internal` instead of `commit`', () => {
    const dir = tempDir('lucium-sync-base-')
    const store = new BaseStore(dir)
    store.save('iphone-1', snapshot('A'), NOW)
    const blocked = new BaseStore(join(dir, 'missing-folder'))
    expect(() => blocked.save('iphone-1', snapshot('B'), NOW)).toThrow()
    expect(store.get('iphone-1', NOW)?.snapshot.entities['space']?.['s1']?.fields['name']).toBe('A')
  })
})
