import CryptoKit
import Foundation

/// The two proofs of a pairing (docs/synchronisation.md §4.4): an HMAC-SHA-256, keyed by the secret of the QR, over a transcription that names both
/// fingerprints, both nonces and the identifiers. A proof is therefore good for one pair of certificates and one connection: a man in the middle who
/// shows the phone his own certificate cannot make a proof the Mac's secret would have made.
///
/// Every field is written after its length on two bytes, big-endian; a text is its UTF-8. The label differs between the two proofs, so that a request cannot
/// pass for an accept. `ios/Contracts/sync-pairing-vectors.json` holds the bytes: the Mac's TypeScript recomputes the same tags.
public struct SyncProofInputs: Equatable, Sendable {
    public var secret: Data
    public var fingerprintMac: Data
    public var fingerprintPhone: Data
    public var nonceMac: Data
    public var noncePhone: Data
    public var idMac: String
    public var idPhone: String

    public init(secret: Data, fingerprintMac: Data, fingerprintPhone: Data, nonceMac: Data, noncePhone: Data, idMac: String, idPhone: String) {
        self.secret = secret
        self.fingerprintMac = fingerprintMac
        self.fingerprintPhone = fingerprintPhone
        self.nonceMac = nonceMac
        self.noncePhone = noncePhone
        self.idMac = idMac
        self.idPhone = idPhone
    }
}

public enum SyncProof {
    static let requestLabel = "lucium-sync/1 pair-request"
    static let acceptLabel = "lucium-sync/1 pair-accept"

    /// `label` then the fields, each after its length on two bytes. A field longer than 65535 bytes cannot be written: the identifiers it is made of are
    /// bounded long before (64 characters), so this is a refusal, not a case.
    static func transcription(_ label: String, _ fields: [Data]) -> Data? {
        var out = Data()
        for field in [Data(label.utf8)] + fields {
            guard field.count <= 0xffff else { return nil }
            out.append(UInt8(field.count >> 8))
            out.append(UInt8(field.count & 0xff))
            out.append(field)
        }
        return out
    }

    private static func requestTranscription(_ i: SyncProofInputs) -> Data? {
        transcription(requestLabel, [i.fingerprintMac, i.fingerprintPhone, i.nonceMac, i.noncePhone, Data(i.idPhone.utf8)])
    }

    private static func acceptTranscription(_ i: SyncProofInputs) -> Data? {
        transcription(acceptLabel, [i.fingerprintMac, i.fingerprintPhone, i.nonceMac, i.noncePhone, Data(i.idMac.utf8), Data(i.idPhone.utf8)])
    }

    /// What the phone sends in `pair.request`.
    public static func requestTag(_ inputs: SyncProofInputs) -> Data? {
        requestTranscription(inputs).map { Data(HMAC<SHA256>.authenticationCode(for: $0, using: SymmetricKey(data: inputs.secret))) }
    }

    /// What the Mac answers in `pair.accept`.
    public static func acceptTag(_ inputs: SyncProofInputs) -> Data? {
        acceptTranscription(inputs).map { Data(HMAC<SHA256>.authenticationCode(for: $0, using: SymmetricKey(data: inputs.secret))) }
    }

    /// Whether the Mac's proof is the right one, compared in constant time (CryptoKit's own check): the length of the common prefix of a wrong tag must
    /// not be learnable from how long the answer takes.
    public static func isValidAccept(_ tag: Data, for inputs: SyncProofInputs) -> Bool {
        guard let transcription = acceptTranscription(inputs) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(tag, authenticating: transcription, using: SymmetricKey(data: inputs.secret))
    }
}
