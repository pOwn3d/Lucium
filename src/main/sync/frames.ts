// The frames of the synchronisation (docs/synchronisation.md §7.1): four bytes (the length of what follows, unsigned, big-endian), then one JSON object in UTF-8.
// The length is read BEFORE the content: a length of zero, or of more than a mebibyte, ends the connection without a byte of the content being read or kept.
// A reader never holds more than one frame: what is waiting for its end is at most `4 + MAX_FRAME_BYTES` bytes, however much the peer sends.

import { MAX_FRAME_BYTES } from './limits'
import type { ErrorCode } from './error-codes'

const HEADER_BYTES = 4

/** A message written as a frame. A message that does not fit in a frame is a bug of ours, not of the peer: it throws. */
export function encodeFrame(message: object): Buffer {
  const content = Buffer.from(JSON.stringify(message), 'utf8')
  if (content.length === 0 || content.length > MAX_FRAME_BYTES) throw new Error(`a frame of ${content.length} bytes cannot be sent`)
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32BE(content.length, 0)
  return Buffer.concat([header, content])
}

/** What the announced length of a frame allows (the vectors `frames` and `snapshotBytes` play this). */
export function frameLengthProblem(length: number): 'bad-frame' | 'too-large' | null {
  if (length === 0) return 'bad-frame'
  return length > MAX_FRAME_BYTES ? 'too-large' : null
}

export type FrameEvent = { kind: 'frame'; content: Buffer } | { kind: 'error'; code: Extract<ErrorCode, 'bad-frame' | 'too-large'> }

/**
 * Cuts a stream into frames. After an error the reader is dead: it answers the error once and then ignores everything, so that the caller closes the
 * connection and nothing that follows is read.
 */
export class FrameReader {
  private waiting: Buffer[] = []
  private waitingBytes = 0
  /** The length the header of the frame being read announced, once its four bytes are in. */
  private announced: number | null = null
  private dead = false
  /** The sum of the contents of the frames read: a session counts it against `MAX_SNAPSHOT_BYTES`. */
  contentBytes = 0

  push(chunk: Buffer): FrameEvent[] {
    if (this.dead || chunk.length === 0) return []
    this.waiting.push(chunk)
    this.waitingBytes += chunk.length
    const events: FrameEvent[] = []
    for (;;) {
      if (this.announced === null) {
        if (this.waitingBytes < HEADER_BYTES) break
        const length = this.merged().readUInt32BE(0)
        const problem = frameLengthProblem(length)
        if (problem !== null) {
          this.dead = true
          this.waiting = []
          this.waitingBytes = 0
          events.push({ kind: 'error', code: problem })
          break
        }
        this.announced = length
      }
      if (this.waitingBytes < HEADER_BYTES + this.announced) break
      const buffered = this.merged()
      const content = Buffer.from(buffered.subarray(HEADER_BYTES, HEADER_BYTES + this.announced))
      const rest = buffered.subarray(HEADER_BYTES + this.announced)
      this.waiting = rest.length > 0 ? [Buffer.from(rest)] : []
      this.waitingBytes = rest.length
      this.contentBytes += this.announced
      this.announced = null
      events.push({ kind: 'frame', content })
    }
    return events
  }

  /** What is waiting, as one buffer (the pieces are joined only when a header or a whole frame needs them). */
  private merged(): Buffer {
    if (this.waiting.length > 1) this.waiting = [Buffer.concat(this.waiting)]
    return this.waiting[0] as Buffer
  }
}
