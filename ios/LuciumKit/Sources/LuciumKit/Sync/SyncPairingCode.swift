import Foundation

/// What the Mac's QR says (docs/synchronisation.md §4.2): the fingerprint of its certificate, the secret of this pairing, the port it listens on and the
/// hosts to try, in the order to try them.
public struct SyncPairingCode: Equatable, Sendable {
    public static let maxCharacters = 300
    public static let maxHosts = 4
    public static let secretBytes = 16
    public static let fingerprintBytes = 32

    /// The SHA-256 of the Mac's certificate in DER: the one the connection is pinned to. Nil for a typed code, which does not carry it (§4.3).
    public let fingerprint: Data?
    /// 16 random bytes, good for one pairing and two minutes. Held in memory for the length of the pairing; never written, never logged.
    public let secret: Data
    public let port: UInt16
    public let hosts: [String]

    public init(fingerprint: Data?, secret: Data, port: UInt16, hosts: [String]) {
        self.fingerprint = fingerprint
        self.secret = secret
        self.port = port
        self.hosts = hosts
    }

    /// Reads the one line of text of a QR: `lucium-sync:1/<fingerprint>/<secret>/<port>/<hosts>`. The reading is strict, and a text that is anything else is
    /// refused whole (`invalid-code`); a version of the code other than 1 is `unsupported-version`, so that the person is told to update, not to scan again.
    /// There is no URL in it on purpose: a URL parser does not read the same thing in Swift and in JavaScript.
    public static func parse(qr text: String) -> Result<SyncPairingCode, SyncFailure> {
        let invalid = Result<SyncPairingCode, SyncFailure>.failure(SyncFailure(.invalidCode, "the text is not a pairing code"))
        guard text.utf16.count <= maxCharacters, text.hasPrefix("lucium-sync:") else { return invalid }
        let rest = text.dropFirst("lucium-sync:".count)
        guard let slash = rest.firstIndex(of: "/") else { return invalid }
        let version = rest[rest.startIndex..<slash]
        guard !version.isEmpty, version.allSatisfy({ $0.isASCII && $0.isNumber }), version == "1" || !version.hasPrefix("0") else { return invalid }
        guard version == "1" else { return .failure(SyncFailure(.unsupportedVersion, "pairing code version \(version.prefix(10))")) }
        let parts = rest[rest.index(after: slash)...].split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return invalid }
        guard let fingerprint = SyncEncoding.base64urlDecode(String(parts[0]), characters: 43),
              let secret = SyncEncoding.base64urlDecode(String(parts[1]), characters: 22) else { return invalid }
        let portText = parts[2]
        guard (1...5).contains(portText.count), portText.allSatisfy({ $0.isASCII && $0.isNumber }), !portText.hasPrefix("0"), let port = UInt16(portText) else { return invalid }
        let hosts = parts[3].split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        guard (1...maxHosts).contains(hosts.count), hosts.allSatisfy({ $0 == $0.lowercased() && SyncAddress.isLocal($0) }) else { return invalid }
        return .success(SyncPairingCode(fingerprint: fingerprint, secret: secret, port: port, hosts: hosts))
    }

    /// Reads the code typed when there is no camera (§4.3): 26 characters of the base32 alphabet, in any case, with spaces and dashes ignored. It carries the
    /// secret only: the host and the port are typed beside it, and the fingerprint is learnt from the connection and checked by the Mac's proof.
    public static func parse(typedCode input: String, host: String, port: Int) -> Result<SyncPairingCode, SyncFailure> {
        let invalid = Result<SyncPairingCode, SyncFailure>.failure(SyncFailure(.invalidCode, "the typed code is not a pairing code"))
        guard let secret = parseSecret(typedCode: input), (1...65535).contains(port) else { return invalid }
        let cleaned = host.trimmingCharacters(in: .whitespaces).lowercased()
        guard SyncAddress.isLocal(cleaned) else { return invalid }
        return .success(SyncPairingCode(fingerprint: nil, secret: secret, port: UInt16(port), hosts: [cleaned]))
    }

    /// The secret of a typed code, or nil when it is not one.
    public static func parseSecret(typedCode input: String) -> Data? {
        let text = String(input.filter { !$0.isWhitespace && $0 != "-" }).uppercased()
        guard text.allSatisfy({ $0.isASCII }) else { return nil }
        return SyncEncoding.base32DecodeSecret(text)
    }

    /// What the Mac writes under its QR: `name.local:49213` or `10.0.0.7:49213`. Read by the field of the typed code, which takes the host and the port
    /// in one piece. An IPv6 address needs its brackets (`[fd12::1]:49213`).
    public static func parse(address text: String) -> (host: String, port: Int)? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("[") {
            guard let close = trimmed.firstIndex(of: "]") else { return nil }
            let host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let tail = trimmed[trimmed.index(after: close)...]
            guard tail.hasPrefix(":"), let port = Int(tail.dropFirst()) else { return nil }
            return (host, port)
        }
        guard let colon = trimmed.lastIndex(of: ":"), trimmed.firstIndex(of: ":") == colon, let port = Int(trimmed[trimmed.index(after: colon)...]) else { return nil }
        return (String(trimmed[trimmed.startIndex..<colon]), port)
    }
}
