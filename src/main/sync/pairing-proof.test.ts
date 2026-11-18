// The proofs of a pairing (docs/synchronisation.md §4.4) against the shared vectors: the same HMAC is recomputed on the iPhone by CryptoKit.
import { describe, expect, it } from 'vitest'
import { acceptProof, lengthPrefixed, proofMatches, requestProof, transcription, type ProofInputs } from './pairing-proof'
import { pairingVectors, type ProofInputsVector } from './sync-vectors.test-support'

const fromHex = (hex: string): Buffer => Buffer.from(hex, 'hex')
const inputsOf = (c: ProofInputsVector): ProofInputs => ({ secret: fromHex(c.secret), fingerprintMac: fromHex(c.fpMac), fingerprintPhone: fromHex(c.fpPhone), nonceMac: fromHex(c.nonceMac), noncePhone: fromHex(c.noncePhone), idMac: c.idMac, idPhone: c.idPhone })

describe('the pairing proofs: the vectors of the specification', () => {
  it.each(pairingVectors.proof)('recomputes the proofs of: $name', (c) => {
    const inputs = inputsOf(c)
    expect({ requestTag: requestProof(inputs), acceptTag: acceptProof(inputs) }).toEqual({ requestTag: c.requestTag, acceptTag: c.acceptTag })
  })

  it('writes the two proofs of one exchange differently: a request cannot stand for an accept', () => {
    for (const c of pairingVectors.proof) expect(requestProof(inputsOf(c))).not.toBe(acceptProof(inputsOf(c)))
  })

  it.each(pairingVectors.mutations.cases)('changing $field changes the proofs it takes part in', (m) => {
    const reference = pairingVectors.proof.find((c) => c.name === pairingVectors.mutations.of) as ProofInputsVector
    const inputs = inputsOf({ ...reference, [m.field]: m.value ?? m.valueHex } as ProofInputsVector)
    expect({ requestTag: requestProof(inputs), acceptTag: acceptProof(inputs) }).toEqual({ requestTag: m.requestTag, acceptTag: m.acceptTag })
    expect(requestProof(inputs) !== reference.requestTag).toBe(m.changesRequestTag)
    expect(acceptProof(inputs) !== reference.acceptTag).toBe(m.changesAcceptTag)
  })
})

describe('the transcription', () => {
  it('writes every field after its length on two bytes, big-endian', () => {
    expect(lengthPrefixed(Buffer.from('ab')).toString('hex')).toBe('0002' + '6162')
    expect(transcription('x', [Buffer.from([1, 2, 3])]).toString('hex')).toBe('0001' + '78' + '0003' + '010203')
  })

  it('refuses a field that its length cannot hold, instead of writing a wrong length', () => {
    expect(() => lengthPrefixed(Buffer.alloc(0x10000))).toThrow()
    expect(lengthPrefixed(Buffer.alloc(0xffff)).length).toBe(0xffff + 2)
  })
})

describe('proofMatches', () => {
  const expected = 'A'.repeat(43)

  it('accepts the proof expected, and only it', () => {
    expect(proofMatches(expected, expected)).toBe(true)
    expect(proofMatches('B'.repeat(43), expected)).toBe(false)
    expect(proofMatches(`${'A'.repeat(42)}B`, expected)).toBe(false)
  })

  it('answers false, and does not throw, for a proof of another length or that is not a text', () => {
    expect(proofMatches('A'.repeat(42), expected)).toBe(false)
    expect(proofMatches(`${expected}A`, expected)).toBe(false)
    expect(proofMatches('', expected)).toBe(false)
    for (const received of [undefined, null, 5, {}, [expected]]) expect(proofMatches(received, expected)).toBe(false)
  })
})
