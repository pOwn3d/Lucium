import LuciumKit
import UIKit
import WebKit
import XCTest
@testable import Lucium

/// An owner of the phone that says what it is told to (the lock asks it before it turns on or opens a space).
private final class Owner: LockAuthenticating, @unchecked Sendable {
    private let guardLock = NSLock()
    private var outcomeValue: LockOutcome = .granted
    var outcome: LockOutcome { get { guardLock.withLock { outcomeValue } } set { guardLock.withLock { outcomeValue = newValue } } }
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { outcome }
}

/// Spaces, profiles, private tabs and the data of a site, on real web views and real stores. A page of a local server stands for a site; its cookies
/// are written by the page itself (`document.cookie`), the way a site writes them.
@MainActor
final class SpacesTests: BrowserCoreTestCase {
    /// Profiles are stores on the disk of the simulator, and the same ids come back in every test: each test starts from stores with nothing in them.
    /// The data is erased, not the stores removed: a store that a view of a former test still holds cannot be removed, and cannot lose its data either way.
    private func eraseEveryProfile() async {
        for id in await WKWebsiteDataStore.allDataStoreIdentifiers {
            await WKWebsiteDataStore(forIdentifier: id).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        }
    }

    override func setUp() async throws {
        try await super.setUp()
        await eraseEveryProfile()
    }

    override func tearDown() async throws {
        await eraseEveryProfile()
        try await super.tearDown()
    }

    /// What went wrong, when something did.
    private func failure<T>(_ result: Result<T, BrowserModel.SpaceFailure>) -> BrowserModel.SpaceFailure? {
        if case .failure(let error) = result { error } else { nil }
    }

    private func cookie(in model: BrowserModel, file: StaticString = #filePath, line: UInt = #line) async throws -> String {
        let view = try XCTUnwrap(model.webView, "no web view", file: file, line: line)
        return try await view.evaluateJavaScript("document.cookie") as? String ?? ""
    }

    private func setCookie(_ pair: String, in model: BrowserModel) async throws {
        let view = try XCTUnwrap(model.webView)
        _ = try await view.evaluateJavaScript("document.cookie = '\(pair); path=/'")
    }

    private func cookieNames(of profileId: String) async -> [String] {
        await WKWebsiteDataStore(forIdentifier: ProfileStore.identifier(for: profileId)).httpCookieStore.allCookies().map(\.name).sorted()
    }

    // MARK: Profiles

