import LuciumKit
import XCTest
@testable import Lucium

/// What the application does with the synchronisation (docs/synchronisation.md §8, §12, §13): the controller over a connector that answers from a script, so that the
/// rules are tried without a network. The connection itself (TLS, the pins) is `SyncNetworkTests`.
@MainActor
final class SyncControllerTests: XCTestCase {
    private var directory: URL!
    private var store: TestIdentityStore!
    private let macFingerprint = Data((0..<32).map { UInt8(255 - $0) })
    private let secret = Data((0..<16).map { UInt8($0 &* 3 &+ 5) })

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = TestIdentityStore()
    }

    override func tearDown() async throws {
        store.cleanUp()
        try? FileManager.default.removeItem(at: directory)
    }

    private func failure(_ result: Result<Void, SyncController.PairingFailure>) -> SyncController.PairingFailure? {
        if case .failure(let why) = result { return why }
        return nil
    }

    private var file: SyncSettingsFile { SyncSettingsFile(url: directory.appending(path: SyncSettingsFile.fileName)) }

    /// A body that reads one message more than `hello`, as the real body will: it lets a test cut the connection in the middle of a session.
    private struct ReadsOne: SyncSessionBody {
        func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
            _ = try await channel.receive(timeout: .seconds(2))
            return .notExchanged
        }
    }

    private final class Box<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: T
        init(_ value: T) { stored = value }
        var value: T { get { lock.withLock { stored } } set { lock.withLock { stored = newValue } } }
    }

    private func makeController(connector: ScriptedConnector, locked: Box<Bool> = Box(false), body: any SyncSessionBody = SyncNoSessionBody(), now: @escaping @Sendable () -> Int = { 1_790_000_000_000 }) -> SyncController {
        SyncController(file: file, identityStore: store, makeConnector: { _ in connector }, body: body, deviceName: "iPhone de test", appVersion: "0.1.0", now: now, isAppLocked: { locked.value })
    }

    private func waitUntil(_ what: String, timeout: Duration = .seconds(10), _ condition: () -> Bool, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline { return XCTFail("timed out waiting for: \(what)", line: line) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// The settings of a phone that is paired with the scripted Mac.
    private func pairedSettings(hosts: [String] = ["mac-de-test.local", "192.168.1.20"], enabled: Bool = true) throws -> SyncSettings {
        _ = try store.loadOrCreate()
        let mac = SyncPairedMac(id: "mac-test-0000000001", name: "Mac de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: hosts, pairedAt: 1_789_000_000_000)
        return SyncSettings(enabled: enabled, categories: [.structure, .archive], deviceId: "phone-test-000000001", mac: mac)
    }

    nonisolated private static func helloFromMac(now: Int = 1_790_000_000_000, hosts: [String] = ["mac-de-test.local", "192.168.1.30"], id: String = "mac-test-0000000001") -> [String: Any] {
        ["device": ["id": id, "name": "Mac de test", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": ["structure"], "baseHash": NSNull(),
         "stateVersion": 1, "appVersion": "1.2.0", "now": now, "hosts": hosts]
    }

    private func sessionMac(hello: @escaping @Sendable () -> [String: Any]) -> ScriptedConnector.Answer {
        .connect(fingerprint: macFingerprint, mac: { mac in
            try await mac.write("hello", hello())
            _ = try await mac.read()
            _ = try? await mac.read()
        })
    }

    // MARK: Off by default

    func testItIsOffByDefaultAndNothingRunsNorIsMadeNorAsked() async throws {
        let connector = ScriptedConnector(.fail(.timedOut))
        let controller = makeController(connector: connector)
        XCTAssertEqual(controller.status, .off)
        XCTAssertFalse(controller.settings.enabled)
        XCTAssertEqual(controller.settings.categories, [.structure])
        controller.launched()
        controller.becameActive()
        controller.requestSession(.manual)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(connector.attempts, [], "no connection while the switch is off")
        XCTAssertTrue(store.isEmpty, "no identity is made while the switch is off")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path), "nothing is written either")
    }

    func testTurningItOnMakesTheIdentityAndTheDeviceIdAndOpensNoConnection() async throws {
        let connector = ScriptedConnector(.fail(.timedOut))
        let controller = makeController(connector: connector)
        XCTAssertTrue(controller.setEnabled(true))
        XCTAssertEqual(controller.status, .noDevice)
        XCTAssertFalse(store.isEmpty)
        let id = try XCTUnwrap(controller.settings.deviceId)
        XCTAssertEqual(id.count, 22)
        XCTAssertEqual(connector.attempts, [])
        // It is on the disk, and a new launch finds it as it was, with the same id (a phone keeps one identifier).
        let again = makeController(connector: connector)
        XCTAssertTrue(again.settings.enabled)
        XCTAssertEqual(again.settings.deviceId, id)
        XCTAssertEqual(again.status, .noDevice)
        again.setEnabled(false)
        XCTAssertEqual(again.status, .off)
        again.setEnabled(true)
        XCTAssertEqual(again.settings.deviceId, id, "turning it off and on does not change the identifier")
    }

    func testIfTheIdentityCannotBeMadeTheSwitchStaysOff() throws {
        store.failCreation()
        let controller = makeController(connector: ScriptedConnector(.fail(.timedOut)))
        XCTAssertFalse(controller.setEnabled(true), "the keychain refused: the person is not told it is on")
        XCTAssertFalse(controller.settings.enabled)
        XCTAssertEqual(controller.status, .off)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
    }

    func testTheCategoriesAreKeptInTheOrderOfTheCatalogue() throws {
        let controller = makeController(connector: ScriptedConnector(.fail(.timedOut)))
        controller.setCategory(.openTabs, on: true)
        controller.setCategory(.settings, on: true)
        controller.setCategory(.structure, on: false)
        XCTAssertEqual(controller.settings.categories, [.settings, .openTabs])
        XCTAssertFalse(controller.isOn(.structure))
        XCTAssertEqual(makeController(connector: ScriptedConnector(.fail(.timedOut))).settings.categories, [.settings, .openTabs])
    }

    // MARK: A pairing

    private func pairingMac(secret: Data, phoneFingerprint: Data, refuse: SyncErrorCode? = nil) -> ScriptedConnector.Answer {
        let macFingerprint = self.macFingerprint
        return .connect(fingerprint: macFingerprint, mac: { mac in
            let nonce = Data((0..<16).map { UInt8($0) })
            try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(nonce)])
            let request = try await mac.read()
            if let refuse { return try await mac.write("error", ["code": refuse.rawValue, "fatal": true]) }
            let device = request["device"] as? [String: Any]
            let inputs = SyncProofInputs(secret: secret, fingerprintMac: macFingerprint, fingerprintPhone: phoneFingerprint, nonceMac: nonce,
                                         noncePhone: SyncEncoding.base64urlDecode(request["nonce"] as? String ?? "", characters: 22) ?? Data(), idMac: "mac-test-0000000001", idPhone: device?["id"] as? String ?? "")
            let accept = SyncProof.acceptTag(inputs).map(SyncEncoding.base64url) ?? ""
            try await mac.write("pair.accept", ["device": ["id": "mac-test-0000000001", "name": "Mac de test", "platform": "mac"], "proof": accept, "hosts": ["mac-de-test.local", "192.168.1.20"]])
            _ = try? await mac.read()
        })
    }

    private func qr(_ fingerprint: Data?) -> SyncPairingCode { SyncPairingCode(fingerprint: fingerprint, secret: secret, port: 49213, hosts: ["mac-de-test.local"]) }

    func testAPairingKeepsTheMacAsItProvedItAndStartsAFirstSessionThatSaysWhatItDid() async throws {
        let phoneFingerprint = try store.loadOrCreate().fingerprint
        let connector = ScriptedConnector(pairingMac(secret: secret, phoneFingerprint: phoneFingerprint))
        let controller = makeController(connector: connector)
        controller.setEnabled(true)
        // The first connection is the pairing; the next is the session the pairing starts.
        let result = await controller.pair(with: qr(macFingerprint))
        XCTAssertNil(failure(result), "the pairing went through")
        connector.set(sessionMac(hello: { Self.helloFromMac() }))
        let mac = try XCTUnwrap(controller.settings.mac)
        XCTAssertEqual(mac.id, "mac-test-0000000001")
        XCTAssertEqual(mac.name, "Mac de test")
        XCTAssertEqual(mac.fingerprint, macFingerprint)
        XCTAssertEqual(mac.hosts, ["mac-de-test.local", "192.168.1.20"])
        XCTAssertEqual(mac.port, 49213)
        XCTAssertEqual(file.load(), .loaded(controller.settings), "the pairing is on the disk")
        XCTAssertEqual(controller.pairingStep, .idle)
    }

    func testAWrongOrSpentCodeKeepsNothing() async throws {
        let phoneFingerprint = try store.loadOrCreate().fingerprint
        for refusal in [SyncErrorCode.pairingUsed, .pairingExpired, .pairingRefused] {
            let controller = makeController(connector: ScriptedConnector(pairingMac(secret: secret, phoneFingerprint: phoneFingerprint, refuse: refusal)))
            controller.setEnabled(true)
            let result = await controller.pair(with: qr(macFingerprint))
            XCTAssertEqual(failure(result), .code(refusal))
            XCTAssertNil(controller.settings.mac)
            XCTAssertEqual(controller.status, .noDevice)
            controller.setEnabled(false)
            try? FileManager.default.removeItem(at: file.url)
        }
    }

    func testAMacThatDoesNotKnowTheSecretIsNotKept() async throws {
        let phoneFingerprint = try store.loadOrCreate().fingerprint
        let controller = makeController(connector: ScriptedConnector(pairingMac(secret: Data(repeating: 1, count: 16), phoneFingerprint: phoneFingerprint)))
        controller.setEnabled(true)
        let result = await controller.pair(with: qr(macFingerprint))
        XCTAssertEqual(failure(result), .code(.badProof))
        XCTAssertNil(controller.settings.mac)
    }

    func testWhyTheMacWasNotReachedIsToldAsItIs() async throws {
        let cases: [(SyncConnectError, SyncReachFailure)] = [(.refused, .refused), (.timedOut, .unreachable), (.localNetworkDenied, .localNetworkDenied), (.fingerprintMismatch, .fingerprintMismatch)]
        for (error, reason) in cases {
            let controller = makeController(connector: ScriptedConnector(.fail(error)))
            controller.setEnabled(true)
            let result = await controller.pair(with: qr(macFingerprint))
            XCTAssertEqual(failure(result), .reach(reason), "\(error)")
            XCTAssertNil(controller.settings.mac)
            try? FileManager.default.removeItem(at: file.url)
        }
    }

    func testAPairingIsRefusedWhileTheSwitchIsOff() async throws {
        let connector = ScriptedConnector(.fail(.timedOut))
        let controller = makeController(connector: connector)
        let result = await controller.pair(with: qr(macFingerprint))
        XCTAssertEqual(failure(result), .cancelled)
        XCTAssertEqual(connector.attempts, [])
    }

    // MARK: A session

    private func paired(_ connector: ScriptedConnector, locked: Box<Bool> = Box(false), body: any SyncSessionBody = SyncNoSessionBody(), now: @escaping @Sendable () -> Int = { 1_790_000_000_000 }) throws -> SyncController {
        try file.save(try pairedSettings())
        return makeController(connector: connector, locked: locked, body: body, now: now)
    }

    func testASessionThatReachesHelloSaysTheMacAnsweredAndNeverUpToDate() async throws {
        let connector = ScriptedConnector(sessionMac(hello: { Self.helloFromMac() }))
        let controller = try paired(connector)
        XCTAssertEqual(controller.status, .idle)
        controller.requestSession(.manual)
        try await waitUntil("the session ends") { controller.status != .idle && controller.status != .running }
        XCTAssertEqual(controller.status, .macAnswered(at: 1_790_000_000_000), "nothing was exchanged, so it is not 'up to date'")
        XCTAssertEqual(controller.settings.mac?.hosts, ["mac-de-test.local", "192.168.1.30"], "the Mac's addresses replace the stored ones")
        XCTAssertEqual(controller.settings.mac?.lastContactAt, 1_790_000_000_000)
        XCTAssertEqual(connector.attempts.first, "mac-de-test.local:49213", "the .local name first")
        XCTAssertEqual(file.load(), .loaded(controller.settings))
    }

    func testADriftOfTheClocksIsAWarning() async throws {
        let connector = ScriptedConnector(sessionMac(hello: { Self.helloFromMac(now: 1_790_000_900_000) }))
        let controller = try paired(connector)
        controller.requestSession(.manual)
        try await waitUntil("the session ends") { controller.status != .idle && controller.status != .running }
        XCTAssertEqual(controller.status, .clockSkew)
    }

    func testWhyASessionDidNotHappenIsToldAsItIs() async throws {
        let cases: [(SyncConnectError, SyncStatus)] = [(.refused, .waiting), (.timedOut, .unreachable), (.failed("no route"), .unreachable), (.localNetworkDenied, .localNetworkDenied),
                                                       (.fingerprintMismatch, .failed(.fingerprintMismatch))]
        for (error, expected) in cases {
            let controller = try paired(ScriptedConnector(.fail(error)))
            controller.requestSession(.manual)
            try await waitUntil("the session ends for \(error)") { controller.status != .idle && controller.status != .running }
            XCTAssertEqual(controller.status, expected, "\(error)")
            XCTAssertNotNil(controller.settings.mac, "an unreachable Mac is still paired")
        }
    }

    func testAMacThatDoesNotKnowThisPhoneAnyMoreMakesThePhoneForgetIt() async throws {
        let connector = ScriptedConnector(.connect(fingerprint: macFingerprint, mac: { mac in
            _ = try? await mac.read()
            try await mac.write("error", ["code": "not-paired", "fatal": true])
        }))
        let controller = try paired(connector)
        controller.requestSession(.manual)
        try await waitUntil("the Mac is forgotten") { controller.settings.mac == nil }
        XCTAssertEqual(controller.status, .failed(.notPaired))
        guard case .loaded(let onDisk) = file.load() else { return XCTFail("no file") }
        XCTAssertNil(onDisk.mac, "forgotten on the disk too")
    }

    func testALockedMacIsWaitingNotAnError() async throws {
        let connector = ScriptedConnector(.connect(fingerprint: macFingerprint, mac: { mac in
            _ = try? await mac.read()
            try await mac.write("error", ["code": "locked", "fatal": true])
        }))
        let controller = try paired(connector)
        controller.requestSession(.manual)
        try await waitUntil("the session ends") { controller.status != .idle && controller.status != .running }
        XCTAssertEqual(controller.status, .waiting)
    }

    func testAConnectionCutInTheMiddleIsAnInterruptedExchange() async throws {
        let connector = ScriptedConnector(.connect(fingerprint: macFingerprint, mac: { mac in
            try await mac.write("hello", Self.helloFromMac())
            mac.transport.close()
        }))
        let controller = try paired(connector, body: ReadsOne())
        controller.requestSession(.manual)
        try await waitUntil("the session ends") { controller.status != .idle && controller.status != .running }
        XCTAssertEqual(controller.status, .interrupted)
        XCTAssertNotNil(controller.settings.mac)
    }

    func testNoSessionStartsWhileTheApplicationIsLockedOrTheSwitchIsOff() async throws {
        let connector = ScriptedConnector(sessionMac(hello: { Self.helloFromMac() }))
        let locked = Box(true)
        let controller = try paired(connector, locked: locked)
        // A request that has a delay (a return to the front waits 5 seconds, a change 30) replaces the one before it, so each is tried on its own: what is observed is
        // whether a session opens, and a request without delay opens one at once.
        for trigger in [SyncScheduler.Trigger.launch, .manual] {
            controller.requestSession(trigger)
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertEqual(connector.attempts, [], "a locked application is not synchronised (\(trigger))")
        }
        // The same request opens a session once the application is open: it is the lock that held it back, not something else in the setup.
        locked.value = false
        controller.requestSession(.manual)
        try await waitUntil("a session opens once the application is unlocked") { connector.attempts.count == 1 }
        try await waitUntil("the session ends") { controller.status != .idle && controller.status != .running }

        controller.setEnabled(false)
        controller.requestSession(.manual)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(connector.attempts.count, 1, "nor with the switch off")
        controller.setEnabled(true)
        controller.requestSession(.manual)
        try await waitUntil("a session opens once the switch is on again") { connector.attempts.count == 2 }
    }

    func testTwoAutomaticSessionsAreNotStartedWithinFifteenSecondsButTheButtonAlwaysWorks() async throws {
        let connector = ScriptedConnector(sessionMac(hello: { Self.helloFromMac() }))
        let controller = try paired(connector)
        controller.launched()
        try await waitUntil("the first session ends") { controller.status != .idle && controller.status != .running }
        controller.launched()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(connector.attempts.count, 1, "a second automatic session within 15 seconds is not started")
        controller.requestSession(.manual)
        try await waitUntil("the button's session") { connector.attempts.count == 2 }
    }

    func testAPhoneThatLostItsKeyForgetsTheMacAndSaysSo() async throws {
        try file.save(try pairedSettings())
        try store.delete()
        let controller = makeController(connector: ScriptedConnector(.fail(.timedOut)))
        XCTAssertEqual(controller.status, .identityLost)
        XCTAssertNil(controller.settings.mac)
        guard case .loaded(let onDisk) = file.load() else { return XCTFail("no file") }
        XCTAssertNil(onDisk.mac)
        XCTAssertTrue(onDisk.enabled, "the person's switch is theirs: only the pairing is lost")
    }

    // MARK: Forgetting

    func testForgettingTheMacErasesItAtOnceAndTellsItWhenItCanBeReached() async throws {
        let told = Box<[String]>([])
        let connector = ScriptedConnector(.connect(fingerprint: macFingerprint, mac: { mac in
            try await mac.write("hello", Self.helloFromMac())
            _ = try await mac.read()
            let next = try await mac.read()
            told.value.append(next["t"] as? String ?? "?")
        }))
        let controller = try paired(connector)
        controller.forgetMac()
        XCTAssertNil(controller.settings.mac, "erased here before anything is sent")
        XCTAssertEqual(controller.status, .noDevice)
        try await waitUntil("the Mac is told") { !told.value.isEmpty }
        XCTAssertEqual(told.value, ["unpair"])
    }

    func testForgettingAMacThatIsNotThereStillForgetsIt() async throws {
        let controller = try paired(ScriptedConnector(.fail(.timedOut)))
        controller.forgetMac()
        XCTAssertNil(controller.settings.mac)
        guard case .loaded(let onDisk) = file.load() else { return XCTFail("no file") }
        XCTAssertNil(onDisk.mac)
    }
}
