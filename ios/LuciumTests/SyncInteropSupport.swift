@preconcurrency import Darwin
import Foundation
import LuciumKit
import XCTest
@testable import Lucium

/// What the interoperability check is made of (scripts/sync-interop/README.md): the REAL Mac of the synchronisation (the TypeScript of src/main/sync/, run under Node by
/// scripts/sync-interop/mac-peer.ts) on the other end of a real network connection, driven through a small control server on the loopback. Nothing here runs unless the
/// check was started (`LUCIUM_INTEROP_PORT` is set): an ordinary run of the test suite skips it.

// MARK: The Mac's control server

struct PeerTab: Decodable, Equatable {
    let id: String, spaceId: String, pinned: Bool, title: String, url: String
    let customTitle: String?
}
struct PeerSpace: Decodable, Equatable { let id: String, name: String }
struct PeerFolder: Decodable, Equatable { let id: String, spaceId: String, name: String }
struct PeerArchived: Decodable, Equatable { let id: String, source: String, url: String }
struct PeerFavorite: Decodable, Equatable { let id: String, url: String }

struct PeerSummary: Decodable {
    let spaces: [PeerSpace]
    let folders: [PeerFolder]
    let tabs: [PeerTab]
    let archive: [PeerArchived]
    let favorites: [PeerFavorite]
}

struct PeerDevice: Decodable { let id: String, name: String }
struct PeerStatus: Decodable {
    let listening: Bool
    let devices: [PeerDevice]
    let codesShown: [String]
    let justPaired: String?
    struct Exchange: Decodable { let ok: Bool, code: String? }
    let lastExchange: Exchange?
}
struct PeerPairing: Decodable { let qr: String, code: String, address: String }
struct PeerBase: Decodable { let hash: String, entities: Int }
struct PeerMetrics: Decodable {
    struct Session: Decodable { let applyMs: Double, applies: Int }
    let cpuMs: Double, rssBytes: Int, heapBytes: Int, uptimeS: Double
    let sessions: [Session]
}

struct MacPeerClient: Sendable {
    let base: URL

    static func fromEnvironment() throws -> MacPeerClient {
        guard let port = ProcessInfo.processInfo.environment["LUCIUM_INTEROP_PORT"], let url = URL(string: "http://127.0.0.1:\(port)") else {
            throw XCTSkip("The interoperability check is not started (scripts/sync-interop/run.sh starts it).")
        }
        return MacPeerClient(base: url)
    }

