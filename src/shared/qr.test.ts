import { describe, expect, it } from 'vitest'
import { fingerprint as hashText } from './page-watch'
import { QR_MAX_BYTES, codewords, encodeQr, formatBits, penalty, qrPath, reedSolomon, versionBits, type QrCode } from './qr'

const code = (text: string, mask?: number): QrCode => {
  const result = encodeQr(text, mask)
  if ('error' in result) throw new Error(result.error)
  return result
}

const fingerprint = (qr: QrCode): string => hashText(qr.modules.map((row) => row.map((m) => (m ? '1' : '0')).join('')).join('\n'))

describe('error correction', () => {
  it('computes the codewords of the standard worked example (HELLO WORLD, version 1, level M)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })

  it('interleaves the blocks of a version that has several: data first, then error correction, column by column', () => {
    // Version 5 has two blocks of 43 data and 24 error correction codewords.
    const data = Array.from({ length: 86 }, (_, i) => i)
    const words = codewords(data, 5)
    expect(words).toHaveLength(134)
    expect(words.slice(0, 4)).toEqual([0, 43, 1, 44])
    const first = reedSolomon(data.slice(0, 43), 24)
    const second = reedSolomon(data.slice(43), 24)
    expect(words.slice(86, 90)).toEqual([first[0], second[0], first[1], second[1]])
  })

  it('puts the longer blocks last when a version has blocks of two sizes (version 8: 38 then 39 data codewords)', () => {
    const data = Array.from({ length: 154 }, (_, i) => i % 251)
    const words = codewords(data, 8)
    expect(words).toHaveLength(242)
    // The 39th codeword of the stream is the 39th of the third block only: the 38-word blocks have none left.
    expect(words.slice(4 * 38, 4 * 38 + 2)).toEqual([data[76 + 38], data[115 + 38]])
  })
})

describe('format and version information', () => {
  it('gives the format bits of the standard for level M (mask 0 is 101010000010010)', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010')
    expect(formatBits(5).toString(2).padStart(15, '0')).toBe('100000011001110')
  })

  it('gives the version bits of the standard (version 7 is 000111110010010100)', () => {
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100')
    expect(versionBits(10).toString(2).padStart(18, '0')).toBe('001010010011010011')
  })
})

describe('the code', () => {
  it('picks the smallest version that holds the text, and a longer text takes the next one', () => {
    const versions = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]
    versions.forEach((length, index) => {
      expect(code('a'.repeat(length)).version).toBe(index + 1)
      if (length < QR_MAX_BYTES) expect(code('a'.repeat(length + 1)).version).toBe(index + 2)
    })
  })

  it('is as large as the version says', () => {
    for (const [text, version] of [['a', 1], ['a'.repeat(27), 3], ['a'.repeat(200), 10]] as const) {
      const qr = code(text)
      expect(qr.version).toBe(version)
      expect(qr.size).toBe(17 + 4 * version)
      expect(qr.modules).toHaveLength(qr.size)
      expect(qr.modules.every((row) => row.length === qr.size)).toBe(true)
    }
  })

  it('draws the three finder patterns, the timing patterns and the dark module', () => {
    const qr = code('https://example.com/')
    const { modules, size } = qr
    const finder = (x: number, y: number) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
          expect(modules[y + dy]![x + dx]).toBe(ring !== 2)
        }
      }
    }
    finder(0, 0)
    finder(size - 7, 0)
    finder(0, size - 7)
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0)
      expect(modules[i]![6]).toBe(i % 2 === 0)
    }
    expect(modules[size - 8]![8]).toBe(true)
  })

  it('writes the same format information twice, and it is the one of the mask it chose', () => {
    for (let mask = 0; mask < 8; mask++) {
      const qr = code('https://example.com/', mask)
      const { modules, size } = qr
      const bits = formatBits(mask)
      let first = 0
      let second = 0
      const at = (x: number, y: number) => (modules[y]![x] ? 1 : 0)
      const cells1: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
      const cells2: Array<[number, number]> = [...Array.from({ length: 8 }, (_, i): [number, number] => [size - 1 - i, 8]), ...Array.from({ length: 7 }, (_, i): [number, number] => [8, size - 7 + i])]
      cells1.forEach(([x, y], i) => (first |= at(x, y) << i))
      cells2.forEach(([x, y], i) => (second |= at(x, y) << i))
      expect(first).toBe(bits)
      expect(second).toBe(bits)
    }
  })

  it('writes the version information twice from version 7 on, and not before', () => {
    const big = code('a'.repeat(122))
    expect(big.version).toBe(7)
    const bits = versionBits(7)
    for (let i = 0; i < 18; i++) {
      const a = big.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      expect(big.modules[b]![a]).toBe(((bits >>> i) & 1) === 1)
      expect(big.modules[a]![b]).toBe(((bits >>> i) & 1) === 1)
    }
  })

  it('is the same every time and differs from the code of another text', () => {
    expect(fingerprint(code('https://example.com/'))).toBe(fingerprint(code('https://example.com/')))
    expect(fingerprint(code('https://example.com/'))).not.toBe(fingerprint(code('https://example.com/x')))
  })

  it('picks the mask with the lowest penalty', () => {
    const text = 'https://example.com/a/path?x=1'
    const chosen = code(text)
    const scores = Array.from({ length: 8 }, (_, mask) => penalty(code(text, mask).modules))
    expect(penalty(chosen.modules)).toBe(Math.min(...scores))
    expect(scores[chosen.mask]).toBe(Math.min(...scores))
  })

  it('matches the codes read back by a QR reader (CoreImage, checked once on every version and mask; the fingerprints keep them that way)', () => {
    const long = `https://example.com/${'abcdefghij0123456789'.repeat(9)}`
    const known: Array<[string, number, number, string]> = [
      ['HELLO WORLD', 1, 4, '13438877b6797f39'],
      ['https://example.com/', 2, 4, '1114bb7374c3c462'],
      ['https://example.com/a/very/long/path?with=query&and=more#fragment-and-some-more-text-to-reach-version-four-xxxxxxxxxxx', 7, 6, 'e6ff6f2d9c573441'],
      [long, 10, 6, '7006cc4ffa4a530e']
    ]
    for (const [text, version, mask, hash] of known) {
      const qr = code(text)
      expect([qr.version, qr.mask, fingerprint(qr)]).toEqual([version, mask, hash])
    }
  })

  it('encodes the UTF-8 bytes of the text, not its characters', () => {
    // 106 two-byte letters are 212 bytes: version 10, where 106 characters would have fitted version 6.
    expect(code('é'.repeat(106)).version).toBe(10)
  })
})

