// The commitment of the iPhone at a pairing (docs/synchronisation.md §4.7, review n° 36 of the synchronisation).
//
// The code a person compares (pairing-compare.ts) is only worth 30 bits if nobody can pick the values it is made of after seeing the other side's. The iPhone therefore
// commits to its fingerprint and to a code nonce it keeps to itself, in `pair.request`; the Mac answers with its own code nonce only after a right proof (`pair.nonce`);
// the iPhone then reveals its nonce (`pair.reveal`) and the Mac checks that it opens the commitment. Both sides then compute the code from the two fingerprints and the
// two nonces. A relay between them has one try at 2^-30 per pairing, because each side's last value is drawn after the relay has fixed the other session's.
//
// The commitment names the fingerprint the Mac SAW in the TLS handshake, not one the iPhone would announce: a commitment relayed from another iPhone does not open.
//
// SHA-256 of the transcription of §4.4 (label, fingerprint, nonce, each after its length), written in base64url without padding (43 characters).
// The vectors `commitments` of ios/Contracts/sync-pairing-vectors.json are played by this code and by LuciumKit.

import { createHash, timingSafeEqual } from 'node:crypto'
import { CODE_NONCE_BYTES, FINGERPRINT_BYTES } from './limits'
import { transcription } from './pairing-proof'

const LABEL = 'lucium-sync/1 pair-commit'

/** The commitment of an iPhone whose certificate has this fingerprint, to this code nonce. */
export function pairingCommitment(fingerprintPhone: Buffer, noncePhone: Buffer): string {
  if (fingerprintPhone.length !== FINGERPRINT_BYTES) throw new Error('pairingCommitment: a fingerprint is 32 bytes')
  if (noncePhone.length !== CODE_NONCE_BYTES) throw new Error('pairingCommitment: a code nonce is 16 bytes')
  return createHash('sha256').update(transcription(LABEL, [fingerprintPhone, noncePhone])).digest('base64url')
}

/** Whether a nonce revealed opens the commitment received, compared in constant time; anything but 16 bytes does not open it. */
export function commitmentOpens(received: string, fingerprintPhone: Buffer, noncePhone: Buffer): boolean {
  if (noncePhone.length !== CODE_NONCE_BYTES) return false
  const given = Buffer.from(received, 'utf8')
  const wanted = Buffer.from(pairingCommitment(fingerprintPhone, noncePhone), 'utf8')
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}