    @discardableResult
    func call(_ method: String, _ path: String, _ body: JSONValue? = nil) async throws -> Data {
        guard let url = URL(string: path, relativeTo: base) else { throw SyncFailure(.internal, "bad path \(path)") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 120
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw SyncFailure(.internal, "the Mac peer answered \(String(data: data, encoding: .utf8) ?? "?") to \(method) \(path)")
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T { try JSONDecoder().decode(T.self, from: try await call("GET", path)) }

    func reset() async throws { try await call("POST", "/reset") }
    func summary() async throws -> PeerSummary { try await get("/state") }
    func status() async throws -> PeerStatus { try await get("/status") }
    func metrics() async throws -> PeerMetrics { try await get("/metrics") }
    func baseHash(forPhone id: String) async throws -> PeerBase? {
        let data = try await call("GET", "/base?peer=\(id)")
        return try? JSONDecoder().decode(PeerBase.self, from: data)
    }

    func enable(_ categories: [SyncCategory]) async throws { try await call("POST", "/enable", .object(["categories": .array(categories.map { .string($0.rawValue) })])) }
    func setCategories(_ categories: [SyncCategory]) async throws { try await call("POST", "/categories", .object(["categories": .array(categories.map { .string($0.rawValue) })])) }
    func pair(answer: String = "allow", delayMs: Int = 0) async throws -> PeerPairing {
        try JSONDecoder().decode(PeerPairing.self, from: try await call("POST", "/pair", .object(["answer": .string(answer), "delayMs": .number(Double(delayMs))])))
    }
    func beginSession() async throws { try await call("POST", "/begin-session") }
    func seedToday(_ count: Int, space: String, prefix: String) async throws {
        try await call("POST", "/seed-today", .object(["count": .number(Double(count)), "spaceId": .string(space), "prefix": .string(prefix)]))
    }
    func lock(space: String, _ locked: Bool) async throws { try await call("POST", "/lock-space", .object(["id": .string(space), "locked": .bool(locked)])) }
    func stop() async { _ = try? await call("POST", "/stop") }

    /// A person's gesture at the Mac: an action of the reducer.
    func dispatch(_ type: String, _ fields: [String: JSONValue] = [:]) async throws {
        var action = fields
        action["type"] = .string(type)
        try await call("POST", "/dispatch", .object(["action": .object(action)]))
    }
}

// MARK: What crosses the wire, what a session costs

final class WireCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var out = 0, inn = 0, connections = 0
    func add(sent: Int = 0, received: Int = 0) { lock.withLock { out += sent; inn += received } }
    func opened() { lock.withLock { connections += 1 } }
    func take() -> (sent: Int, received: Int, connections: Int) { lock.withLock { defer { out = 0; inn = 0; connections = 0 }; return (out, inn, connections) } }
}

struct CountingTransport: SyncTransport {
    let inner: any SyncTransport
    let counter: WireCounter
    func send(_ bytes: Data) async throws { counter.add(sent: bytes.count); try await inner.send(bytes) }
    func receive() async throws -> Data { let bytes = try await inner.receive(); counter.add(received: bytes.count); return bytes }
    func close() { inner.close() }
}

/// The real TLS connector of the application, with the bytes counted. The loopback is NOT allowed: the Mac is reached at a real address of this machine.
struct CountingConnector: SyncConnecting {
    let inner: NetworkSyncConnector
    let counter: WireCounter
    func connect(host: String, port: UInt16, pin: SyncPin, timeout: Duration) async throws -> SyncConnection {
        let connection = try await inner.connect(host: host, port: port, pin: pin, timeout: timeout)
        counter.opened()
        return SyncConnection(transport: CountingTransport(inner: connection.transport, counter: counter), presentedFingerprint: connection.presentedFingerprint)
    }
}

/// The model's host of the exchange, with the time of what it writes and the number of sessions that went through.
final class MeasuringHost: SyncExchangeHost, @unchecked Sendable {
    let inner: SyncModelHost
    private let lock = NSLock()
    private var applyMs = 0.0, applies = 0, done = 0
    private var summaries: [SyncExchangeSummary] = []

    init(model: BrowserModel) { inner = SyncModelHost(model: model) }

    var sessionsDone: Int { lock.withLock { done } }
    var lastSummary: SyncExchangeSummary? { lock.withLock { summaries.last } }
    func takeApply() -> (ms: Double, count: Int) { lock.withLock { defer { applyMs = 0; applies = 0 }; return (applyMs, applies) } }

    func currentState() async -> BrowserState { await inner.currentState() }
    func lockedSpaceIDs() async -> Set<String> { await inner.lockedSpaceIDs() }
    func isAppLocked() async -> Bool { await inner.isAppLocked() }
    func isNeverModified() async -> Bool { await inner.isNeverModified() }
    func apply(_ patch: SyncPatch) async -> SyncApply.Outcome {
        let started = ContinuousClock.now
        let outcome = await inner.apply(patch)
        let elapsed = ContinuousClock.now - started
        let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
        lock.withLock { applyMs += ms; applies += 1 }
        return outcome
    }
    func exchanged(_ summary: SyncExchangeSummary) async {
        lock.withLock { done += 1; summaries.append(summary) }
        await inner.exchanged(summary)
    }
    func restore(_ change: SyncChange) async -> Bool { await inner.restore(change) }
}

struct SessionCost: Codable {
    var sentBytes: Int, receivedBytes: Int, connections: Int
    var durationMs: Double
    var phoneApplyMs: Double, phoneApplies: Int
    var macApplyMs: Double, macApplies: Int
}

// MARK: The phone

/// A phone of the check: a real model, the real controller over the real TLS connector, paired with the real Mac of the peer.
@MainActor
final class InteropPhone {
    let peer: MacPeerClient
    let model: BrowserModel
    let controller: SyncController
    let host: MeasuringHost
    let counter = WireCounter()
    let store: TestIdentityStore
    let directory: URL