describe('what is refused', () => {
  it('a text that is too long for version 10, with the sentence that says so', () => {
    const result = encodeQr('a'.repeat(QR_MAX_BYTES + 1))
    expect(result).toEqual({ error: `Cette adresse est trop longue pour un code QR (${QR_MAX_BYTES + 1} octets, ${QR_MAX_BYTES} au plus).` })
    expect('error' in encodeQr('a'.repeat(QR_MAX_BYTES))).toBe(false)
  })

  it('counts bytes, not characters, when it refuses', () => {
    expect('error' in encodeQr('é'.repeat(107))).toBe(true)
    expect('error' in encodeQr('é'.repeat(106))).toBe(false)
  })

  it('an empty text, and a mask that does not exist', () => {
    expect(encodeQr('')).toEqual({ error: 'Il n’y a rien à encoder.' })
    expect(encodeQr('a', 8)).toEqual({ error: 'Masque inconnu.' })
    expect(encodeQr('a', -1)).toEqual({ error: 'Masque inconnu.' })
    expect(encodeQr('a', 1.5)).toEqual({ error: 'Masque inconnu.' })
    expect(encodeQr(42 as unknown as string)).toEqual({ error: 'Il n’y a rien à encoder.' })
  })
})

describe('the picture', () => {
  it('draws the dark modules as runs of one row, inside the margin, with numbers only', () => {
    const qr = code('HELLO WORLD')
    const path = qrPath(qr, 4)
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/)
    // The first finder pattern starts the first row: seven dark modules after the margin.
    expect(path.startsWith('M4 4h7v1h-7z')).toBe(true)
    // Every module of every run is dark, and every dark module is in a run.
    const dark = new Set<string>()
    for (const run of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) for (let i = 0; i < Number(run[3]); i++) dark.add(`${Number(run[1]) + i - 4},${Number(run[2]) - 4}`)
    const expected = qr.modules.flatMap((row, y) => row.flatMap((m, x) => (m ? [`${x},${y}`] : [])))
    expect([...dark].sort()).toEqual(expected.sort())
  })

  it('has no margin to draw when asked for none', () => {
    expect(qrPath(code('HELLO WORLD'), 0).startsWith('M0 0h7v1h-7z')).toBe(true)
  })
})
