// Reading the body of an answer that may never end, piece by piece, and stopping as soon as it passes a limit: a server that announces no
// length can stream without end. The one loop of the filter lists (blocking/list-updater.ts), of the Chrome Web Store (engine/web-store-network.ts),
// of the live folders (shell/live-fetch.ts) and of the update feed (update-check.ts), which then give the stream up each in its own way.
// The pictures of a Markdown export (engine/resource-fetch.ts) keep a loop of their own: each piece is also counted against a total shared by
// the downloads that run together.

/** The pieces `reader` gives until it ends, or null as soon as they pass `limit` bytes; the stream is then still open, for the caller to cancel. */
export async function readPiecesWithin(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): Promise<Uint8Array[] | null> {
  const pieces: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return pieces
    size += value.byteLength
    if (size > limit) return null
    pieces.push(value)
  }
}

/** The pieces of a body as one run of bytes. */
export function joinPieces(pieces: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(pieces.reduce((size, piece) => size + piece.byteLength, 0))
  let at = 0
  for (const piece of pieces) {
    bytes.set(piece, at)
    at += piece.byteLength
  }
  return bytes
}
