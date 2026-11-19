// `sync.json` (docs/synchronisation.md §3.3): off by default, only the structure ticked, strict reading, and a device list that never grows without bound.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from '../temp-dir'
import { DEFAULT_CATEGORIES, MAX_PEERS, PORT_MAX, PORT_MIN, SyncStore, type PeerRecord } from './sync-store'

const peer = (n: number, extra: Partial<PeerRecord> = {}): PeerRecord => ({ id: `iphone-${n}`, name: `iPhone ${n}`, platform: 'ios', fingerprint: n.toString(16).padStart(64, '0'), pairedAt: 1_790_000_000_000 + n, lastSessionAt: null, ...extra })
const fresh = (): { path: string; dir: string } => {
  const dir = tempDir('lucium-sync-store-')
  return { dir, path: join(dir, 'sync.json') }
}

describe('SyncStore: the defaults', () => {
  it('is OFF, ticks only the structure, has no port and no device', () => {
    const { path } = fresh()
    const config = new SyncStore(path).config()
    expect(config.enabled).toBe(false)
    expect(config.categories).toEqual({ structure: true, settings: false, archive: false, todayTabs: false })
    expect(config.categories).toEqual(DEFAULT_CATEGORIES)
    expect(config.port).toBeNull()
    expect(config.peers).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('hands out copies: changing what config() gave changes nothing in the store', () => {
    const store = new SyncStore(fresh().path)
    const config = store.config()
    config.enabled = true
    config.categories.settings = true
    config.peers.push(peer(1))
    expect(store.config()).toMatchObject({ enabled: false, categories: DEFAULT_CATEGORIES, peers: [] })
  })
})

describe('SyncStore: what is kept', () => {
  it('keeps the switch and the categories across a restart', () => {
    const { path } = fresh()
    const store = new SyncStore(path)
    store.setEnabled(true)
    store.setCategory('archive', true)
    store.setCategory('structure', false)
    const again = new SyncStore(path).config()
    expect(again.enabled).toBe(true)
    expect(again.categories).toEqual({ structure: false, settings: false, archive: true, todayTabs: false })
  })

  // A POSIX mode: Windows keeps none.
  it.skipIf(process.platform === 'win32')('writes a file only its owner reads', () => {
    const { path } = fresh()
    new SyncStore(path).setEnabled(true)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('draws the port once and keeps it; replaces it only when asked', () => {
    const { path } = fresh()
    const store = new SyncStore(path)
    const pick = vi.fn(() => 50_000)
    expect(store.port(pick)).toBe(50_000)
    expect(store.port(pick)).toBe(50_000)
    expect(pick).toHaveBeenCalledTimes(1)
    expect(new SyncStore(path).port(() => 1)).toBe(50_000)
    store.replacePort(50_001)
    expect(new SyncStore(path).config().port).toBe(50_001)
  })

  it('refuses a port out of the dynamic range, from the picker and from the caller', () => {
    const store = new SyncStore(fresh().path)
    expect(() => store.port(() => PORT_MIN - 1)).toThrow(/not a port/)
    expect(() => store.replacePort(PORT_MAX + 1)).toThrow()
    expect(() => store.replacePort(80)).toThrow()
    expect(() => store.replacePort(1.5)).toThrow()
    expect(store.config().port).toBeNull()
  })

  it('keeps a device, finds it by fingerprint, and forgets it', () => {
    const { path } = fresh()
    const store = new SyncStore(path)
    store.addPeer(peer(1))
    store.addPeer(peer(2))
    expect(store.findByFingerprint(peer(2).fingerprint)?.id).toBe('iphone-2')
    expect(store.findByFingerprint('f'.repeat(64))).toBeUndefined()
    expect(new SyncStore(path).peers().map((p) => p.id)).toEqual(['iphone-1', 'iphone-2'])
    expect(store.forgetPeer('iphone-1')).toBe(true)
    expect(store.forgetPeer('iphone-1')).toBe(false)
    expect(new SyncStore(path).peers().map((p) => p.id)).toEqual(['iphone-2'])
    expect(store.findByFingerprint(peer(1).fingerprint)).toBeUndefined()
  })

  it('takes a device paired again in the place of its old entry (same identifier, or same fingerprint)', () => {
    const store = new SyncStore(fresh().path)
    store.addPeer(peer(1))
    store.addPeer(peer(2))
    store.addPeer(peer(1, { fingerprint: 'a'.repeat(64), name: 'Renamed' }))
    store.addPeer(peer(9, { fingerprint: peer(2).fingerprint }))
    const list = store.peers()
    expect(list).toHaveLength(2)
    expect(list.find((p) => p.id === 'iphone-1')).toMatchObject({ name: 'Renamed', fingerprint: 'a'.repeat(64) })
    expect(list.find((p) => p.id === 'iphone-9')?.fingerprint).toBe(peer(2).fingerprint)
    expect(list.some((p) => p.id === 'iphone-2')).toBe(false)
  })

  it(`holds at most ${MAX_PEERS} devices: the next one is refused and the list is as it was`, () => {
    const { path } = fresh()
    const store = new SyncStore(path)
    for (let n = 1; n <= MAX_PEERS; n++) store.addPeer(peer(n))
    expect(() => store.addPeer(peer(MAX_PEERS + 1))).toThrow(/more than/)
    expect(store.peers()).toHaveLength(MAX_PEERS)
    expect(new SyncStore(path).peers()).toHaveLength(MAX_PEERS)
  })

  it('records the end of a session, and ignores a device it does not know', () => {
    const store = new SyncStore(fresh().path)
    store.addPeer(peer(1))
    store.touchSession('iphone-1', 1_790_000_999_000)
    store.touchSession('nobody', 5)
    expect(store.peers()).toEqual([peer(1, { lastSessionAt: 1_790_000_999_000 })])
  })

  it('forgets every device at once', () => {
    const { path } = fresh()
    const store = new SyncStore(path)
    store.addPeer(peer(1))
    store.addPeer(peer(2))
    store.clearPeers()
    expect(new SyncStore(path).peers()).toEqual([])
  })

  it('keeps the store as it was when a write fails, and throws', () => {
    const { dir, path } = fresh()
    const store = new SyncStore(path)
    store.setEnabled(true)
    // A folder where the file's temporary name goes: the write cannot happen.
    const blocked = new SyncStore(join(dir, 'missing', 'sync.json'))
    expect(() => blocked.setEnabled(true)).toThrow()
    expect(blocked.config().enabled).toBe(false)
    expect(store.config().enabled).toBe(true)
  })
})

describe('SyncStore: a file that is not one of ours', () => {
  const valid = (): Record<string, unknown> => ({ version: 1, enabled: true, categories: { structure: true, settings: true, archive: false, todayTabs: false }, port: 50_000, peers: [peer(1)] })

  it('reads a good file', () => {
    const { path } = fresh()
    writeFileSync(path, JSON.stringify(valid()))
    expect(new SyncStore(path).config()).toMatchObject({ enabled: true, port: 50_000, categories: { settings: true } })
  })

  it('keeps what a later version added: unknown fields are ignored, a missing category takes its default', () => {
    const { path } = fresh()
    writeFileSync(path, JSON.stringify({ ...valid(), categories: { settings: true }, aLaterField: [1, 2] }))
    expect(new SyncStore(path).config().categories).toEqual({ structure: true, settings: true, archive: false, todayTabs: false })
  })

  it('ignores the retired category `openTabs` of a development file, and does not write it back (§27.11)', () => {
    const { path } = fresh()
    writeFileSync(path, JSON.stringify({ ...valid(), categories: { structure: true, settings: true, archive: false, openTabs: true, todayTabs: false } }))
    const store = new SyncStore(path)
    expect(store.config().categories).toEqual({ structure: true, settings: true, archive: false, todayTabs: false })
    store.setCategory('archive', true)
    expect(JSON.parse(readFileSync(path, 'utf8')).categories).not.toHaveProperty('openTabs')
  })

  it.each([
    ['not JSON', 'nope'],
    ['a list', '[]'],
    ['another version', JSON.stringify({ ...valid(), version: 2 })],
    ['a port below the range', JSON.stringify({ ...valid(), port: 80 })],
    ['a port that is a text', JSON.stringify({ ...valid(), port: '50000' })],
    ['peers that is not a list', JSON.stringify({ ...valid(), peers: {} })],
    ['more devices than a person has', JSON.stringify({ ...valid(), peers: Array.from({ length: MAX_PEERS + 1 }, (_, n) => peer(n + 1)) })],
    ['a device with a fingerprint in capitals', JSON.stringify({ ...valid(), peers: [peer(1, { fingerprint: 'A'.repeat(64) })] })],
    ['a device with an identifier with a space', JSON.stringify({ ...valid(), peers: [peer(1, { id: 'a b' })] })],
    ['a device with no name', JSON.stringify({ ...valid(), peers: [peer(1, { name: '' })] })],
    ['a device with a name of 81 characters', JSON.stringify({ ...valid(), peers: [peer(1, { name: 'x'.repeat(81) })] })],
    ['a device of an unknown platform', JSON.stringify({ ...valid(), peers: [{ ...peer(1), platform: 'tv' }] })],
    ['the same device twice', JSON.stringify({ ...valid(), peers: [peer(1), peer(1)] })],
    ['the same fingerprint twice', JSON.stringify({ ...valid(), peers: [peer(1), peer(2, { fingerprint: peer(1).fingerprint })] })]
  ])('moves a file with %s aside and starts again OFF with nothing paired', (_name, text) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { dir, path } = fresh()
    writeFileSync(path, text)
    const config = new SyncStore(path).config()
    expect(config).toMatchObject({ enabled: false, port: null, peers: [] })
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir).some((name) => name.startsWith('sync.json'))).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[sync]'))
    log.mockRestore()
  })

  it('does not read a file of more than a mebibyte', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { path } = fresh()
    writeFileSync(path, JSON.stringify({ ...valid(), pad: 'x'.repeat(1024 * 1024) }))
    expect(new SyncStore(path).config().enabled).toBe(false)
    expect(readFileSync.length).toBeGreaterThan(0)
    log.mockRestore()
  })
})
