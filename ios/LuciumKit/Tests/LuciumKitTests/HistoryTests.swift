import Foundation
import Testing
@testable import LuciumKit

private func historyState() -> BrowserState {
    BrowserState(spaces: [Space(id: "s-default", name: "Perso", emoji: "🏠", profileId: "default"),
                          Space(id: "s-work", name: "Travail", emoji: "💼", profileId: "work")], activeSpaceId: "s-work")
}

@Suite("History of the phone")
struct HistoryTests {
    private let day = 86_400_000.0
    private let now = 1_800_000_000_000.0

    @Test func aVisitIsNotedWithItsTitleAndCountsAgainWhenRepeated() {
        var book = HistoryBook()
        let r1 = book.visit(url: "https://example.com/a#top", title: "A", profileId: "work", at: now)
        #expect(r1)
        let r2 = book.visit(url: "https://example.com/a", title: "A2", profileId: "work", at: now + 1)
        #expect(r2)
        let entries = book.entries(profileId: "work", matching: "", limit: 10, now: now + 2)
        #expect(entries == [HistoryEntry(url: "https://example.com/a", title: "A2", visitCount: 2, lastVisitAt: now + 1)])
    }

    @Test func onlyAWebPageIsAVisit() {
        var book = HistoryBook()
        for address in ["about:blank", "file:///etc/hosts", "javascript:alert(1)", "https://", "", "data:text/html,x"] {
            let r3 = book.visit(url: address, title: "x", profileId: "work", at: now)
            #expect(!r3, "\(address)")
        }
        #expect(book.profiles.isEmpty)
    }

    @Test func eachProfileHasItsOwnHistory() {
        var book = HistoryBook()
        book.visit(url: "https://a.example/", title: "A", profileId: "work", at: now)
        book.visit(url: "https://b.example/", title: "B", profileId: "home", at: now)
        #expect(book.entries(profileId: "work", matching: "", limit: 10, now: now).map(\.title) == ["A"])
        #expect(book.entries(profileId: "home", matching: "", limit: 10, now: now).map(\.title) == ["B"])
    }

    @Test func aVisitOlderThanTheDelayIsNotOfferedAndIsPruned() {
        var book = HistoryBook()
        book.visit(url: "https://old.example/", title: "Old", profileId: "work", at: now - 31 * day)
        book.visit(url: "https://new.example/", title: "New", profileId: "work", at: now - day)
        #expect(book.entries(profileId: "work", matching: "", limit: 10, now: now).map(\.title) == ["New"])
        let r4 = book.prune(now: now)
        #expect(r4)
        #expect(book.profiles["work"]?.count == 1)
        let r5 = book.prune(now: now)
        #expect(!r5)
    }

    @Test func aShorterDelayForgetsAtOnceOnPrune() {
        var book = HistoryBook()
        book.visit(url: "https://a.example/", title: "A", profileId: "work", at: now - 3 * day)
        let r6 = book.chooseRetention(days: 1)
        #expect(r6)
        let r7 = book.prune(now: now)
        #expect(r7)
        #expect(book.profiles.isEmpty)
        let r8 = book.chooseRetention(days: 1)
        #expect(!r8)
        let r9 = book.chooseRetention(days: 2)
        #expect(!r9, "a delay that is not offered is refused")
    }

    @Test func clearingForgetsOneProfileAndLeavesTheDelay() {
        var book = HistoryBook()
        book.chooseRetention(days: 7)
        book.visit(url: "https://a.example/", title: "A", profileId: "work", at: now)
        book.visit(url: "https://b.example/", title: "B", profileId: "home", at: now)
        let r10 = book.clear(profileId: "work")
        #expect(r10)
        let r11 = book.clear(profileId: "work")
        #expect(!r11)
        #expect(book.profiles.keys.sorted() == ["home"])
        #expect(book.retentionDays == 7)
        let r12 = book.clearAll()
        #expect(r12)
        #expect(book.profiles.isEmpty)
    }

    @Test func forgettingOnePageLeavesTheOthers() {
        var book = HistoryBook()
        book.visit(url: "https://a.example/", title: "A", profileId: "work", at: now)
        book.visit(url: "https://b.example/", title: "B", profileId: "work", at: now + 1)
        let r13 = book.forget(url: "https://a.example/", profileId: "work")
        #expect(r13)
        let r14 = book.forget(url: "https://a.example/", profileId: "work")
        #expect(!r14)
        #expect(book.entries(profileId: "work", matching: "", limit: 10, now: now + 2).map(\.title) == ["B"])
    }

    @Test func aTitleThatArrivesLaterRenamesWithoutANewVisit() {
        var book = HistoryBook()
        book.visit(url: "https://a.example/", title: "", profileId: "work", at: now)
        let r15 = book.retitle(url: "https://a.example/", title: "Hello", profileId: "work")
        #expect(r15)
        let r16 = book.retitle(url: "https://a.example/", title: "Hello", profileId: "work")
        #expect(!r16)
        #expect(book.profiles["work"]?.first?.visitCount == 1)
        #expect(book.profiles["work"]?.first?.title == "Hello")
    }

