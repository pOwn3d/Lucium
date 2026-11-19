import Foundation

/// Both directions of one connection, with the rules of §7 applied on the way in: whole frames only, a message that passes every check of the codec, numbers in
/// order, a type that is allowed after what came before. Whatever does not pass closes the connection with the code that says why.
public actor SyncChannel {
    private let transport: any SyncTransport
    private let phase: SyncPhase
    private let log: @Sendable (String) -> Void
    private var decoder = SyncFrameDecoder()
    private var incoming = SyncSequence()
    private var outgoing = SyncSequence()
    private var history: [String] = []
    private var received = 0
    /// What the messages of this connection may still hold in values (`SyncLimits.maxSessionValues`).
    private var valuesLeft = SyncLimits.maxSessionValues

    /// `log` is where a failure that changes nothing for the person is written down (the line of a log, never a screen): it names no secret, no address and no
    /// fingerprint.
    public init(transport: any SyncTransport, phase: SyncPhase, log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) {
        self.transport = transport
        self.phase = phase
        self.log = log
    }

    public func send(_ message: SyncMessage) async throws {
        let frame = try SyncFrame.encode(try SyncMessageCodec.encode(message, number: outgoing.next()))
        try await transport.send(frame)
    }

    /// A message that is sent when the outcome of the session is already known (the `bye` that ends it, the `error` that says why it is refused): if it cannot be
    /// sent the person has nothing to do, so the failure is logged with what the message was for, and the session goes on to close.
    public func sendBestEffort(_ message: SyncMessage, why: String) async {
        do {
            try await send(message)
        } catch {
            log("could not send \(message.type) (\(why)): \(error)")
        }
    }

    /// The next message, waiting at most `timeout`. A silence longer than that is `timeout`, and the connection is closed. A frame or a message that breaks a
    /// rule throws its code, and the connection is closed too: the other side's bytes are not trusted past the first one that is wrong.
    public func receive(timeout: Duration) async throws -> SyncMessage {
        do {
            while true {
                if let content = try decoder.next() {
                    let envelope: SyncEnvelope
                    switch SyncMessageCodec.decode(content, valuesLeft: &valuesLeft) {
                    case .success(let value): envelope = value
                    case .failure(let failure): throw failure
                    }
                    try incoming.accept(envelope.number)
                    guard SyncTransitions.allows(envelope.message.type, after: history, receiver: .ios, phase: phase) else {
                        throw SyncFailure(.badMessage, "\(envelope.message.type) is not allowed here")
                    }
                    // The kinds that came, once each: the rules of §7.4 ask whether a kind was seen, never how many times, and a list of every message made each one search all
                    // the ones before it (quadratic, for a peer that sends them by the hundred thousand).
                    if !history.contains(envelope.message.type) { history.append(envelope.message.type) }
                    return envelope.message
                }
                let chunk = try await Self.read(transport, timeout: timeout)
                received += chunk.count
                guard received <= SyncLimits.maxSnapshotBytes + SyncLimits.maxFrameBytes else { throw SyncFailure(.tooLarge, "more than a session may hold") }
                decoder.append(chunk)
            }
        } catch {
            transport.close()
            throw error
        }
    }

    public func close() { transport.close() }

    /// One read from the transport, or `timeout`. The read that loses the race is abandoned by closing the transport, which ends it.
    private static func read(_ transport: any SyncTransport, timeout: Duration) async throws -> Data {
        // A read of the transport cannot be cancelled by itself: when the task that waits is cancelled (the application is locked, the person leaves the pairing),
        // the connection is closed, which ends the read at once instead of after the silence timeout.
        try await withTaskCancellationHandler {
            try await readOrTimeOut(transport, timeout: timeout)
        } onCancel: {
            transport.close()
        }
    }

    private static func readOrTimeOut(_ transport: any SyncTransport, timeout: Duration) async throws -> Data {
        try await withThrowingTaskGroup(of: Data?.self) { group in
            group.addTask { try await transport.receive() }
            group.addTask {
                try await Task.sleep(for: timeout)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw SyncFailure(.internal, "no result") }
            guard let bytes = first else {
                transport.close()
                throw SyncFailure(.timeout, "no frame within the time")
            }
            return bytes
        }
    }
}
