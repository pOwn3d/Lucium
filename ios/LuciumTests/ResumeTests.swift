import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// « Reprendre un onglet du Mac » in the application (docs/synchronisation.md §10.4): the list the Mac announced is kept in memory and forgotten with the lock, the
/// category and the Mac; a touch opens the address as a new tab of the right space; the command bar's source « Sur le Mac » reads the same list. The rules of the rows
/// and of the space are proved in LuciumKit (`SyncResumeTests`).
@MainActor
final class ResumeTests: BrowserCoreTestCase {
    private var store: TestIdentityStore!
    private let now = 1_790_000_000_000

    override func setUp() async throws {
        try await super.setUp()
        store = TestIdentityStore()
    }

    override func tearDown() async throws {
        store.cleanUp()
        try await super.tearDown()
    }

    private var syncFile: SyncSettingsFile { SyncSettingsFile(url: directory.appending(path: SyncSettingsFile.fileName)) }

    /// A phone paired with a Mac, the synchronisation on, and `categories` ticked here.
    private func pairedModel(categories: [SyncCategory] = [.structure, .openTabs], locked: Bool = false) async throws -> (BrowserModel, SyncController) {
        _ = try store.loadOrCreate()  // a phone paired with a Mac has its identity: without it the controller would forget the Mac
        let mac = SyncPairedMac(id: "mac-test-0000000001", name: "Mac de test", fingerprintHex: String(repeating: "ab", count: 32), port: 49213, hosts: ["mac-de-test.local"], pairedAt: 1_789_000_000_000)
        try syncFile.save(SyncSettings(enabled: true, categories: categories, deviceId: "phone-test-000000001", mac: mac))
        let model = await makeModel()
        let controller = SyncController(file: syncFile, identityStore: store, makeConnector: { _ in ScriptedConnector(.fail(.timedOut)) }, exchangeHost: SyncModelHost(model: model),
                                        deviceName: "iPhone de test", appVersion: "0.1.0", now: { 1_790_000_000_000 }, isAppLocked: { model.lock?.appLocked ?? false })
        model.sync = controller
        return (model, controller)
    }

    /// A second space, in the profile of the first; the first stays on screen.
    private func addWorkSpace(_ model: BrowserModel) throws -> Space {
        let home = model.state.activeSpaceId
        guard case .success(let space) = model.addSpace(name: "Lecture", emoji: "📚", profile: .existing(model.activeSpace.profileId), hue: 200) else { throw XCTSkip("the space was refused") }
        model.selectSpace(home)
        return space
    }

    private func summary(_ tabs: [SyncOpenTab]?) -> SyncExchangeSummary {
        SyncExchangeSummary(at: now, conflicts: [], refusedSent: [], refusedReceived: [], rejectedByApply: [], applied: true, adoptedTheMacState: false, spacesSetAside: 0, openTabs: tabs)
    }

    private func tab(_ id: String, _ path: String, title: String = "Une page", space: String, at: Int = 100) -> SyncOpenTab {
        SyncOpenTab(id: id, spaceId: space, url: "http://127.0.0.1:\(port)\(path)", title: title, lastActiveAt: at)
    }

    // MARK: The list

    func testTheListIsKeptInMemoryAndForgottenWithTheLockTheCategoryAndTheMac() async throws {
        let (model, controller) = try await pairedModel()
        let space = model.state.activeSpaceId
        controller.exchangeDone(summary([tab("t1", "/a.html", space: space)]))
        XCTAssertEqual(model.resumeRows.map(\.id), ["t1"])
        XCTAssertEqual(model.resumeAvailability, .list)
        XCTAssertNil(controller.lastExchange?.openTabs, "the list has one home: the summary kept for the page does not hold it")
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            let text = (try? String(contentsOf: directory.appending(path: name), encoding: .utf8)) ?? ""
            XCTAssertFalse(text.contains("/a.html"), "\(name) holds an address of the Mac's open tabs")
        }

        // The lock: the list goes, and what the screen says is that it comes with the next session.
        let lock = LockController(authenticator: AlwaysGranted(), file: nil, spaceIds: nil)
        model.attach(lock)
        let guarded = await lock.setLockApp(true)
        XCTAssertTrue(guarded)
        lock.lockAll()
        XCTAssertTrue(lock.appLocked)
        XCTAssertTrue(controller.macOpenTabs.isEmpty, "the lock forgets the list")
        XCTAssertTrue(model.resumeRows.isEmpty)
        XCTAssertEqual(model.resumeAvailability, .waiting)

        // The category turned off here: nothing is kept for it.
        controller.exchangeDone(summary([tab("t1", "/a.html", space: space)]))
        controller.setCategory(.openTabs, on: false)
        XCTAssertTrue(controller.macOpenTabs.isEmpty)
        XCTAssertEqual(controller.resumeAvailability, .disabledHere)

