import LuciumKit
import XCTest
@testable import Lucium

/// The Today tabs of the other device, written into the model (docs/synchronisation.md §27, card 509): a tab that arrives is made at rest, with no web view and nothing loaded,
/// and never takes the screen; a tab on screen that the other device closed is archived, the neighbour is shown, and the model says so. The rules of the write are proved in
/// LuciumKit (`SyncTodayTabsTests`); this is what the application adds around it.
@MainActor
final class SyncTodayTabsAppTests: BrowserCoreTestCase {
    private func patch(_ build: (inout SyncPatch) -> Void) -> SyncPatch {
        var patch = SyncPatch()
        build(&patch)
        return patch
    }

    private func arrival(_ id: String, space: String, path: String, activeAt: Double) -> SyncPatch.Upsert {
        SyncPatch.Upsert(kind: .todayTab, id: id, create: true, fields: ["spaceId": .string(space), "url": .string(address(path).absoluteString), "title": .string("Page \(id)"), "activeAt": .number(activeAt)], remove: [],
                         expect: [:])
    }

    private func closing(_ tab: TabItem) -> SyncPatch.Removal {
        SyncPatch.Removal(kind: .todayTab, id: tab.id, expect: ["spaceId": .string(tab.spaceId), "activeAt": .number(Double(SyncToday.roundActiveAt(tab.lastActiveAt ?? 0)))])
    }

    func testATabOfTheOtherDeviceArrivesAsleepAndTheScreenDoesNotMove() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let shown = try XCTUnwrap(model.activeTab)
        let space = model.state.activeSpaceId
        let outcome = model.applySyncPatch(patch { $0.upserts = [arrival("from-mac", space: space, path: "/b.html", activeAt: 1_790_000_000_000 - 3_600_000)] })
        XCTAssertTrue(outcome.changed)
        let arrived = try XCTUnwrap(model.state.tabs.first { $0.id == "from-mac" })
        XCTAssertNil(model.webViews["from-mac"], "no web view: nothing is loaded until the tab is opened (§27.12)")
        XCTAssertFalse(model.awakeTabIds.contains("from-mac"))
        XCTAssertEqual(model.activeTab?.id, shown.id, "an arrival never takes the screen (§27.6)")
        XCTAssertEqual(model.state.activeSpaceId, space)
        XCTAssertTrue(model.state.todayTabs(in: space).contains { $0.id == "from-mac" }, "it is in the list of Today")
        XCTAssertNil(model.syncClosedShownTab)
        // Opened by the person, it wakes where it was sent: the page it carries.
        model.openTab(arrived)
        XCTAssertNotNil(model.webViews["from-mac"])
    }

    func testTheTabOnScreenThatTheOtherDeviceClosedIsArchivedAndTheNeighbourIsShown() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        let space = model.state.activeSpaceId
        model.applySyncPatch(patch { $0.upserts = [arrival("closed-there", space: space, path: "/b.html", activeAt: 1_790_000_000_000 - 3_600_000)] })
        model.openTab(try XCTUnwrap(model.state.tabs.first { $0.id == "closed-there" }))
        XCTAssertEqual(model.activeTab?.id, "closed-there")
        XCTAssertNotNil(model.webViews["closed-there"], "awake: it is on screen")
        let closedTab = try XCTUnwrap(model.activeTab)
        let outcome = model.applySyncPatch(patch { $0.removals = [closing(closedTab)] })
        XCTAssertEqual(outcome.closedTabIDs, ["closed-there"])
        XCTAssertFalse(model.state.tabs.contains { $0.id == "closed-there" })
        XCTAssertNil(model.webViews["closed-there"], "its view goes with it")
        XCTAssertEqual(model.activeTab?.id, first.id, "the neighbour is shown")
        let entry = try XCTUnwrap(model.state.archive.first { $0.id == "closed-there" })
        XCTAssertEqual(entry.source, ArchivedTab.Source.sync.rawValue)
        XCTAssertEqual(entry.url, address("/b.html").absoluteString)
        let event = try XCTUnwrap(model.syncClosedShownTab, "the line « Fermé sur le Mac » has what it needs")
        XCTAssertEqual(event.id, "closed-there")
        XCTAssertEqual(event.title, closedTab.title)
    }

    func testReopeningTheTabTheMacClosedBringsItsPageBackAndTheLineGoes() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let space = model.state.activeSpaceId
        model.applySyncPatch(patch { $0.upserts = [arrival("closed-there", space: space, path: "/b.html", activeAt: 1_790_000_000_000 - 3_600_000)] })
        model.openTab(try XCTUnwrap(model.state.tabs.first { $0.id == "closed-there" }))
        let closedTab = try XCTUnwrap(model.activeTab)
        model.applySyncPatch(patch { $0.removals = [closing(closedTab)] })
        XCTAssertNotNil(model.syncClosedShownTab)
        model.reopenSyncClosedShownTab()
        XCTAssertNil(model.syncClosedShownTab, "the line goes")
        XCTAssertEqual(model.activeTab?.url, address("/b.html").absoluteString, "the page is shown again")
        XCTAssertNotEqual(model.activeTab?.id, "closed-there", "as a new tab, with a new identifier (§27.5)")
        XCTAssertFalse(model.state.archive.contains { $0.id == "closed-there" }, "and no longer in the archive")
    }

    func testReopeningWithNothingClosedDoesNothing() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let before = model.state
        model.reopenSyncClosedShownTab()
        XCTAssertEqual(model.state, before)
    }

    func testATabClosedThereThatWasNotOnScreenSaysNothing() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let space = model.state.activeSpaceId
        model.applySyncPatch(patch { $0.upserts = [arrival("background", space: space, path: "/c.html", activeAt: 1_790_000_000_000 - 3_600_000)] })
        let tab = try XCTUnwrap(model.state.tabs.first { $0.id == "background" })
        let shown = model.activeTab?.id
        model.applySyncPatch(patch { $0.removals = [closing(tab)] })
        XCTAssertFalse(model.state.tabs.contains { $0.id == "background" })
        XCTAssertNil(model.syncClosedShownTab)
        XCTAssertEqual(model.activeTab?.id, shown)
        XCTAssertEqual(model.state.archive.first { $0.id == "background" }?.source, ArchivedTab.Source.sync.rawValue)
    }
}
