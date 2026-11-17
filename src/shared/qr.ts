// QR code encoder (ISO/IEC 18004), written for the "Code QR de cette page" panel: the address is turned into modules here, in the
// application, and never sent to a service. Only what an address needs is supported: byte mode (UTF-8), error correction level M,
// versions 1 to 10 (up to 213 bytes). A longer text is refused with a sentence rather than shrunk, since a code that scans as
// another address would be worse than none. Pure: no Electron, no DOM.

/** The longest text the encoder takes (version 10, level M, byte mode), in UTF-8 bytes. */
import { t } from './i18n'

export const QR_MAX_BYTES = 213

export interface QrCode {
  version: number
  /** Side of the square, in modules (17 + 4 × version). */
  size: number
  /** The mask the encoder picked (0 to 7). */
  mask: number
  /** Row-major, `size × size`: true is a dark module. */
  modules: boolean[][]
}

// ---------- Reed-Solomon over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1 ----------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!)

/** The generator polynomial of `degree` error correction codewords without its leading 1 (highest power first). */
function generator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!)
    }
    poly = next
  }
  return poly.slice(1)
}

/** The `degree` error correction codewords of a block of data codewords. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const gen = generator(degree)
  const remainder = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!
    remainder.push(0)
    for (let i = 0; i < degree; i++) remainder[i] = remainder[i]! ^ gfMul(gen[i]!, factor)
  }
  return remainder
}

// ---------- tables (level M) ----------

interface Spec {
  /** Error correction codewords per block. */
  ec: number
  /** [number of blocks, data codewords of each], in the order the standard lists them. */
  blocks: ReadonlyArray<readonly [number, number]>
}

const SPECS: readonly Spec[] = [
  { ec: 10, blocks: [[1, 16]] },
  { ec: 16, blocks: [[1, 28]] },
  { ec: 26, blocks: [[1, 44]] },
  { ec: 18, blocks: [[2, 32]] },
  { ec: 24, blocks: [[2, 43]] },
  { ec: 16, blocks: [[4, 27]] },
  { ec: 18, blocks: [[4, 31]] },
  { ec: 22, blocks: [[2, 38], [2, 39]] },
  { ec: 22, blocks: [[3, 36], [2, 37]] },
  { ec: 26, blocks: [[4, 43], [1, 44]] }
]

/** Centres of the alignment patterns, by version (the first is always 6). */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

const dataCodewords = (spec: Spec): number => spec.blocks.reduce((sum, [count, size]) => sum + count * size, 0)

/** The smallest version that holds `length` bytes, or 0 when none does. */
function versionFor(length: number): number {
  for (let version = 1; version <= SPECS.length; version++) {
    // 4 bits of mode, the length field (8 bits, 16 from version 10) and the bytes.
    const bits = 4 + (version >= 10 ? 16 : 8) + length * 8
    if (bits <= dataCodewords(SPECS[version - 1]!) * 8) return version
  }
  return 0
}

// ---------- the codeword stream ----------

function dataStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const byte of bytes) push(byte, 8)
  const capacity = dataCodewords(SPECS[version - 1]!) * 8
  push(0, Math.min(4, capacity - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  for (let pad = 0xec; words.length < capacity / 8; pad ^= 0xec ^ 0x11) words.push(pad)
  return words
}

/** Splits the data into blocks, adds each block's error correction and interleaves them as the standard asks. */
export function codewords(data: readonly number[], version: number): number[] {
  const spec = SPECS[version - 1]!
  const dataBlocks: number[][] = []
  let at = 0
  for (const [count, size] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      dataBlocks.push(data.slice(at, at + size))
      at += size
    }
  }
  const ecBlocks = dataBlocks.map((block) => reedSolomon(block, spec.ec))
  const out: number[] = []
  const longest = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < longest; i++) for (const block of dataBlocks) if (i < block.length) out.push(block[i]!)
  for (let i = 0; i < spec.ec; i++) for (const block of ecBlocks) out.push(block[i]!)
  return out
}

// ---------- the grid ----------

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0
]

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly reserved: boolean[][]

  constructor(size: number) {
    this.size = size
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  /** A module of a fixed pattern (finder, timing, format…): the data never goes there and the mask never touches it. */
  fixed(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    this.modules[y]![x] = dark
    this.reserved[y]![x] = true
  }
}

function drawFinder(grid: Grid, cx: number, cy: number): void {
  // 7 × 7 finder plus its one-module light separator.
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      grid.fixed(cx + dx, cy + dy, distance !== 2 && distance !== 4)
    }
  }
}

function drawAlignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) grid.fixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
}

/** The 15 format bits (level M and the mask), BCH-coded and masked as the standard says. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** The 18 version bits of a version 7 or later, BCH-coded. */
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

const bit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0

