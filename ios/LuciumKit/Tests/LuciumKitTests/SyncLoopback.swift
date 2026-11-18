import Foundation
@testable import LuciumKit

/// Bytes that wait for whoever reads them: one direction of an in-memory connection.
actor SyncInbox {
    private var queue: [Data] = []
    private var waiters: [CheckedContinuation<Data, Error>] = []
    private var closed = false

    func push(_ bytes: Data) {
        guard !closed else { return }
        if waiters.isEmpty { queue.append(bytes) } else { waiters.removeFirst().resume(returning: bytes) }
    }

    func pop() async throws -> Data {
        if !queue.isEmpty { return queue.removeFirst() }
        if closed { throw SyncConnectError.failed("closed") }
        return try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    func close() {
        closed = true
        for waiter in waiters { waiter.resume(throwing: SyncConnectError.failed("closed")) }
        waiters = []
    }
}

/// One end of an in-memory connection. `sent` counts what this end wrote, so that a test can say "nothing was sent".
final class SyncLoopbackEnd: SyncTransport, @unchecked Sendable {
    fileprivate let inbox = SyncInbox()
    fileprivate var peer: SyncLoopbackEnd?
    private let lock = NSLock()
    private var written = 0
    private var isClosed = false

    var sent: Int { lock.withLock { written } }
    var closed: Bool { lock.withLock { isClosed } }

    func send(_ bytes: Data) async throws {
        guard !closed else { throw SyncConnectError.failed("closed") }
        lock.withLock { written += bytes.count }
        await peer?.inbox.push(bytes)
    }

    func receive() async throws -> Data { try await inbox.pop() }

    func close() {
        lock.withLock { isClosed = true }
        Task {
            await inbox.close()
            await peer?.inbox.close()
        }
    }
}

func syncLoopback() -> (phone: SyncLoopbackEnd, mac: SyncLoopbackEnd) {
    let phone = SyncLoopbackEnd(), mac = SyncLoopbackEnd()
    phone.peer = mac
    mac.peer = phone
    return (phone, mac)
}

/// The Mac's side of a conversation, written the way the specification says the Mac behaves, for the tests: it reads the phone's messages with the real
/// decoder and writes its own with a hand-made JSON, so that a mistake in the phone's writer is not hidden by the same mistake in the reader.
final class SyncFakeMac: @unchecked Sendable {
    let end: SyncLoopbackEnd
    private var decoder = SyncFrameDecoder()
    private var number = 0

    init(_ end: SyncLoopbackEnd) { self.end = end }

    /// The next message the phone sent, as its fields.
    func read(timeout: Duration = .seconds(2)) async throws -> (n: Int, fields: [String: Any]) {
        while true {
            if let content = try decoder.next() {
                guard let object = try JSONSerialization.jsonObject(with: content) as? [String: Any], let n = object["n"] as? Int else { throw SyncFailure(.badMessage, "the phone wrote a message without a number") }
                return (n, object)
            }
            decoder.append(try await end.receive())
        }
    }

    func write(_ type: String, _ fields: [String: Any] = [:], number override: Int? = nil, version: Int = 1) async throws {
        number += 1
        var object = fields
        object["v"] = version
        object["t"] = type
        object["n"] = override ?? number
        try await end.send(try SyncFrame.encode(try JSONSerialization.data(withJSONObject: object)))
    }

    func writeRaw(_ bytes: Data) async throws { try await end.send(bytes) }
}
