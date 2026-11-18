import Foundation
import LuciumKit
import Network
import Security
@testable import Lucium

/// An identity store of a test: the real keychain under a tag of its own, so that it never touches the identity of the application, and an easy way to make it
/// fail. `cleanUp()` removes what the test made.
final class TestIdentityStore: SyncIdentityStoring, @unchecked Sendable {
    private let real = KeychainSyncIdentityStore(tag: "app.lucium.sync.tests.\(UUID().uuidString)")
    private let lock = NSLock()
    private var failing = false

    func failCreation() { lock.withLock { failing = true } }
    var isEmpty: Bool { (try? real.load()) == nil }

    func load() throws -> SyncIdentity? { try real.load() }

    func loadOrCreate() throws -> SyncIdentity {
        if lock.withLock({ failing }) { throw SyncIdentityError.keychain("test", errSecAuthFailed) }
        return try real.loadOrCreate()
    }

    func delete() throws { try real.delete() }

    func cleanUp() {
        do { try real.delete() } catch { print("[test] the keychain items of a test were not removed: \(error)") }
    }
}

/// One end of an in-memory connection, with the bytes it wrote counted.
final class LoopbackEnd: SyncTransport, @unchecked Sendable {
    private actor Inbox {
        var queue: [Data] = []
        var waiters: [CheckedContinuation<Data, Error>] = []
        var closed = false
        func push(_ bytes: Data) { if waiters.isEmpty { queue.append(bytes) } else { waiters.removeFirst().resume(returning: bytes) } }
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

    private let inbox = Inbox()
    fileprivate var peer: LoopbackEnd?
    private let lock = NSLock()
    private var written = 0
    var sent: Int { lock.withLock { written } }

    func send(_ bytes: Data) async throws {
        lock.withLock { written += bytes.count }
        await peer?.inbox.push(bytes)
    }

    func receive() async throws -> Data { try await inbox.pop() }

    func close() {
        Task {
            await inbox.close()
            await peer?.inbox.close()
        }
    }

    static func pair() -> (phone: LoopbackEnd, mac: LoopbackEnd) {
        let phone = LoopbackEnd(), mac = LoopbackEnd()
        phone.peer = mac
        mac.peer = phone
        return (phone, mac)
    }
}

/// The Mac of the tests, over any transport: reads the phone's messages with the real decoder and writes its own as hand-made JSON.
final class TestMac: @unchecked Sendable {
    let transport: any SyncTransport
    private var decoder = SyncFrameDecoder()
    private var number = 0

    init(_ transport: any SyncTransport) { self.transport = transport }

    func read() async throws -> [String: Any] {
        while true {
            if let content = try decoder.next() {
                guard let object = try JSONSerialization.jsonObject(with: content) as? [String: Any] else { throw SyncFailure(.badMessage, "not an object") }
                return object
            }
            decoder.append(try await transport.receive())
        }
    }

    func write(_ type: String, _ fields: [String: Any] = [:]) async throws {
        number += 1
        var object = fields
        object["v"] = 1
        object["t"] = type
        object["n"] = number
        try await transport.send(try SyncFrame.encode(try JSONSerialization.data(withJSONObject: object)))
    }
}

/// A connector that answers from a script, and counts how often it was asked. `connect` either throws, or gives the phone's end of a loopback and runs `mac` on the
/// other end.
final class ScriptedConnector: SyncConnecting, @unchecked Sendable {
    enum Answer { case fail(SyncConnectError), connect(fingerprint: Data, mac: @Sendable (TestMac) async throws -> Void) }
    private let lock = NSLock()
    private var asked: [String] = []
    private var answer: Answer
    private(set) var macTask: Task<Void, Never>?

    init(_ answer: Answer) { self.answer = answer }

    var attempts: [String] { lock.withLock { asked } }
    func set(_ next: Answer) { lock.withLock { answer = next } }

    func connect(host: String, port: UInt16, pin: SyncPin, timeout: Duration) async throws -> SyncConnection {
        let current: Answer = lock.withLock { asked.append("\(host):\(port)"); return answer }
        switch current {
        case .fail(let error): throw error
        case .connect(let fingerprint, let script):
            if case .fingerprint(let expected) = pin, expected != fingerprint { throw SyncConnectError.fingerprintMismatch }
            let ends = LoopbackEnd.pair()
            let mac = TestMac(ends.mac)
            macTask = Task { try? await script(mac) }
            return SyncConnection(transport: ends.phone, presentedFingerprint: fingerprint)
        }
    }
}
