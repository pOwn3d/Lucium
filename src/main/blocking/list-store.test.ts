import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onWindows, expectMode } from '../windows.test-support'
import { ListStore } from './list-store'

let dir: string
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-store-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
const enginePath = (category = 'ads') => join(dir, `engine-${category}.bin`)
const mode = (path: string) => statSync(path).mode & 0o777

describe('the compiled engine on disk', () => {
  it('comes back as it was written: the key and every byte', () => {
    const store = new ListStore(dir)
    store.writeEngine('ads', { key: 'ghostery-899|easylist:abc', bytes: bytes(10_000) })
    const read = new ListStore(dir).readEngine('ads')
    expect(read?.key).toBe('ghostery-899|easylist:abc')
    expect(Buffer.from(read!.bytes).equals(Buffer.from(bytes(10_000)))).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  // Windows has no O_NOFOLLOW: the look for a link before the open (durable-write.ts) refuses it there.
  it('is never written through a link left under its temporary name: what the link points at is not ours', () => {
    const elsewhere = join(dir, 'elsewhere.txt')
    writeFileSync(elsewhere, 'not ours')
    symlinkSync(elsewhere, `${enginePath()}.tmp`)
    expect(() => new ListStore(dir).writeEngine('ads', { key: 'k', bytes: bytes(100) })).toThrow(/ELOOP/)
    expect(readFileSync(elsewhere, 'utf8')).toBe('not ours')
  })

  it('is for its owner alone, and so is the folder it sits in', () => {
    const store = new ListStore(dir)
    store.writeEngine('ads', { key: 'k', bytes: bytes(100) })
    expectMode(enginePath(), 0o600)
    expectMode(join(dir, 'lists'), 0o700)
    store.install('easylist', '||a.example^\n', { checkedAt: 1, rules: 1 })
    expectMode(join(dir, 'index.json'), 0o600)
    expectMode(join(dir, 'lists', 'easylist.txt'), 0o600)
  })

  // Windows: it has no mode to read, so nothing is open to others there and nothing is narrowed (the next test, on a Windows system played anywhere).
  it.skipIf(onWindows)('narrows, at its first write and with a message, the folders and files an earlier version left open to everyone; until then it touches nothing', () => {
    mkdirSync(join(dir, 'lists'))
    for (const file of ['index.json', 'engine-ads.bin', join('lists', 'easylist.txt')]) writeFileSync(join(dir, file), file === 'index.json' ? '{"version":1,"lists":{},"errors":{}}' : 'x')
    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'lists'), 0o755)
    for (const file of ['index.json', 'engine-ads.bin', join('lists', 'easylist.txt')]) chmodSync(join(dir, file), 0o644)
    const store = new ListStore(dir)
    expect([dir, join(dir, 'lists')].map(mode)).toEqual([0o755, 0o755])
    expect(warn).not.toHaveBeenCalled()
    store.writeEngine('ads', { key: 'k', bytes: bytes(10) })
    expect([dir, join(dir, 'lists')].map(mode)).toEqual([0o700, 0o700])
    expect(['index.json', 'engine-ads.bin', join('lists', 'easylist.txt')].map((file) => mode(join(dir, file)))).toEqual([0o600, 0o600, 0o600])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('now for its owner only'))
    warn.mockClear()
    new ListStore(dir).writeEngine('ads', { key: 'k', bytes: bytes(10) })
    expect(warn).not.toHaveBeenCalled()
    const absent = join(dir, 'never-made')
    new ListStore(absent)
    expect(existsSync(absent)).toBe(false)
  })

  it('has a header that says its layout, its key, and the size and checksum of the bytes', () => {
    new ListStore(dir).writeEngine('ads', { key: 'the-key', bytes: bytes(50) })
    const raw = readFileSync(enginePath())
    const header = JSON.parse(raw.subarray(0, raw.indexOf(10)).toString('utf8')) as Record<string, unknown>
    expect(header).toMatchObject({ format: 2, key: 'the-key', size: 50 })
    expect(typeof header['crc32']).toBe('number')
  })

  it('is not there on the first launch: nothing is said, nothing is made', () => {
    expect(new ListStore(dir).readEngine('ads')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is ignored, with a message, and removed when it is cut short', () => {
    const store = new ListStore(dir)
    store.writeEngine('ads', { key: 'k', bytes: bytes(1000) })
    const whole = readFileSync(enginePath())
    writeFileSync(enginePath(), whole.subarray(0, whole.length - 10))
    expect(store.readEngine('ads')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is cut short'))
    expect(existsSync(enginePath())).toBe(false)
  })

  it('is ignored, with a message, and removed when a byte was changed behind our back', () => {
    const store = new ListStore(dir)
    store.writeEngine('ads', { key: 'k', bytes: bytes(1000) })
    const changed = Buffer.from(readFileSync(enginePath()))
    changed[changed.length - 100] = changed[changed.length - 100]! ^ 0xff
    writeFileSync(enginePath(), changed)
    expect(store.readEngine('ads')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match its checksum'))
    expect(existsSync(enginePath())).toBe(false)
  })

  it('is ignored when it was written by another layout of the cache (the one before this had only a key)', () => {
    const old = Buffer.concat([Buffer.from(`${JSON.stringify({ key: 'k' })}\n`), Buffer.from(bytes(100))])
    writeFileSync(enginePath(), old)
    expect(new ListStore(dir).readEngine('ads')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another version of the cache'))
    expect(existsSync(enginePath())).toBe(false)
  })

  it('is ignored when it is not an engine file at all: no header, a header that is not JSON, an empty file', () => {
    for (const content of [Buffer.from('no newline at all'), Buffer.from('not json\nbytes'), Buffer.alloc(0), Buffer.from('{"format":2,"key":5,"size":0,"crc32":0}\n')]) {
      warn.mockClear()
      writeFileSync(enginePath(), content)
      expect(new ListStore(dir).readEngine('ads'), content.toString().slice(0, 20)).toBeNull()
      expect(warn, content.toString().slice(0, 20)).toHaveBeenCalled()
    }
  })

  // Windows: the mode it reports says nothing of who can read the file, so nothing is told there.
  it.skipIf(onWindows)('tells and tightens a file that other users could read', () => {
    const store = new ListStore(dir)
    store.writeEngine('ads', { key: 'k', bytes: bytes(100) })
    chmodSync(enginePath(), 0o644)
    expect(store.readEngine('ads')?.key).toBe('k')
    expect(mode(enginePath())).toBe(0o600)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('now for its owner only'))
  })

  it('tells nothing and touches nothing on a system whose files have no mode to read: Windows reports 0666 for each, and it would be told at every launch for nothing', () => {
    const files = ['index.json', 'engine-ads.bin', join('lists', 'easylist.txt')]
    mkdirSync(join(dir, 'lists'))
    for (const file of files) writeFileSync(join(dir, file), file === 'index.json' ? '{"version":1,"lists":{},"errors":{}}' : 'x')
    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'lists'), 0o755)
    for (const file of files) chmodSync(join(dir, file), 0o644)
    new ListStore(dir, 'win32').writeEngine('ads', { key: 'k', bytes: bytes(10) })
    expect(new ListStore(dir, 'win32').readEngine('ads')?.key).toBe('k')
    expect(warn).not.toHaveBeenCalled()
    expectMode(dir, 0o755)
    expectMode(join(dir, 'lists'), 0o755)
    expectMode(join(dir, 'index.json'), 0o644)
    expectMode(join(dir, 'lists', 'easylist.txt'), 0o644)
  })

  it('tells why a file cannot be read, when it is something other than not being there', () => {
    // A folder where the file should be: reading it fails with EISDIR, not ENOENT.
    mkdirSync(enginePath('cookies'))
    expect(new ListStore(dir).readEngine('cookies')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read the compiled cookies engine'), expect.stringContaining('EISDIR'))
  })
})

describe('what a store that is never used leaves on the disk', () => {
  it('nothing: no folder, no file, even after the lists were asked about', () => {
    const fresh = join(dir, 'filters')
    const store = new ListStore(fresh)
    expect(store.meta('easylist')).toBeUndefined()
    expect(store.read('easylist')).toBeNull()
    expect(store.readEngine('ads')).toBeNull()
    expect(existsSync(fresh)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
