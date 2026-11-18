import XCTest
@testable import LuciumKit

/// « Reprendre un onglet du Mac » (docs/synchronisation.md §10.4): which rows, in which order, why the screen is empty, and where a tap opens.
final class SyncResumeTests: XCTestCase {
    private func tab(_ id: String, _ url: String, title: String = "T", space: String = "s1", at: Int = 1000) -> SyncOpenTab {
        SyncOpenTab(id: id, spaceId: space, url: url, title: title, lastActiveAt: at)
    }

    func testOnlyWebPagesAreRowsWhateverTheReceiverKept() {
        let rows = SyncResume.rows(from: [
            tab("a", "https://example.com/a"), tab("b", "http://example.org/b"), tab("c", "javascript:alert(1)"), tab("d", "file:///etc/hosts"),
            tab("e", "data:text/html,<b>x</b>"), tab("i", "ftp://example.com/x"), tab("j", "ws://example.com/"), tab("f", "HTTPS://Example.net/f"), tab("g", "https://"), tab("h", "about:blank"),
        ])
        XCTAssertEqual(Set(rows.map(\.id)), ["a", "b", "f"])
    }

    func testAnAddressOverTheLimitIsNotARow() {
        let long = "https://example.com/" + String(repeating: "a", count: SyncLimits.maxOpenTabURLBytes)
        XCTAssertTrue(SyncResume.rows(from: [tab("a", long)]).isEmpty)
    }

    func testTheMostRecentlyReadComesFirstAndOneRowPerAddress() {
        let rows = SyncResume.rows(from: [
            tab("old", "https://a.example/", at: 10), tab("new", "https://b.example/", at: 30),
            tab("dup", "https://b.example/", at: 20), tab("mid", "https://c.example/", at: 20),
        ])
        XCTAssertEqual(rows.map(\.id), ["new", "mid", "old"])
    }

    func testATitleMissingIsTheHostAndAtMostTheProtocolLimitIsKept() {
        XCTAssertEqual(SyncResume.rows(from: [tab("a", "https://example.com/p", title: "  ")]).first?.title, "example.com")
        let many = (0..<(SyncLimits.maxOpenTabs + 20)).map { tab("t\($0)", "https://example.com/\($0)", at: $0) }
        XCTAssertEqual(SyncResume.rows(from: many).count, SyncLimits.maxOpenTabs)
    }

    func testWhyTheScreenIsEmpty() {
        func a(paired: Bool = true, here: Bool = true, at: Int? = nil, announced: Bool = false, rows: Int = 0, session: Bool = true) -> SyncResume.Availability {
            SyncResume.availability(paired: paired, categoryOnHere: here, announcedAt: at, listAnnounced: announced, rowCount: rows, sessionHappened: session)
        }
        XCTAssertEqual(a(paired: false, here: false), .notPaired)
        XCTAssertEqual(a(here: false, at: 5, announced: true, rows: 3), .disabledHere, "the category off on the phone wins over a list kept in memory")
        XCTAssertEqual(a(session: false), .waiting)
        XCTAssertEqual(a(announced: false, session: true), .disabledOnMac)
        XCTAssertEqual(a(at: 5, announced: true, rows: 0), .empty)
        XCTAssertEqual(a(at: 5, announced: true, rows: 2), .list)
    }

    func testATapOpensInTheSpaceOfTheMacWhenItExistsHereAndIsNotLocked() {
        let row = SyncResume.rows(from: [tab("a", "https://example.com/", space: "work")])[0]
        let spaces: Set<String> = ["work", "home"]
        XCTAssertEqual(SyncResume.targetSpace(of: row, spaceIds: spaces, activeSpaceId: "home", isLocked: { _ in false }), "work")
        // The space of the row is locked: the page goes to the space on screen, never into the locked one.
        XCTAssertEqual(SyncResume.targetSpace(of: row, spaceIds: spaces, activeSpaceId: "home", isLocked: { $0 == "work" }), "home")
        // Unknown here: the space on screen.
        XCTAssertEqual(SyncResume.targetSpace(of: row, spaceIds: ["home"], activeSpaceId: "home", isLocked: { _ in false }), "home")
        // Everything is locked: nowhere.
        XCTAssertNil(SyncResume.targetSpace(of: row, spaceIds: spaces, activeSpaceId: "home", isLocked: { _ in true }))
    }

    func testTheAgeOfAList() {
        let now = 10_000_000
        XCTAssertEqual(SyncResume.age(at: now - 59_000, now: now), .justNow)
        XCTAssertEqual(SyncResume.age(at: now - 60_000, now: now), .minutes(1))
        XCTAssertEqual(SyncResume.age(at: now - 3_599_000, now: now), .minutes(59))
        XCTAssertEqual(SyncResume.age(at: now - 3_600_000, now: now), .hours(1))
        XCTAssertEqual(SyncResume.age(at: now - 86_400_000, now: now), .days(1))
        XCTAssertEqual(SyncResume.age(at: now + 5_000_000, now: now), .justNow, "a clock that went back is not a negative time")
    }

    func testTheCommandBarKeepsWhatTheWordNames() {
        let rows = SyncResume.rows(from: [
            tab("a", "https://lemonde.fr/x", title: "Le Monde", at: 3), tab("b", "https://example.com/", title: "Dernière nouvelle du monde", at: 2),
            tab("c", "https://other.example/", title: "Autre", at: 1),
        ])
        XCTAssertEqual(SyncResume.matching(rows, query: "monde").map(\.id), ["a", "b"], "a prefix of a title beats a word inside one; accents are ignored")
        XCTAssertEqual(SyncResume.matching(rows, query: "derniere").map(\.id), ["b"])
        XCTAssertEqual(SyncResume.matching(rows, query: "example").map(\.id), ["b", "c"], "the address counts, in the order of the list")
        XCTAssertEqual(SyncResume.matching(rows, query: "   ").map(\.id), ["a", "b", "c"])
        XCTAssertEqual(SyncResume.matching(rows, query: "", limit: 2).count, 2)
        XCTAssertTrue(SyncResume.matching(rows, query: "zzz").isEmpty)
    }
}
