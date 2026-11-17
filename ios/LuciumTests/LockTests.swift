import LocalAuthentication
import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// An owner that says what it is told to, and keeps what it was asked.
private final class Owner: LockAuthenticating, @unchecked Sendable {
    private let guardLock = NSLock()
    private var outcomeValue: LockOutcome
    private var askedValue: [LockPurpose] = []

    init(_ outcome: LockOutcome = .granted) { outcomeValue = outcome }

    var outcome: LockOutcome { get { guardLock.withLock { outcomeValue } } set { guardLock.withLock { outcomeValue = newValue } } }
    var asked: [LockPurpose] { guardLock.withLock { askedValue } }

    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome {
        guardLock.withLock { askedValue.append(purpose) }
        return outcome
    }
}

/// What the browser does about the lock, with real web views and a local server: a covered space has no view, no tab on screen and no address in the
/// bar; a refusal changes none of it; the owner's yes brings the page back where it was left.
@MainActor
final class LockBrowserTests: BrowserCoreTestCase {
    /// A model like the application's, with a lock whose owner is `owner`. The lock's file is in the test's folder, like the state.
    private func makeLockedModel(owner: Owner, in folder: URL? = nil) async -> (BrowserModel, LockController) {
        let directory = folder ?? self.directory!
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: owner, file: file)
        let model = BrowserModel.launch(directory: directory, lock: lock, embeddedLists: { nil })
        await model.prepare()
        return (model, lock)
    }

    func testALockedSpaceHasNoViewNoTabAndNoAddressUntilTheOwnerOpensIt() async throws {
        let owner = Owner()
        let (model, lock) = await makeLockedModel(owner: owner)
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        XCTAssertEqual(model.host, "127.0.0.1:\(port)")

        let spaceId = model.activeSpace.id
        let spaceTabs = model.state.tabs(in: spaceId).count
        let locked = await lock.setSpace(spaceId, guarded: true)
        XCTAssertTrue(locked)
        XCTAssertTrue(model.activeSpaceCovered)
        XCTAssertNil(model.webView, "a covered space has no page")
        XCTAssertTrue(model.awakeTabIds.isEmpty, "its page was put to sleep: nothing of it plays or loads")
        XCTAssertNil(model.activeTab)
        XCTAssertTrue(model.activeTabs.isEmpty, "the list of tabs names nothing of a locked space")
        XCTAssertEqual(model.host, "", "the bar shows nothing of the page")
        XCTAssertEqual(model.addressText, "")
        XCTAssertFalse(model.canGoBack)

        let tabsBefore = model.state.tabs
        model.newTab()
        model.openTab(tab)
        model.submitAddress()
        XCTAssertEqual(model.state.tabs(in: spaceId).count, spaceTabs, "no tab is added to a locked space")
        XCTAssertEqual(model.state.tabs, tabsBefore, "nothing of a locked space is touched: not shown, not even dated")
        XCTAssertNil(model.webView)
        XCTAssertTrue(model.awakeTabIds.isEmpty)

        let opened = await lock.unlock(space: spaceId)
        XCTAssertTrue(opened)
        let view = try XCTUnwrap(model.webView, "the owner's yes brings the page back")
        XCTAssertEqual(model.activeTab?.id, tab.id)
        try await eventually("the page is where it was left") { view.url?.path == "/a.html" && !view.isLoading }
        XCTAssertEqual(model.host, "127.0.0.1:\(port)")
    }

    func testARefusedOwnerLeavesALockedSpaceCoveredAndNoPageIsMade() async throws {
        let owner = Owner()
        let (model, lock) = await makeLockedModel(owner: owner)
        try await load("/a.html", in: model)
        let spaceId = model.activeSpace.id
        let locked = await lock.setSpace(spaceId, guarded: true)
        XCTAssertTrue(locked)
        let requests = server.requestedPaths.count

        owner.outcome = .refused(.failed)
        let opened = await lock.unlock(space: spaceId)
        XCTAssertFalse(opened, "the refusal")
        XCTAssertTrue(model.activeSpaceCovered)
        XCTAssertNil(model.webView)
        XCTAssertTrue(model.awakeTabIds.isEmpty)
        XCTAssertEqual(lock.notice, .refused(.failed))
        XCTAssertEqual(server.requestedPaths.count, requests, "no page of a locked space is loaded")
    }

    func testChoosingALockedSpaceAsksTheOwnerAndARefusalKeepsItCovered() async throws {
        let owner = Owner()
        let (model, lock) = await makeLockedModel(owner: owner)
        try await load("/a.html", in: model)
        let home = try XCTUnwrap(model.spaces.first { $0.id != model.activeSpace.id })
        let locked = await lock.setSpace(home.id, guarded: true)
        XCTAssertTrue(locked)

        owner.outcome = .refused(.cancelled)
        model.selectSpace(home.id)
        XCTAssertTrue(model.activeSpaceCovered, "the space is covered the moment it is chosen")
        XCTAssertNil(model.webView)
        try await eventually("the owner was asked") { owner.asked.contains(.unlockSpace) }
        try await eventually("the refusal was heard") { lock.notice == .refused(.cancelled) }
        XCTAssertTrue(model.activeSpaceCovered)
        XCTAssertTrue(model.awakeTabIds.isDisjoint(with: model.state.tabs(in: home.id).map(\.id)), "no tab of the locked space is awake (the other space keeps its own)")

        owner.outcome = .granted
        model.requestUnlock()
        try await eventually("the space is open") { !model.activeSpaceCovered }
        XCTAssertNotNil(model.webView)
    }

    func testLeavingLuciumPutsEverythingToSleepAndTheOwnerBringsItBack() async throws {
        let owner = Owner()
        let (model, lock) = await makeLockedModel(owner: owner)
        try await load("/a.html", in: model)
        let a = try XCTUnwrap(model.activeTab)
        _ = try await openTab("/b.html", in: model)
        let turnedOn = await lock.setLockApp(true)
        XCTAssertTrue(turnedOn)
        XCTAssertFalse(lock.appLocked, "the screen in use is not locked when the lock is turned on")
        model.tabsSheetShown = true

        model.lockOnLeaving()
        XCTAssertTrue(lock.appLocked)
        XCTAssertTrue(model.awakeTabIds.isEmpty, "no page stays alive behind a locked application")
        XCTAssertFalse(model.tabsSheetShown, "a sheet that lists tabs does not stay up")
        XCTAssertNil(model.webView)
        XCTAssertEqual(model.host, "")

        owner.outcome = .refused(.failed)
        let refused = await lock.unlockApp()
        XCTAssertFalse(refused)
        XCTAssertTrue(lock.appLocked)
        XCTAssertNil(model.webView)
        XCTAssertTrue(model.awakeTabIds.isEmpty)

        owner.outcome = .granted
        let opened = await lock.unlockApp()
        XCTAssertTrue(opened)
        let view = try XCTUnwrap(model.webView)
        try await eventually("the page of the tab on screen is back") { view.url?.path == "/b.html" && !view.isLoading }
        XCTAssertEqual(model.state.tabs.first { $0.id == a.id }?.url, address("/a.html").absoluteString, "the other tab kept its line")
    }

    func testALaunchWithTheApplicationLockedLoadsNoPage() async throws {
        let first = await makeModel()
        try await load("/a.html", in: first)
        first.flush()
        let before = server.requestedPaths.count
        try LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName)).save(LockSettings(lockApp: true))

        let owner = Owner(.refused(.cancelled))
        let (model, lock) = await makeLockedModel(owner: owner)
        XCTAssertTrue(lock.appLocked, "the application starts locked when it is set to")
        XCTAssertTrue(model.isReady, "the blocker is ready; the page is not made")
        XCTAssertNil(model.webView)
        XCTAssertTrue(model.awakeTabIds.isEmpty)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(server.requestedPaths.count, before, "a locked launch requests nothing")
        XCTAssertEqual(model.host, "")
    }

    /// The lock screens and the settings sheet draw, in each language, with the icon of the project and the refusal the person just had; a picture
    /// of each is written when `LUCIUM_SHOTS` names a folder (`scripts/ios-check.sh` does), for the person who reads the captures.
    func testTheLockScreensDrawInBothLanguages() async throws {
        let owner = Owner(.refused(.failed))
        let lock = LockController(authenticator: owner, file: nil, spaceIds: nil)
        owner.outcome = .granted
        let guarded = await lock.setSpace("work", guarded: true)
        XCTAssertTrue(guarded)
        owner.outcome = .refused(.failed)
        await lock.unlock(space: "work")
        XCTAssertEqual(lock.notice, .refused(.failed))
        try render(lock)
    }

    private func render(_ lock: LockController) throws {
        let spaces = [Space(id: "work", name: "Work", emoji: "💼", profileId: "work"), Space(id: "home", name: "Home", emoji: "🏠", profileId: "home")]
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for language in ["en", "fr"] {
            let screens: [(String, AnyView)] = [
                ("app", AnyView(LockScreen(kind: .app, lock: lock, unlock: {}))),
                ("space", AnyView(LockScreen(kind: .space(name: "Work"), lock: lock, unlock: {}))),
                ("settings", AnyView(LockSettingsSheet(lock: lock, spaces: spaces))),
            ]
            for (name, view) in screens {
                let controller = UIHostingController(rootView: view.environment(\.locale, Locale(identifier: language)))
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
                window.rootViewController = controller
                window.makeKeyAndVisible()
                controller.view.layoutIfNeeded()
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 1))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                XCTAssertGreaterThan(image.size.width, 0)
                if let folder = ProcessInfo.processInfo.environment["LUCIUM_SHOTS"], let png = image.pngData() {
                    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
                    try png.write(to: URL(fileURLWithPath: folder).appending(path: "lucium-ios-lock-\(name)-\(language).png"))
                }
                window.isHidden = true
            }
        }
    }

    func testTheSceneLocksOnLeavingCoversWhileInactiveAndAsksOnceOnReturn() async throws {
        let owner = Owner()
        let (model, lock) = await makeLockedModel(owner: owner)
        try await load("/a.html", in: model)
        let cover = PrivacyCover()

        model.sceneChanged(to: .inactive, cover: cover)
        XCTAssertFalse(cover.isShown, "with no lock set, nothing is hidden: a system alert is not a reason to blank the page")
        let turnedOn = await lock.setLockApp(true)
        XCTAssertTrue(turnedOn)
        owner.outcome = .refused(.cancelled)

        model.sceneChanged(to: .inactive, cover: cover)
        XCTAssertTrue(cover.isShown, "the cover is up as the scene stops being active, before the system takes its picture")
        XCTAssertFalse(lock.appLocked, "an alert or the control centre does not lock")
        model.sceneChanged(to: .active, cover: cover)
        XCTAssertFalse(cover.isShown)
        XCTAssertFalse(lock.appLocked)

        model.sceneChanged(to: .inactive, cover: cover)
        model.sceneChanged(to: .background, cover: cover)
        XCTAssertTrue(cover.isShown)
        XCTAssertTrue(lock.appLocked, "leaving locks at once")
        XCTAssertTrue(model.awakeTabIds.isEmpty)

        let before = owner.asked.count
        model.sceneChanged(to: .active, cover: cover)
        try await eventually("the owner is asked on return") { owner.asked.count == before + 1 }
        try await eventually("the refusal was heard") { lock.notice == .refused(.cancelled) }
        XCTAssertFalse(cover.isShown)
        XCTAssertTrue(lock.appLocked)
        model.sceneChanged(to: .inactive, cover: cover)
        model.sceneChanged(to: .active, cover: cover)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(owner.asked.count, before + 1, "a prompt the person cancelled does not come back by itself")
        cover.set(shown: false)
    }

    func testTheCoverIsAWindowAboveEverythingThatComesAndGoes() throws {
        XCTAssertFalse(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.isEmpty, "the host application has no scene")
        let cover = PrivacyCover()
        XCTAssertFalse(cover.isShown)
        cover.set(shown: true)
        XCTAssertTrue(cover.isShown)
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.windowLevel > .alert })
        XCTAssertFalse(window.isHidden)
        cover.set(shown: false)
        XCTAssertFalse(cover.isShown)
        XCTAssertTrue(window.isHidden)
    }
}

