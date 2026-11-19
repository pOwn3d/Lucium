import Foundation

/// What the body of a session is given once both `hello` have been read and found compatible (docs/synchronisation.md §8.2).
public struct SyncSessionContext: Sendable {
    /// The Mac, as it said it in its `hello` and as the pairing registered it.
    public let mac: SyncDeviceInfo
    /// The categories both devices ticked, among the ones this version knows.
    public let categories: Set<SyncCategory>
    public let local: SyncHello
    public let remote: SyncHello
}

/// What a session body reports.
public enum SyncBodyOutcome: Equatable, Sendable {
    /// Nothing was exchanged: there is no body yet (the exchange of snapshots, their merge and the `commit` are the card that follows this one).
    case notExchanged
    /// Both devices merged the same state and the Mac's `commit` was read: "up to date". Milliseconds since 1970.
    case committed(at: Int)
}

/// The part of a session after `hello` (§8.2 to §8.5): the snapshots, their merge, the comparison of the two results, the application of the patch and the
/// `commit`. It is an interface on purpose: it needs the merge and the canonical form (card 446) and the snapshot of the phone's state, which are not this
/// card's. The session below hands it the channel, still open, and closes the connection when it returns.
public protocol SyncSessionBody: Sendable {
    func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome
}

/// No body: the session goes as far as `hello` and says so.
public struct SyncNoSessionBody: SyncSessionBody {
    public init() {}
    public func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome { .notExchanged }
}

/// What a finished session tells the person and the settings.
public struct SyncSessionReport: Equatable, Sendable {
    public let outcome: SyncBodyOutcome
    /// The Mac's current addresses, to replace the stored ones (§5); nil when it gave none.
    public let hosts: [String]?
    /// The port the Mac says it listens on (review n° 38), or nil when its hello did not say.
    public let port: Int?
    /// The clocks differ by more than five minutes (§9.3): a warning, not a failure.
    public let clockSkew: Bool
    public let categories: Set<SyncCategory>
    public let macAppVersion: String
}

/// The phone's side of a session (docs/synchronisation.md §7.4, §8): both sides send `hello` at once; the phone checks the Mac's, and passes what is left to a
/// body. It refuses an answer from a device that is not the one the fingerprint was registered for, a state of a newer format, and anything out of order.
public enum SyncSessionClient {
    /// The highest `stateVersion` of the Mac's format this phone knows how to write (`BrowserState.supportedVersion`); a newer state is not touched (§2).
    ///
    /// A session lasts at most `sessionMaximum` (ten minutes, §6.1, §7.5: the Mac holds the same limit): a Mac, or whoever answers in its place, that sends a byte a minute
    /// keeps every silence short and the session going, and « Synchroniser maintenant » stays « en cours » for ever (review n° 19). Past it the connection is closed and the
    /// session fails with `timeout`.
    public static func run(connection: SyncConnection, peer: SyncPairedMac, device: SyncDeviceInfo, categories: [SyncCategory], appVersion: String, supportedStateVersion: Int,
                           nonce: Data, baseHash: String?, now: @escaping @Sendable () -> Int, body: any SyncSessionBody,
                           handshakeTimeout: Duration = SyncLimits.handshakeTimeout, sessionMaximum: Duration = SyncLimits.sessionMaximum,
                           log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) async throws -> SyncSessionReport {
        try await within(sessionMaximum, closing: connection.transport) {
            try await exchange(connection: connection, peer: peer, device: device, categories: categories, appVersion: appVersion, supportedStateVersion: supportedStateVersion,
                               nonce: nonce, baseHash: baseHash, now: now, body: body, handshakeTimeout: handshakeTimeout, log: log)
        }
    }

    /// `work`, or `timeout` when `limit` has passed first: the transport is then closed, which ends the read that `work` is waiting on.
    private static func within<T: Sendable>(_ limit: Duration, closing transport: any SyncTransport, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T?.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(for: limit)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw SyncFailure(.internal, "no result") }
            guard let value = first else {
                transport.close()
                throw SyncFailure(.timeout, "the session lasted longer than the time a session may take")
            }
            return value
        }
    }

    private static func exchange(connection: SyncConnection, peer: SyncPairedMac, device: SyncDeviceInfo, categories: [SyncCategory], appVersion: String, supportedStateVersion: Int,
                                 nonce: Data, baseHash: String?, now: @Sendable () -> Int, body: any SyncSessionBody, handshakeTimeout: Duration,
                                 log: @escaping @Sendable (String) -> Void) async throws -> SyncSessionReport {
        let transport = connection.transport
        // The second lock of the pin: the connection was made to the fingerprint registered for the Mac, and nothing else may be on the line.
        guard connection.presentedFingerprint == peer.fingerprint else {
            transport.close()
            throw SyncFailure(.fingerprintMismatch, "the certificate shown is not the one registered")
        }
        let channel = SyncChannel(transport: transport, phase: .session, log: log)
        // A category whose entities hang on a space is announced with the structure only (§10.1, card 516).
        let announced = SyncCategory.announced(categories)
        let local = SyncHello(device: device, nonce: nonce, categories: announced.map(\.rawValue), baseHash: baseHash, stateVersion: supportedStateVersion, appVersion: appVersion, now: now(), diff: SyncHello.diffVersion)
        try await channel.send(.hello(local))
        let first = try await channel.receive(timeout: handshakeTimeout)
        let remote: SyncHello
        switch first {
        case .hello(let hello): remote = hello
        case .error(let code, _, _, let detail):
            await channel.close()
            throw SyncFailure(code, detail ?? "")
        default:
            await channel.close()
            throw SyncFailure(.badMessage, "the first message of a session is hello")
        }
        guard remote.device.id == peer.id, remote.device.platform == .mac else {
            await channel.sendBestEffort(.error(code: .fingerprintMismatch, fatal: true, supported: nil, detail: "the identifier does not belong to this certificate"), why: "the identifier is not the registered one")
            await channel.close()
            throw SyncFailure(.fingerprintMismatch, "the identifier does not belong to the certificate")
        }
        guard remote.stateVersion <= supportedStateVersion else {
            await channel.sendBestEffort(.error(code: .stateTooNew, fatal: true, supported: nil, detail: "state version \(remote.stateVersion)"), why: "the Mac's state is too new")
            await channel.close()
            throw SyncFailure(.stateTooNew, "the Mac's state is version \(remote.stateVersion)")
        }
        let common = SyncCategory.common(mine: announced, theirs: remote.categories)
        let skew = abs(remote.now - local.now) > SyncLimits.clockSkewWarningMilliseconds
        let context = SyncSessionContext(mac: remote.device, categories: common, local: local, remote: remote)
        let outcome: SyncBodyOutcome
        do {
            outcome = try await body.run(context, channel: channel)
        } catch {
            await channel.close()
            throw error
        }
        await channel.sendBestEffort(.bye, why: "the session is done")
        await channel.close()
        return SyncSessionReport(outcome: outcome, hosts: remote.hosts.map(SyncCandidates.ordered), port: remote.port, clockSkew: skew, categories: common, macAppVersion: remote.appVersion)
    }
}
