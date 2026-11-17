// Reads the keys of a LevelDB folder, and only the keys: the engine keeps local storage in one, and has no call that lists the sites
// that stored something there. Nothing is written and no lock is taken: the tables (`.ldb`) and the logs (`.log`) are read as plain
// files while the engine goes on using them. The checksums of the blocks are not verified; a file that does not read as LevelDB is an
// error the caller reports, never a shorter list.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** A file that is not what LevelDB writes (or a compression this reader does not know). */
export class LevelDbFormatError extends Error {}

/** Biggest file read whole. A table is a few megabytes and a log is smaller: beyond this the file is not one of them. */
export const LEVELDB_FILE_MAX = 64 * 1024 * 1024
/** Biggest block once uncompressed (the engine writes blocks of a few kilobytes; one value can make a block as big as itself). */
const BLOCK_MAX = 64 * 1024 * 1024

const TABLE_MAGIC = 0xdb4775248b80fb57n
const FOOTER_BYTES = 48
const LOG_BLOCK = 32768
const LOG_HEADER = 7

/** A 32-bit varint at `at`: the value and where the next byte is. */
function varint(data: Buffer, at: number): [number, number] {
  let value = 0
  for (let shift = 0; shift <= 28; shift += 7) {
    const byte = data[at++]
    if (byte === undefined) throw new LevelDbFormatError('a number runs past the end of its block')
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return [value, at]
  }
  throw new LevelDbFormatError('a number is longer than five bytes')
}

/** A 64-bit varint, for the offsets of a table: files are far smaller than 2^53 bytes. */
function varint64(data: Buffer, at: number): [number, number] {
  let value = 0
  for (let shift = 0; shift <= 63; shift += 7) {
    const byte = data[at++]
    if (byte === undefined) throw new LevelDbFormatError('an offset runs past the end of its block')
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return [value, at]
  }
  throw new LevelDbFormatError('an offset is longer than ten bytes')
}

/** The bytes a Snappy block stands for (the raw format, without framing: what LevelDB stores). */
export function snappyUncompress(input: Buffer): Buffer {
  const [length, start] = varint(input, 0)
  if (length > BLOCK_MAX) throw new LevelDbFormatError(`a block of ${length} bytes is too big`)
  const out = Buffer.alloc(length)
  let pos = start
  let at = 0
  while (pos < input.length) {
    const tag = input[pos++]!
    if ((tag & 3) === 0) {
      let size = tag >> 2
      if (size >= 60) {
        const bytes = size - 59
        if (pos + bytes > input.length) throw new LevelDbFormatError('a literal length runs past the end of its block')
        size = input.readUIntLE(pos, bytes)
        pos += bytes
      }
      size += 1
      if (pos + size > input.length || at + size > length) throw new LevelDbFormatError('a literal runs past the end of its block')
      input.copy(out, at, pos, pos + size)
      pos += size
      at += size
      continue
    }
    let size: number
    let offset: number
    const extra = (tag & 3) === 1 ? 1 : (tag & 3) === 2 ? 2 : 4
    if (pos + extra > input.length) throw new LevelDbFormatError('a copy runs past the end of its block')
    if (extra === 1) {
      size = ((tag >> 2) & 7) + 4
      offset = ((tag >> 5) << 8) | input[pos]!
    } else {
      size = (tag >> 2) + 1
      offset = extra === 2 ? input.readUInt16LE(pos) : input.readUInt32LE(pos)
    }
    pos += extra
    if (offset === 0 || offset > at || at + size > length) throw new LevelDbFormatError('a copy points outside what was written')
    // Byte by byte: a copy may overlap what it writes (a run of the same byte is a copy of offset one).
    for (let i = 0; i < size; i++, at++) out[at] = out[at - offset]!
  }
  if (at !== length) throw new LevelDbFormatError('a block is shorter than it says')
  return out
}

/** The contents of the block at `offset`, `size` bytes long, followed by its compression byte and its checksum. */
function readBlock(file: Buffer, offset: number, size: number): Buffer {
  if (offset + size + 5 > file.length) throw new LevelDbFormatError('a block runs past the end of the file')
  const raw = file.subarray(offset, offset + size)
  const compression = file[offset + size]
  if (compression === 0) return raw
  if (compression === 1) return snappyUncompress(raw)
  throw new LevelDbFormatError(`a block uses a compression this reader does not know (${compression})`)
}

