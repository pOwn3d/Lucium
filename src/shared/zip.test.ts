import { describe, expect, it } from 'vitest'
import { createZip, crc32, isSafeEntryName } from './zip'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Reads an archive back the way an unpacker does: from the end, through the central directory. */
function readZip(zip: Uint8Array): Array<{ name: string; data: Uint8Array; crc: number; time: number; date: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = zip.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  expect(view.getUint16(end + 8, true)).toBe(count)
  let central = view.getUint32(end + 16, true)
  expect(central + view.getUint32(end + 12, true)).toBe(end)
  const entries = []
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(central, true)).toBe(0x02014b50)
    const crc = view.getUint32(central + 16, true)
    const size = view.getUint32(central + 24, true)
    expect(view.getUint32(central + 20, true)).toBe(size)
    expect(view.getUint16(central + 10, true)).toBe(0)
    const nameLength = view.getUint16(central + 28, true)
    const local = view.getUint32(central + 42, true)
    const name = new TextDecoder().decode(zip.subarray(central + 46, central + 46 + nameLength))
    expect(view.getUint32(local, true)).toBe(0x04034b50)
    expect(view.getUint16(local + 6, true) & 0x0800).toBe(0x0800)
    expect(view.getUint32(local + 14, true)).toBe(crc)
    const start = local + 30 + view.getUint16(local + 26, true)
    entries.push({ name, data: zip.subarray(start, start + size), crc, time: view.getUint16(central + 12, true), date: view.getUint16(central + 14, true) })
    central += 46 + nameLength
  }
  return entries
}

describe('crc32', () => {
  it('matches the reference values', () => {
    expect(crc32(new Uint8Array())).toBe(0)
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })
})

describe('createZip', () => {
  it('stores every entry with its name, bytes and checksum, in order', () => {
    const png = Uint8Array.from({ length: 300 }, (_, i) => i % 251)
    const zip = createZip([
      { name: 'page.md', data: bytes('# Titre\n\nÉté ☀\n') },
      { name: 'images/image-001.png', data: png },
      { name: 'bilan.txt', data: new Uint8Array() }
    ])
    const entries = readZip(zip)
    expect(entries.map((e) => e.name)).toEqual(['page.md', 'images/image-001.png', 'bilan.txt'])
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('# Titre\n\nÉté ☀\n')
    expect([...entries[1]!.data]).toEqual([...png])
    expect(entries[1]!.crc).toBe(crc32(png))
    expect(entries[2]!.data.length).toBe(0)
  })

  it('dates the entries with the time it is given, and not before 1980', () => {
    const [entry] = readZip(createZip([{ name: 'a', data: bytes('x') }], new Date(2026, 9, 24, 13, 45, 30)))
    expect(entry!.date).toBe(((2026 - 1980) << 9) | (10 << 5) | 24)
    expect(entry!.time).toBe((13 << 11) | (45 << 5) | 15)
    const [old] = readZip(createZip([{ name: 'a', data: bytes('x') }], new Date(1970, 0, 1)))
    expect(old!.date >> 9).toBe(0)
  })

  it('writes an empty archive', () => {
    expect(readZip(createZip([]))).toEqual([])
  })

  it('refuses a name that could write outside the folder it is unpacked in', () => {
    for (const name of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'c:/x', 'a\u0000b', 'a/']) {
      expect(() => createZip([{ name, data: bytes('x') }]), JSON.stringify(name)).toThrow(RangeError)
    }
  })

  it('refuses two entries of the same name, case aside', () => {
    expect(() => createZip([{ name: 'images/a.png', data: bytes('1') }, { name: 'images/A.PNG', data: bytes('2') }])).toThrow(/repeated/)
  })

  it('refuses more entries than the format counts', () => {
    expect(() => createZip(Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array() })))).toThrow(/Too many/)
  })
})

describe('isSafeEntryName', () => {
  it('accepts plain relative paths', () => {
    expect(isSafeEntryName('page.md')).toBe(true)
    expect(isSafeEntryName('images/image-001.png')).toBe(true)
    expect(isSafeEntryName('dossier/é.txt')).toBe(true)
  })
})
