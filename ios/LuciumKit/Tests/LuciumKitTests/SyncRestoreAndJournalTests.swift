import Foundation
import Testing
@testable import LuciumKit

/// « Rétablir » (docs/synchronisation.md §13.4) and the file of the conflicts (§11.7.3).
@Suite("Synchronisation: putting back the version that lost")
struct SyncRestoreTests {
    private let now = Double(SyncStateFixtures.now)

    @Test func aFieldThatLostIsWrittenBackAsAnOrdinaryChange() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = SyncApply.restore(.set(kind: "space", id: "s1", field: "name", value: .string("Ancien nom")), to: state, now: now)
        #expect(outcome.state.spaces[0].name == "Ancien nom")
        #expect(outcome.changed)
        #expect(outcome.state.spaces[1] == state.spaces[1], "nothing else moved")
    }

    @Test func aFieldThatHadNoValueIsTakenAwayAgain() throws {
        var state = try SyncStateFixtures.sample()
        state.spaces[0].rest["hideHeader"] = .bool(true)
        let outcome = SyncApply.restore(.unset(kind: "space", id: "s1", field: "hideHeader"), to: state, now: now)
        #expect(outcome.state.spaces[0].rest["hideHeader"] == nil)
        #expect(!SyncApply.restore(.unset(kind: "space", id: "s1", field: "hideHeader"), to: outcome.state, now: now).changed, "nothing to take away twice")
    }

    @Test func anEntityThatLostTheDeletionIsDeletedEverywhere() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = SyncApply.restore(.delete(kind: "folder", id: "f2"), to: state, now: now)
        #expect(outcome.state.folders.map(\.id) == ["f1"])
        let tab = SyncApply.restore(.delete(kind: "tab", id: "t2"), to: state, now: now)
        #expect(tab.removedTabIDs == ["t2"])
        #expect(SyncApply.restore(.delete(kind: "favorite", id: "fav1"), to: state, now: now).state.favorites.isEmpty)
        #expect(SyncApply.restore(.delete(kind: "archived", id: "a1"), to: state, now: now).state.archive.isEmpty)
    }

    @Test func aListThatLostIsPutBackInItsOrder() throws {
        var state = try SyncStateFixtures.sample()
        state.spaces = state.spaces.reversed()
        let outcome = SyncApply.restore(.order(list: "spaces", ids: ["s1", "s2"]), to: state, now: now)
        #expect(outcome.state.spaces.map(\.id) == ["s1", "s2"])
    }

    @Test func aSettingThatLostIsWrittenBackThroughTheClosedList() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = SyncApply.restore(.set(kind: "setting", id: "sendGpc", field: "value", value: .bool(true)), to: state, now: now)
        guard case .object(let settings)? = outcome.state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(settings["sendGpc"] == .bool(true))
        // A setting that is not in the list is never written, even by a line of a hostile journal.
        let lock = SyncApply.restore(.set(kind: "setting", id: "lockEnabled", field: "value", value: .bool(false)), to: state, now: now)
        #expect(lock.state == state)
        // Only the value of a setting is a field of it.
        #expect(SyncApply.restore(.set(kind: "setting", id: "sendGpc", field: "other", value: .bool(true)), to: state, now: now).state == state)
    }

    @Test func whatIsNoLongerThereIsLeftAlone() throws {
        let state = try SyncStateFixtures.sample()
        for change in [SyncChange.set(kind: "space", id: "gone", field: "name", value: .string("x")), .unset(kind: "space", id: "gone", field: "name"), .delete(kind: "space", id: "gone"),
                       .set(kind: "widget", id: "w", field: "a", value: .number(1)), .delete(kind: "widget", id: "w"), .unset(kind: "widget", id: "w", field: "a")] {
            let outcome = SyncApply.restore(change, to: state, now: now)
            #expect(outcome.state == state && !outcome.changed, "\(change)")
        }
    }

    @Test func aValueThisVersionDoesNotKeepIsNotWrittenBack() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = SyncApply.restore(.set(kind: "tab", id: "t1", field: "anchorUrl", value: .string("javascript:alert(1)")), to: state, now: now)
        #expect(outcome.state == state)
        #expect(outcome.rejected.count == 1)
    }

    @Test func theLastSpaceIsNotDeletedEvenByALineOfTheJournal() throws {
        var state = try SyncStateFixtures.sample()
        state.spaces = [state.spaces[0]]
        let outcome = SyncApply.restore(.delete(kind: "space", id: "s1"), to: state, now: now)
        #expect(outcome.state.spaces.map(\.id) == ["s1"])
    }
}

