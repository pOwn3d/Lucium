import CryptoKit
import Foundation
import LuciumKit
import Network
import Security

/// The only code of the application that opens a connection of its own (docs/synchronisation.md §6.4): a TLS 1.3 connection to the Mac that the phone is paired
/// with, on the local network, with both certificates and the Mac's pinned. It is made only when the person has turned the synchronisation on, by a pairing
/// they started or a session the settings allow (`SyncController`); nothing else in the application imports `Network`.
///
/// What it fixes, in order: the address has already been through the local filter (`SyncReacher`, and again here); TLS 1.3 is the least that is offered; the
/// phone shows its own identity; the ALPN is `lucium-sync/1`; and the verification of the Mac's certificate is not left to the system (the certificate is
/// self-signed and no authority would vouch for it): a block of ours takes the SHA-256 of the certificate the Mac shows and says yes only when it is the
/// pinned one. With a typed code there is nothing to pin yet: the block keeps what it saw and the proof of the pairing decides.
/// `SecIdentity` is a reference to an immutable keychain item, safe to use from any thread; the compiler cannot know that of a Core Foundation type.
struct NetworkSyncConnector: SyncConnecting, @unchecked Sendable {
    let identity: SecIdentity
    /// Tests only: the loopback is what a test server can be reached by. The application never sets it.
    var allowsLoopback = false

    static let alpn = "lucium-sync/1"

    func connect(host: String, port: UInt16, pin: SyncPin, timeout: Duration) async throws -> SyncConnection {
        guard allowsLoopback || SyncAddress.isLocal(host) else { throw SyncConnectError.failed("not a local address") }
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw SyncConnectError.failed("no port") }
        let seen = SeenCertificate()
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: Self.parameters(identity: identity, pin: pin, seen: seen))
        let transport = NetworkSyncTransport(connection)
        do {
            try await transport.start(timeout: timeout)
        } catch {
            transport.close()
            // A handshake that our own block refused is a certificate that is not the pinned one, whatever the system then says of it.
            if seen.mismatched { throw SyncConnectError.fingerprintMismatch }
            throw error
        }
        guard let presented = seen.fingerprint else {
            transport.close()
            throw SyncConnectError.failed("the handshake ended without a certificate")
        }
        if case .fingerprint(let expected) = pin, expected != presented {
            transport.close()
            throw SyncConnectError.fingerprintMismatch
        }
        return SyncConnection(transport: transport, presentedFingerprint: presented)
    }

    static func parameters(identity: SecIdentity, pin: SyncPin, seen: SeenCertificate) -> NWParameters {
        let tls = NWProtocolTLS.Options()
        let options = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(options, .TLSv13)
        sec_protocol_options_add_tls_application_protocol(options, alpn)
        if let local = sec_identity_create(identity) { sec_protocol_options_set_local_identity(options, local) }
        sec_protocol_options_set_peer_authentication_required(options, true)
        sec_protocol_options_set_verify_block(options, { metadata, _, complete in
            var first: Data?
            _ = sec_protocol_metadata_access_peer_certificate_chain(metadata) { certificate in
                if first == nil { first = SecCertificateCopyData(sec_certificate_copy_ref(certificate).takeRetainedValue()) as Data }
            }
            guard let der = first else {
                complete(false)
                return
            }
            let fingerprint = SyncCertificate.fingerprint(of: der)
            seen.record(fingerprint)
            if case .fingerprint(let expected) = pin, expected != fingerprint {
                seen.markMismatch()
                complete(false)
            } else {
                complete(true)
            }
        }, DispatchQueue(label: "app.lucium.sync.verify"))
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 10
        return NWParameters(tls: tls, tcp: tcp)
    }
}

/// What the verification block saw of the Mac's certificate, handed to the code that waits for the connection.
final class SeenCertificate: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: Data?
    private var refused = false

    var fingerprint: Data? { lock.withLock { seen } }
    var mismatched: Bool { lock.withLock { refused } }
    func record(_ fingerprint: Data) { lock.withLock { seen = fingerprint } }
    func markMismatch() { lock.withLock { refused = true } }
}

/// A `NWConnection` as the protocol's transport: whole reads and writes, one at a time, and a close that ends whatever waits.
final class NetworkSyncTransport: SyncTransport, @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "app.lucium.sync.connection")

    init(_ connection: NWConnection) { self.connection = connection }

    /// Waits for the handshake to be done, at most `timeout`. What the system says while it waits is told apart: a refusal (the Mac is there and nobody
    /// listens), the local network that iOS did not allow, and a silence.
    func start(timeout: Duration) async throws {
        let milliseconds = Int(timeout.components.seconds) * 1000 + Int(timeout.components.attoseconds / 1_000_000_000_000_000)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = Once()
            let finish: @Sendable (Result<Void, Error>) -> Void = { result in
                guard once.take() else { return }
                continuation.resume(with: result)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(.success(()))
                case .failed(let error): finish(.failure(Self.reason(of: error)))
                case .cancelled: finish(.failure(SyncConnectError.failed("cancelled")))
                case .waiting(let error):
                    // The system waits for a better path instead of failing; a refusal or a denial will not get better by waiting.
                    let reason = Self.reason(of: error)
                    if reason == .refused || reason == .localNetworkDenied { finish(.failure(reason)) }
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + .milliseconds(milliseconds)) { finish(.failure(SyncConnectError.timedOut)) }
        }
    }

    /// What an error of the system means for a connection to the Mac. Not every case is known; what is not is "failed", which is treated as "did not answer".
    static func reason(of error: NWError) -> SyncConnectError {
        switch error {
        case .posix(let code) where code == .ECONNREFUSED: .refused
        case .posix(let code) where code == .ETIMEDOUT: .timedOut
        case .dns(let code) where code == DNSServiceErrorType(kDNSServiceErr_PolicyDenied) || code == DNSServiceErrorType(kDNSServiceErr_NoAuth): .localNetworkDenied
        default: .failed("\(error)")
        }
    }

    func send(_ bytes: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: bytes, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: SyncConnectError.failed("send: \(error)")) } else { continuation.resume() }
            })
        }
    }

    func receive() async throws -> Data {
        while true {
            let chunk: Data? = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data?, Error>) in
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
                    if let error {
                        continuation.resume(throwing: SyncConnectError.failed("receive: \(error)"))
                    } else if let data, !data.isEmpty {
                        continuation.resume(returning: data)
                    } else if isComplete {
                        continuation.resume(throwing: SyncConnectError.failed("closed by the other side"))
                    } else {
                        continuation.resume(returning: nil)
                    }
                }
            }
            if let chunk { return chunk }
        }
    }

    func close() { connection.cancel() }

    /// What the handshake settled: the version of TLS and the protocol of the ALPN. Read by the tests, and by nothing that decides.
    func negotiated() -> (tlsVersion: tls_protocol_version_t, alpn: String)? {
        guard let metadata = connection.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata else { return nil }
        let security = metadata.securityProtocolMetadata
        guard let name = sec_protocol_metadata_get_negotiated_protocol(security) else { return nil }
        return (sec_protocol_metadata_get_negotiated_tls_protocol_version(security), String(cString: name))
    }
}

/// Takes the first of several callers: a state handler may fire again after a result.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.withLock { defer { taken = true }; return !taken } }
}
