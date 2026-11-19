import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// Bookmarks and "Read later" in the application: what the menu's actions do to the tabs, the lists and the saved state. The rules themselves
/// (outcomes, limits, search, the stored shape) are proved by `LuciumKit` (`swift test`) and by the vectors shared with the Mac.
@MainActor
final class KeptModelTests: BrowserCoreTestCase {
    func testBookmarkingThePageOnScreenKeepsItAndATapRemovesIt() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        XCTAssertNotNil(model.keepableTab)
        XCTAssertFalse(model.activePageIsBookmarked)

        model.toggleBookmark()
        XCTAssertEqual(model.bookmarks.map(\.url), [tab.url])
        XCTAssertEqual(model.bookmarks.first?.title, "Page A")
        XCTAssertEqual(model.keepNotice, .bookmarkSaved)
        XCTAssertTrue(model.activePageIsBookmarked)
        XCTAssertEqual(model.activeTab?.id, tab.id, "a bookmark leaves the tab open")

        model.toggleBookmark()
        XCTAssertTrue(model.bookmarks.isEmpty)
        XCTAssertEqual(model.keepNotice, .bookmarkRemoved)
    }

    func testReadLaterKeepsThePageAndClosesItsTabButNotAPinnedOne() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        let second = try await openTab("/b.html", in: model)

        model.readLater()
        XCTAssertEqual(model.readLaterPages.map(\.url), [second.url])
        XCTAssertEqual(model.keepNotice, .readLaterSaved)
        XCTAssertFalse(model.state.tabs.contains { $0.id == second.id }, "the tab of the page is closed")
        XCTAssertEqual(model.activeTab?.id, first.id)

        // A pinned tab is not closed by keeping its page, and a page already in the list is not added twice.
        model.pin(first)
        model.readLater()
        XCTAssertEqual(model.readLaterPages.count, 2)
        XCTAssertTrue(model.state.tabs.contains { $0.id == first.id })
        model.readLater()
        XCTAssertEqual(model.readLaterPages.count, 2)
        XCTAssertEqual(model.keepNotice, .readLaterAlready)
    }

    func testAPrivateTabAndABlankTabKeepNothing() async throws {
        let model = await makeModel()
        XCTAssertNil(model.keepableTab, "a blank tab has no page to keep")
        model.toggleBookmark()
        XCTAssertEqual(model.keepNotice, .unsupported)

        model.newPrivateTab()
        try await load("/a.html", in: model)
        XCTAssertNil(model.keepableTab, "a private page leaves no trace")
        model.readLater()
        model.toggleBookmark()
        XCTAssertTrue(model.bookmarks.isEmpty && model.readLaterPages.isEmpty)
    }

    func testOpeningAKeptPageOpensANewTabAndLeavesItInItsList() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.toggleBookmark()
        let before = model.state.tabs.count
        model.keptShown = true

        model.openKept(address: try XCTUnwrap(model.bookmarks.first).url)
        XCTAssertFalse(model.keptShown, "the sheet closes")
        XCTAssertEqual(model.state.tabs.count, before + 1)
        XCTAssertEqual(model.bookmarks.count, 1, "the page stays in its list")
        // What is not a web page is not opened.
        model.openKept(address: "javascript:alert(1)")
        XCTAssertEqual(model.state.tabs.count, before + 1)
    }

    func testRemovingAndClearingTheListsAreSaved() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.toggleBookmark()
        let second = try await openTab("/b.html", in: model)
        model.readLater()
        XCTAssertEqual(model.readLaterPages.map(\.url), [second.url])

        model.removeBookmark(try XCTUnwrap(model.bookmarks.first))
        model.removeReadLater(try XCTUnwrap(model.readLaterPages.first))
        XCTAssertTrue(model.bookmarks.isEmpty && model.readLaterPages.isEmpty)
        model.clearReadLater()
        XCTAssertTrue(model.readLaterPages.isEmpty)
    }
}
