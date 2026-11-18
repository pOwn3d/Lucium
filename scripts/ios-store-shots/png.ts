// What a store picture must be before it goes to App Store Connect: the size of its device, and no alpha channel (the simulator writes RGBA, the store wants a
// picture with no transparency). Pure, and loaded by Node with type stripping: no runtime import beyond node:zlib, no enum, no parameter property.
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngFacts {
  width: number
  height: number
  /** 2 for RGB, 6 for RGBA: the only two this module reads. */
  colour: 2 | 6
}

/** The facts of the header of an 8-bit PNG without interlacing; anything else is refused with the reason. */
export function pngFacts(bytes: Buffer): PngFacts {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file')
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('the first chunk is not IHDR')
  const depth = bytes[24]
  const colour = bytes[25]
  const interlaced = bytes[28]
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlaced !== 0) {
    throw new Error(`only 8-bit RGB or RGBA PNG pictures without interlacing are read (depth ${depth}, colour type ${colour}, interlace ${interlaced})`)
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colour }
}

const CRC_TABLE = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table.push(c >>> 0)
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** The pixels of the picture, row after row, 3 (RGB) or 4 (RGBA) bytes each, the PNG filters undone. */
export function readPixels(bytes: Buffer): Buffer {
  return unfiltered(bytes, pngFacts(bytes))
}

function unfiltered(bytes: Buffer, facts: PngFacts): Buffer {
  const channels = facts.colour === 6 ? 4 : 3
  const data: Buffer[] = []
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    if (bytes.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = facts.width * channels
  if (raw.length !== (stride + 1) * facts.height) throw new Error('the pixel data does not match the size in the header')
  const pixels = Buffer.alloc(stride * facts.height)
  for (let y = 0; y < facts.height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]!
      const left = i >= channels ? pixels[y * stride + i - channels]! : 0
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0
      const paeth = (): number => {
        const p = left + up - upLeft
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      if (filter > 4) throw new Error(`unknown PNG filter ${filter}`)
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth()
      pixels[y * stride + i] = (value + predictor) & 255
    }
  }
  return pixels
}

/**
 * The same picture without its alpha channel. A picture that is not fully opaque is refused: dropping the channel would change what it shows, and a store
 * picture that lets the background through is a defect of the shot, not something to hide.
 */
export function withoutAlpha(bytes: Buffer): Buffer {
  const facts = pngFacts(bytes)
  if (facts.colour === 2) return bytes
  const rgba = unfiltered(bytes, facts)
  const stride = facts.width * 3
  const rows = Buffer.alloc((stride + 1) * facts.height)
  for (let y = 0; y < facts.height; y++) {
    // Filter "Sub" on every row: cheap, and what keeps a flat interface small.
    rows[y * (stride + 1)] = 1
    for (let x = 0; x < facts.width; x++) {
      const from = (y * facts.width + x) * 4
      if (rgba[from + 3] !== 255) throw new Error(`the pixel (${x}, ${y}) is not opaque: ${rgba[from + 3]}`)
      for (let c = 0; c < 3; c++) {
        const here = rgba[from + c]!
        const left = x > 0 ? rgba[from - 4 + c]! : 0
        rows[y * (stride + 1) + 1 + x * 3 + c] = (here - left) & 255
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(facts.width, 0)
  header.writeUInt32BE(facts.height, 4)
  header[8] = 8 // depth
  header[9] = 2 // RGB
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Why a picture is not what the store takes for a device whose pictures are `size` ("1320x2868"), or an empty list. */
export function pictureProblems(bytes: Buffer, size: string): string[] {
  let facts: PngFacts
  try {
    facts = pngFacts(bytes)
  } catch (error) {
    return [(error as Error).message]
  }
  const problems: string[] = []
  if (`${facts.width}x${facts.height}` !== size) problems.push(`it is ${facts.width}x${facts.height}, not ${size}`)
  if (facts.colour !== 2) problems.push('it has an alpha channel')
  return problems
}
