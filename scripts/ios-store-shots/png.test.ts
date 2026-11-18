import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { pictureProblems, pngFacts, readPixels, withoutAlpha } from './png'

// A tiny PNG built here, the way the simulator writes one: 8-bit RGBA, one filter byte per row.
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
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
function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number], filter = 0): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < width; x++) {
      const px = pixel(x, y)
      for (let c = 0; c < 4; c++) {
        // Filter 1 (Sub) stores the difference with the pixel on the left; filter 2 (Up), with the one above.
        const here = px[c]!
        const reference = filter === 1 ? (x > 0 ? pixel(x - 1, y)[c]! : 0) : filter === 2 ? (y > 0 ? pixel(x, y - 1)[c]! : 0) : 0
        raw[y * (stride + 1) + 1 + x * 4 + c] = (here - reference) & 255
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const colourOf = (x: number, y: number): [number, number, number, number] => [(x * 40) & 255, (y * 60) & 255, (x + y) * 17, 255]

describe('the pictures of the store listing', () => {
  it('lose their alpha channel and nothing else', () => {
    for (const filter of [0, 1, 2]) {
      const flat = withoutAlpha(rgbaPng(5, 4, colourOf, filter))
      expect(pngFacts(flat)).toEqual({ width: 5, height: 4, colour: 2 })
      // A picture that has no alpha channel any more is left as it is.
      expect(withoutAlpha(flat)).toBe(flat)
    }
  })

  it('keep their pixels: the flattened picture reads the colours the simulator drew, whatever filter the simulator used', () => {
    for (const filter of [0, 1, 2]) {
      const flat = readPixels(withoutAlpha(rgbaPng(5, 4, colourOf, filter)))
      const expected = [0, 1, 2, 3].flatMap((y) => [0, 1, 2, 3, 4].flatMap((x) => colourOf(x, y).slice(0, 3)))
      expect([...flat]).toEqual(expected)
    }
  })

  it('refuse a picture that lets the background through, rather than flatten it', () => {
    expect(() => withoutAlpha(rgbaPng(4, 4, (x, y) => [10, 20, 30, x === 2 && y === 1 ? 200 : 255]))).toThrow('the pixel (2, 1) is not opaque: 200')
  })

  it('are checked against the size of the device and for alpha', () => {
    const picture = rgbaPng(6, 3, colourOf)
    expect(pictureProblems(picture, '6x3')).toEqual(['it has an alpha channel'])
    expect(pictureProblems(withoutAlpha(picture), '6x3')).toEqual([])
    expect(pictureProblems(withoutAlpha(picture), '1320x2868')).toEqual(['it is 6x3, not 1320x2868'])
    expect(pictureProblems(Buffer.from('not a picture'), '6x3')).toEqual(['not a PNG file'])
  })

  it('refuse a PNG this module does not read, with the reason', () => {
    const sixteenBit = rgbaPng(2, 2, colourOf)
    sixteenBit[24] = 16
    expect(() => pngFacts(sixteenBit)).toThrow('depth 16')
  })
})
