// The code both devices show at a pairing, to be compared by eye (docs/synchronisation.md §4.6, review n° 9): derived from the two fingerprints, the same on both sides.
import { describe, expect, it } from 'vitest'
import { COMPARISON_CODE_CHARS, comparisonCode } from './pairing-compare'
import { pairingVectors } from './sync-vectors.test-support'

const MAC = Buffer.alloc(32, 0x11)
const PHONE = Buffer.alloc(32, 0x22)

describe('comparisonCode: the vectors shared with the iPhone', () => {
  it('has the length the vectors state', () => {
    expect(COMPARISON_CODE_CHARS).toBe(pairingVectors.constants.comparisonCodeChars)
  })

  it.each(pairingVectors.comparisonCode)('$name', ({ fpMac, fpPhone, code }) => {
    expect(comparisonCode(Buffer.from(fpMac, 'hex'), Buffer.from(fpPhone, 'hex'))).toBe(code)
  })
})

describe('comparisonCode: what makes it worth comparing', () => {
  it('is six characters of the alphabet of the typed code, A to Z and 2 to 7 (no 0, 1, 8 or 9 to mistake for a letter)', () => {
    for (const code of pairingVectors.comparisonCode.map((one) => one.code)) expect(code).toMatch(/^[A-Z2-7]{6}$/)
  })

  it('depends on the Mac fingerprint and on the iPhone one, and on which is which', () => {
    const base = comparisonCode(MAC, PHONE)
    expect(comparisonCode(PHONE, MAC)).not.toBe(base)
    for (const at of [0, 15, 31]) {
      const otherMac = Buffer.from(MAC)
      otherMac[at] = (otherMac[at] as number) ^ 0x01
      const otherPhone = Buffer.from(PHONE)
      otherPhone[at] = (otherPhone[at] as number) ^ 0x01
      expect(comparisonCode(otherMac, PHONE), `a bit of byte ${at} of the Mac's`).not.toBe(base)
      expect(comparisonCode(MAC, otherPhone), `a bit of byte ${at} of the iPhone's`).not.toBe(base)
    }
  })

  it('refuses a fingerprint that is not 32 bytes: a code made of something else would compare nothing', () => {
    expect(() => comparisonCode(Buffer.alloc(31), PHONE)).toThrow()
    expect(() => comparisonCode(MAC, Buffer.alloc(33))).toThrow()
  })
})