    init(peer: MacPeerClient, model: BrowserModel, directory: URL, store: TestIdentityStore, modified: Bool = true, categories: [SyncCategory]) throws {
        self.peer = peer
        self.model = model
        self.store = store
        self.directory = directory
        host = MeasuringHost(model: model)
        if modified {
            // The launch wrote the origin of a first run (never modified): a phone that was used before has no such file (as in SyncExchangeAppTests).
            let origin = directory.appending(path: SyncOriginFile.fileName)
            try FileManager.default.removeItem(at: origin)
            model.syncOrigin = SyncOriginKeeper(file: SyncOriginFile(url: origin), stateWasFound: true, state: model.state)
        }
        let counter = counter
        // The settings are written as they are asked for, not through the page's rules: a phone whose file ticks the archive without the structure (a file of an older version) is a case
        // to play (`SyncController.setCategory` refuses it, `SyncCategory.announced` and `common` are what protect the other device).
        let file = SyncSettingsFile(url: directory.appending(path: SyncSettingsFile.fileName))
        try file.save(SyncSettings(enabled: true, categories: categories, deviceId: SyncEncoding.base64url(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))))
        controller = SyncController(file: file, identityStore: store,
                                    makeConnector: { identity in CountingConnector(inner: NetworkSyncConnector(identity: identity.identity), counter: counter) },
                                    exchangeHost: host, deviceName: "iPhone interop", appVersion: "0.1.0-interop", isAppLocked: { false })
        model.sync = controller
        model.flush()  // the first marks, as the switch's catch-up does
    }

    var deviceId: String { controller.settings.deviceId ?? "" }

    func waitFor(_ what: String, timeout: Duration = .seconds(60), _ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("timed out waiting for \(what)")
        throw SyncFailure(.internal, "timed out: \(what)")
    }

    /// The pairing of §4.7 against the real Mac. Returns the code both sides compared.
    @discardableResult
    func pair(answerOnPhone: Bool = true) async throws -> String? {
        let view = try await peer.pair()
        let code = try SyncPairingCode.parse(qr: view.qr).get()
        let task = Task { await controller.pair(with: code) }
        try await waitFor("the code to compare on the phone") {
            if case .comparing = controller.pairingStep { return true }
            return task.isCancelled
        }
        var shown: String?
        if case .comparing(let proposal) = controller.pairingStep {
            shown = proposal.code
            let macShown = try await peer.status().codesShown.last
            XCTAssertEqual(proposal.code, macShown, "the two devices must show the same words")
        }
        controller.answerComparison(answerOnPhone)
        let result = await task.value
        if answerOnPhone { if case .failure(let failure) = result { XCTFail("the pairing failed: \(failure)") } }
        return shown
    }

