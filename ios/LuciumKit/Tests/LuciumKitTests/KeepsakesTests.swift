import Foundation
import Testing
@testable import LuciumKit

private func vectors() throws -> [String: JSONValue] {
    let file = URL(fileURLWithPath: #filePath)
    let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Contracts/bookmark-vectors.json")
    guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)) else { return [:] }
    return fields
}

private func rows(_ value: JSONValue?) -> [[String: JSONValue]] {
    guard case .array(let items)? = value else { return [] }
    return items.compactMap { if case .object(let fields) = $0 { fields } else { nil } }
}

private func strings(_ value: JSONValue?) -> [String] {
    guard case .array(let items)? = value else { return [] }
    return items.compactMap { if case .string(let text) = $0 { text } else { nil } }
}

private func bookmarkList(_ all: [String: JSONValue]) -> [Bookmark] {
    rows(all["bookmarks"]).compactMap { Bookmark(json: .object($0)) }
}

@Suite("Bookmarks and read later")
struct KeepsakesTests {
    // MARK: Rules shared with the Mac

    @Test func keysFollowTheMacsVectors() throws {
        let all = try vectors()
        let cases = rows(all["keys"])
        #expect(cases.count > 3)
        for row in cases { #expect(Keepsakes.key(of: row.string("input") ?? "") == row.string("expect"), "\(row.string("input") ?? "")") }
    }

    @Test func webAddressesFollowTheMacsVectors() throws {
        for row in rows(try vectors()["webAddresses"]) {
            #expect(Keepsakes.isWebAddress(row.string("input") ?? "", max: 4096) == row.bool("expect"), "\(row.string("input") ?? "")")
        }
    }

    @Test func searchesFollowTheMacsVectors() throws {
        let all = try vectors()
        let list = bookmarkList(all)
        #expect(list.count == 3)
        for row in rows(all["filters"]) {
            let found = Keepsakes.filter(list, query: row.string("query") ?? "", tags: strings(row["tags"])).map(\.id)
            #expect(found == strings(row["expect"]), "\(row.string("query") ?? "") \(strings(row["tags"]))")
        }
        let pages = rows(all["readLater"]).compactMap { ReadLaterItem(json: .object($0)) }
        for row in rows(all["readLaterFilters"]) {
            #expect(Keepsakes.filter(pages, query: row.string("query") ?? "").map(\.id) == strings(row["expect"]), "\(row.string("query") ?? "")")
        }
    }

    // MARK: Bookmarks

    @Test func addingABookmarkPutsItFirstAndKeepsEachPageOnce() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        #expect(state.addBookmark(id: "a", url: "https://one.example/", title: "One", now: 10) == .saved)
        #expect(state.addBookmark(id: "b", url: "https://two.example/", title: "  Two  ", now: 20) == .saved)
        #expect(state.bookmarks.map(\.id) == ["b", "a"])
        #expect(state.bookmarks.first?.title == "Two" && state.bookmarks.first?.addedAt == 20)
        // The same page spelled otherwise is the same page: the one already there stays as it is.
        #expect(state.addBookmark(id: "c", url: "https://ONE.example", title: "Again", now: 30) == .already)
        #expect(state.bookmarks.map(\.id) == ["b", "a"])
    }

