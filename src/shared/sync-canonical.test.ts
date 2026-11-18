// The canonical form (sync-canonical.ts) and the order of the marks (sync-snapshot.ts), played against the vectors of ios/Contracts/sync-message-vectors.json
// that LuciumKit plays too (`canonical` and `stamps`): one file, two implementations.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, compareUtf16, sameJson } from './sync-canonical'
import { compareStamps, isStamp, maxStamp, minStamp, ZERO_STAMP } from './sync-snapshot'

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-message-vectors.json'), 'utf8')) as {
  canonical: { name: string; value: unknown; canonical: string; sha256Hex: string }[]
  stamps: { a: string; b: string; expect: -1 | 0 | 1 }[]
}

describe('sync canonical form (docs/synchronisation.md §8.4)', () => {
  it.each(vectors.canonical)('writes the vector: $name', (v) => {
    expect(canonicalJson(v.value)).toBe(v.canonical)
    expect(createHash('sha256').update(v.canonical, 'utf8').digest('hex')).toBe(v.sha256Hex)
  })

  it('sorts the keys by UTF-16 code unit, not by the bytes of UTF-8', () => {
    // U+1F600 is D83D DE00 in UTF-16 and F0… in UTF-8; U+FF5E is FF5E and EF… : the two orders disagree on these two.
    expect(canonicalJson({ '～': 1, '😀': 2 })).toBe('{"😀":2,"～":1}')
  })

  it('leaves out a member that is undefined, as JSON does, and writes -0 as 0', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(canonicalJson([-0])).toBe('[0]')
  })

  it('refuses what has no JSON text, instead of writing a text the two devices would not write alike', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson(Infinity)).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
    expect(() => canonicalJson(10n)).toThrow(TypeError)
  })

  it('compares values by their canonical text: the order of the keys does not matter, the order of a list does', () => {
    expect(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
    expect(sameJson([1, 2], [2, 1])).toBe(false)
    expect(sameJson(undefined, undefined)).toBe(true)
    expect(sameJson(undefined, null)).toBe(false)
    expect(sameJson(1, 1.0)).toBe(true)
    expect(sameJson('1', 1)).toBe(false)
    expect(sameJson({}, [])).toBe(false)
  })
})

describe('sync marks (docs/synchronisation.md §9.2)', () => {
  it.each(vectors.stamps.map((v) => [`${v.a} ? ${v.b}`, v] as const))('compares %s', (_label, v) => {
    expect(compareStamps(v.a, v.b)).toBe(v.expect)
    expect(compareStamps(v.b, v.a)).toBe(v.expect === 0 ? 0 : -v.expect)
  })

  it('has the greater and the smaller of marks, and "0" below every other', () => {
    const a = '1790000000001-0000-mac'
    const b = '1790000000001-0000-phone'
    expect(maxStamp(a, b)).toBe(b)
    expect(minStamp([b, a])).toBe(a)
    expect(maxStamp()).toBe(ZERO_STAMP)
    expect(minStamp([])).toBe(ZERO_STAMP)
    expect(minStamp([a, ZERO_STAMP])).toBe(ZERO_STAMP)
    expect(compareStamps(ZERO_STAMP, '0000000000000-0000-a')).toBe(-1)
  })

  it('reads a mark only in the form of the specification', () => {
    expect(isStamp('1790000000001-0000-mac')).toBe(true)
    expect(isStamp('0')).toBe(true)
    for (const bad of ['', '00', '1790000000001-0000', '179000000001-0000-mac', '1790000000001-000G-mac', '1790000000001-0000-', '1790000000001-0000-a b', '1790000000001-0000-' + 'a'.repeat(65), 5, null, undefined]) {
      expect(isStamp(bad), String(bad)).toBe(false)
    }
  })

  it('orders two strings by UTF-16 code unit', () => {
    expect(compareUtf16('a', 'b')).toBe(-1)
    expect(compareUtf16('b', 'a')).toBe(1)
    expect(compareUtf16('a', 'a')).toBe(0)
    expect(compareUtf16('😀', '～')).toBe(-1)
  })
})
