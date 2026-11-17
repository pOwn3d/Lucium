// Builds LevelDB files byte by byte, for the tests of the reader (leveldb-keys.ts) and of what leans on it. Written from the format LevelDB
// documents (table_format.md, log_format.md) and the raw Snappy format, not with the reader's own code: a reader that misreads the format
// does not read these.

const TABLE_MAGIC = 0xdb4775248b80fb57n

export function varint(value: number): Buffer {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

/** A write as the fixtures name it: a value under `key`, or its deletion, at a sequence number. */
export interface FixtureWrite {
  key: string
  sequence: number
  deleted?: boolean
  value?: string
}

function internalKey(write: FixtureWrite): Buffer {
  const trailer = Buffer.alloc(8)
  trailer.writeBigUInt64LE((BigInt(write.sequence) << 8n) | (write.deleted ? 0n : 1n))
  return Buffer.concat([Buffer.from(write.key, 'utf8'), trailer])
}

/** A block: each key as what it shares with the one before (a restart point every `interval` entries, where a key is whole) and the rest. */
function block(entries: Array<[Buffer, Buffer]>, interval = 2): Buffer {
  const parts: Buffer[] = []
  const restarts: number[] = []
  let size = 0
  let last: Buffer = Buffer.alloc(0)
  entries.forEach(([key, value], index) => {
    let shared = 0
    if (index % interval === 0) restarts.push(size)
    else while (shared < last.length && shared < key.length && last[shared] === key[shared]) shared++
    const entry = Buffer.concat([varint(shared), varint(key.length - shared), varint(value.length), key.subarray(shared), value])
    parts.push(entry)
    size += entry.length
    last = key
  })
  if (restarts.length === 0) restarts.push(0)
  const tail = Buffer.alloc(4 * restarts.length + 4)
  restarts.forEach((offset, index) => tail.writeUInt32LE(offset, index * 4))
  tail.writeUInt32LE(restarts.length, restarts.length * 4)
  return Buffer.concat([...parts, tail])
}

/**
 * Raw Snappy for `data`, written the simple way: literals, and a copy wherever the next four bytes or more already appeared in the last
 * 2047 bytes (so repeated hosts and prefixes become copies, as in a real file). Not the shortest encoding, a valid one.
 */
export function snappy(data: Buffer): Buffer {
  const out: Buffer[] = [varint(data.length)]
  let literalStart = 0
  const flush = (end: number): void => {
    for (let at = literalStart; at < end; at += 60) {
      const size = Math.min(60, end - at)
      out.push(Buffer.from([(size - 1) << 2]), data.subarray(at, at + size))
    }
  }
  let pos = 0
  while (pos < data.length) {
    let best = 0
    let bestOffset = 0
    for (let from = Math.max(0, pos - 2047); from < pos; from++) {
      let size = 0
      while (size < 11 && pos + size < data.length && data[from + size] === data[pos + size]) size++
      if (size > best) {
        best = size
        bestOffset = pos - from
      }
    }
    if (best >= 4) {
      flush(pos)
      // A copy with a one-byte offset: three bits of length (4 to 11), eleven bits of offset.
      out.push(Buffer.from([1 | ((best - 4) << 2) | ((bestOffset >> 8) << 5), bestOffset & 0xff]))
      pos += best
      literalStart = pos
    } else pos++
  }
  flush(data.length)
  return Buffer.concat(out)
}

/** A table file. `perBlock` writes go in each data block; `compress` stores the blocks as Snappy; `compression` forces the byte that names it. */
export function tableFile(writes: FixtureWrite[], options: { perBlock?: number; compress?: boolean; compression?: number } = {}): Buffer {
  const perBlock = options.perBlock ?? 3
  const parts: Buffer[] = []
  let offset = 0
  const store = (contents: Buffer): Buffer => {
    const body = options.compress ? snappy(contents) : contents
    const handle = Buffer.concat([varint(offset), varint(body.length)])
    // The compression byte, then a checksum the reader does not verify.
    const stored = Buffer.concat([body, Buffer.from([options.compression ?? (options.compress ? 1 : 0)]), Buffer.alloc(4)])
    parts.push(stored)
    offset += stored.length
    return handle
  }
  const sorted = [...writes].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || b.sequence - a.sequence)
  const index: Array<[Buffer, Buffer]> = []
  for (let at = 0; at < sorted.length; at += perBlock) {
    const chunk = sorted.slice(at, at + perBlock)
    const handle = store(block(chunk.map((write) => [internalKey(write), Buffer.from(write.value ?? '')])))
    // The index names each block by its last key, which is what LevelDB does for the last block and may do for any.
    index.push([internalKey(chunk[chunk.length - 1]!), handle])
  }
  const metaindex = store(block([]))
  const indexHandle = store(block(index, 1))
  const footer = Buffer.alloc(48)
  Buffer.concat([metaindex, indexHandle]).copy(footer)
  footer.writeBigUInt64LE(TABLE_MAGIC, 40)
  return Buffer.concat([...parts, footer])
}

/** One batch of a log: the writes take the sequence numbers that follow `first`. */
export function batch(first: number, writes: Array<Omit<FixtureWrite, 'sequence'>>): Buffer {
  const header = Buffer.alloc(12)
  header.writeBigUInt64LE(BigInt(first))
  header.writeUInt32LE(writes.length, 8)
  const ops = writes.map((write) => {
    const key = Buffer.from(write.key, 'utf8')
    if (write.deleted) return Buffer.concat([Buffer.from([0]), varint(key.length), key])
    const value = Buffer.from(write.value ?? '')
    return Buffer.concat([Buffer.from([1]), varint(key.length), key, varint(value.length), value])
  })
  return Buffer.concat([header, ...ops])
}

/** A log file: each batch as one record, cut in pieces where it crosses the end of a 32768-byte block. */
export function logFile(batches: Buffer[]): Buffer {
  const out: Buffer[] = []
  let pos = 0
  const push = (piece: Buffer): void => {
    out.push(piece)
    pos += piece.length
  }
  for (const record of batches) {
    let rest = record
    let first = true
    do {
      let left = 32768 - (pos % 32768)
      if (left < 7) {
        push(Buffer.alloc(left))
        left = 32768
      }
      const piece = rest.subarray(0, left - 7)
      rest = rest.subarray(piece.length)
      const last = rest.length === 0
      const header = Buffer.alloc(7)
      header.writeUInt16LE(piece.length, 4)
      header[6] = first && last ? 1 : first ? 2 : last ? 4 : 3
      push(Buffer.concat([header, piece]))
      first = false
    } while (rest.length > 0)
  }
  return Buffer.concat(out)
}
