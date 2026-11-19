import CryptoKit
import Foundation

/// The commitment of the phone at a pairing (docs/synchronisation.md §4.7, review n° 36 of the synchronisation).
///
/// The code both devices show (`SyncPairingCompare`) is only worth 30 bits if nobody can pick the values it is made of after seeing the other side's. The phone
/// therefore commits to its fingerprint and to a code nonce it keeps to itself, in `pair.request`; the Mac answers with its own code nonce only after a right proof
/// (`pair.nonce`); the phone then reveals its nonce (`pair.reveal`) and the Mac checks that it opens the commitment. A relay between them has one try at 2^-30 per
/// pairing, because each side's last value is drawn after the relay has fixed the other session's.
///
/// SHA-256 of the transcription of §4.4 (the label, the fingerprint, the nonce, each after its length): 32 bytes, written in base64url on the wire. The vectors
/// `commitments` of `ios/Contracts/sync-pairing-vectors.json` fix the result; the Mac's `pairing-commit.ts` plays the same vectors.
public enum SyncPairingCommit {
    public static let commitBytes = 32
    public static let codeNonceBytes = 16
    static let label = "lucium-sync/1 pair-commit"

    /// The commitment, or nil for a fingerprint that is not 32 bytes or a nonce that is not 16 (a commitment made of something else would commit to nothing).
    public static func commitment(fingerprintPhone: Data, nonce: Data) -> Data? {
        guard fingerprintPhone.count == SyncPairingCode.fingerprintBytes, nonce.count == codeNonceBytes,
              let transcription = SyncProof.transcription(label, [fingerprintPhone, nonce]) else { return nil }
        return Data(SHA256.hash(data: transcription))
    }
}
