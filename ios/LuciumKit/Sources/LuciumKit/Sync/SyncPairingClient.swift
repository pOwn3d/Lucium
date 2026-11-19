import Foundation

/// What a successful pairing gives: the Mac's identity as it proved it, the fingerprint it is pinned to from now on, and the addresses it gave.
public struct SyncPairingOutcome: Equatable, Sendable {
    public let mac: SyncDeviceInfo
    public let fingerprint: Data
    public let hosts: [String]
    /// The port the Mac listens on now, as `pair.accept` says it (review n° 38): the one to keep, whatever the QR said.
    public let port: Int
}

/// The phone's half of the pairing (docs/synchronisation.md §4.1, steps 3 to 9), over a connection that has finished its TLS handshake.
///
/// Nothing is sent before the fingerprint the Mac showed has been compared with the QR's. After that the phone only answers: the Mac sends a nonce
/// (`pair.challenge`), the phone proves it knows the secret and commits to a code nonce it keeps back (`pair.request`, §4.7), the Mac sends its own code nonce
/// (`pair.nonce`) once the proof is right, the phone reveals its nonce (`pair.reveal`), the Mac asks its person (`pair.accept`, or an error), and the phone checks the
/// Mac's proof, which covers both fingerprints. A pairing whose proof is wrong stores nothing.
///
/// Then the phone's person decides (§4.6, review n° 9): `confirm` is told the name the Mac gave itself and the code both devices show (made of the two fingerprints and
/// the two code nonces, review n° 36), and answers whether to pair.
/// `false` (or no answer in time) sends `error pairing-refused` and keeps nothing; `true` sends `bye`, the Mac keeps the phone and answers `bye`, and only that last
/// word makes the pairing: a Mac that could not keep the phone answers `error`, and the phone keeps nothing either. `confirm` must come back when its task is cancelled
/// (the time given to the person, and the cancel of the pairing, both cancel it).
public enum SyncPairingClient {
    public static func pair(code: SyncPairingCode, connection: SyncConnection, ownFingerprint: Data, device: SyncDeviceInfo, nonce: Data, codeNonce: Data,
                            handshakeTimeout: Duration = SyncLimits.handshakeTimeout, confirmationTimeout: Duration = SyncLimits.pairingConfirmationWait,
                            comparisonTimeout: Duration = SyncPairingCompare.personWait,
                            onRequestSent: @Sendable () -> Void = {}, confirm: @escaping @Sendable (SyncPairingProposal) async -> Bool,
                            log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) async throws -> SyncPairingOutcome {
        let transport = connection.transport
        // Whatever ends the pairing but a success leaves no connection open: a Mac that answers `bye` for a challenge, a send that fails or a silence that times out
        // threw out of here with the transport still up, and nothing else closed it.
        var done = false
        defer { if !done { transport.close() } }
        // The comparison of §4.1 step 3. The TLS layer already refuses a different certificate when the QR named one; this is the second lock, and the only one
        // a test of the logic can reach.
        if let expected = code.fingerprint, expected != connection.presentedFingerprint {
            transport.close()
            throw SyncFailure(.fingerprintMismatch, "the certificate shown is not the one of the code")
        }
        // `codeNonce` is the nonce of the commitment (§4.7): drawn for this pairing, never the proof's nonce (that one is said before the commitment).
        guard nonce.count == 16, codeNonce.count == SyncPairingCommit.codeNonceBytes, codeNonce != nonce, ownFingerprint.count == SyncPairingCode.fingerprintBytes, connection.presentedFingerprint.count == SyncPairingCode.fingerprintBytes else {
            transport.close()
            throw SyncFailure(.internal, "a nonce or a fingerprint of the wrong size")
        }
        let channel = SyncChannel(transport: transport, phase: .pairing, log: log)
        // 1. The Mac speaks first.
        guard case .pairChallenge(let macNonce) = try await expectAnswer(channel, timeout: handshakeTimeout) else { throw SyncFailure(.badMessage, "no challenge") }
        // 2. The proof of the phone.
        var inputs = SyncProofInputs(secret: code.secret, fingerprintMac: connection.presentedFingerprint, fingerprintPhone: ownFingerprint, nonceMac: macNonce, noncePhone: nonce,
                                     idMac: "", idPhone: device.id)
        guard let requestTag = SyncProof.requestTag(inputs) else { throw SyncFailure(.internal, "no proof") }
        guard let commit = SyncPairingCommit.commitment(fingerprintPhone: ownFingerprint, nonce: codeNonce) else { throw SyncFailure(.internal, "no commitment") }
        try await channel.send(.pairRequest(device: device, nonce: nonce, proof: requestTag, commit: commit))
        onRequestSent()
        // 3. The Mac's code nonce, which it gives only after the commitment and a right proof; the phone reveals its own only now (§4.7).
        guard case .pairNonce(let macCodeNonce) = try await expectAnswer(channel, timeout: handshakeTimeout) else { throw SyncFailure(.badMessage, "no code nonce") }
        try await channel.send(.pairReveal(nonce: codeNonce))
        // 4. The Mac's person answers, which may take a minute.
        guard case .pairAccept(let mac, let proof, let hosts, let port) = try await expectAnswer(channel, timeout: confirmationTimeout) else { throw SyncFailure(.badMessage, "no accept") }
        guard mac.platform == .mac else {
            await channel.close()
            throw SyncFailure(.badMessage, "the answer does not come from a Mac")
        }
        // 5. The Mac's proof, which names its own identifier: a wrong one registers nothing.
        inputs.idMac = mac.id
        guard SyncProof.isValidAccept(proof, for: inputs) else {
            await channel.close()
            throw SyncFailure(.badProof, "the Mac's proof is not the right one")
        }
        // 6. The phone's person compares the code and decides (§4.6). Nothing has been kept yet, here or on the Mac.
        guard let comparison = SyncPairingCompare.code(fingerprintMac: connection.presentedFingerprint, fingerprintPhone: ownFingerprint, nonceMac: macCodeNonce, noncePhone: codeNonce) else {
            await channel.close()
            throw SyncFailure(.internal, "no code to compare")
        }
        let proposal = SyncPairingProposal(macName: mac.name, code: comparison)
        guard await Self.answer(within: comparisonTimeout, { await confirm(proposal) }) else {
            await channel.sendBestEffort(.error(code: .pairingRefused, fatal: true, supported: nil, detail: "the person did not agree to the pairing"), why: "the person refused")
            await channel.close()
            throw SyncFailure(.pairingRefused, "the person did not agree to the pairing")
        }
        // 7. « Appairer »: a `bye` says yes, and the Mac's own `bye` says it kept the phone, which is what makes the pairing. An `error` in its place is the Mac that could not.
        try await channel.send(.bye)
        guard case .bye = try await expectAnswer(channel, timeout: handshakeTimeout) else {
            await channel.close()
            throw SyncFailure(.badMessage, "no bye from the Mac")
        }
        await channel.close()
        done = true
        return SyncPairingOutcome(mac: mac, fingerprint: connection.presentedFingerprint, hosts: SyncCandidates.ordered(hosts), port: port)
    }

    /// What the phone's person answered, or `false` when they gave no answer within `limit` (and when the task that waits is cancelled, which `confirm` is told by the
    /// caller: it answers `false` then).
    private static func answer(within limit: Duration, _ ask: @escaping @Sendable () async -> Bool) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { await ask() }
            group.addTask {
                try? await Task.sleep(for: limit)
                return false
            }
            defer { group.cancelAll() }
            return await group.next() ?? false
        }
    }

    /// The next message, or the failure the Mac announced: an `error` is the Mac saying why it refuses (a spent secret, a refusal of its person…).
    private static func expectAnswer(_ channel: SyncChannel, timeout: Duration) async throws -> SyncMessage {
        let message = try await channel.receive(timeout: timeout)
        if case .error(let code, _, _, let detail) = message {
            await channel.close()
            throw SyncFailure(code, detail ?? "")
        }
        return message
    }
}