    @Test func theSearchOrdersByScoreThenRecencyAndIgnoresAccents() {
        var book = HistoryBook()
        book.visit(url: "https://a.example/x", title: "Café du coin", profileId: "work", at: now)
        book.visit(url: "https://b.example/x", title: "Le grand café", profileId: "work", at: now + 1)
        book.visit(url: "https://c.example/x", title: "Thé", profileId: "work", at: now + 2)
        #expect(book.entries(profileId: "work", matching: "cafe", limit: 10, now: now + 3).map(\.title) == ["Café du coin", "Le grand café"])
        #expect(book.entries(profileId: "work", matching: "", limit: 2, now: now + 3).map(\.title) == ["Thé", "Le grand café"])
    }

    @Test func aProfileListIsBounded() {
        var book = HistoryBook()
        for index in 0..<(HistoryBook.maxEntriesPerProfile + 5) { book.visit(url: "https://e.example/\(index)", title: "", profileId: "work", at: now + Double(index)) }
        #expect(book.profiles["work"]?.count == HistoryBook.maxEntriesPerProfile)
        #expect(book.profiles["work"]?.first?.url == "https://e.example/\(HistoryBook.maxEntriesPerProfile + 4)")
    }

    // MARK: The state

    @Test func historyIsKeptUnlessTheStateSaysOtherwiseAndTheChoiceIsTheMacs() throws {
        var state = historyState()
        let profile = "default"
        #expect(state.recordsHistory(forProfile: profile))
        let r17 = state.chooseRecordsHistory(false, forProfile: profile)
        #expect(r17)
        #expect(!state.recordsHistory(forProfile: profile))
        let settings = try #require(state.rest["settings"])
        guard case .object(let object) = settings, case .bool(true)? = object["historyOff"] else { Issue.record("the Mac's key is not written: \(settings)"); return }
        let r18 = state.chooseRecordsHistory(false, forProfile: profile)
        #expect(!r18)
        let r19 = state.chooseRecordsHistory(true, forProfile: profile)
        #expect(r19)
        #expect(state.recordsHistory(forProfile: profile))
    }

    @Test func aProfileOwnChoiceWinsOverTheGeneralOneAsOnTheMac() {
        var state = historyState()
        let first = state.spaces[0].profileId, second = state.spaces[1].profileId
        state.chooseRecordsHistory(false, forProfile: second)
        #expect(state.recordsHistory(forProfile: first))
        #expect(!state.recordsHistory(forProfile: second))
    }

    @Test func theResetPutsTheKeepingBackOn() {
        var state = historyState()
        let profile = "work"
        state.chooseRecordsHistory(false, forProfile: profile)
        #expect(SettingsDefaults.changedRows(in: state, profileId: profile).contains(.history))
        let r20 = SettingsDefaults.reset(&state, profileId: profile)
        #expect(r20)
        #expect(state.recordsHistory(forProfile: profile))
        #expect(!SettingsDefaults.changedRows(in: state, profileId: profile).contains(.history))
    }

    // MARK: The file

    private func tempFile() -> HistoryFile {
        HistoryFile(url: FileManager.default.temporaryDirectory.appending(path: "hist-\(UUID().uuidString)", directoryHint: .isDirectory).appending(path: HistoryFile.fileName))
    }

    @Test func theFileRoundTripsAndStaysOutOfTheBackups() throws {
        let file = tempFile()
        #expect(file.load(now: now) == .fresh)
        var book = HistoryBook()
        book.chooseRetention(days: 90)
        book.visit(url: "https://a.example/", title: "A", profileId: "work", at: now)
        try file.save(book)
        #expect(file.load(now: now) == .loaded(book))
        let excluded = try file.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        #expect(excluded == true)
    }

    @Test func anUnreadableFileIsPutAsideNotErased() throws {
        let file = tempFile()
        try FileManager.default.createDirectory(at: file.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file.url)
        guard case .setAside(let aside) = file.load(now: now) else { Issue.record("expected .setAside"); return }
        #expect(FileManager.default.fileExists(atPath: aside.path))
        #expect(!FileManager.default.fileExists(atPath: file.url.path))
    }

    @Test func aFileOfALaterVersionIsPutAside() throws {
        let file = tempFile()
        var book = HistoryBook()
        book.version = HistoryBook.currentVersion + 1
        try file.save(book)
        guard case .setAside = file.load(now: now) else { Issue.record("expected .setAside"); return }
    }

    @Test func theHistoryIsNotInTheStateTheSynchronisationCarries() throws {
        // The visited pages live in their own file: the state of a phone that browsed a lot is the same JSON as that of one that did not.
        var book = HistoryBook()
        book.visit(url: "https://secret.example/", title: "Secret", profileId: "work", at: now)
        let state = historyState()
        let text = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        #expect(!text.contains("secret.example"))
        #expect(SyncFieldClasses.neverKinds.contains("history"))
    }
}