/// What the system's answers mean for the lock, and the texts it shows.
final class SystemAuthenticatorTests: XCTestCase {
    func testOnlyACancellationIsACancellationAndOnlyAMissingMeansIsUnavailable() {
        for code in [LAError.Code.userCancel, .systemCancel, .appCancel, .userFallback] {
            XCTAssertEqual(SystemAuthenticator.outcome(for: LAError(code)), .refused(.cancelled), "\(code)")
        }
        for code in [LAError.Code.passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .notInteractive] {
            XCTAssertEqual(SystemAuthenticator.outcome(for: LAError(code)), .refused(.unavailable), "\(code)")
        }
        XCTAssertEqual(SystemAuthenticator.outcome(for: LAError(.authenticationFailed)), .refused(.failed))
    }

    func testOnlyAConfirmationOpens() {
        XCTAssertEqual(SystemAuthenticator.outcome(confirmed: true), .granted)
        XCTAssertEqual(SystemAuthenticator.outcome(confirmed: false), .refused(.failed), "a false that is not an error is still a refusal")
    }

    func testAnErrorThatIsNotTheSystemsIsARefusalNeverAnOpening() {
        struct Unknown: Error {}
        XCTAssertEqual(SystemAuthenticator.outcome(for: Unknown()), .refused(.failed))
        XCTAssertEqual(SystemAuthenticator.outcome(for: NSError(domain: "elsewhere", code: -1)), .refused(.failed))
    }