    /// One session, asked for like the person's « Synchroniser maintenant ». Returns what it cost, both sides counted.
    @discardableResult
    func session(file: StaticString = #filePath, line: UInt = #line) async throws -> SessionCost {
        let sessionsBefore = host.sessionsDone
        _ = counter.take()
        _ = host.takeApply()
        let macBefore = try await peer.metrics().sessions.count
        try await peer.beginSession()
        let started = ContinuousClock.now
        controller.requestSession(.manual)
        var sawRunning = false
        // A session on the local network can end between two looks: the number of sessions that went through is what says it, the status only says one failed.
        try await waitFor("a session to end", timeout: .seconds(120)) {
            if controller.status == .running { sawRunning = true }
            return host.sessionsDone > sessionsBefore || (sawRunning && controller.status != .running)
        }
        let elapsed = ContinuousClock.now - started
        guard host.sessionsDone > sessionsBefore else {
            XCTFail("the session did not go through: \(controller.status)", file: file, line: line)
            throw SyncFailure(.internal, "session failed: \(controller.status)")
        }
        let wire = counter.take()
        let apply = host.takeApply()
        let mac = try await peer.metrics().sessions
        let macSession = mac.count > macBefore ? mac[macBefore] : nil
        return SessionCost(sentBytes: wire.sent, receivedBytes: wire.received, connections: wire.connections,
                           durationMs: Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15,
                           phoneApplyMs: apply.ms, phoneApplies: apply.count, macApplyMs: macSession?.applyMs ?? -1, macApplies: macSession?.applies ?? -1)
    }

    // What a person does on the phone, through the state the screens write, then written as the application writes it (so that the marks are taken).

    func edit(_ change: (inout BrowserState) -> Void) {
        var next = model.state
        change(&next)
        model.state = next
        model.flush()
    }

    func openToday(_ id: String, in space: String, url: String? = nil, title: String? = nil, ageMs: Double = 120_000) {
        let now = Double(Date().timeIntervalSince1970 * 1000)
        edit { state in
            _ = state.openTab(id: id, in: space, url: url ?? "https://\(id).example/page", title: title ?? "Page \(id)", now: now - ageMs)
        }
    }

    func seedToday(_ count: Int, in space: String, prefix: String, ageMs: Double = 120_000) {
        let now = Double(Date().timeIntervalSince1970 * 1000)
        edit { state in
            for index in 0..<count {
                let id = "\(prefix)-\(String(format: "%03d", index))"
                _ = state.openTab(id: id, in: space, url: "https://\(id).example/page/\(index)", title: "Page \(id)", now: now - ageMs - Double(index))
            }
        }
    }

    func tab(_ id: String) -> TabItem? { model.state.tabs.first { $0.id == id } }
    /// The Today tabs that can be shared: a blank tab (the start page) is the phone's own and never crosses.
    func todayIDs(in space: String? = nil) -> Set<String> { Set(model.state.tabs.filter { !$0.pinned && !$0.isBlank && (space == nil || $0.spaceId == space) }.map(\.id)) }
    func pinnedIDs() -> Set<String> { Set(model.state.tabs.filter(\.pinned).map(\.id)) }
    var spaceIDs: Set<String> { Set(model.state.spaces.map(\.id)) }
    var folderIDs: Set<String> { Set(model.state.folders.map(\.id)) }
    var favoriteIDs: Set<String> { Set(model.state.favorites.map(\.id)) }
    var archiveIDs: Set<String> { Set(model.state.archive.map(\.id)) }
}

extension PeerSummary {
    func todayIDs(in space: String? = nil) -> Set<String> { Set(tabs.filter { !$0.pinned && (space == nil || $0.spaceId == space) }.map(\.id)) }
    var pinnedIDs: Set<String> { Set(tabs.filter(\.pinned).map(\.id)) }
    var spaceIDs: Set<String> { Set(spaces.map(\.id)) }
    var folderIDs: Set<String> { Set(folders.map(\.id)) }
    var favoriteIDs: Set<String> { Set(favorites.map(\.id)) }
    var archiveIDs: Set<String> { Set(archive.map(\.id)) }
}

// MARK: This process, as it costs

enum ProcessCost {
    /// CPU time (user + system) of this process in milliseconds, and its memory footprint in bytes.
    static func now() -> (cpuMs: Double, footprint: Int) {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let cpu = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return (cpu, result == KERN_SUCCESS ? Int(info.phys_footprint) : -1)
    }
}
