import CryptoKit
import Foundation

/// What the phone shows its person once the Mac's proof is checked, and before anything is kept (docs/synchronisation.md §4.6, review n° 9 of the synchronisation): the
/// name the Mac gave itself and the code to compare with the one on the Mac's sheet « Autoriser / Refuser ».
public struct SyncPairingProposal: Equatable, Sendable {
    public let macName: String
    public let code: String

    /// `macName` is what the Mac wrote about itself, shown as text: a control character or a mark that turns the text round becomes a space, so that a name cannot
    /// disguise the line it is in (the Mac does the same for the name of an iPhone).
    public init(macName: String, code: String) {
        let readable = String(String.UnicodeScalarView(macName.unicodeScalars.map { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: " "
            default: scalar
            }
        })).trimmingCharacters(in: .whitespaces)
        self.macName = readable
        self.code = code
    }
}

/// The code both devices show at a pairing, to be compared by eye. A person who scanned the QR of someone else's Mac sees a code that the real Mac does not show.
///
/// SHA-256 of the transcription of §4.4 (the label, then each fingerprint after its length), the first 30 bits, as six characters of the alphabet of the typed code
/// (RFC 4648: A–Z and 2–7). The fingerprints are the ones each device saw in the TLS handshake, the Mac's first. `comparisonCode` in
/// `ios/Contracts/sync-pairing-vectors.json` fixes the result; the Mac's `pairing-compare.ts` plays the same vectors.
public enum SyncPairingCompare {
    public static let codeCharacters = 6
    /// How long the phone's person has to compare and answer: the Mac gives the same minute, and a refusal (or no answer) keeps nothing on either side.
    public static let personWait: Duration = .seconds(55)
    static let label = "lucium-sync/1 pair-compare"
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    /// The code, or nil for a fingerprint that is not 32 bytes (a code made of something else would compare nothing).
    public static func code(fingerprintMac: Data, fingerprintPhone: Data) -> String? {
        guard fingerprintMac.count == SyncPairingCode.fingerprintBytes, fingerprintPhone.count == SyncPairingCode.fingerprintBytes,
              let transcription = SyncProof.transcription(label, [fingerprintMac, fingerprintPhone]) else { return nil }
        let digest = Array(SHA256.hash(data: transcription))
        let bits = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return String((0..<codeCharacters).map { alphabet[Int((bits >> UInt32(27 - $0 * 5)) & 31)] })
    }
}