    /// The real system, asked in a way that forbids its prompt: it refuses at once, and what it says is a refusal, never an opening. (Showing a
    /// prompt needs a person, so Face ID itself is tried on a device, not here.)
    func testTheRealSystemRefusesWhenItMayNotAskAndNothingOpens() async {
        var system = SystemAuthenticator()
        system.interactive = false
        let outcome = await system.authenticate(purpose: .unlockApp)
        XCTAssertEqual(outcome, .refused(.unavailable), "the system could not ask: the lock treats it as a refusal")
    }

    func testEveryReasonTheSystemShowsIsInBothLanguages() throws {
        for purpose in [LockPurpose.unlockApp, .unlockSpace, .turnOn, .turnOff] {
            let english = SystemAuthenticator.reason(for: purpose, bundle: try bundle("en"))
            let french = SystemAuthenticator.reason(for: purpose, bundle: try bundle("fr"))
            XCTAssertFalse(english.hasPrefix("lock.reason"), "\(purpose) has no English text")
            XCTAssertFalse(french.hasPrefix("lock.reason"), "\(purpose) has no French text")
            XCTAssertNotEqual(english, french, "\(purpose) is the same in both languages")
        }
    }

    func testTheFaceIDSentenceIsInTheApplicationAndInBothLanguages() throws {
        let key = "NSFaceIDUsageDescription"
        XCTAssertFalse((Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "").isEmpty, "the build carries no Face ID sentence: the system would stop the application at the first prompt")
        let english = try bundle("en").localizedString(forKey: key, value: key, table: "InfoPlist")
        let french = try bundle("fr").localizedString(forKey: key, value: key, table: "InfoPlist")
        XCTAssertNotEqual(english, key)
        XCTAssertNotEqual(french, key)
        XCTAssertNotEqual(english, french)
    }

    private func bundle(_ language: String) throws -> Bundle {
        let path = try XCTUnwrap(Bundle.main.path(forResource: language, ofType: "lproj"), "\(language).lproj is missing from the application")
        return try XCTUnwrap(Bundle(path: path))
    }
}