/** The entries of a block, in order: a key is stored as what it shares with the one before and what differs. */
function* blockEntries(block: Buffer): Generator<[Buffer, Buffer]> {
  if (block.length < 4) throw new LevelDbFormatError('a block is too short')
  const restarts = block.readUInt32LE(block.length - 4)
  const end = block.length - 4 - restarts * 4
  if (end < 0) throw new LevelDbFormatError('a block has more restart points than bytes')
  let pos = 0
  let last: Buffer = Buffer.alloc(0)
  while (pos < end) {
    let shared: number
    let own: number
    let valueSize: number
    ;[shared, pos] = varint(block, pos)
    ;[own, pos] = varint(block, pos)
    ;[valueSize, pos] = varint(block, pos)
    if (shared > last.length || pos + own + valueSize > end) throw new LevelDbFormatError('an entry runs past the end of its block')
    const key = Buffer.concat([last.subarray(0, shared), block.subarray(pos, pos + own)])
    pos += own
    yield [key, block.subarray(pos, pos + valueSize)]
    pos += valueSize
    last = key
  }
}

/** What was last done to a key: the write with the highest sequence number wins, and it is either a value or a deletion. */
type Latest = Map<string, { sequence: bigint; live: boolean }>

function note(latest: Latest, key: Buffer, sequence: bigint, live: boolean): void {
  // Byte for byte as a map key; the caller decodes the keys it keeps.
  const id = key.toString('latin1')
  const seen = latest.get(id)
  if (!seen || sequence >= seen.sequence) latest.set(id, { sequence, live })
}

/** The first key after every key that starts with `prefix`, or null when there is none (a prefix of 0xff bytes). */
function prefixEnd(prefix: Buffer): Buffer | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i]! < 0xff) {
      const end = Buffer.from(prefix.subarray(0, i + 1))
      end[i]! += 1
      return end
    }
  }
  return null
}

/** A key of a table without the eight bytes that end it (sequence number and kind). */
function userKey(internal: Buffer): Buffer {
  if (internal.length < 8) throw new LevelDbFormatError('a key of a table is shorter than its trailer')
  return internal.subarray(0, internal.length - 8)
}

/** The keys of one table that start with one of `prefixes`. Only the blocks that can hold such a key are read. */
function readTable(file: Buffer, prefixes: readonly Buffer[], latest: Latest): void {
  if (file.length < FOOTER_BYTES || file.readBigUInt64LE(file.length - 8) !== TABLE_MAGIC) throw new LevelDbFormatError('a table does not end with the mark of a table')
  const footer = file.subarray(file.length - FOOTER_BYTES)
  let pos = 0
  // The first handle is the one of the filters, which are not needed to list keys.
  ;[, pos] = varint64(footer, pos)
  ;[, pos] = varint64(footer, pos)
  const [indexOffset, afterOffset] = varint64(footer, pos)
  const [indexSize] = varint64(footer, afterOffset)
  const ranges = prefixes.map((prefix) => ({ prefix, end: prefixEnd(prefix) }))
  // The key of an index entry is at or after every key of its block, and before every key of the next one.
  let before: Buffer | null = null
  for (const [separator, handle] of blockEntries(readBlock(file, indexOffset, indexSize))) {
    const upTo = userKey(separator)
    const after: Buffer | null = before
    before = upTo
    const mayHold = ranges.some(({ prefix, end }) => Buffer.compare(upTo, prefix) >= 0 && (after === null || end === null || Buffer.compare(after, end) < 0))
    if (!mayHold) continue
    const [offset, next] = varint64(handle, 0)
    const [size] = varint64(handle, next)
    for (const [internal] of blockEntries(readBlock(file, offset, size))) {
      const key = userKey(internal)
      if (!prefixes.some((prefix) => key.subarray(0, prefix.length).equals(prefix))) continue
      const trailer = internal.readBigUInt64LE(internal.length - 8)
      note(latest, key, trailer >> 8n, (trailer & 0xffn) === 1n)
    }
  }
}