@Suite("Synchronisation: the file of the conflicts")
struct SyncJournalFileTests {
    private func entry(_ id: String = "x", at: Int = 1_790_000_000_000) -> SettledConflict {
        SettledConflict(id: SyncConflicts.entryID(kind: "space", id: id, field: "name"), settledAt: at, peer: .mac, kind: "space", entityID: id, field: "name", reason: .newer, winner: .remote, label: "Travail",
                        kept: .text("A"), lost: .text("B"), keptAt: at - 10, lostAt: at - 20, restore: .set(kind: "space", id: id, field: "name", value: .string("B")))
    }

    private func file() -> (SyncJournalFile, URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "journal-\(UUID().uuidString)")
        return (SyncJournalFile(url: directory.appending(path: SyncJournalFile.fileName)), directory)
    }

    @Test func aMissingFileIsAnEmptyJournal() {
        let (file, directory) = file()
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(file.load(now: 5) == SyncJournalFile.Loaded(entries: [], skipped: 0, tooNew: false))
    }

    @Test func theJournalIsWrittenAndReadBackWithTheRightsOfItsOwnerOnly() throws {
        let (file, directory) = file()
        defer { try? FileManager.default.removeItem(at: directory) }
        let lines = [entry("a"), entry("b")]
        try file.save(lines)
        let loaded = file.load(now: 1_790_000_000_000)
        #expect(Set(loaded.entries.map(\.id)) == Set(lines.map(\.id)))
        #expect(loaded.skipped == 0 && !loaded.tooNew)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "it holds titles and addresses")
    }

    @Test func aLineOfMoreThanThirtyDaysIsNotKept() throws {
        let (file, directory) = file()
        defer { try? FileManager.default.removeItem(at: directory) }
        try file.save([entry("old", at: 1_000)])
        #expect(file.load(now: 1_000 + SyncConflicts.Limits.retentionMs + 1).entries.isEmpty)
    }

    @Test func aFileOfANewerVersionIsReadAsEmptyAndSaysSo() throws {
        let (file, directory) = file()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(#"{"v":2,"entries":[]}"#.utf8).write(to: file.url)
        #expect(file.load(now: 5).tooNew)
    }

    @Test func aHostileFileIsBoundedAndNeverTrusted() throws {
        let (file, directory) = file()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for text in ["not json", "[]", #"{"v":1}"#, #"{"v":1,"entries":[1,2,"x"]}"#] {
            try Data(text.utf8).write(to: file.url)
            let loaded = file.load(now: 5)
            #expect(loaded.entries.isEmpty && !loaded.tooNew, "\(text)")
        }
        try Data(repeating: 0x20, count: SyncConflicts.Limits.maxFileChars * 4 + 1).write(to: file.url)
        #expect(file.load(now: 5).entries.isEmpty, "a file over the bound is not read")
        try Data(#"{"v":1,"entries":[{"id":"x"}, 5]}"#.utf8).write(to: file.url)
        #expect(file.load(now: 5).skipped == 2, "a line that is not well formed is left out and counted")
    }

    @Test func forgettingTheMacRemovesItsJournal() throws {
        let (file, directory) = file()
        defer { try? FileManager.default.removeItem(at: directory) }
        try file.save([entry()])
        try file.remove()
        #expect(!FileManager.default.fileExists(atPath: file.url.path))
        try file.remove()
    }
}
