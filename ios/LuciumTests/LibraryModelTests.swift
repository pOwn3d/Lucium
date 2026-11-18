import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// The lists of a space in the application (favourites, pinned tabs, folders, Today, the archive): what a change does to the views, the files and the
/// saved state. The rules themselves are proved by `LuciumKit` (`swift test`) and by the vectors shared with the Mac.
@MainActor
final class LibraryModelTests: BrowserCoreTestCase {
    /// The time the model reads, moved by hand.
    final class Clock: @unchecked Sendable {
        var now = 1_790_000_000_000.0
    }

    /// A model like the application's, on a clock of its own.
    func makeModel(clock: Clock) async -> BrowserModel {
        var file = StateFile(url: directory.appending(path: StateFile.fileName))
        let load = file.load()
        let model = BrowserModel(state: BrowserModel.defaultState(), stateFile: file,
                                 sideStore: TabSideStore(directory: directory.appending(path: TabSideStore.directoryName, directoryHint: .isDirectory)),
                                 startup: load, clock: { clock.now })
        await model.prepare()
        return model
    }

    func testArchivingATabLetsGoOfItsViewAndItsFilesAndShowsAnotherOfTheSpace() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        let second = try await openTab("/b.html", in: model)
        try model.sideStore?.write(Data([1, 2, 3]), kind: .thumbnail, for: second.id)
        XCTAssertTrue(model.awakeTabIds.contains(second.id))

        model.archive(second)