/** The records of a log. A log the engine is writing ends anywhere: what follows the last whole record is left unread, without an error. */
function* logRecords(file: Buffer): Generator<Buffer> {
  let pos = 0
  let parts: Buffer[] | null = null
  while (pos + LOG_HEADER <= file.length) {
    const left = LOG_BLOCK - (pos % LOG_BLOCK)
    if (left < LOG_HEADER) {
      pos += left
      continue
    }
    const size = file.readUInt16LE(pos + 4)
    const kind = file[pos + 6]!
    // Zeros: space set aside and not written yet.
    if (kind === 0 && size === 0) return
    if (size > left - LOG_HEADER) throw new LevelDbFormatError('a record of a log is longer than its block')
    if (pos + LOG_HEADER + size > file.length) return
    const data = file.subarray(pos + LOG_HEADER, pos + LOG_HEADER + size)
    pos += LOG_HEADER + size
    if (kind === 1) yield data
    else if (kind === 2) parts = [data]
    else if (kind === 3) parts?.push(data)
    else if (kind === 4) {
      if (parts) yield Buffer.concat([...parts, data])
      parts = null
    } else throw new LevelDbFormatError(`a record of a log has an unknown kind (${kind})`)
  }
}

/** The keys of one log (the writes not yet moved to a table) that start with one of `prefixes`. */
function readLog(file: Buffer, prefixes: readonly Buffer[], latest: Latest): void {
  for (const batch of logRecords(file)) {
    if (batch.length < 12) throw new LevelDbFormatError('a batch of a log is shorter than its header')
    const first = batch.readBigUInt64LE(0)
    const count = batch.readUInt32LE(8)
    let pos = 12
    for (let i = 0; i < count; i++) {
      const kind = batch[pos++]
      if (kind !== 0 && kind !== 1) throw new LevelDbFormatError(`a write of a log has an unknown kind (${kind})`)
      let size: number
      ;[size, pos] = varint(batch, pos)
      if (pos + size > batch.length) throw new LevelDbFormatError('a key runs past the end of its batch')
      const key = batch.subarray(pos, pos + size)
      pos += size
      if (kind === 1) {
        ;[size, pos] = varint(batch, pos)
        if (pos + size > batch.length) throw new LevelDbFormatError('a value runs past the end of its batch')
        pos += size
      }
      if (prefixes.some((prefix) => key.subarray(0, prefix.length).equals(prefix))) note(latest, key, first + BigInt(i), kind === 1)
    }
  }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** How many times the folder is read again when a file went away in the middle (the engine merged it into another one). */
const ATTEMPTS = 3

/**
 * The keys of the LevelDB folder `dir` that start with one of `prefixes` and still have a value, as text. An empty list when the folder does
 * not exist (nothing was ever stored). Rejects when a file cannot be read or is not LevelDB: a list that may miss keys is never answered.
 */
export async function readLevelDbKeys(dir: string, prefixes: readonly string[]): Promise<string[]> {
  const wanted = prefixes.map((prefix) => Buffer.from(prefix, 'utf8'))
  for (let attempt = 1; ; attempt++) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const latest: Latest = new Map()
    try {
      for (const name of names) {
        const table = name.endsWith('.ldb')
        if (!table && !name.endsWith('.log')) continue
        const path = join(dir, name)
        const { size } = await stat(path)
        if (size > LEVELDB_FILE_MAX) throw new LevelDbFormatError(`${name} is too big to be read (${size} bytes)`)
        const file = await readFile(path)
        try {
          if (table) readTable(file, wanted, latest)
          else readLog(file, wanted, latest)
        } catch (error) {
          // A read past the end of a buffer is a damaged file too.
          if (error instanceof RangeError) throw new LevelDbFormatError(`${name}: ${error.message}`, { cause: error })
          throw error
        }
      }
    } catch (error) {
      // The file was listed and then merged away: its keys are in a file the listing did not have. Read the folder again.
      if (isMissing(error) && attempt < ATTEMPTS) continue
      throw error
    }
    return [...latest].filter(([, state]) => state.live).map(([key]) => Buffer.from(key, 'latin1').toString('utf8'))
  }
}
