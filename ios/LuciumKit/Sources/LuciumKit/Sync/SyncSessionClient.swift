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
    /// The clocks differ by more than five minutes (§9.3): a warning, not a failure.
    public let clockSkew: Bool
    public let categories: Set<SyncCategory>
    public let macAppVersion: String
}

/// The phone's side of a session (docs/synchronisation.md §7.4, §8): both sides send `hello` at once; the phone checks the Mac's, and passes what is left to a
/// body. It refuses an answer from a device that is not the one the fingerprint was registered for, a state of a newer format, and anything out of order.
public enum SyncSessionClient {
    /// The highest `stateVersion` of the Mac's format this phone knows how to write (`BrowserState.supportedVersion`); a newer state is not touched (§2).
    public static func run(connection: SyncConnection, peer: SyncPairedMac, device: SyncDeviceInfo, categories: [SyncCategory], appVersion: String, supportedStateVersion: Int,
                           nonce: Data, baseHash: String?, now: @Sendable () -> Int, body: any SyncSessionBody,
                           handshakeTimeout: Duration = SyncLimits.handshakeTimeout, log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) async throws -> SyncSessionReport {
        let transport = connection.transport
        // The second lock of the pin: the connection was made to the fingerprint registered for the Mac, and nothing else may be on the line.
        guard connection.presentedFingerprint == peer.fingerprint else {
            transport.close()
            throw SyncFailure(.fingerprintMismatch, "the certificate shown is not the one registered")
        }
        let channel = SyncChannel(transport: transport, phase: .session, log: log)
        let local = SyncHello(device: device, nonce: nonce, categories: categories.map(\.rawValue), baseHash: baseHash, stateVersion: supportedStateVersion, appVersion: appVersion, now: now())
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
        let common = Set(categories).intersection(remote.categories.compactMap(SyncCategory.init(rawValue:)))
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
        return SyncSessionReport(outcome: outcome, hosts: remote.hosts.map(SyncCandidates.ordered), clockSkew: skew, categories: common, macAppVersion: remote.appVersion)
    }
}
