import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { batch, logFile, snappy, tableFile, type FixtureWrite } from './leveldb-fixture'
import { LEVELDB_FILE_MAX, LevelDbFormatError, readLevelDbKeys, snappyUncompress } from './leveldb-keys'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leveldb-keys-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (key: string, sequence: number, value = 'v'): FixtureWrite => ({ key, sequence, value })
const sorted = async (prefixes: string[]): Promise<string[]> => (await readLevelDbKeys(dir, prefixes)).sort()

describe('snappyUncompress', () => {
  it('reads literals and the three kinds of copy, written here by hand from the format', () => {
    // Eleven bytes: the literal "ab", then a copy of nine bytes from two bytes back, which overlaps what it writes.
    expect(snappyUncompress(Buffer.from([11, 0x04, 0x61, 0x62, 0x15, 0x02])).toString()).toBe('abababababa')
    // A copy with a two-byte offset: "abcd", then four bytes from four bytes back.
    expect(snappyUncompress(Buffer.from([8, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x0e, 0x04, 0x00])).toString()).toBe('abcdabcd')
    // A copy with a four-byte offset.
    expect(snappyUncompress(Buffer.from([8, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x0f, 0x04, 0x00, 0x00, 0x00])).toString()).toBe('abcdabcd')
    // A literal longer than sixty bytes carries its length in the byte that follows.
    const long = Buffer.alloc(70, 0x7a)
    expect(snappyUncompress(Buffer.concat([Buffer.from([70, 0xf0, 69]), long]))).toEqual(long)
  })

  it('gives back what the fixtures compress', () => {
    const text = Buffer.from('META:https://a.example.com META:https://b.example.com '.repeat(20))
    expect(snappy(text).length).toBeLessThan(text.length / 2)
    expect(snappyUncompress(snappy(text))).toEqual(text)
  })

  it('refuses a block that lies about itself instead of answering part of it', () => {
    // A copy from before the start, a copy of offset zero, a block shorter than its length, a literal that runs out.
    for (const bad of [[4, 0x01, 0x05], [4, 0x00, 0x61, 0x01, 0x00], [9, 0x04, 0x61, 0x62], [4, 0x0c, 0x61]]) {
      expect(() => snappyUncompress(Buffer.from(bad)), String(bad)).toThrow(LevelDbFormatError)
    }
  })
})

