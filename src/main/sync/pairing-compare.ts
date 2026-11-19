// The code a person compares at a pairing (docs/synchronisation.md §4.6, review n° 9 of the synchronisation). Once the Mac's proof is checked and before anything is kept,
// the iPhone shows « Appairer avec « <Mac> » ? Code : XXXXXX » and the sheet « Autoriser / Refuser » of the Mac shows the same six characters: a person who scanned the
// QR of someone else's Mac, or whose connection is relayed, sees a code that the real Mac does not show.
//
// The code is made of the two fingerprints (what each device saw in the TLS handshake, not what the other said: the Mac's first, then the iPhone's) AND of the two code
// nonces of the commitment exchange (pairing-commit.ts, §4.7, review n° 36). The fingerprints alone let a relay who holds the real QR vary its own certificates until two
// of them gave the same code on both sides (80 000 tries a side, measured); the nonces are drawn after the other side is committed, so the relay has one try, at 2^-30.
// It is not a secret and it proves nothing alone: the proofs of §4.4 do; the code lets a person see that both ends agree about who they are talking to.
//
// SHA-256 of the transcription of §4.4 (the label, then the two fingerprints and the two nonces, each after its length), the first 30 bits, written as six characters of the
// alphabet of the typed code (RFC 4648: A–Z and 2–7). The vectors `comparisonCode` of ios/Contracts/sync-pairing-vectors.json are played by this code and by LuciumKit.

import { createHash } from 'node:crypto'
import { CODE_NONCE_BYTES, FINGERPRINT_BYTES } from './limits'
import { transcription } from './pairing-proof'

const LABEL = 'lucium-sync/1 pair-code'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** How many characters the code has: thirty bits: with the commitment of §4.7 a relay has one try at 2^-30, not a search. */
export const COMPARISON_CODE_CHARS = 6

export function comparisonCode(fingerprintMac: Buffer, fingerprintPhone: Buffer, nonceMac: Buffer, noncePhone: Buffer): string {
  if (fingerprintMac.length !== FINGERPRINT_BYTES || fingerprintPhone.length !== FINGERPRINT_BYTES) throw new Error('comparisonCode: a fingerprint is 32 bytes')
  if (nonceMac.length !== CODE_NONCE_BYTES || noncePhone.length !== CODE_NONCE_BYTES) throw new Error('comparisonCode: a code nonce is 16 bytes')
  const digest = createHash('sha256').update(transcription(LABEL, [fingerprintMac, fingerprintPhone, nonceMac, noncePhone])).digest()
  // The first 30 bits, five at a time.
  const bits = digest.readUInt32BE(0)
  let code = ''
  for (let index = 0; index < COMPARISON_CODE_CHARS; index++) code += BASE32[(bits >>> (27 - index * 5)) & 31]
  return code
}