        XCTAssertFalse(model.awakeTabIds.contains(second.id), "its view is let go")
        XCTAssertNil(model.sideStore?.read(.thumbnail, for: second.id), "its picture goes with it")
        XCTAssertEqual(model.state.archive.first?.id, second.id)
        XCTAssertEqual(model.state.archive.first?.url, second.url, "what it comes back with is its address…")
        XCTAssertEqual(model.state.archive.first?.title, "Page B", "…and its title")
        XCTAssertEqual(model.activeTab?.id, first.id, "the space shows the tab it had left")
        XCTAssertEqual(model.activeTabs.map(\.id), [first.id])
    }

    func testArchivingTheOnlyTabLeavesABlankOneAndKeepsTheEntry() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let only = try XCTUnwrap(model.activeTab)
        model.archive(only)
        XCTAssertTrue(try XCTUnwrap(model.activeTab).isBlank, "a space always shows a tab")
        XCTAssertEqual(model.state.archive.map(\.id), [only.id])
        XCTAssertNotNil(model.webView)
    }

    func testArchiveAllKeepsTheTabOnScreenTheOtherSpacesAndThePinnedOnes() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let pinned = try XCTUnwrap(model.activeTab)
        model.pin(pinned)
        let today1 = try await openTab("/b.html", in: model)
        let today2 = try await openTab("/c.html", in: model)
        model.selectSpace("home")
        try await load("/d.html", in: model)
        let elsewhere = try XCTUnwrap(model.activeTab)
        model.selectSpace("work")
        XCTAssertEqual(model.activeTab?.id, today2.id)

        model.archiveToday()

        XCTAssertEqual(model.todayTabs.map(\.id), [today2.id], "the one on screen stays")
        XCTAssertTrue(model.state.archive.map(\.id).contains(today1.id))
        XCTAssertTrue(model.state.tabs.contains { $0.id == pinned.id && $0.pinned }, "a pinned tab is not Today")
        XCTAssertTrue(model.state.tabs.contains { $0.id == elsewhere.id }, "another space is not touched")
        XCTAssertFalse(model.awakeTabIds.contains(today1.id))
    }

    func testAnArchivedPinnedTabComesBackPinnedInItsFolderAsANewShownTab() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        let folder = try XCTUnwrap(model.newFolder(named: "Reading"))
        model.move(tab, toFolder: folder.id)
        let other = try await openTab("/b.html", in: model)
        model.archive(try XCTUnwrap(model.state.tabs.first { $0.id == tab.id }))
        XCTAssertEqual(model.activeTab?.id, other.id)
        let entry = try XCTUnwrap(model.state.archive.first)
        XCTAssertTrue(entry.pinned && entry.folderId == folder.id)

        model.restore(entry)

        let back = try XCTUnwrap(model.activeTab)
        XCTAssertNotEqual(back.id, tab.id, "a new tab, as on the Mac")
        XCTAssertTrue(back.pinned && back.folderId == folder.id && back.anchorUrl == tab.url)
        XCTAssertTrue(model.state.archive.isEmpty)
        XCTAssertFalse(model.tabsSheetShown)
        try await eventually("the page of the restored tab") { model.webView?.url?.absoluteString == tab.url }
    }

    func testAFavouriteOpensAsATabNoListShowsAndIsShownAgainNotOpenedTwice() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let page = try XCTUnwrap(model.activeTab)
        XCTAssertFalse(model.isFavorite(page))
        model.addFavorite(page)
        XCTAssertTrue(model.isFavorite(page))
        let favorite = try XCTUnwrap(model.favorites.first)
        model.addFavorite(page)
        XCTAssertEqual(model.favorites.count, 1, "the same address is one favourite")

        let other = try await openTab("/b.html", in: model)
        model.openFavorite(favorite)
        let favoritePage = try XCTUnwrap(model.activeTab)
        XCTAssertEqual(favoritePage.favoriteId, favorite.id)
        XCTAssertTrue(model.isShown(favorite))
        XCTAssertFalse(model.todayTabs.contains { $0.id == favoritePage.id }, "its tile stands for it: no row")
        XCTAssertTrue(model.todayTabs.contains { $0.id == other.id })

        model.selectSpace("home")
        XCTAssertTrue(model.favorites.isEmpty, "the favourites are those of the profile of the space")
        model.selectSpace("work")
        model.openFavorite(favorite)
        XCTAssertEqual(model.state.tabs.filter { $0.favoriteId == favorite.id }.count, 1)

        model.removeFavorite(favorite)
        XCTAssertTrue(model.favorites.isEmpty)
        XCTAssertTrue(model.todayTabs.contains { $0.id == favoritePage.id }, "without its favourite the tab is an ordinary one")
    }

    func testAnIdleTabIsSweptWhenTheApplicationStartsAndTheOneOnScreenNever() async throws {
        let clock = Clock()
        let model = await makeModel(clock: clock)
        try await load("/a.html", in: model)
        let idle = try XCTUnwrap(model.activeTab)
        let shown = try await openTab("/b.html", in: model)
        let view = try XCTUnwrap(model.webViews[idle.id])
        XCTAssertNotNil(view)

        clock.now += 11 * 3_600_000
        model.sweepIdleTabs()
        XCTAssertEqual(model.state.archive.count, 0, "12 hours is the delay")

        clock.now += 2 * 3_600_000
        model.sweepIdleTabs()
        XCTAssertEqual(model.state.archive.map(\.id), [idle.id])
        XCTAssertEqual(model.state.archive.first?.source, "auto")
        XCTAssertNil(model.webViews[idle.id], "its view is let go")
        XCTAssertEqual(model.activeTab?.id, shown.id, "the tab on screen is not idle, whatever its date says")
    }

    func testIdleTabsAreSweptWhenTheModelIsReadyAndWhenTheApplicationComesBack() async throws {
        let clock = Clock()
        // A saved state with an idle tab and the tab it was left on (20 hours ago): the sweep is part of starting.
        var state = BrowserModel.defaultState()
        state.openTab(id: "idle", in: "work", url: address("/a.html").absoluteString, title: "Idle", now: clock.now - 20 * 3_600_000)
        state.openTab(id: "left-on", in: "work", url: address("/b.html").absoluteString, title: "Left on", now: clock.now - 20 * 3_600_000)
        let model = BrowserModel(state: state, clock: { clock.now })
        XCTAssertTrue(model.state.archive.isEmpty, "nothing is swept before the application is ready")
        await model.prepare()
        XCTAssertEqual(model.state.archive.map(\.id), ["idle"], "the tab the space showed is not idle, whatever its date says")
        XCTAssertEqual(model.activeTab?.id, "left-on")

        // Back in the foreground 13 hours later: the tab opened since and the one left on have waited longer than the delay; the one on screen has not.
        let later = try await openTab("/c.html", in: model)
        let shown = try await openTab("/d.html", in: model)
        clock.now += 13 * 3_600_000
        model.didBecomeActive()
        XCTAssertEqual(Set(model.state.archive.map(\.id)), ["idle", "left-on", later.id])
        XCTAssertEqual(model.activeTabs.map(\.id), [shown.id], "only the tab on screen is kept")
    }

    func testWhatTheListsChangeIsWrittenToTheStateFile() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        model.pin(tab)
        let folder = try XCTUnwrap(model.newFolder(named: "Reading"))
        model.move(tab, toFolder: folder.id)
        model.flush()
        let saved = try BrowserState.decode(Data(contentsOf: directory.appending(path: StateFile.fileName)))
        XCTAssertEqual(saved.folders.map(\.name), ["Reading"])
        let written = try XCTUnwrap(saved.tabs.first { $0.id == tab.id })
        XCTAssertTrue(written.pinned)
        XCTAssertEqual(written.folderId, folder.id)
        XCTAssertEqual(saved.pinnedRows(in: "work").map(\.id), ["folder:\(folder.id)"])
    }

    func testEntriesOfTheListsThatDoNotReadAreCountedWhenTheModelIsMade() async throws {
        var state = BrowserModel.defaultState()
        state.rest["folders"] = .array([.object(["id": .string("f1"), "spaceId": .string("work"), "name": .string("Good")]), .object(["id": .string("bad")])])
        state.rest["archive"] = .array([.string("nonsense")])
        let model = BrowserModel(state: state)
        XCTAssertEqual(model.unreadableLibraryEntries, ["folders": 1, "archive": 1])
        XCTAssertEqual(model.folders.map(\.id), ["f1"])
        XCTAssertTrue(BrowserModel(state: BrowserModel.defaultState()).unreadableLibraryEntries.isEmpty)
    }

    func testTheProfileLineOfTheSheetSaysTheNameOfTheProfile() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.profileTitle, model.activeSpace.name, "each space of the first state has a profile named like it")
        model.state.setProfileName("Bureau", for: model.activeSpace.profileId)
        XCTAssertEqual(model.profileTitle, "Bureau")
        model.state.spaces[0].profileId = "unnamed"
        XCTAssertEqual(model.profileTitle, "unnamed", "a profile with no name is told by its identifier")
        model.state.spaces[0].profileId = BrowserState.defaultProfileId
        XCTAssertEqual(model.profileTitle, String(localized: "profile.default"))
    }

    func testAPrivateTabIsNeverAFavouriteNorPinnedNorKept() async throws {
        let model = await makeModel()
        model.newPrivateTab()
        let tab = try XCTUnwrap(model.activeTab)
        XCTAssertTrue(tab.isPrivate)
        model.addFavorite(tab)
        XCTAssertTrue(model.favorites.isEmpty, "the Mac refuses a favourite that only private tabs are on")
        model.pin(tab)
        XCTAssertFalse(model.state.tabs.first { $0.id == tab.id }?.pinned ?? true)
        XCTAssertEqual(model.commandTabs(matching: "").map(\.id), [], "a blank private tab has nothing to find")
        model.archive(tab)
        XCTAssertTrue(model.state.archive.isEmpty, "the archive never hears of a private tab")
    }

    /// The start page reads the favourites of the profile of the space on screen; a private tab gets none (`StartPageContent` is proved in `LuciumKit`).
    func testTheStartPageOffersTheFavouritesOfTheProfileOfTheSpaceOnScreenAndAPrivateTabOffersNone() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.startPage, .noFavorites)
        try await load("/a.html", in: model)
        model.addFavorite(try XCTUnwrap(model.activeTab))
        let favorite = try XCTUnwrap(model.favorites.first)
        XCTAssertEqual(model.startPage, .favorites([favorite]))
        model.selectSpace("home")  // another profile
        XCTAssertEqual(model.startPage, .noFavorites)
        model.selectSpace("work")
        model.newPrivateTab()
        XCTAssertEqual(model.startPage, .privateTab, "a private tab is not offered the favourites of the space")
    }

    /// A tile of the start page is a tap on a blank tab: the favourite opens, and the blank tab does not stay in Today (it would, once per tap).
    func testAFavouriteOpenedFromTheStartPageTakesTheBlankTabsPlace() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.addFavorite(try XCTUnwrap(model.activeTab))
        let favorite = try XCTUnwrap(model.favorites.first)
        model.newTab()
        let blank = try XCTUnwrap(model.activeTab)
        XCTAssertTrue(blank.isBlank)
        XCTAssertTrue(model.awakeTabIds.contains(blank.id), "the blank tab holds a view")

        model.openFavorite(favorite)

        XCTAssertEqual(model.activeTab?.favoriteId, favorite.id, "the favourite is on screen")
        XCTAssertFalse(model.state.tabs.contains { $0.id == blank.id }, "the blank tab is gone")
        XCTAssertFalse(model.awakeTabIds.contains(blank.id), "and so is its view")
        XCTAssertFalse(model.commandBarShown || model.tabsSheetShown)
    }

    /// Only a blank tab is replaced: opening a favourite from a page leaves that page open, as the sheet always did.
    func testAFavouriteOpenedFromAPageLeavesThatPageOpen() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.addFavorite(try XCTUnwrap(model.activeTab))
        let favorite = try XCTUnwrap(model.favorites.first)
        let page = try await openTab("/b.html", in: model)

        model.openFavorite(favorite)

        XCTAssertEqual(model.activeTab?.favoriteId, favorite.id)
        XCTAssertTrue(model.state.tabs.contains { $0.id == page.id }, "the page that was on screen is still a tab")
    }

    func testTheCommandsOfferedFollowThePageOnScreen() async throws {
        let model = await makeModel()
        XCTAssertEqual(CommandItem.available(in: model).map(\.id), ["new-tab", "close"], "a blank tab has no page to reload, pin or archive")
        try await load("/a.html", in: model)
        let ids = { CommandItem.available(in: model).map(\.id) }
        XCTAssertEqual(ids(), ["new-tab", "reload", "pin", "favorite", "archive", "close"])
        model.pin(try XCTUnwrap(model.activeTab))
        model.addFavorite(try XCTUnwrap(model.activeTab))
        XCTAssertEqual(ids(), ["new-tab", "reload", "unpin", "archive", "close"])
        _ = try await openTab("/b.html", in: model)
        XCTAssertFalse(ids().contains("archive-all"), "the only Today tab is the one on screen: nothing to archive")
        _ = try await openTab("/c.html", in: model)
        XCTAssertTrue(ids().contains("archive-all"), "another Today tab than the one on screen exists")
    }

    func testTheEngineOfTheProfileIsTheOneWordsAreSearchedWith() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.searchEngineName, "DuckDuckGo")
        XCTAssertEqual(model.request(for: "hello world")?.url?.absoluteString, "https://duckduckgo.com/?q=hello%20world")
        model.state.rest["settings"] = .object(["profiles": .object(["work": .object(["searchUrlTemplate": .string("https://www.ecosia.org/search?q=%s")])])])
        XCTAssertEqual(model.searchEngineName, "Ecosia")
        XCTAssertEqual(model.request(for: "hello world")?.url?.absoluteString, "https://www.ecosia.org/search?q=hello%20world")
        model.selectSpace("home")
        XCTAssertEqual(model.request(for: "hello world")?.url?.host(), "duckduckgo.com", "another profile keeps its own engine")
    }

    func testOpeningWhatWasTypedClosesTheBarAndLoadsTheAddress() async throws {
        let model = await makeModel()
        model.commandBarShown = true
        model.open(address("/a.html").absoluteString)
        XCTAssertFalse(model.commandBarShown)
        try await eventually("the page loads") { model.webView?.url == self.address("/a.html") }
    }
}

