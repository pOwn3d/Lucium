// The commitment of the iPhone at a pairing (docs/synchronisation.md §4.7, review n° 36): the vectors it shares with LuciumKit, and what makes it a commitment.
import { describe, expect, it } from 'vitest'
import { commitmentOpens, pairingCommitment } from './pairing-commit'
import { pairingVectors } from './sync-vectors.test-support'

const PHONE = Buffer.alloc(32, 0x22)
const NONCE = Buffer.alloc(16, 0x44)
const hex = (value: string): Buffer => Buffer.from(value, 'hex')

describe('pairingCommitment: the vectors shared with the iPhone', () => {
  it('has the sizes the vectors state', () => {
    expect(pairingVectors.constants.commitBytes).toBe(Buffer.from(pairingCommitment(PHONE, NONCE), 'base64url').length)
    expect(pairingVectors.constants.codeNonceBytes).toBe(NONCE.length)
  })

  it.each(pairingVectors.commitments)('$name', ({ fpPhone, nonceCodePhone, commit }) => {
    expect(pairingCommitment(hex(fpPhone), hex(nonceCodePhone))).toBe(commit)
    expect(commitmentOpens(commit, hex(fpPhone), hex(nonceCodePhone))).toBe(true)
  })
})

describe('commitmentOpens: what makes it a commitment', () => {
  const commit = pairingCommitment(PHONE, NONCE)

  it('opens with the fingerprint and the nonce it was made of, and with nothing else', () => {
    expect(commitmentOpens(commit, PHONE, NONCE)).toBe(true)
    const otherNonce = Buffer.from(NONCE)
    otherNonce[3] = (otherNonce[3] as number) ^ 0x01
    expect(commitmentOpens(commit, PHONE, otherNonce)).toBe(false)
    const otherPhone = Buffer.from(PHONE)
    otherPhone[31] = (otherPhone[31] as number) ^ 0x01
    expect(commitmentOpens(commit, otherPhone, NONCE)).toBe(false)
  })

  it('does not open for a nonce of the wrong size, and does not throw on a commitment that is not one', () => {
    expect(commitmentOpens(commit, PHONE, Buffer.alloc(15))).toBe(false)
    expect(commitmentOpens('', PHONE, NONCE)).toBe(false)
    expect(commitmentOpens(`${commit}A`, PHONE, NONCE)).toBe(false)
  })

  it('refuses to commit to what is not a fingerprint of 32 bytes and a nonce of 16', () => {
    expect(() => pairingCommitment(Buffer.alloc(31), NONCE)).toThrow()
    expect(() => pairingCommitment(PHONE, Buffer.alloc(17))).toThrow()
  })
})