    @Test func aBookmarkIsRefusedForWhatIsNotAWebPage() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        for address in ["about:blank", "javascript:alert(1)", "file:///x", "ftp://x.example", "", "https://" + String(repeating: "a", count: 5000)] {
            #expect(state.addBookmark(id: "x", url: address, title: "t", now: 1) == .unsupported, "\(address.prefix(30))")
        }
        #expect(state.bookmarks.isEmpty)
        // A state that never had the list does not gain an empty one.
        #expect(state.rest["bookmarks"] == nil)
    }

    @Test func aFullLibraryRefusesTheNewPageAndKeepsTheOthers() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.bookmarks = (0..<Keepsakes.bookmarksLimit).map { Bookmark(id: "b\($0)", url: "https://p\($0).example/", title: "p", addedAt: 0) }
        #expect(state.addBookmark(id: "new", url: "https://new.example/", title: "New", now: 1) == .full)
        #expect(state.bookmarks.count == Keepsakes.bookmarksLimit && !state.bookmarks.contains { $0.id == "new" })
    }

    @Test func aTitleIsMadePrintableCutAndFallsBackToTheHost() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.addBookmark(id: "a", url: "https://host.example/p", title: "   ", now: 1)
        state.addBookmark(id: "b", url: "https://long.example/", title: String(repeating: "x", count: 900) + "\n", now: 2)
        state.addBookmark(id: "c", url: "https://ctl.example/", title: "a\u{0007}b\nc", now: 3)
        let byId = Dictionary(uniqueKeysWithValues: state.bookmarks.map { ($0.id, $0) })
        #expect(byId["a"]?.title == "host.example")
        #expect(byId["b"]?.title.utf16.count == Keepsakes.bookmarkTitleMax)
        #expect(byId["c"]?.title == "a b c")
    }

    @Test func removingABookmarkRemovesOnlyThatOne() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.addBookmark(id: "a", url: "https://one.example/", title: "One", now: 1)
        state.addBookmark(id: "b", url: "https://two.example/", title: "Two", now: 2)
        state.removeBookmark(id: "a")
        #expect(state.bookmarks.map(\.id) == ["b"])
        state.removeBookmark(id: "unknown")
        #expect(state.bookmarks.map(\.id) == ["b"])
    }

    // MARK: Read later

    @Test func readLaterKeepsThePageOnceAtTheTopAndRefusesWhatIsNotAWebPage() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        #expect(state.addReadLater(id: "a", url: "https://one.example/x", title: "One", now: 10) == .saved)
        #expect(state.addReadLater(id: "b", url: "https://two.example/x", title: "Two", now: 20) == .saved)
        #expect(state.addReadLater(id: "c", url: "https://one.example/x", title: "Again", now: 30) == .already)
        #expect(state.addReadLater(id: "d", url: "about:blank", title: "Blank", now: 40) == .unsupported)
        #expect(state.readLater.map(\.id) == ["b", "a"])
        #expect(state.readLater.last?.savedAt == 10)
    }

    @Test func aFullReadLaterListRefusesTheNewPage() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.readLater = (0..<Keepsakes.readLaterLimit).map { ReadLaterItem(id: "r\($0)", url: "https://p\($0).example/", title: "p", savedAt: 0) }
        #expect(state.addReadLater(id: "new", url: "https://new.example/", title: "New", now: 1) == .full)
        #expect(state.readLater.count == Keepsakes.readLaterLimit)
    }

    @Test func removingAndClearingReadLater() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.addReadLater(id: "a", url: "https://one.example/", title: "One", now: 1)
        state.addReadLater(id: "b", url: "https://two.example/", title: "Two", now: 2)
        state.removeReadLater(id: "a")
        #expect(state.readLater.map(\.id) == ["b"])
        state.clearReadLater()
        #expect(state.readLater.isEmpty)
    }

    // MARK: The file of the Mac

    @Test func theReferenceStateOfTheMacReadsAndWritesBackUnchanged() throws {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Contracts/state-reference.json")
        var state = try BrowserState.decode(Data(contentsOf: url))
        #expect(state.readLater.map(\.title) == ["Un long article"])
        let before = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state))
        state.readLater = state.readLater
        state.bookmarks = state.bookmarks
        #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state)) == before)
    }

    @Test func whatTheMacKeepsInAnEntryIsWrittenBack() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.rest["readLater"] = .array([.object(["id": .string("r"), "url": .string("https://a.example/"), "title": .string("A"), "savedAt": .number(5), "folderId": .string("f1")])])
        state.rest["bookmarks"] = .array([.object(["id": .string("b"), "url": .string("https://b.example/"), "title": .string("B"), "tags": .array([.string("x")]),
                                                    "note": .string("n"), "addedAt": .number(6), "future": .bool(true)])])
        state.addReadLater(id: "n", url: "https://new.example/", title: "New", now: 9)
        state.addBookmark(id: "m", url: "https://newb.example/", title: "NewB", now: 9)
        let kept = state.readLater.first { $0.id == "r" }
        #expect(kept?.rest["folderId"] == .string("f1"))
        let mark = state.bookmarks.first { $0.id == "b" }
        #expect(mark?.tags == ["x"] && mark?.note == "n" && mark?.rest["future"] == .bool(true))
    }

    @Test func anEntryThatDoesNotReadIsCounted() {
        var state = BrowserState(revision: 2, spaces: [], activeSpaceId: "")
        state.rest["readLater"] = .array([.string("junk"), .object(["id": .string("r"), "url": .string("https://a.example/"), "title": .string("A")])])
        state.rest["bookmarks"] = .array([.number(3)])
        #expect(state.unreadableLibraryEntries == ["readLater": 1, "bookmarks": 1])
    }
}
