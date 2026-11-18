// The proofs of a pairing (docs/synchronisation.md §4.4): an HMAC-SHA-256, keyed with the secret of the QR, over a transcription written byte by byte. The
// transcription names both fingerprints and both nonces, which ties a proof to *this* TLS connection: an interceptor who presents its own certificate to the
// iPhone cannot make a proof that holds, for want of the secret. Two different labels keep a request proof from standing for an accept proof.
//
// Everything is bytes. A field is written after its length on two bytes, big-endian (`lengthPrefixed`); a string is UTF-8. The vectors of
// ios/Contracts/sync-pairing-vectors.json (`proof`, `mutations`) are played against these functions, and LuciumKit recomputes them with CryptoKit.

import { createHmac, timingSafeEqual } from 'node:crypto'

const REQUEST_LABEL = 'lucium-sync/1 pair-request'
const ACCEPT_LABEL = 'lucium-sync/1 pair-accept'

/** A field after its length on two bytes, big-endian. A field of 64 KiB or more cannot be written: nothing of a pairing is that long, so it is refused loudly. */
export function lengthPrefixed(field: Buffer): Buffer {
  if (field.length > 0xffff) throw new Error('a field of the transcription is longer than 65535 bytes')
  return Buffer.concat([Buffer.from([field.length >> 8, field.length & 0xff]), field])
}

/** The label, then each field, each after its length. */
export function transcription(label: string, fields: readonly Buffer[]): Buffer {
  return Buffer.concat([lengthPrefixed(Buffer.from(label, 'utf8')), ...fields.map(lengthPrefixed)])
}

/** What both proofs are made of: the 32-byte fingerprints, the 16-byte nonces, and the device identifiers (text). */
export interface ProofInputs {
  secret: Buffer
  fingerprintMac: Buffer
  fingerprintPhone: Buffer
  nonceMac: Buffer
  noncePhone: Buffer
  idMac: string
  idPhone: string
}

const tag = (secret: Buffer, data: Buffer): string => createHmac('sha256', secret).update(data).digest('base64url')

/** The proof the iPhone sends in `pair.request`: it does not name the Mac's identifier (the Mac has not told it yet). */
export function requestProof(inputs: ProofInputs): string {
  return tag(inputs.secret, transcription(REQUEST_LABEL, [inputs.fingerprintMac, inputs.fingerprintPhone, inputs.nonceMac, inputs.noncePhone, Buffer.from(inputs.idPhone, 'utf8')]))
}

/** The proof the Mac sends in `pair.accept`: it names both identifiers. */
export function acceptProof(inputs: ProofInputs): string {
  return tag(inputs.secret, transcription(ACCEPT_LABEL, [inputs.fingerprintMac, inputs.fingerprintPhone, inputs.nonceMac, inputs.noncePhone, Buffer.from(inputs.idMac, 'utf8'), Buffer.from(inputs.idPhone, 'utf8')]))
}

/**
 * Whether a proof received is the one expected, compared in constant time. A proof of the wrong length is false (`timingSafeEqual` would throw on it), and so is
 * anything that is not a text.
 */
export function proofMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false
  const given = Buffer.from(received, 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}