        // The Mac forgotten: the list and the memory of the last session go.
        controller.setCategory(.openTabs, on: true)
        controller.exchangeDone(summary([tab("t1", "/a.html", space: space)]))
        controller.forgetMac()
        XCTAssertTrue(controller.macOpenTabs.isEmpty)
        XCTAssertEqual(controller.resumeAvailability, .notPaired)
    }

    func testWhyThereIsNoListWhenTheCategoryIsNotOnAtBothEnds() async throws {
        let (model, controller) = try await pairedModel(categories: [.structure])
        XCTAssertEqual(model.resumeAvailability, .disabledHere, "not ticked here: a sentence says how to turn it on")
        controller.setCategory(.openTabs, on: true)
        XCTAssertEqual(model.resumeAvailability, .waiting, "ticked here, no session yet")
        controller.exchangeDone(summary(nil))
        XCTAssertEqual(model.resumeAvailability, .disabledOnMac, "a session went through and the Mac sent none: it has not ticked it")
        controller.exchangeDone(summary([]))
        XCTAssertEqual(model.resumeAvailability, .empty)
        XCTAssertTrue(model.resumeRows.isEmpty)
    }

    // MARK: A touch

    func testATouchOpensTheAddressInANewTabOfTheSpaceOfTheMacAndNothingElseIsWritten() async throws {
        let (model, controller) = try await pairedModel()
        let home = model.state.activeSpaceId
        let work = try addWorkSpace(model)
        controller.exchangeDone(summary([tab("m1", "/b.html", title: "Page B du Mac", space: work.id)]))
        let before = model.state.tabs.count
        let row = try XCTUnwrap(model.resumeRows.first)

        model.resume(row)

        XCTAssertEqual(model.state.tabs.count, before + 1, "a new tab, not the replacement of one")
        XCTAssertEqual(model.state.activeSpaceId, work.id, "the space of the Mac, which exists here")
        let opened = try XCTUnwrap(model.activeTab)
        XCTAssertEqual(opened.url, row.url)
        XCTAssertEqual(opened.spaceId, work.id)
        XCTAssertNotEqual(work.id, home)
        XCTAssertEqual(model.resumeRows.map(\.id), ["m1"], "the list stays: a touch consumes nothing")
    }

    func testARowOfASpaceThatDoesNotExistHereOpensInTheSpaceOnScreen() async throws {
        let (model, controller) = try await pairedModel()
        let home = model.state.activeSpaceId
        controller.exchangeDone(summary([tab("m1", "/b.html", space: "space-of-the-mac-only")]))
        model.resume(try XCTUnwrap(model.resumeRows.first))
        XCTAssertEqual(model.state.activeSpaceId, home)
        XCTAssertEqual(model.activeTab?.url, "http://127.0.0.1:\(port)/b.html")
    }

    func testARowOfALockedSpaceNeverOpensInIt() async throws {
        let (model, controller) = try await pairedModel()
        let lock = LockController(authenticator: AlwaysGranted(), file: nil, spaceIds: nil)
        model.attach(lock)
        let home = model.state.activeSpaceId
        let work = try addWorkSpace(model)
        model.selectSpace(home)
        let guarded = await lock.setSpace(work.id, guarded: true)
        XCTAssertTrue(guarded)
        controller.exchangeDone(summary([tab("m1", "/b.html", space: work.id)]))
        let row = try XCTUnwrap(model.resumeRows.first)
        XCTAssertNil(model.resumeSpaceShown(of: row), "a locked space is not named by the list")
        let before = model.state.tabs(in: work.id).count
        model.resume(row)
        XCTAssertEqual(model.state.tabs(in: work.id).count, before, "nothing goes into the locked space")
        XCTAssertEqual(model.state.activeSpaceId, home)
        XCTAssertEqual(model.activeTab?.url, row.url)
    }

    func testAnAddressThatIsNotAWebPageOpensNothing() async throws {
        let (model, _) = try await pairedModel()
        let before = model.state.tabs.count
        let row = SyncResume.Row(id: "x", url: "javascript:alert(1)", title: "x", host: "x", spaceId: model.state.activeSpaceId, lastActiveAt: 1)
        model.resume(row)
        XCTAssertEqual(model.state.tabs.count, before)
    }

    // MARK: The command bar

    func testTheCommandBarListsTheTabsOfTheMacUnderTheirOwnSourceAndOnlyWhenOffered() async throws {
        let (model, controller) = try await pairedModel(categories: [.structure])
        let space = model.state.activeSpaceId
        XCTAssertTrue(model.offersMacSource, "a Mac is paired: the chip is there, and says how to turn the category on")
        XCTAssertEqual(model.commandBarContent(for: "", filter: .mac).macTabs.count, 0)
        controller.setCategory(.openTabs, on: true)
        controller.exchangeDone(summary([tab("m1", "/a.html", title: "Le Monde", space: space, at: 3), tab("m2", "/b.html", title: "Autre", space: space, at: 2)]))
        XCTAssertEqual(model.commandBarContent(for: "monde", filter: nil).macTabs.map(\.id), ["m1"])
        XCTAssertTrue(model.commandBarContent(for: "", filter: nil).macTabs.isEmpty, "nothing typed: the tabs of this phone and the commands, not a flood of the Mac's")
        XCTAssertEqual(model.commandBarContent(for: "", filter: .mac).macTabs.map(\.id), ["m1", "m2"], "under its filter the source lists all, the latest read first")
        XCTAssertTrue(model.commandBarContent(for: "monde", filter: .tabs).macTabs.isEmpty)
        XCTAssertTrue(model.commandBarContent(for: "monde", filter: .commands).macTabs.isEmpty)
        XCTAssertTrue(model.commandBarContent(for: "monde", filter: nil).sections.contains(.mac))
        controller.forgetMac()
        XCTAssertFalse(model.offersMacSource)
    }

    // MARK: The words

    func testEveryTextIsInFrenchAndEnglishAndTheAgeReadsInTheLanguage() throws {
        func bundle(_ language: String) throws -> Bundle { try XCTUnwrap(Bundle(path: try XCTUnwrap(Bundle.main.path(forResource: language, ofType: "lproj")))) }
        let keys = ["command.filter.mac", "command.section.mac", "resume.title", "resume.age.now", "resume.footer", "resume.notice.not-paired", "resume.notice.disabled-here",
                    "resume.notice.waiting", "resume.notice.disabled-mac", "resume.notice.empty", "resume.notice.no-match"]
        for language in ["fr", "en"] {
            for key in keys {
                let text = try bundle(language).localizedString(forKey: key, value: nil, table: nil)
                XCTAssertNotEqual(text, key, "\(key) has no \(language) text")
            }
        }
        XCTAssertEqual(try bundle("fr").localizedString(forKey: "resume.title", value: nil, table: nil), "Reprendre un onglet du Mac")
        XCTAssertEqual(try bundle("en").localizedString(forKey: "command.filter.mac", value: nil, table: nil), "On the Mac")
        // The sentence that says how to turn the category on names the page and the tick, on both devices.
        XCTAssertTrue(try bundle("fr").localizedString(forKey: "resume.notice.disabled-here", value: nil, table: nil).contains("Onglets ouverts"))
        XCTAssertTrue(try bundle("en").localizedString(forKey: "resume.notice.disabled-here", value: nil, table: nil).contains("Open tabs"))
    }

    // MARK: Pictures

    /// The screen and the command bar draw, in each language and each scheme; a picture of each is written when `LUCIUM_SHOTS` names a folder
    /// (`scripts/ios-check.sh` does), for the person who reads the captures.
    func testTheScreenAndTheBarDrawInBothLanguagesAndSchemes() async throws {
        let (model, controller) = try await pairedModel()
        let home = model.state.activeSpaceId
        let work = try addWorkSpace(model)
        controller.exchangeDone(SyncExchangeSummary(at: Int(Date().timeIntervalSince1970 * 1000) - 5 * 60_000, conflicts: [], refusedSent: [], refusedReceived: [], rejectedByApply: [], applied: true,
                                                    adoptedTheMacState: false, spacesSetAside: 0, openTabs: [
            SyncOpenTab(id: "1", spaceId: work.id, url: "https://www.lemonde.fr/idees/article", title: "Le Monde, édito du jour", lastActiveAt: 30),
            SyncOpenTab(id: "2", spaceId: home, url: "https://developer.apple.com/documentation/swiftui", title: "SwiftUI | Apple Developer Documentation", lastActiveAt: 20),
            SyncOpenTab(id: "3", spaceId: "gone", url: "https://example.org/", title: "", lastActiveAt: 10),
        ]))
        try render(model)
    }

    /// Not async: a run loop cannot be run from an asynchronous context.
    private func render(_ model: BrowserModel) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let screens: [(String, AnyView)] = [
            ("screen", AnyView(NavigationStack { ResumeScreen(model: model) })),
            ("bar", AnyView(CommandBar(model: model, text: "", filter: .mac))),
        ]
        for language in ["en", "fr"] {
            for dark in [false, true] {
                for (name, screen) in screens {
                    let controller = UIHostingController(rootView: screen.environment(\.locale, Locale(identifier: language)))
                    controller.overrideUserInterfaceStyle = dark ? .dark : .light
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
                        try png.write(to: URL(fileURLWithPath: folder).appending(path: "lucium-ios-resume-\(name)-\(language)-\(dark ? "dark" : "light").png"))
                    }
                    window.isHidden = true
                }
            }
        }
    }
}

/// An owner who always says yes: the tests of the lock that do not ask for its answer.
private final class AlwaysGranted: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}