    /// The fix of the card: two spaces with two profiles share no cookie; two spaces with the same profile do.
    func testTwoProfilesShareNoCookieAndTwoSpacesOfOneProfileDo() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)  // the space "work", profile "work"
        try await setCookie("who=work", in: model)
        let cookieOfWork = try await cookie(in: model)
        XCTAssertEqual(cookieOfWork, "who=work")

        model.selectSpace("home")  // profile "home"
        try await load("/a.html", in: model)
        let cookieOfHome = try await cookie(in: model)
        XCTAssertEqual(cookieOfHome, "", "another profile: the cookie of the first profile is not there")
        let homeNames = await cookieNames(of: "home")
        XCTAssertEqual(homeNames, [], "…not even in its store")
        try await setCookie("who=home", in: model)

        model.selectSpace("work")
        let workAgain = try await cookie(in: model)
        XCTAssertEqual(workAgain, "who=work", "each profile keeps its own")

        // A new space on the profile "work" shares its cookies.
        guard case .success(let second) = model.addSpace(name: "Second", emoji: "📚", profile: .existing("work"), hue: 55) else { return XCTFail("the space was refused") }
        XCTAssertEqual(model.activeSpace.id, second.id, "a new space is shown")
        try await load("/a.html", in: model)
        let shared = try await cookie(in: model)
        XCTAssertEqual(shared, "who=work", "two spaces of one profile share its cookies")
        XCTAssertEqual(model.webView?.configuration.websiteDataStore.identifier, ProfileStore.identifier(for: "work"))
    }

    func testANewProfileFromTheSpaceFormHasItsOwnStoreAndOutlivesItsSpace() async throws {
        let model = await makeModel()
        guard case .success(let space) = model.addSpace(name: "Lecture", emoji: "📚", profile: .new("Lecture & Co"), hue: 130) else { return XCTFail("refused") }
        XCTAssertEqual(space.profileId, "lecture-co")
        XCTAssertEqual(model.label(ofProfile: "lecture-co"), "Lecture & Co")
        try await load("/a.html", in: model)
        try await setCookie("who=reading", in: model)
        let before = await cookieNames(of: "lecture-co")
        XCTAssertEqual(before, ["who"])

        model.selectSpace("work")
        guard case .success = model.deleteSpace(space.id) else { return XCTFail("the space was not deleted") }
        XCTAssertTrue(model.state.profileIds.contains("lecture-co"), "a profile outlives its last space")
        let after = await cookieNames(of: "lecture-co")
        XCTAssertEqual(after, ["who"], "…and keeps its cookies")
    }

    func testRemovingAProfileNoSpaceUsesErasesItsData() async throws {
        let model = await makeModel()
        guard case .success(let id) = model.addProfile(named: "Temp") else { return XCTFail("refused") }
        do {
            let store = WKWebsiteDataStore(forIdentifier: ProfileStore.identifier(for: id))
            let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "left", .value: "behind"]))
            await store.httpCookieStore.setCookie(cookie)
            let names = await store.httpCookieStore.allCookies().map(\.name)
            XCTAssertEqual(names, ["left"])
        }
        let before = await WKWebsiteDataStore.allDataStoreIdentifiers
        XCTAssertTrue(before.contains(ProfileStore.identifier(for: id)), "the store of the profile exists on the disk")
        // A profile a space uses is refused, and nothing is erased.
        let refused = await model.removeProfile("work")
        XCTAssertEqual(failure(refused), .invalid(.profileInUse))
        let kept = await WKWebsiteDataStore.allDataStoreIdentifiers
        XCTAssertTrue(kept.contains(ProfileStore.identifier(for: "work")) || !before.contains(ProfileStore.identifier(for: "work")), "a profile in use keeps its store")

        let removed = await model.removeProfile(id)
        XCTAssertNil(failure(removed), "\(removed)")
        XCTAssertFalse(model.state.profileIds.contains(id))
        // The store itself is deleted from the disk, not only emptied: nothing of the profile is left behind.
        let after = await WKWebsiteDataStore.allDataStoreIdentifiers
        XCTAssertFalse(after.contains(ProfileStore.identifier(for: id)), "the store of the profile is gone")
        let names = await cookieNames(of: id)
        XCTAssertEqual(names, [], "what the profile held is gone")
    }

    func testDeletingASpaceFreesItsViewsAndFilesAndMovesToANeighbour() async throws {
        let model = await makeModel()
        model.selectSpace("home")
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        XCTAssertTrue(model.awakeTabIds.contains(tab.id))

        guard case .success = model.deleteSpace("home") else { return XCTFail("refused") }
        XCTAssertFalse(model.awakeTabIds.contains(tab.id), "the view of the tab is freed")
        XCTAssertNil(model.state.tabs.first { $0.id == tab.id })
        XCTAssertEqual(model.spaces.map(\.id), ["work", "projects"])
        XCTAssertEqual(model.activeSpace.id, "projects", "the space on screen was deleted: the next one shows")
        XCTAssertNotNil(model.webView, "the space that shows has a tab")

        guard case .success = model.deleteSpace("work") else { return XCTFail("refused") }
        XCTAssertEqual(failure(model.deleteSpace("projects")), .invalid(.lastSpace), "the last space stays")
        XCTAssertEqual(model.spaces.map(\.id), ["projects"])
    }

    func testSpacesAndProfilesComeBackAfterARestartWithTheirThemes() async throws {
        let model = await makeModel()
        guard case .success(let space) = model.addSpace(name: "Jeux", emoji: "🎮", profile: .new("Loisirs"), hue: 345) else { return XCTFail("refused") }
        XCTAssertNil(failure(model.updateSpace(space.id, name: "Jeux vidéo", emoji: "🕹️", hue: 55)))
        model.flush()

        let again = BrowserModel.launch(directory: directory)
        let saved = try XCTUnwrap(again.spaces.first { $0.id == space.id })
        XCTAssertEqual(saved.name, "Jeux vidéo")
        XCTAssertEqual(saved.emoji, "🕹️")
        XCTAssertEqual(saved.tint, SpaceTheme.swatch(hue: 55))
        XCTAssertEqual(again.label(ofProfile: "loisirs"), "Loisirs")
        XCTAssertEqual(again.colors(of: saved).count, 2)
        // The three spaces of a first launch have a theme the Mac would have written.
        XCTAssertTrue(again.spaces.prefix(3).allSatisfy { $0.themeColors.count == 2 })
    }

    // MARK: Private tabs

    func testAPrivateTabHasAStoreInMemoryOnlyAndLeavesNothingInTheProfile() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        try await setCookie("who=work", in: model)

        model.newPrivateTab()
        let tab = try XCTUnwrap(model.activeTab)
        XCTAssertTrue(tab.isPrivate)
        try await load("/b.html", in: model)
        let view = try XCTUnwrap(model.webView)
        XCTAssertFalse(view.configuration.websiteDataStore.isPersistent, "a private tab keeps nothing on the disk")
        let seen = try await cookie(in: model)
        XCTAssertEqual(seen, "", "a private tab does not see the cookies of the profile")
        try await setCookie("secret=1", in: model)
        let names = await cookieNames(of: "work")
        XCTAssertEqual(names, ["who"], "what a private tab sets never reaches the profile")

        // A second private tab shares the one in-memory store; closing the last one lets it go, and WebKit forgets what it held.
        model.newPrivateTab()
        let secondSeen = try await cookie(in: model)
        XCTAssertEqual(secondSeen, "", "a blank private tab has no page: it sees no cookie")
        model.closePrivateTabs()
        XCTAssertNil(model.privateStore, "the store of the private tabs is let go with the last one")
        XCTAssertTrue(model.state.privateTabs.isEmpty)
        model.newPrivateTab()
        try await load("/b.html", in: model)
        let fresh = try await cookie(in: model)
        XCTAssertEqual(fresh, "", "a new private tab starts with nothing")
    }

    func testAPrivateTabIsNeverWrittenAnywhere() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.newPrivateTab()
        let tab = try XCTUnwrap(model.activeTab)
        try await load("/b.html", in: model)
        try putOnScreen(try XCTUnwrap(model.webView))  // a picture can only be taken of a view that is on a screen
        await model.enterBackground()  // writes the state, the page states and the picture of the tab on screen
        model.flush()

        let text = try String(contentsOf: directory.appending(path: StateFile.fileName), encoding: .utf8)
        XCTAssertFalse(text.contains(tab.id), "the state file names no private tab")
        XCTAssertFalse(text.contains("/b.html") || text.contains("Page B"), "…nor its page")
        XCTAssertNil(model.sideStore?.read(.interaction, for: tab.id), "no page state of a private tab")
        XCTAssertNil(model.sideStore?.read(.thumbnail, for: tab.id), "no picture of a private tab")
        let kept = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(kept.filter { $0.hasPrefix(StateFile.fileName) }, [StateFile.fileName], "no other copy of the state")

        // After a restart nothing of it is back, and the space shows the tab it had.
        let again = BrowserModel.launch(directory: directory)
        XCTAssertNil(again.state.tabs.first { $0.id == tab.id })
        XCTAssertTrue(again.state.privateTabs.isEmpty)
        XCTAssertEqual(again.activeTab?.url, address("/a.html").absoluteString)
    }

    func testAPrivateTabIsNotPutToSleepBeyondTheCapAndKeepsNoPageStateEvenUnderMemoryPressure() async throws {
        let model = await makeModel(cap: 1)
        model.newPrivateTab()
        let secret = try XCTUnwrap(model.activeTab)
        try await load("/a.html", in: model)
        try await openTab("/b.html", in: model)
        await model.sleepSurplus()
        XCTAssertTrue(model.awakeTabIds.contains(secret.id), "a private tab that sleeps would lose its cookies: it stays awake past the cap")

        await model.sleepSurplus(underPressure: true)
        XCTAssertFalse(model.awakeTabIds.contains(secret.id), "under memory pressure only the tab on screen stays")
        XCTAssertNil(model.sideStore?.read(.interaction, for: secret.id), "…and the history of its page is not written to the disk")
    }

    // MARK: The lock

    /// Every list and every action of this card goes through the lock: a locked space shows no count of tabs, no private tab, and cannot be deleted
    /// behind its lock, receive a private tab or have the data of a site cleared while it is covered.
    func testALockedSpaceShowsNoCountNoPrivateTabAndIsNotDeletedNorGivenOneNorCleared() async throws {
        let owner = Owner()
        let lock = LockController(authenticator: owner, file: LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName)))
        let model = BrowserModel.launch(directory: directory, lock: lock, embeddedLists: { nil })
        await model.prepare()
        try await load("/a.html", in: model)  // work
        let work = model.activeSpace
        XCTAssertEqual(model.tabCount(in: work), 1)
        model.newPrivateTab()
        XCTAssertEqual(model.visiblePrivateTabs.count, 1)

        model.selectSpace("home")
        let locked = await lock.setSpace("work", guarded: true)
        XCTAssertTrue(locked)
        XCTAssertNil(model.tabCount(in: work), "a locked space says nothing of what it holds")
        XCTAssertNotNil(model.tabCount(in: model.activeSpace), "the other spaces still do")
        XCTAssertTrue(model.visiblePrivateTabs.isEmpty, "not even that it holds a private tab")
        XCTAssertEqual(failure(model.deleteSpace("work")), .locked)
        XCTAssertNotNil(model.spaces.first { $0.id == "work" }, "a locked space is not deleted behind its lock")
        model.closePrivateTabs()
        XCTAssertEqual(model.state.privateTabs.count, 1, "the private tab of a locked space is not reached either")

        owner.outcome = .refused(.failed)
        model.selectSpace("work")  // asks the owner, who refuses: the space stays covered
        XCTAssertTrue(model.activeSpaceCovered)
        model.newPrivateTab()
        XCTAssertEqual(model.state.privateTabs.count, 1, "no tab is added to a locked space, private or not")
        let erased = await model.clearSiteData(host: "127.0.0.1")
        XCTAssertEqual(erased, 0)
        XCTAssertNil(model.siteOfActivePage)
    }

    // MARK: The data of a site

    /// A site is a host: `127.0.0.1` and `localhost` are two sites for the same server. Clearing one in a profile leaves the other, and leaves the
    /// same site in another profile.
    func testClearingTheDataOfASiteErasesItInThatProfileOnly() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)  // work, 127.0.0.1
        try await setCookie("a=1", in: model)
        let view = try XCTUnwrap(model.webView)
        let waiter = NavigationWaiter()
        let other = try XCTUnwrap(URL(string: "http://localhost:\(port)/b.html"))
        try await waiter.load(in: view) { view.load(URLRequest(url: other)) }
        try await setCookie("b=2", in: model)

        model.selectSpace("home")
        try await load("/a.html", in: model)  // home, 127.0.0.1
        try await setCookie("c=3", in: model)
        model.selectSpace("work")

        XCTAssertEqual(model.siteOfActivePage, "localhost", "the page on screen is the one on localhost")
        let erased = await model.clearSiteData(host: "127.0.0.1")
        XCTAssertGreaterThan(erased, 0, "WebKit named a record for the site")
        let work = await cookieNames(of: "work")
        XCTAssertEqual(work, ["b"], "127.0.0.1 is gone from the profile of the space, localhost stays")
        let home = await cookieNames(of: "home")
        XCTAssertEqual(home, ["c"], "the same site in another profile is not touched")

        let none = await model.clearSiteData(host: "127.0.0.1")
        XCTAssertEqual(none, 0, "nothing left to erase")
    }

    func testThereIsNoSiteToClearOnAPrivateOrBlankTab() async throws {
        let model = await makeModel()
        XCTAssertNil(model.siteOfActivePage, "a blank tab is on no site")
        try await load("/a.html", in: model)
        XCTAssertEqual(model.siteOfActivePage, "127.0.0.1")
        model.newPrivateTab()
        try await load("/b.html", in: model)
        XCTAssertNil(model.siteOfActivePage, "a private tab keeps nothing to clear")
    }
}
