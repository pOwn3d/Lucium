import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// An owner that says yes: the lock is turned on by a test, and nothing asks a person.
private final class YesOwner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}

/// The synchronisation's place in the application: the settings page, the lock, and the flag that says whether the phone was ever modified.
@MainActor
final class SyncScreenTests: BrowserCoreTestCase {
    private var store: TestIdentityStore!
    private let macFingerprint = Data((0..<32).map { UInt8(255 - $0) })

    override func setUp() async throws {
        try await super.setUp()
        store = TestIdentityStore()
    }

    override func tearDown() async throws {
        store.cleanUp()
        try await super.tearDown()
    }

    private var syncFile: SyncSettingsFile { SyncSettingsFile(url: directory.appending(path: SyncSettingsFile.fileName)) }

    private func makeSync(connector: ScriptedConnector = ScriptedConnector(.fail(.timedOut)), locked: @escaping @MainActor () -> Bool = { false }) -> SyncController {
        SyncController(file: syncFile, identityStore: store, makeConnector: { _ in connector }, deviceName: "iPhone de test", appVersion: "0.1.0", isAppLocked: locked)
    }

    // MARK: The settings

    func testTheSettingsHaveAPageForTheSynchronisationOnlyWhenTheModelHasOne() async throws {
        let model = await makeModel()
        XCTAssertFalse(SettingsScreen.groups(for: model).flatMap(\.rows).contains(.sync), "a copy with no synchronisation lists none")
        model.attach(makeSync())
        let groups = SettingsScreen.groups(for: model)
        XCTAssertTrue(groups.flatMap(\.rows).contains(.sync))
        let sections = groups.map(\.section)
        let spaces = try XCTUnwrap(sections.firstIndex(of: .spaces)), sync = try XCTUnwrap(sections.firstIndex(of: .sync)), about = try XCTUnwrap(sections.firstIndex(of: .about))
        XCTAssertTrue(spaces < sync && sync < about, "between the spaces and the licences, where the layout keeps its place")
    }

    func testTheSynchronisationIsOffUntilThePersonTurnsItOn() async throws {
        let model = await makeModel()
        let sync = makeSync()
        model.attach(sync)
        XCTAssertFalse(sync.settings.enabled)
        XCTAssertEqual(sync.status, .off)
        XCTAssertTrue(store.isEmpty, "attaching it makes no identity")
        XCTAssertFalse(FileManager.default.fileExists(atPath: syncFile.url.path), "and writes nothing")
    }

    // MARK: The page, drawn

    private static let phone = CGSize(width: 393, height: 852)

