import { describe, expect, it } from 'vitest'
import { joinPieces, readPiecesWithin } from './bounded-stream'

/** A stream of the given pieces that records how many it was asked for and whether it was cancelled. */
function streamOf(pieces: number[], endless = false) {
  const seen = { pulled: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = pieces[seen.pulled]
      seen.pulled++
      if (size !== undefined) controller.enqueue(new Uint8Array(size).fill(seen.pulled))
      else if (endless) controller.enqueue(new Uint8Array(1000))
      else controller.close()
    },
    cancel() {
      seen.cancelled = true
    }
  })
  return { reader: stream.getReader(), seen }
}

describe('reading a body up to a limit', () => {
  it('gives every piece, in order, of a body within the limit (the limit itself included)', async () => {
    const { reader } = streamOf([3, 2])
    const pieces = await readPiecesWithin(reader, 5)
    expect(pieces?.map((piece) => [...piece])).toEqual([[1, 1, 1], [2, 2]])
  })

  it('gives an empty list for an empty body', async () => {
    expect(await readPiecesWithin(streamOf([]).reader, 0)).toEqual([])
  })

  it('stops at the piece that passes the limit, without reading on, and leaves the stream to the caller', async () => {
    const { reader, seen } = streamOf([], true)
    expect(await readPiecesWithin(reader, 4500)).toBeNull()
    expect(seen.pulled).toBeLessThanOrEqual(6)
    expect(seen.cancelled).toBe(false)
    await reader.cancel()
    expect(seen.cancelled).toBe(true)
  })
})

describe('the pieces of a body as one run of bytes', () => {
  it('puts the pieces end to end, in order, whatever their sizes', () => {
    expect([...joinPieces([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3]), new Uint8Array([4, 5, 6])])]).toEqual([1, 2, 3, 4, 5, 6])
    expect(joinPieces([]).byteLength).toBe(0)
  })
})