function drawFormat(grid: Grid, mask: number): void {
  const { size } = grid
  const bits = formatBits(mask)
  for (let i = 0; i <= 5; i++) grid.fixed(8, i, bit(bits, i))
  grid.fixed(8, 7, bit(bits, 6))
  grid.fixed(8, 8, bit(bits, 7))
  grid.fixed(7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i++) grid.fixed(14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i++) grid.fixed(size - 1 - i, 8, bit(bits, i))
  for (let i = 8; i < 15; i++) grid.fixed(8, size - 15 + i, bit(bits, i))
  // The module that is always dark.
  grid.fixed(8, size - 8, true)
}

function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const a = grid.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    grid.fixed(a, b, bit(bits, i))
    grid.fixed(b, a, bit(bits, i))
  }
}

/** The grid with every fixed pattern drawn and the format area reserved (filled for mask 0 until the real mask is known). */
function frame(version: number): Grid {
  const size = 17 + 4 * version
  const grid = new Grid(size)
  for (let i = 0; i < size; i++) {
    grid.fixed(6, i, i % 2 === 0)
    grid.fixed(i, 6, i % 2 === 0)
  }
  drawFinder(grid, 3, 3)
  drawFinder(grid, size - 4, 3)
  drawFinder(grid, 3, size - 4)
  const centres = ALIGNMENT[version - 1]!
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      // The three corners belong to the finders.
      if ((i === 0 && j === 0) || (i === 0 && j === centres.length - 1) || (i === centres.length - 1 && j === 0)) continue
      drawAlignment(grid, centres[i]!, centres[j]!)
    }
  }
  drawFormat(grid, 0)
  drawVersion(grid, version)
  return grid
}

/** Writes the codewords in the zigzag the standard prescribes, skipping the fixed modules. */
function place(grid: Grid, words: readonly number[]): void {
  const { size } = grid
  let index = 0
  const total = words.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (grid.reserved[y]![x] || index >= total) continue
        grid.modules[y]![x] = bit(words[index >>> 3]!, 7 - (index & 7))
        index++
      }
    }
  }
}

function applyMask(grid: Grid, mask: number): void {
  const rule = MASKS[mask]!
  for (let y = 0; y < grid.size; y++) for (let x = 0; x < grid.size; x++) if (!grid.reserved[y]![x] && rule(x, y)) grid.modules[y]![x] = !grid.modules[y]![x]
}

/** The penalty score of the standard (runs, 2 × 2 blocks, finder-like patterns, dark proportion): the lowest one picks the mask. */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length
  let score = 0
  const lines = [...modules.map((row) => [...row]), ...Array.from({ length: size }, (_, x) => modules.map((row) => row[x]!))]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        run++
        if (run === 5) score += 3
        else if (run > 5) score += 1
      } else run = 1
    }
    // 1:1:3:1:1 with four light modules on one side.
    for (let i = 0; i + 11 <= size; i++) {
      const window = line.slice(i, i + 11).map((m) => (m ? 1 : 0)).join('')
      if (window === '10111010000' || window === '00001011101') score += 40
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const m = modules[y]![x]
      if (m === modules[y]![x + 1] && m === modules[y + 1]![x] && m === modules[y + 1]![x + 1]) score += 3
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  score += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10
  return score
}

/**
 * Why a text has no code, or the modules of its code. The mask is the one with the lowest penalty; `mask` forces one (the tests
 * check every mask against a reader).
 */
export function encodeQr(text: string, mask?: number): QrCode | { error: string } {
  if (typeof text !== 'string' || text === '') return { error: t('qr.il-n-y-a-rien-a-encoder') }
  const bytes = new TextEncoder().encode(text)
  const version = versionFor(bytes.length)
  if (version === 0) return { error: t('qr.cette-adresse-est-trop-longue-pour-un-code-qr', { length: bytes.length, QR_MAX_BYTES }) }
  if (mask !== undefined && !(Number.isInteger(mask) && mask >= 0 && mask < 8)) return { error: t('qr.masque-inconnu') }
  const words = codewords(dataStream(bytes, version), version)
  // The remainder bits some versions have (7 for versions 2 to 6) stay light until the mask is applied, as the standard has them.
  let best: QrCode | null = null
  let bestScore = Infinity
  for (let candidate = 0; candidate < 8; candidate++) {
    if (mask !== undefined && candidate !== mask) continue
    const grid = frame(version)
    place(grid, words)
    applyMask(grid, candidate)
    drawFormat(grid, candidate)
    const score = penalty(grid.modules)
    if (score < bestScore) {
      bestScore = score
      best = { version, size: grid.size, mask: candidate, modules: grid.modules }
    }
  }
  return best!
}

/** The path of the dark modules (one run per row), for an SVG whose view box is `size + 2 × margin` square. Numbers only: nothing to escape. */
export function qrPath(code: QrCode, margin = 4): string {
  const parts: string[] = []
  for (let y = 0; y < code.size; y++) {
    let x = 0
    while (x < code.size) {
      if (!code.modules[y]![x]) {
        x++
        continue
      }
      let end = x
      while (end < code.size && code.modules[y]![end]) end++
      parts.push(`M${x + margin} ${y + margin}h${end - x}v1h${x - end}z`)
      x = end
    }
  }
  return parts.join('')
}