/// The owner of the phone, who says yes, for the lock.
private final class GrantingOwner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}

/// What the lock hides from the lists of the sheet, the command bar and the archive: a locked space (or a locked application) shows nothing of
/// itself, however the list is reached. Reading `state.tabs` or `state.archive` directly would walk around the lock: these tests read through the
/// model, as the screens do.
@MainActor
final class LibraryLockTests: BrowserCoreTestCase {
    private func makeLockedModel() async throws -> (BrowserModel, LockController) {
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: GrantingOwner(), file: file)
        let model = BrowserModel.launch(directory: directory, lock: lock, embeddedLists: { nil })
        await model.prepare()
        return (model, lock)
    }

    /// "work" holds a pinned tab in a folder, a Today tab, a favourite and two archived pages; "home" holds a Today tab and an archived page.
    private func seed(_ model: BrowserModel) async throws {
        try await load("/a.html", in: model)
        let pinned = try XCTUnwrap(model.activeTab)
        let folder = try XCTUnwrap(model.newFolder(named: "Secret folder"))
        model.move(pinned, toFolder: folder.id)
        model.addFavorite(pinned)
        _ = try await openTab("/b.html", in: model)
        let old = try await openTab("/c.html", in: model)
        model.archive(old)
        _ = try await openTab("/d.html", in: model)
        model.selectSpace("home")
        try await load("/a.html", in: model)
        let homeOld = try await openTab("/b.html", in: model)
        model.archive(homeOld)
        model.selectSpace("work")
    }

    func testALockedSpaceListsNothingOfItselfAnywhere() async throws {
        let (model, lock) = try await makeLockedModel()
        try await seed(model)
        XCTAssertFalse(model.todayTabs.isEmpty && model.pinnedRows().isEmpty, "something to hide")
        XCTAssertEqual(model.favorites.count, 1)
        XCTAssertEqual(model.archiveCount, 2)
        let workTitles = Set(model.state.tabs(in: "work").map(\.title))
        let workEntry = try XCTUnwrap(model.state.archive.first { $0.spaceId == "work" })
        XCTAssertTrue(CommandItem.available(in: model).count > 1)
        XCTAssertEqual(model.startPage, .favorites(model.favorites), "something for the start page to hide")

        let locked = await lock.setSpace("work", guarded: true)
        XCTAssertTrue(locked)
        XCTAssertTrue(model.activeSpaceCovered)

        // The sheet of tabs.
        XCTAssertTrue(model.todayTabs.isEmpty && model.pinnedRows().isEmpty && model.folders.isEmpty && model.favorites.isEmpty)
        XCTAssertNil(model.folder(try XCTUnwrap(model.state.folders.first).id), "not even a folder by its identifier")
        XCTAssertTrue(model.tabsMatching("").isEmpty && model.tabsMatching("page").isEmpty)
        // The command bar: the tabs of the other spaces are still found, those of the locked one never are.
        let found = model.commandTabs(matching: "").map(\.spaceId)
        XCTAssertFalse(found.isEmpty, "the other space is not locked")
        XCTAssertFalse(found.contains("work"), "\(found)")
        XCTAssertTrue(model.commandTabs(matching: "page").allSatisfy { !workTitles.contains($0.title) || $0.spaceId != "work" })
        XCTAssertTrue(model.commandFavorites(matching: "").isEmpty)
        XCTAssertEqual(model.startPage, .hidden, "nor does its start page say there are favourites, or that there are none")
        XCTAssertTrue(CommandItem.available(in: model).isEmpty, "a locked space has nothing to do from the bar")
        // The archive: the pages of the locked space are neither listed, nor counted, nor brought back, nor forgotten.
        XCTAssertEqual(model.archiveCount, 1)
        XCTAssertEqual(model.archiveGroups.flatMap(\.entries).map(\.spaceId), ["home"])
        let before = model.state.tabs.count
        model.restore(workEntry)
        XCTAssertEqual(model.state.tabs.count, before, "a stale row does not bring a locked page back")
        XCTAssertTrue(model.state.archive.contains { $0.id == workEntry.id })
        model.clearArchive()
        XCTAssertTrue(model.state.archive.contains { $0.id == workEntry.id }, "what the lock hides is not emptied with the rest")
        XCTAssertFalse(model.state.archive.contains { $0.spaceId == "home" })
        // The ways to act on a locked space.
        let hidden = try XCTUnwrap(model.state.tabs(in: "work").first { !$0.pinned })
        model.show(hidden)
        model.archive(hidden)
        model.pin(hidden)
        model.archiveToday()
        XCTAssertTrue(model.state.tabs.contains { $0.id == hidden.id && !$0.pinned }, "nothing was archived or pinned from outside the lock")
        XCTAssertEqual(model.state.tabs(in: "work").count, workTitles.count)

        // Opened by the owner, the space lists what it held.
        let opened = await lock.unlock(space: "work")
        XCTAssertTrue(opened)
        XCTAssertFalse(model.todayTabs.isEmpty)
        XCTAssertEqual(model.favorites.count, 1)
        XCTAssertEqual(model.archiveCount, 1, "the page of the space that was locked is listed again (the one of the other space was emptied)")
    }

    func testALockedApplicationHidesEverySpaceAndClosesTheCommandBar() async throws {
        let (model, lock) = try await makeLockedModel()
        try await seed(model)
        let on = await lock.setLockApp(true)
        XCTAssertTrue(on)
        model.commandBarShown = true
        lock.lockAll()
        XCTAssertTrue(lock.appLocked)
        XCTAssertFalse(model.commandBarShown, "the bar is closed when the application is locked")
        XCTAssertTrue(model.commandTabs(matching: "").isEmpty, "no space is listed in a locked application")
        XCTAssertEqual(model.archiveCount, 0)
        XCTAssertTrue(model.todayTabs.isEmpty && model.favorites.isEmpty)
        model.selectSpace("home")
        XCTAssertTrue(model.todayTabs.isEmpty && model.commandTabs(matching: "").isEmpty, "the other space is covered too")
    }

    func testWithoutALockNothingIsHidden() async throws {
        let model = await makeModel()
        XCTAssertNil(model.lock)
        try await load("/a.html", in: model)
        XCTAssertFalse(model.isCovered("work"))
        XCTAssertEqual(model.commandTabs(matching: "").count, 1)
    }
}

