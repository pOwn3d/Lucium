import Foundation

/// One connection to the other device, as the protocol sees it: bytes in, bytes out, closed on demand. The application gives one made of `Network.framework`
/// (TLS 1.3, both certificates, the peer pinned); the tests give one made of memory.
public protocol SyncTransport: Sendable {
    func send(_ bytes: Data) async throws
    /// The next bytes that come, whatever their number. Throws when the connection is closed or has failed.
    func receive() async throws -> Data
    func close()
}

/// How the connection is pinned (docs/synchronisation.md §6.4).
public enum SyncPin: Equatable, Sendable {
    /// Only the certificate whose SHA-256 is this one is accepted. Anything else ends the handshake before a byte is sent.
    case fingerprint(Data)
    /// A typed code does not know the fingerprint (§4.3): the certificate is taken as it comes and handed back, and the pairing's proof is what decides.
    case learn
}

/// A connection that has finished its handshake, with the fingerprint of the certificate the other side showed.
public struct SyncConnection: Sendable {
    public let transport: any SyncTransport
    public let presentedFingerprint: Data

    public init(transport: any SyncTransport, presentedFingerprint: Data) {
        self.transport = transport
        self.presentedFingerprint = presentedFingerprint
    }
}

/// Why one address did not give a connection.
public enum SyncConnectError: Error, Equatable, Sendable {
    /// The address answered "no": the Mac is there and nobody listens (its window is closed, §6.1).
    case refused
    /// Nothing answered within the time.
    case timedOut
    /// The address showed a certificate that is not the pinned one.
    case fingerprintMismatch
    /// iOS refused the local network to Lucium.
    case localNetworkDenied
    /// Anything else (no route, a handshake that failed): treated as "did not answer".
    case failed(String)
}

public protocol SyncConnecting: Sendable {
    /// Opens a TLS connection to `host:port` and waits for its handshake, at most `timeout`.
    func connect(host: String, port: UInt16, pin: SyncPin, timeout: Duration) async throws -> SyncConnection
}

/// The order a Mac's addresses are tried in (§5): its `.local` name first, because the system resolves it by mDNS and it follows the Mac when its IP changes,
/// then the last addresses it gave, each once, in the order given; at most four, every one local.
public enum SyncCandidates {
    public static func ordered(_ hosts: [String]) -> [String] {
        var seen = Set<String>()
        let unique = hosts.filter { SyncAddress.isLocal($0) && seen.insert($0).inserted }
        let names = unique.filter { $0.hasSuffix(".local") }
        let addresses = unique.filter { !$0.hasSuffix(".local") }
        return Array((names + addresses).prefix(SyncPairedMac.maxHosts))
    }
}

/// What trying every address of a Mac gave.
public enum SyncReach: Sendable {
    case connected(SyncConnection)
    case failed(SyncReachFailure)
}

/// Tries the addresses one after the other, 3 seconds each (§5). The first connection wins. When none does, the reason that says the most is reported: a
/// local network that iOS refused, then a certificate that is not the pinned one (somebody else is at a Mac's old address), then a Mac that is there and
/// refuses (its window is closed), then nobody. No address is tried in parallel: a Mac's window is short and a burst of connections is what a rate limit
/// is made to refuse.
public enum SyncReacher {
    public static func connect(hosts: [String], port: UInt16, pin: SyncPin, using connector: any SyncConnecting, timeout: Duration = SyncLimits.candidateTimeout) async -> SyncReach {
        var denied = false, mismatch = false, refused = false
        for host in SyncCandidates.ordered(hosts) {
            if Task.isCancelled { break }
            do {
                return .connected(try await connector.connect(host: host, port: port, pin: pin, timeout: timeout))
            } catch SyncConnectError.localNetworkDenied {
                // Every address is on the same network: the next one would be refused the same way.
                denied = true
                break
            } catch SyncConnectError.fingerprintMismatch {
                mismatch = true
            } catch SyncConnectError.refused {
                refused = true
            } catch {
                continue
            }
        }
        if denied { return .failed(.localNetworkDenied) }
        if mismatch { return .failed(.fingerprintMismatch) }
        if refused { return .failed(.refused) }
        return .failed(.unreachable)
    }
}
