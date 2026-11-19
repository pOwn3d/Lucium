import LuciumKit
import XCTest
@testable import Lucium

/// The automatic synchronisation of the phone (docs/synchronisation.md §8.1, card 505): a session at each due time while the application is on the screen, at the interval the
/// person chose, slowed down after three sessions in a row that did not go through, and nothing at all once the application leaves the screen. The waits are given by a gate
/// the test opens, and the 15 seconds between two sessions by an instant the test moves: nothing here waits for a real minute.
@MainActor
final class SyncIntervalTests: XCTestCase {
    private var directory: URL!
    private var store: TestIdentityStore!
    private let macFingerprint = Data((0..<32).map { UInt8(255 - $0) })

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-sync-interval-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = TestIdentityStore()
    }

    override func tearDown() async throws {
        store.cleanUp()
        try? FileManager.default.removeItem(at: directory)
    }

    /// The waits of the loop: each one is recorded and lasts until the test opens the gate (or the loop is cancelled).
    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var waited: [Duration] = []
        private var permits = 0
        var delays: [Duration] { lock.withLock { waited } }
        func open() { lock.withLock { permits += 1 } }
        /// What was opened and not used (the loop that would have used it had ended).
        func drain() { lock.withLock { permits = 0 } }
        func sleep(_ duration: Duration) async throws {
            lock.withLock { waited.append(duration) }
            while true {
                try Task.checkCancellation()
                if lock.withLock({ if permits > 0 { permits -= 1; return true }; return false }) { return }
                try await Task.sleep(for: .milliseconds(5))
            }
        }
    }

    /// An instant that moves by a minute each time it is read: two sessions are never closer than the floor of 15 seconds.
    private final class Ticking: @unchecked Sendable {
        private let lock = NSLock()
        private var offset = 0
        private let origin = ContinuousClock.now
        func now() -> ContinuousClock.Instant { lock.withLock { offset += 60; return origin.advanced(by: .seconds(offset)) } }
    }

    private var file: SyncSettingsFile { SyncSettingsFile(url: directory.appending(path: SyncSettingsFile.fileName)) }

    private func makeController(_ connector: ScriptedConnector, gate: Gate, interval: SyncInterval? = nil) throws -> SyncController {
        _ = try store.loadOrCreate()
        let mac = SyncPairedMac(id: "mac-test-0000000001", name: "Mac de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["mac-de-test.local"], pairedAt: 1_789_000_000_000)
        var settings = SyncSettings(enabled: true, categories: [.structure], deviceId: "phone-test-000000001", mac: mac)
        if let interval { settings.interval = interval }
        try file.save(settings)
        let ticking = Ticking()
        return SyncController(file: file, identityStore: store, makeConnector: { _ in connector }, deviceName: "iPhone de test", appVersion: "0.1.0", now: { 1_790_000_000_000 }, isAppLocked: { false },
                              sleeper: { try await gate.sleep($0) }, instant: { ticking.now() })
    }

    nonisolated private static func hello() -> [String: Any] {
        ["device": ["id": "mac-test-0000000001", "name": "Mac de test", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": ["structure"], "baseHash": NSNull(),
         "stateVersion": 1, "appVersion": "1.2.0", "now": 1_790_000_000_000, "hosts": ["mac-de-test.local"]]
    }

    private func answering() -> ScriptedConnector.Answer {
        .connect(fingerprint: macFingerprint, mac: { mac in
            try await mac.write("hello", Self.hello())
            _ = try await mac.read()
            _ = try? await mac.read()
        })
    }

    private func waitUntil(_ what: String, timeout: Duration = .seconds(10), _ condition: () -> Bool, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline { return XCTFail("timed out waiting for: \(what)", line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// Opens the gate once and waits for the session it lets start to end and for the loop to wait again (the next delay is then recorded).
    private func tick(_ controller: SyncController, _ gate: Gate, _ connector: ScriptedConnector, line: UInt = #line) async throws {
        let waits = gate.delays.count
        let attempts = connector.attempts.count
        gate.open()
        try await waitUntil("a session starts at the due time", { connector.attempts.count > attempts }, line: line)
        try await waitUntil("the loop waits again", { gate.delays.count > waits }, line: line)
    }

    // MARK: The setting

    func testTheIntervalIsOneMinuteUntilThePersonChoosesAndIsKeptInTheFile() throws {
        let controller = try makeController(ScriptedConnector(.fail(.timedOut)), gate: Gate())
        XCTAssertEqual(controller.interval, .minute1)
        controller.setInterval(.minutes5)
        XCTAssertEqual(controller.interval, .minutes5)
        guard case .loaded(let kept) = file.load() else { return XCTFail("the settings were not written") }
        XCTAssertEqual(kept.interval, .minutes5)
        XCTAssertEqual(SyncSettings().interval, .minute1)
    }

    // MARK: On the screen

    func testWhileOnTheScreenASessionOpensAtEachDueTimeAtTheChosenInterval() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(answering())
        let controller = try makeController(connector, gate: gate)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        XCTAssertEqual(gate.delays, [.seconds(60)], "one minute by default")
        try await tick(controller, gate, connector)
        XCTAssertEqual(connector.attempts.count, 1, "a session opened at the due time, not before")
        try await waitUntil("the session ends", { controller.status != .idle && controller.status != .running })
        try await tick(controller, gate, connector)
        XCTAssertEqual(connector.attempts.count, 2, "and again at the next one")
        XCTAssertEqual(gate.delays, [.seconds(60), .seconds(60), .seconds(60)])
        controller.leftScreen()
    }

    func testAnotherIntervalStartsTheWaitAgainWithTheNewValue() async throws {
        let gate = Gate()
        let controller = try makeController(ScriptedConnector(answering()), gate: gate)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        controller.setInterval(.seconds30)
        try await waitUntil("the loop waits with the new value", { gate.delays.last == .seconds(30) })
        controller.setInterval(.minutes15)
        try await waitUntil("and again", { gate.delays.last == .seconds(900) })
        controller.leftScreen()
    }

    func testNothingRunsOnceTheApplicationLeavesTheScreen() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(answering())
        let controller = try makeController(connector, gate: gate)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        controller.leftScreen()
        gate.open()
        gate.open()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(connector.attempts, [], "in the background iOS suspends the application: no session is promised, and none is started by the loop")
        XCTAssertEqual(gate.delays.count, 1, "the loop ended, it does not wait again")
        // Back on the screen: the loop starts again, from a gate that holds nothing over.
        gate.drain()
        controller.becameActive()
        try await waitUntil("the loop waits again", { gate.delays.count == 2 })
        controller.leftScreen()
    }

    func testNoLoopRunsWhileTheSwitchIsOffOrNoMacIsPairedAndTheMacForgottenStopsIt() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(.fail(.timedOut))
        let alone = SyncController(file: file, identityStore: store, makeConnector: { _ in connector }, sleeper: { try await gate.sleep($0) })
        alone.becameActive()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(gate.delays, [], "switch off: no loop, nothing is waited for")
        alone.setEnabled(true)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(gate.delays, [], "no Mac paired: no loop")

        let controller = try makeController(connector, gate: gate)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        controller.forgetMac()
        gate.open()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(gate.delays.count, 1, "the Mac was forgotten: the loop ended")
        controller.setEnabled(false)
    }

    // MARK: Slowing down

    func testAfterThreeSessionsInARowThatDidNotGoThroughTheWaitDoublesAndASessionThatGoesThroughResetsIt() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(.fail(.timedOut))
        let controller = try makeController(connector, gate: gate, interval: .seconds30)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        for _ in 0..<5 { try await tick(controller, gate, connector) }
        XCTAssertEqual(gate.delays, [30, 30, 30, 60, 120, 240].map { Duration.seconds($0) }, "30 s, 30 s, 30 s (three failures), then doubled at each failure more")
        XCTAssertEqual(controller.consecutiveFailures, 5)
        // The Mac is back: the next session goes through and the wait is the interval again.
        connector.set(answering())
        try await tick(controller, gate, connector)
        try await waitUntil("the session ends", { controller.status != .running })
        try await waitUntil("the wait is the interval again", { gate.delays.last == .seconds(30) })
        XCTAssertEqual(controller.consecutiveFailures, 0)
        controller.leftScreen()
    }

    func testTheWaitNeverPassesFifteenMinutes() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(.fail(.timedOut))
        let controller = try makeController(connector, gate: gate, interval: .minutes5)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        for _ in 0..<8 { try await tick(controller, gate, connector) }
        XCTAssertEqual(gate.delays.max(), .seconds(900))
        XCTAssertEqual(gate.delays.last, .seconds(900))
        controller.leftScreen()
    }

    func testAMacThatRefusesCountsAsAFailureToo() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(.fail(.refused))
        let controller = try makeController(connector, gate: gate)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        for _ in 0..<3 { try await tick(controller, gate, connector) }
        XCTAssertEqual(controller.status, .waiting)
        XCTAssertEqual(gate.delays.last, .seconds(120), "the Mac that does not listen is not asked every minute for ever")
        controller.leftScreen()
    }

    func testTheReturnToTheFrontAndTheButtonStartTheCountOverButTheLoopDoesNot() async throws {
        let gate = Gate()
        let connector = ScriptedConnector(.fail(.timedOut))
        let controller = try makeController(connector, gate: gate, interval: .seconds30)
        controller.becameActive()
        try await waitUntil("the loop waits", { gate.delays.count == 1 })
        for _ in 0..<4 { try await tick(controller, gate, connector) }
        XCTAssertEqual(controller.consecutiveFailures, 4)
        controller.leftScreen()
        controller.becameActive()
        XCTAssertEqual(controller.consecutiveFailures, 0, "coming back to the front tries again at the chosen pace")
        try await waitUntil("the loop waits again", { gate.delays.last == .seconds(30) && gate.delays.count >= 6 })
        for _ in 0..<3 { try await tick(controller, gate, connector) }
        XCTAssertGreaterThan(controller.consecutiveFailures, 0)
        controller.requestSession(.manual)
        XCTAssertEqual(controller.consecutiveFailures, 0, "« Synchroniser maintenant » too")
        controller.leftScreen()
    }
}
