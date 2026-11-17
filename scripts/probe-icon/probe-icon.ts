// The icon of the probe extension compat/surface-probe (what the engine checks load to see which extension APIs answer). A probe is a tool of the
// tests: its icon is a drawing of this repository, in greys only, that looks like no product: a rounded tile with a ring and a point (a target).
// It is worked out pixel by pixel and written as a PNG here, with Node alone: no browser, no picture taken from elsewhere. The pixels are the same on
// every machine; the compressed stream that holds them is not promised to be (see probeIconFault), so what a test compares with the file of the
// repository is the picture it holds, not its bytes (scripts/make-probe-icon.mjs writes the file and checks it).

import { deflateSync, inflateSync } from 'node:zlib'

/** The size the manifest of the probe declares for its icon (`"icons": { "128": … }`): the picture is exactly that. */
export const PROBE_ICON_SIZE = 128

/** The greys of the drawing, one value for the three channels: the tile, and the ring and the point on it. */
const TILE = 96
const MARK = 236
/** The drawing on a grid of 128: the radius of the corners of the tile, the ring (its middle radius and its width) and the point. */
const CORNER = 28
const RING = 36
const RING_WIDTH = 9
const POINT = 9
/** Each pixel is the mean of 4 x 4 points of it: the edges are smooth without a library. */
const SAMPLES = 4

/** Whether a point of the grid of 128 is in the tile (a square with rounded corners that fills the picture). */
function inTile(x: number, y: number): boolean {
  const half = PROBE_ICON_SIZE / 2
  const dx = Math.max(0, Math.abs(x - half) - (half - CORNER))
  const dy = Math.max(0, Math.abs(y - half) - (half - CORNER))
  return dx * dx + dy * dy <= CORNER * CORNER
}

/** Whether a point of the grid of 128 is on the ring or on the point at its centre. */
function inMark(x: number, y: number): boolean {
  const half = PROBE_ICON_SIZE / 2
  const distance = Math.hypot(x - half, y - half)
  return distance <= POINT || Math.abs(distance - RING) <= RING_WIDTH / 2
}

/** The picture as RGBA bytes, row after row, at `size` pixels a side (the drawing is scaled from its grid of 128). */
export function probeIconPixels(size: number = PROBE_ICON_SIZE): Uint8Array {
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error(`probe icon: ${size} is not a size it is drawn at (16 to 1024)`)
  const pixels = new Uint8Array(size * size * 4)
  const scale = PROBE_ICON_SIZE / size
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let covered = 0
      let grey = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (column + (sx + 0.5) / SAMPLES) * scale
          const y = (row + (sy + 0.5) / SAMPLES) * scale
          if (!inTile(x, y)) continue
          covered++
          grey += inMark(x, y) ? MARK : TILE
        }
      }
      const at = (row * size + column) * 4
      const value = covered === 0 ? 0 : Math.round(grey / covered)
      pixels[at] = value
      pixels[at + 1] = value
      pixels[at + 2] = value
      pixels[at + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255)
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, sum])
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The header of the PNG: its size, 8 bits a channel, RGBA (colour type 6), the one method of compression and of filter PNG has, no interlacing. */
function pngHeader(size: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return header
}

/** The scanlines of the PNG before compression: each row starts with the byte of its filter, none. */
function pngRows(size: number, pixels: Uint8Array): Buffer {
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let row = 0; row < size; row++) rows.set(pixels.subarray(row * size * 4, (row + 1) * size * 4), row * (size * 4 + 1) + 1)
  return rows
}

/**
 * A PNG file (8 bits a channel, RGBA, no filter) that holds `pixels`, `size` pixels a side. `level` is the compression of the zlib of this machine: the
 * file keeps its default (the best), and a test gives another to play a zlib that writes other bytes for the same picture.
 */
export function pngOf(size: number, pixels: Uint8Array, level = 9): Buffer {
  return Buffer.concat([SIGNATURE, chunk('IHDR', pngHeader(size)), chunk('IDAT', deflateSync(pngRows(size, pixels), { level })), chunk('IEND', new Uint8Array(0))])
}

/** The icon as a PNG file (8 bits a channel, RGBA, no filter), at `size` pixels a side. */
export function probeIconPng(size: number = PROBE_ICON_SIZE): Buffer {
  return pngOf(size, probeIconPixels(size))
}

/**
 * What is wrong with `file` as the icon this module draws at `size`, or null when it is that picture: a well-formed PNG of exactly the three chunks
 * IHDR, IDAT and IEND (nothing else rides along in it), whose pixels are the drawing's. Not the same bytes: the pixels are worked out here, but the
 * stream that holds them is written by the zlib of the machine, which Node takes from a fork whose code depends on the processor, and the output of
 * two zlibs for one picture is valid and not always equal. A picture put there by hand, or taken from elsewhere, is still refused.
 */
export function probeIconFault(file: Uint8Array, size: number = PROBE_ICON_SIZE): string | null {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength)
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return 'it is not a PNG file'
  const chunks: Array<{ type: string; data: Buffer }> = []
  for (let at = 8; at < bytes.length; ) {
    if (at + 12 > bytes.length || at + 12 + bytes.readUInt32BE(at) > bytes.length) return 'it ends in the middle of a chunk'
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (bytes.readUInt32BE(at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length))) return `the checksum of its chunk ${type} is wrong`
    chunks.push({ type, data })
    at += 12 + length
  }
  const types = chunks.map((one) => one.type).join(' ')
  if (types !== 'IHDR IDAT IEND') return `it has the chunks ${types}, not IHDR IDAT IEND`
  if (!chunks[0]!.data.equals(pngHeader(size))) return `its header is not the one of a ${size} px picture (8 bits, RGBA, no interlacing)`
  let rows: Buffer
  try {
    rows = inflateSync(chunks[1]!.data)
  } catch (error) {
    return `its pixels cannot be read (${error instanceof Error ? error.message : String(error)})`
  }
  return rows.equals(pngRows(size, probeIconPixels(size))) ? null : 'its pixels are not the drawing'
}