    /// A view drawn off screen in the test host (no window is shown: the simulator runs in the background), as `SettingsScreenshotTests` does it.
    private func draw<V: View>(_ view: V, language: String, textSize: DynamicTypeSize = .large) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: Self.phone)
        window.rootViewController = UIHostingController(rootView: view.environment(\.dynamicTypeSize, textSize).environment(\.locale, Locale(identifier: language)))
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(900))
        let bounds = CGRect(origin: .zero, size: Self.phone)
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in window.drawHierarchy(in: bounds, afterScreenUpdates: true) }
    }

    /// How many different colours a few thousand points of the picture have: a blank picture has one.
    private func colours(in image: UIImage) throws -> Int {
        let cg = try XCTUnwrap(image.cgImage)
        let width = 80, height = 120
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.interpolationQuality = .none
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Set(stride(from: 0, to: pixels.count, by: 4).map { "\(pixels[$0] / 8),\(pixels[$0 + 1] / 8),\(pixels[$0 + 2] / 8)" }).count
    }

    private func check(_ name: String, _ image: UIImage, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertGreaterThan(try colours(in: image), 8, "\(name) drew (almost) nothing", file: file, line: line)
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "sync-\(name).png"))
    }

    /// The page draws in every state it has, in both languages, and with the largest text: it builds, lays out and draws something.
    func testThePageDrawsInEveryStateItHasInBothLanguages() async throws {
        let off = makeSync()
        let on = makeSync()
        on.setEnabled(true)
        var withMac = on.settings
        withMac.mac = SyncPairedMac(id: "mac-test-0000000001", name: "Mac de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["mac.local"], pairedAt: 1)
        try syncFile.save(withMac)
        let paired = makeSync()
        for language in ["fr", "en"] {
            try check("off-\(language)", try await draw(NavigationStack { SyncScreen(controller: off) }, language: language))
            try check("on-\(language)", try await draw(NavigationStack { SyncScreen(controller: on) }, language: language))
            try check("paired-\(language)", try await draw(NavigationStack { SyncScreen(controller: paired) }, language: language))
        }
        try check("paired-largest-text", try await draw(NavigationStack { SyncScreen(controller: paired) }, language: "fr", textSize: .accessibility3))
    }

    /// The pairing sheet in both of its modes. The simulator has no camera: the scan side says so and offers the typed code, which is what a device without one shows.
    func testThePairingSheetDrawsBothWaysOfPairing() async throws {
        let on = makeSync()
        on.setEnabled(true)
        for language in ["fr", "en"] {
            try check("pairing-scan-\(language)", try await draw(SyncPairingSheet(controller: on), language: language))
            try check("pairing-type-\(language)", try await draw(SyncPairingSheet(controller: on, initialMode: .type), language: language))
        }
    }

    /// Every way a pairing can fail has words, except the person's own cancellation, which has none to say.
    func testEveryFailureOfAPairingHasWordsExceptACancellation() {
        let failures: [SyncController.PairingFailure] = SyncErrorCode.allCases.map { .code($0) } + [.reach(.refused), .reach(.unreachable), .reach(.localNetworkDenied), .reach(.fingerprintMismatch), .identity, .notConfirmed, .macKnowsThisPhone]
        for failure in failures { XCTAssertNotNil(SyncTexts.pairing(failure), "\(failure)") }
        XCTAssertNil(SyncTexts.pairing(.cancelled))
    }

    // MARK: The lock

    func testLockingTheApplicationClosesWhatTheSynchronisationHasOpen() async throws {
        // A Mac that answers the TLS handshake and then says nothing: a session sits waiting for its hello.
        let silent = ScriptedConnector(.connect(fingerprint: macFingerprint, mac: { _ in try await Task.sleep(for: .seconds(60)) }))
        let lock = LockController(authenticator: YesOwner(), file: LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName)))
        let model = BrowserModel.launch(directory: directory, lock: lock, embeddedLists: { nil })
        await model.prepare()
        _ = try store.loadOrCreate()
        let mac = SyncPairedMac(id: "mac-test-0000000001", name: "Mac de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["192.168.1.20"], pairedAt: 1)
        try syncFile.save(SyncSettings(enabled: true, categories: [.structure], deviceId: "phone-test-000000001", mac: mac))
        let sync = SyncController(file: syncFile, identityStore: store, makeConnector: { _ in silent }, deviceName: "iPhone de test", appVersion: "0.1.0",
                                  isAppLocked: { [weak lock] in lock?.appLocked ?? false })
        model.attach(sync)
        let on = await lock.setLockApp(true)
        XCTAssertTrue(on)
        try await eventually("the launch session has opened") { sync.status == .running }
        lock.lockAll()
        XCTAssertTrue(lock.appLocked)
        try await eventually("the session is closed when the application locks") { sync.status != .running }
        XCTAssertEqual(sync.status, .idle, "a session that was cut by the lock is not a failure of the Mac")
        // And none starts while it is locked.
        let before = silent.attempts.count
        sync.requestSession(.manual)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(silent.attempts.count, before)
    }

    // MARK: Was the phone ever modified

    func testAPhoneThatStartedWithNoStateIsUntouchedUntilItsPersonArrangesSomething() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.syncOrigin?.origin.untouched, true)
        model.flush()
        XCTAssertEqual(model.syncOrigin?.origin.untouched, true, "saving a state that is the first one changes nothing")
        // Browsing is not arranging.
        try await load("/a.html", in: model)
        model.flush()
        XCTAssertEqual(model.syncOrigin?.origin.untouched, true, "a page opened in Today is not the structure")
        XCTAssertNotNil(model.newFolder(named: "Réunions"))
        model.flush()
        XCTAssertEqual(model.syncOrigin?.origin.untouched, false, "a folder is")
        XCTAssertEqual(SyncOriginFile(url: directory.appending(path: SyncOriginFile.fileName)).load(), .loaded(SyncOrigin(firstStructure: model.syncOrigin?.origin.firstStructure, untouched: false)))
        let restarted = await makeModel()
        XCTAssertEqual(restarted.syncOrigin?.origin.untouched, false, "and it stays so after a restart")
    }

    func testAPhoneThatHadAStateBeforeTheSynchronisationExistedIsNotUntouched() async throws {
        var file = StateFile(url: directory.appending(path: StateFile.fileName))
        try file.save(BrowserModel.defaultState())
        let model = await makeModel()
        XCTAssertEqual(model.syncOrigin?.origin.untouched, false, "the union loses nothing, adopting the Mac's state could")
    }

    func testAnUnreadableOriginIsJudgedModifiedAndTheFileIsWrittenAgain() async throws {
        try Data("not json".utf8).write(to: directory.appending(path: SyncOriginFile.fileName))
        let model = await makeModel()
        XCTAssertEqual(model.syncOrigin?.origin.untouched, false)
        XCTAssertEqual(SyncOriginFile(url: directory.appending(path: SyncOriginFile.fileName)).load(), .loaded(SyncOrigin(firstStructure: nil, untouched: false)))
    }
}
