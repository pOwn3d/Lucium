import { describe, expect, it } from 'vitest'
import { encodeBase32, type TotpAlgorithm } from '@shared/totp'
import { totpAt } from './totp'

// RFC 6238 appendix B: the keys are ASCII strings of the length of the hash (20, 32 and 64 bytes), 8 digits, a period of 30 s.
const KEYS: Record<TotpAlgorithm, string> = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234'
}
const configOf = (algorithm: TotpAlgorithm, digits = 8, period = 30) => ({ secret: encodeBase32(new TextEncoder().encode(KEYS[algorithm])), algorithm, digits, period })

const VECTORS: Array<[number, Record<TotpAlgorithm, string>]> = [
  [59, { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' }],
  [1111111109, { SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' }],
  [1111111111, { SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' }],
  [1234567890, { SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' }],
  [2000000000, { SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' }],
  [20000000000, { SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' }]
]

describe('the code of RFC 6238', () => {
  for (const [seconds, expected] of VECTORS) {
    for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
      it(`is ${expected[algorithm]} with ${algorithm} at ${seconds} s (appendix B)`, () => {
        expect(totpAt(configOf(algorithm), seconds * 1000).code).toBe(expected[algorithm])
      })
    }
  }

  it('is the 6 last digits of the 8 of the vector, the way the RFC 4226 truncation says (the base32 of the SHA-1 key is the usual one)', () => {
    // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ is the base32 of "12345678901234567890", the example key of the authenticator apps.
    expect(configOf('SHA1').secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(totpAt(configOf('SHA1', 6), 59_000).code).toBe('287082')
  })

  it('keeps the leading zeros', () => {
    expect(totpAt(configOf('SHA1'), 1111111109_000).code).toBe('07081804')
  })

  it('counts the seconds left in the period, from the period down to 1', () => {
    expect(totpAt(configOf('SHA1'), 60_000).secondsLeft).toBe(30)
    expect(totpAt(configOf('SHA1'), 60_999).secondsLeft).toBe(30)
    expect(totpAt(configOf('SHA1'), 89_000).secondsLeft).toBe(1)
    expect(totpAt(configOf('SHA1', 6, 60), 61_000).secondsLeft).toBe(59)
  })

  it('does not change inside a period and changes at its edge', () => {
    const at = (ms: number) => totpAt(configOf('SHA1'), ms).code
    expect(at(30_000)).toBe(at(59_999))
    expect(at(59_999)).not.toBe(at(60_000))
  })

  it('follows the period of the key: a period of 60 s gives one code for the 2 half-minutes of a minute', () => {
    expect(totpAt(configOf('SHA1', 6, 60), 60_000).code).toBe(totpAt(configOf('SHA1', 6, 60), 119_000).code)
    expect(totpAt(configOf('SHA1', 6, 60), 119_000).code).not.toBe(totpAt(configOf('SHA1', 6, 30), 119_000).code)
  })

  it('refuses a clock that is not a time, and says nothing of the key', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => totpAt(configOf('SHA1'), bad)).toThrow('the time is not a time')
    }
    expect(() => totpAt({ ...configOf('SHA1'), secret: '1!' }, 0)).toThrow('the key is not base32')
  })
})
