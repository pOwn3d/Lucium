// The frames (docs/synchronisation.md §7.1) against the shared vectors, and the reader that cuts a stream into them.
import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameReader, frameLengthProblem } from './frames'
import { MAX_FRAME_BYTES, MAX_SNAPSHOT_BYTES } from './limits'
import { messageVectors } from './sync-vectors.test-support'

const header = (length: number): Buffer => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(length, 0)
  return bytes
}

describe('the length of a frame: the vectors of the specification', () => {
  it.each(messageVectors.frames.map((v) => [v.length, v] as const))('a frame announced at %d bytes', (_label, v) => {
    const problem = frameLengthProblem(v.length)
    expect(problem === null ? { ok: true } : { ok: false, code: problem }).toEqual(v.expect)
  })

  it('refuses a snapshot of more than 32 MiB in all (the figure of the vectors)', () => {
    for (const v of messageVectors.snapshotBytes) expect(v.total > MAX_SNAPSHOT_BYTES ? { ok: false, code: 'too-large' } : { ok: true }).toEqual(v.expect)
  })
})

describe('encodeFrame', () => {
  it('writes the length of the content on four bytes, big-endian, then the JSON', () => {
    const frame = encodeFrame({ v: 1, t: 'bye', n: 3 })
    const json = '{"v":1,"t":"bye","n":3}'
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(json.length)
    expect(frame.subarray(4).toString('utf8')).toBe(json)
  })

  it('counts the bytes of the content, not its characters', () => {
    const frame = encodeFrame({ a: 'é' })
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength('{"a":"é"}'))
  })

  it('throws on a message that does not fit in a frame: that is a bug of ours, it is not sent cut', () => {
    expect(() => encodeFrame({ a: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow()
  })
})

describe('FrameReader', () => {
  it('reads one frame whatever the way the bytes arrive: whole, byte by byte, or split in the header', () => {
    const frame = encodeFrame({ t: 'hello' })
    for (const cut of [[frame.length], [1, frame.length - 1], [2, 5, frame.length - 7], Array.from({ length: frame.length }, () => 1)]) {
      const reader = new FrameReader()
      const events = []
      let at = 0
      for (const size of cut) {
        events.push(...reader.push(frame.subarray(at, at + size)))
        at += size
      }
      expect(events.map((e) => (e.kind === 'frame' ? e.content.toString('utf8') : e.code))).toEqual(['{"t":"hello"}'])
    }
  })

  it('reads several frames that arrive in one chunk, and the start of the next one in the same chunk', () => {
    const a = encodeFrame({ n: 1 })
    const b = encodeFrame({ n: 2 })
    const c = encodeFrame({ n: 3 })
    const reader = new FrameReader()
    const first = reader.push(Buffer.concat([a, b, c.subarray(0, 3)]))
    expect(first.map((e) => (e.kind === 'frame' ? e.content.toString() : e.code))).toEqual(['{"n":1}', '{"n":2}'])
    const second = reader.push(c.subarray(3))
    expect(second.map((e) => (e.kind === 'frame' ? e.content.toString() : e.code))).toEqual(['{"n":3}'])
  })

  it('counts what it has read, for the limit of a whole session', () => {
    const reader = new FrameReader()
    reader.push(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ bb: 22 })]))
    expect(reader.contentBytes).toBe('{"a":1}'.length + '{"bb":22}'.length)
  })

  it('ends on a length of zero, without reading anything that follows', () => {
    const reader = new FrameReader()
    expect(reader.push(Buffer.concat([header(0), Buffer.from('{"v":1}')]))).toEqual([{ kind: 'error', code: 'bad-frame' }])
    expect(reader.push(encodeFrame({ v: 1 }))).toEqual([])
  })

  it('ends on a length of more than a mebibyte as soon as the header is in, and keeps nothing of what comes after', () => {
    const reader = new FrameReader()
    expect(reader.push(header(MAX_FRAME_BYTES + 1))).toEqual([{ kind: 'error', code: 'too-large' }])
    // Dead: a peer that goes on sending is not buffered.
    expect(reader.push(Buffer.alloc(100_000))).toEqual([])
    expect(reader.contentBytes).toBe(0)
  })

  it('accepts a frame of exactly a mebibyte', () => {
    const reader = new FrameReader()
    const events = reader.push(Buffer.concat([header(MAX_FRAME_BYTES), Buffer.alloc(MAX_FRAME_BYTES, 0x20)]))
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('frame')
  })

  it('waits for the rest of a frame it has the header of, and says nothing yet', () => {
    const reader = new FrameReader()
    expect(reader.push(Buffer.concat([header(10), Buffer.from('abc')]))).toEqual([])
    expect(reader.push(Buffer.from('defghij')).map((e) => e.kind)).toEqual(['frame'])
  })

  it('does not copy the stream again at each chunk of a large frame (joins it once)', () => {
    const reader = new FrameReader()
    const size = 600_000
    const frame = Buffer.concat([header(size), Buffer.alloc(size, 0x41)])
    let events = 0
    for (let at = 0; at < frame.length; at += 16_384) events += reader.push(frame.subarray(at, at + 16_384)).length
    expect(events).toBe(1)
  })
})
