import Foundation

/// The catalogue of what can go wrong in a synchronisation (docs/synchronisation.md §7.6). The same codes, in the same words, on the Mac and on the
/// phone: `ios/Contracts/sync-message-vectors.json` lists them, and `src/shared/ios-sync-contract.test.ts` holds the TypeScript side of the list.
public enum SyncErrorCode: String, CaseIterable, Equatable, Sendable {
    case badFrame = "bad-frame"
    case tooLarge = "too-large"
    case badMessage = "bad-message"
    case unknownType = "unknown-type"
    case badSequence = "bad-sequence"
    case unsupportedVersion = "unsupported-version"
    case invalidCode = "invalid-code"
    case notPaired = "not-paired"
    case fingerprintMismatch = "fingerprint-mismatch"
    case badProof = "bad-proof"
    case pairingExpired = "pairing-expired"
    case pairingUsed = "pairing-used"
    case pairingLocked = "pairing-locked"
    case pairingClosed = "pairing-closed"
    case pairingRefused = "pairing-refused"
    case rateLimited = "rate-limited"
    case timeout
    case busy
    case locked
    case stateTooNew = "state-too-new"
    case truncated
    case divergence
    case clockSkew = "clock-skew"
    case `internal`

    /// A fatal code closes the connection; `clock-skew` is a warning that lets the session go on (§7.6).
    public var isFatal: Bool { self != .clockSkew }
}

/// A synchronisation that stopped, with the code the person is told about and what happened for the log. The detail is English, written for a developer,
/// and never shown to the person (§7.3): it may name a state of the connection, never a secret, a host or a fingerprint.
public struct SyncFailure: Error, Equatable, Sendable {
    public let code: SyncErrorCode
    public let detail: String

    public init(_ code: SyncErrorCode, _ detail: String = "") {
        self.code = code
        self.detail = detail
    }

    /// What a Mac that already knows this phone does at a pairing: it takes the connection for a session and says `hello` where the phone waits for `pair.challenge` (card 652).
    /// It is `bad-message` on the wire (the catalogue of §7.6 has no code for it), told apart by this detail so that the application can say what to do (`isHelloInAPairing`).
    public static let helloInAPairing = "hello where pair.challenge was expected: the Mac already knows this phone"
    public var isHelloInAPairing: Bool { code == .badMessage && detail == Self.helloInAPairing }
}

/// Where the connection to the Mac stopped before any message could say why. Not a code of the protocol: there was nobody to send it.
public enum SyncReachFailure: Equatable, Sendable {
    /// No address of the Mac answered: it is off, away from this network, or not listening (§8.1).
    case unreachable
    /// The person refused Lucium the local network in the settings of iOS: a connection to a local address cannot be made.
    case localNetworkDenied
    /// The Mac is on this network and refused the connection: it does not listen (Lucium closed or locked there, §8.1). Not an error.
    case refused
    /// An address answered with a certificate that is not the one pinned.
    case fingerprintMismatch
}
