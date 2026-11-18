import Foundation
import Testing
@testable import LuciumKit

/// Review n° 17 and 18 of the synchronisation (docs/securite-synchronisation.md): the marks of what a session did not exchange, and a clock that was wrong. The Mac's twin is
/// `src/main/sync/marks.ts`.
@Suite("Synchronisation: the marks of the review")
struct SyncMarksReviewTests {
    private let now = 1_790_000_000_000
    private func mark(_ ms: Int, _ device: String = "phone-0000000001") -> String { String(format: "%013ld-0000-", ms) + device }

    // MARK: n° 17 and 18, the marks

    private func view(_ entities: [String: [String: [String: JSONValue]]], order: [String: [String]] = [:]) -> SyncTrackedView {
        var view = SyncTrackedView()
        view.entities = entities
        view.order = order
        return view
    }

    @Test func aSessionThatDidNotExchangeACategoryKeepsItsMarksItsTombstonesAndItsLists() {
        var book = SyncMarkBook(device: "mac")
        book.update(view(["space": ["s1": ["name": .string("A")]], "setting": ["sendGpc": ["value": .bool(true)]], "archived": ["a1": ["url": .string("https://x.example/")]]], order: ["spaces": ["s1"]]), now: now)
        book.update(view(["space": ["s1": ["name": .string("A")]], "setting": ["sendGpc": ["value": .bool(true)]], "archived": [:]], order: ["spaces": ["s1"]]), now: now + 1000)
        let setting = book.stamps(of: "setting", id: "sendGpc")
        let tombstone = book.tombstonesOfAllKinds()["archived"]
        #expect(tombstone != nil)
        let stamp = mark(now + 500, "phone-0000000001")
        let merged = SyncSnapshot(entities: ["space": ["s1": SyncEntity(fields: ["name": .string("B")], stamps: ["name": stamp])]], tombstones: [:], order: ["spaces": ["s1"]], orderStamps: ["spaces": stamp])
        book.adopt(merged, exchanged: { SyncStateView.isExchanged(kind: $0, categories: [.structure]) })
        #expect(book.stamps(of: "setting", id: "sendGpc") == setting)
        #expect(book.tombstonesOfAllKinds()["archived"] == tombstone)
        #expect(book.stamps(of: "space", id: "s1") == ["name": stamp])
        #expect(book.orderStamp(of: "spaces") == stamp)
        // Without the kinds, the whole book is replaced, as it was: the default says « everything was exchanged ».
        book.adopt(merged)
        #expect(book.stamps(of: "setting", id: "sendGpc").isEmpty)
    }

    @Test func theKindsASessionExchangesAreTheOnesOfItsCategoriesAndTheKindsItDoesNotKnow() {
        #expect(SyncStateView.isExchanged(kind: "space", categories: [.structure]))
        #expect(!SyncStateView.isExchanged(kind: "archived", categories: [.structure]))
        #expect(SyncStateView.isExchanged(kind: "archived", categories: [.archive]))
        #expect(!SyncStateView.isExchanged(kind: "setting", categories: [.structure, .archive]))
        #expect(SyncStateView.isExchanged(kind: "widget", categories: [.structure]), "a kind this version does not know crosses whatever is ticked")
        #expect(SyncMarkBook.listKind(of: "tabs:s:-") == "tab")
        #expect(SyncMarkBook.listKind(of: "elsewhere") == nil)
    }

    @Test func aClockThatWasWrongComesBackAndNeverWritesMoreThanThirteenDigits() {
        let year = 365 * 86_400_000
        var fresh = SyncMarkBook(device: "d")
        _ = fresh.next(now: now + 3 * year)
        #expect(fresh.next(now: now) == mark(now, "d"))
        #expect(fresh.next(now: now) == String(format: "%013ld-0001-", now) + "d")
        // A few minutes ahead (the usual skew) is not a wrong clock: it is counted on from.
        var skewed = SyncMarkBook(device: "d")
        _ = skewed.next(now: now + 60_000)
        #expect(skewed.next(now: now) == String(format: "%013ld-0001-", now + 60_000) + "d")
        var full = SyncMarkBook(device: "d")
        full.observe(String(format: "%013ld-ffff-", 9_999_999_999_999) + "d")
        #expect(full.next(now: now) == mark(now, "d"))
    }

    @Test func marksMoreThanAWeekAheadAreMadeAgainByTheNextLook() {
        let far = now + 3 * 365 * 86_400_000
        var book = SyncMarkBook(device: "mac")
        book.update(view(["space": ["s1": ["name": .string("A"), "gone": .number(1)], "s2": ["name": .string("B")]], "tab": ["t1": ["pinned": .bool(true)]]], order: ["spaces": ["s1", "s2"]]), now: far)
        book.update(view(["space": ["s1": ["name": .string("A")], "s2": ["name": .string("B")]], "tab": [:]], order: ["spaces": ["s1", "s2"]]), now: far)
        book.update(view(["space": ["s1": ["name": .string("A")], "s2": ["name": .string("B")]], "tab": [:]], order: ["spaces": ["s1", "s2"]]), now: now)
        let limit = String(format: "%013ld", now + 604_800_000)
        let stamps = Array(book.stamps(of: "space", id: "s1").values) + Array(book.stamps(of: "space", id: "s2").values) + [book.orderStamp(of: "spaces")] + Array((book.tombstonesOfAllKinds()["tab"] ?? [:]).values)
        #expect(!stamps.isEmpty)
        for stamp in stamps { #expect(stamp.prefix(13) <= limit, "\(stamp)") }
        #expect(Array((book.tombstonesOfAllKinds()["tab"] ?? [:]).keys) == ["t1"])
        // A book in order is not touched.
        var steady = SyncMarkBook(device: "mac")
        steady.update(view(["space": ["s1": ["name": .string("A")]]], order: ["spaces": ["s1"]]), now: now + 120_000)
        let before = steady
        steady.update(view(["space": ["s1": ["name": .string("A")]]], order: ["spaces": ["s1"]]), now: now)
        #expect(steady == before)
    }
}
