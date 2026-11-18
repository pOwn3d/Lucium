import Foundation

/// What a successful pairing gives: the Mac's identity as it proved it, the fingerprint it is pinned to from now on, and the addresses it gave.
public struct SyncPairingOutcome: Equatable, Sendable {
    public let mac: SyncDeviceInfo
    public let fingerprint: Data
    public let hosts: [String]
}

/// The phone's half of the pairing (docs/synchronisation.md §4.1, steps 3 to 9), over a connection that has finished its TLS handshake.
///
/// Nothing is sent before the fingerprint the Mac showed has been compared with the QR's. After that the phone only answers: the Mac sends a nonce
/// (`pair.challenge`), the phone proves it knows the secret (`pair.request`), the Mac asks its person (`pair.accept`, or an error), and the phone checks the
/// Mac's proof, which covers both fingerprints. A pairing whose proof is wrong stores nothing.
public enum SyncPairingClient {
    public static func pair(code: SyncPairingCode, connection: SyncConnection, ownFingerprint: Data, device: SyncDeviceInfo, nonce: Data,
                            handshakeTimeout: Duration = SyncLimits.handshakeTimeout, confirmationTimeout: Duration = SyncLimits.pairingConfirmationWait,
                            onRequestSent: @Sendable () -> Void = {}, log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) async throws -> SyncPairingOutcome {
        let transport = connection.transport
        // The comparison of §4.1 step 3. The TLS layer already refuses a different certificate when the QR named one; this is the second lock, and the only one
        // a test of the logic can reach.
        if let expected = code.fingerprint, expected != connection.presentedFingerprint {
            transport.close()
            throw SyncFailure(.fingerprintMismatch, "the certificate shown is not the one of the code")
        }
        guard nonce.count == 16, ownFingerprint.count == SyncPairingCode.fingerprintBytes, connection.presentedFingerprint.count == SyncPairingCode.fingerprintBytes else {
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
        try await channel.send(.pairRequest(device: device, nonce: nonce, proof: requestTag))
        onRequestSent()
        // 3. The Mac's person answers, which may take a minute.
        guard case .pairAccept(let mac, let proof, let hosts) = try await expectAnswer(channel, timeout: confirmationTimeout) else { throw SyncFailure(.badMessage, "no accept") }
        guard mac.platform == .mac else {
            await channel.close()
            throw SyncFailure(.badMessage, "the answer does not come from a Mac")
        }
        // 4. The Mac's proof, which names its own identifier: a wrong one registers nothing.
        inputs.idMac = mac.id
        guard SyncProof.isValidAccept(proof, for: inputs) else {
            await channel.close()
            throw SyncFailure(.badProof, "the Mac's proof is not the right one")
        }
        await channel.sendBestEffort(.bye, why: "the pairing is done")
        await channel.close()
        return SyncPairingOutcome(mac: mac, fingerprint: connection.presentedFingerprint, hosts: SyncCandidates.ordered(hosts))
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
