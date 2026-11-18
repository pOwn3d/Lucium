// The code a person compares at a pairing (docs/synchronisation.md §4.6, review n° 9 of the synchronisation). Once the Mac's proof is checked and before anything is kept,
// the iPhone shows « Appairer avec « <Mac> » ? Code : XXXXXX » and the sheet « Autoriser / Refuser » of the Mac shows the same six characters: a person who scanned the
// QR of someone else's Mac, or whose connection is relayed, sees a code that the real Mac does not show.
//
// The code is made of the two fingerprints only (what each device saw in the TLS handshake, not what the other said): the Mac's first, then the iPhone's. A man in the
// middle holds a certificate of his own towards each device, so each side computes from a different pair of fingerprints and the two codes differ. It is not a secret and
// it proves nothing alone: the proofs of §4.4 do; the code lets a person see that both ends agree about who they are talking to.
//
// SHA-256 of the transcription of §4.4 (the label, then each fingerprint after its length), the first 30 bits, written as six characters of the alphabet of the typed code
// (RFC 4648: A–Z and 2–7). The vectors `comparisonCode` of ios/Contracts/sync-pairing-vectors.json are played by this code and by LuciumKit.

import { createHash } from 'node:crypto'
import { FINGERPRINT_BYTES } from './limits'
import { transcription } from './pairing-proof'

const LABEL = 'lucium-sync/1 pair-compare'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** How many characters the code has: thirty bits, enough that a relay cannot have two certificates whose pair gives the code the person is waiting for. */
export const COMPARISON_CODE_CHARS = 6

export function comparisonCode(fingerprintMac: Buffer, fingerprintPhone: Buffer): string {
  if (fingerprintMac.length !== FINGERPRINT_BYTES || fingerprintPhone.length !== FINGERPRINT_BYTES) throw new Error('comparisonCode: a fingerprint is 32 bytes')
  const digest = createHash('sha256').update(transcription(LABEL, [fingerprintMac, fingerprintPhone])).digest()
  // The first 30 bits, five at a time.
  const bits = digest.readUInt32BE(0)
  let code = ''
  for (let index = 0; index < COMPARISON_CODE_CHARS; index++) code += BASE32[(bits >>> (27 - index * 5)) & 31]
  return code
}