describe('readLevelDbKeys', () => {
  it('answers nothing for a folder that does not exist: nothing was ever stored', async () => {
    expect(await readLevelDbKeys(join(dir, 'absent'), ['META:'])).toEqual([])
  })

  it('reads the keys of a table, across blocks and through the prefixes the keys share', async () => {
    const hosts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `META:https://${name}.example.com`)
    const writes = [put('VERSION', 1), ...hosts.map((key, i) => put(key, i + 2)), put('_https://a.example.com\u0000token', 20), put('_https://z.example.com\u0000k', 21)]
    writeFileSync(join(dir, '000005.ldb'), tableFile(writes, { perBlock: 2 }))
    expect(await sorted(['META:'])).toEqual(hosts)
    // A prefix that starts in the middle of a block, and one that no key has.
    expect(await sorted(['_https://z'])).toEqual(['_https://z.example.com\u0000k'])
    expect(await sorted(['NOPE'])).toEqual([])
  })

  it('reads a table whose blocks are compressed, where a host is no longer written whole', async () => {
    const hosts = Array.from({ length: 40 }, (_, i) => `META:https://sub${i}.example.com`)
    const file = tableFile(hosts.map((key, i) => put(key, i + 1)), { perBlock: 10, compress: true })
    // The point of the fixture: the bytes of the file do not spell the hosts any more.
    expect(file.includes('sub39.example.com')).toBe(false)
    writeFileSync(join(dir, '000007.ldb'), file)
    expect(await sorted(['META:'])).toEqual([...hosts].sort())
  })

  it('reads the writes still in the log, a batch cut across two blocks of the log included', async () => {
    const filler = 'x'.repeat(40_000)
    const log = logFile([batch(1, [{ key: 'META:https://a.example.com', value: 'm' }, { key: '_https://a.example.com\u0000big', value: filler }]), batch(3, [{ key: 'META:https://late.example.com', value: 'm' }])])
    expect(log.length).toBeGreaterThan(32768)
    writeFileSync(join(dir, '000003.log'), log)
    expect(await sorted(['META:'])).toEqual(['META:https://a.example.com', 'META:https://late.example.com'])
  })

  it('leaves out a key whose last write is a deletion, whichever file holds it, and keeps one written again after', async () => {
    writeFileSync(join(dir, '000005.ldb'), tableFile([put('META:https://gone.example.com', 4), put('META:https://back.example.com', 5), put('META:https://kept.example.com', 6)]))
    writeFileSync(join(dir, '000006.ldb'), tableFile([{ key: 'META:https://back.example.com', sequence: 8, deleted: true }]))
    writeFileSync(join(dir, '000009.log'), logFile([batch(10, [{ key: 'META:https://gone.example.com', deleted: true }, { key: 'META:https://back.example.com', value: 'again' }])]))
    expect(await sorted(['META:'])).toEqual(['META:https://back.example.com', 'META:https://kept.example.com'])
  })

  it('stops at the end of what was written in a log the engine is still writing, without an error', async () => {
    const whole = logFile([batch(1, [{ key: 'META:https://a.example.com', value: 'm' }]), batch(2, [{ key: 'META:https://half.example.com', value: 'm' }])])
    writeFileSync(join(dir, '000003.log'), Buffer.concat([whole.subarray(0, whole.length - 5), Buffer.alloc(0)]))
    expect(await sorted(['META:'])).toEqual(['META:https://a.example.com'])
  })

  it('ignores the files that are neither tables nor logs', async () => {
    writeFileSync(join(dir, 'MANIFEST-000001'), 'not a table')
    writeFileSync(join(dir, 'LOCK'), '')
    writeFileSync(join(dir, '000005.ldb'), tableFile([put('META:https://a.example.com', 1)]))
    expect(await sorted(['META:'])).toEqual(['META:https://a.example.com'])
  })

  it('rejects a file too big to be a table before reading it', async () => {
    writeFileSync(join(dir, '000005.ldb'), tableFile([put('META:https://a.example.com', 1)]))
    // A hole of that size takes no room on the disk.
    truncateSync(join(dir, '000005.ldb'), LEVELDB_FILE_MAX + 1)
    await expect(readLevelDbKeys(dir, ['META:'])).rejects.toThrow(/000005\.ldb is too big to be read/)
  })

  it('rejects, rather than answer a shorter list, when a file is not LevelDB or uses a compression it does not know', async () => {
    writeFileSync(join(dir, '000005.ldb'), tableFile([put('META:https://a.example.com', 1)]))
    writeFileSync(join(dir, '000006.ldb'), Buffer.from('this is not a table, and it is longer than a footer of forty-eight bytes'))
    await expect(readLevelDbKeys(dir, ['META:'])).rejects.toThrow(/mark of a table/)

    writeFileSync(join(dir, '000006.ldb'), tableFile([put('META:https://b.example.com', 2)], { compression: 2 }))
    await expect(readLevelDbKeys(dir, ['META:'])).rejects.toThrow(/compression this reader does not know \(2\)/)

    // A table cut short: its footer is gone.
    writeFileSync(join(dir, '000006.ldb'), tableFile([put('META:https://b.example.com', 2)]).subarray(0, 60))
    await expect(readLevelDbKeys(dir, ['META:'])).rejects.toBeInstanceOf(LevelDbFormatError)

    writeFileSync(join(dir, '000006.ldb'), tableFile([put('META:https://b.example.com', 2)]))
    const record = Buffer.alloc(7 + 4)
    record.writeUInt16LE(4, 4)
    record[6] = 9
    writeFileSync(join(dir, '000008.log'), record)
    await expect(readLevelDbKeys(dir, ['META:'])).rejects.toThrow(/unknown kind \(9\)/)
  })
})
