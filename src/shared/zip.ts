// A ZIP archive written by hand: stored entries (no compression, the images in it are compressed already), UTF-8 names, CRC-32.
// Enough for an export of a page and its images; no ZIP64, so an archive is at most 65 535 entries and 4 GiB.

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff

// Stricter than the reader's (engine/crx-scan.ts) on purpose: this writes file entries only, so it refuses the empty parts of a folder entry ("a/") and every colon.
/** A name that cannot write outside the folder the archive is unpacked in, and that two entries cannot share (macOS folders ignore case). */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || /[:\u0000-\u001f\u007f]/.test(name)) return false
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** MS-DOS date and time as two 16-bit words; the format starts in 1980. */
function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(when.getFullYear(), 1980)
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  }
}

/** The archive holding `entries`, in order. Throws a RangeError for a name that is unsafe or repeated, or an archive too big for the format. */
export function createZip(entries: readonly ZipEntry[], when: Date = new Date()): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new RangeError('Too many entries for a ZIP archive')
  const encoder = new TextEncoder()
  const stamp = dosStamp(when)
  const seen = new Set<string>()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  let centralSize = 0
  for (const { name, data } of entries) {
    const key = name.toLowerCase()
    if (!isSafeEntryName(name) || seen.has(key)) throw new RangeError(`Unsafe or repeated entry name: ${JSON.stringify(name)}`)
    seen.add(key)
    const nameBytes = encoder.encode(name)
    if (nameBytes.length > 0xffff || offset + 30 + nameBytes.length + data.length > MAX_BYTES) throw new RangeError('Archive too big for the ZIP format')
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(10, stamp.time, true)
    lv.setUint16(12, stamp.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(12, stamp.time, true)
    cv.setUint16(14, stamp.date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
    centralSize += central.length
  }
  if (offset + centralSize + 22 > MAX_BYTES) throw new RangeError('Archive too big for the ZIP format')
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + end.length)
  let position = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, position)
    position += part.length
  }
  return out
}
