import Foundation
import Testing
@testable import LuciumKit

/// The journal of the settled conflicts and the sentences of « Conflit réglé » (`SyncConflicts`, docs/synchronisation.md §11.7.3 and §13.4), played against the
/// vectors the Mac's TypeScript plays too: `ios/Contracts/sync-conflict-vectors.json` (the lines and the sentences the Mac gives for each conflict of the merge
/// vectors and of the 60 random states, the retention of the journal, the reading of a hostile file).

private let now = 1_790_000_100_000
private let day = 24 * 60 * 60 * 1000

/// The same line as the TypeScript test's `line()`: a minimal line with the given id and time.
private func line(_ id: String, _ settledAt: Int, label: String? = "x") -> SettledConflict {
    SettledConflict(id: id, settledAt: settledAt, peer: .ios, kind: "space", entityID: id, field: "name", reason: .newer, winner: .remote, label: label,
                    kept: .text("a"), lost: .text("b"), keptAt: 5, lostAt: 4, restore: .set(kind: "space", id: id, field: "name", value: .string("b")))
}

private struct SettleCase: Sendable, CustomTestStringConvertible {
    let source: String
    let name: String
    let peer: SyncPlatform
    let entries: [SettledConflict]
    let views: [JSONValue]
    var testDescription: String { "\(source): \(name)" }
}

private enum ConflictCases {
    static let file: JSONValue = {
        do { return try Contract.load("sync-conflict-vectors.json") } catch {
            Issue.record("the conflict vectors do not load: \(error)")
            return .object([:])
        }
    }()

    static let settle: [SettleCase] = (file["settle"]?.items ?? []).compactMap { raw in
        guard let source = raw["source"]?.text, let name = raw["name"]?.text, let peerText = raw["peer"]?.text, let peer = SyncPlatform(rawValue: peerText) else { return nil }
        let entries = (raw["entries"]?.items ?? []).compactMap(SyncConflicts.read)
        return SettleCase(source: source, name: name, peer: peer, entries: entries, views: raw["views"]?.items ?? [])
    }

    static let sources: [String: MergeCase] = {
        var all: [String: MergeCase] = [:]
        for c in Cases.vectors() { all["vectors/\(c.name)"] = c }
        for c in Cases.draws() { all["draws/\(c.name)"] = c }
        return all
    }()
}

@Suite("Sync conflicts: the vectors shared with the Mac")
struct SyncConflictVectorTests {
    @Test func thereAreVectorsToRun() {
        #expect(ConflictCases.settle.count > 20)
        #expect(Set(ConflictCases.settle.map(\.source)) == ["vectors", "draws"])
        #expect(ConflictCases.settle.allSatisfy { !$0.entries.isEmpty && $0.entries.count == $0.views.count })
    }

    @Test(arguments: ConflictCases.settle)
    fileprivate func settlesLikeTheMac(_ c: SettleCase) throws {
        let source = try #require(ConflictCases.sources["\(c.source)/\(c.name)"], "the source of the case")
        let merged = source.merged()
        let entries = SyncConflicts.settle(conflicts: merged.conflicts, local: source.local, remote: source.remote, merged: merged.snapshot, now: now, peer: c.peer)
        #expect(entries == c.entries)
        #expect(entries.map { SyncConflicts.view(of: $0).json } == c.views)
        // A line goes through its file and comes back the same.
        let again = SyncConflicts.parse(SyncConflicts.serialize(entries), now: now)
        #expect(again.unreadable == false && again.skipped == 0)
        #expect(Set(again.entries.map(\.id)) == Set(entries.map(\.id)))
        for entry in entries { #expect(again.entries.first { $0.id == entry.id } == entry) }
    }

    @Test func keepsTheJournalForThirtyDaysAndTwoHundredLines() throws {
        let retention = try #require(ConflictCases.file["journal"]?["retention"]).items
        #expect(retention.count >= 3)
        for raw in retention {
            func lines(_ key: String) -> [SettledConflict] {
                (raw[key]?.items ?? []).compactMap { pair in
                    guard case .string(let id)? = pair.items.first, case .number(let at)? = pair.items.last else { return nil }
                    return line(id, Int(at))
                }
            }
            let at = try #require({ () -> Int? in if case .number(let value)? = raw["now"] { return Int(value) } else { return nil } }())
            let got = SyncConflicts.add(lines("settled"), to: lines("journal"), now: at).map(\.id)
            #expect(got == (raw["expect"]?.items ?? []).compactMap(\.text), "\(raw["name"]?.text ?? "")")
        }
    }

    @Test func readsAHostileFileLikeTheMac() throws {
        let cases = try #require(ConflictCases.file["journal"]?["parse"]).items
        #expect(cases.count >= 6)
        for raw in cases {
            let text = try #require(raw["text"]?.text)
            let expect = try #require(raw["expect"])
            let parsed = SyncConflicts.parse(text, now: now)
            #expect(parsed.entries.map(\.id) == (expect["ids"]?.items ?? []).compactMap(\.text), "\(raw["name"]?.text ?? "")")
            if case .number(let skipped)? = expect["skipped"] { #expect(parsed.skipped == Int(skipped), "\(raw["name"]?.text ?? "")") }
            #expect(parsed.tooNew == expect["tooNew"]?.flag, "\(raw["name"]?.text ?? "")")
            #expect(parsed.unreadable == expect["unreadable"]?.flag, "\(raw["name"]?.text ?? "")")
        }
    }
}

@Suite("Sync conflicts: the journal and the sentences")
struct SyncConflictTests {
    @Test func dropsALineOlderThanThirtyDaysAndKeepsOneOfExactlyThirtyDays() {
        let kept = SyncConflicts.prune([line("a", now - 30 * day), line("b", now - 30 * day - 1), line("c", now)], now: now)
        #expect(kept.map(\.id) == ["c", "a"])
    }

    @Test func keepsTheTwoHundredNewest() {
        let many = (0..<250).map { line("id\(String(format: "%03d", $0))", now - $0 * 1000) }
        let kept = SyncConflicts.prune(many.reversed(), now: now)
        #expect(kept.count == SyncConflicts.Limits.maxEntries)
        #expect(kept.first?.id == "id000" && kept.last?.id == "id199")
    }

    @Test func removesALineAndTellsTheLastSession() {
        let journal = [line("a", now), line("b", now), line("c", now - day)]
        #expect(SyncConflicts.remove("a", from: journal).map(\.id) == ["b", "c"])
        #expect(SyncConflicts.lastSession(journal).map(\.id) == ["a", "b"])
        #expect(SyncConflicts.lastSession([]).isEmpty)
    }

    @Test func refusesAFileThatIsNotAJournalAndSaysItIsUnreadable() {
        for text in ["", "{", "null", "[]", "{\"v\":1}", "{\"v\":1,\"entries\":5}", "{\"v\":0,\"entries\":[]}", "{\"entries\":[]}", String(repeating: "x", count: SyncConflicts.Limits.maxFileChars + 1)] {
            #expect(SyncConflicts.parse(text, now: now) == SyncConflicts.Parsed(entries: [], skipped: 0, tooNew: false, unreadable: true), "\(text.prefix(20))")
        }
        #expect(SyncConflicts.parse("{\"v\":2,\"entries\":[{}]}", now: now) == SyncConflicts.Parsed(entries: [], skipped: 0, tooNew: true, unreadable: false))
    }

    @Test func leavesOutALineThatIsNotInTheFormAndCountsIt() throws {
        let good = SyncConflicts.json(line("a", now))
        func with(_ members: [String: JSONValue]) -> JSONValue {
            guard case .object(var object) = SyncConflicts.json(line("a", now)) else { return .null }
            for (key, value) in members { object[key] = value }
            return .object(object)
        }
        let bad: [JSONValue] = [
            .number(5), .null, .array([]), .object([:]), with(["id": .string("")]), with(["settledAt": .number(-1)]), with(["settledAt": .number(1.5)]), with(["peer": .string("pc")]),
            with(["kind": .string("")]), with(["field": .string("")]), with(["reason": .string("because")]), with(["winner": .string("both")]), with(["label": .number(5)]),
            with(["kept": .object(["t": .string("text")])]), with(["kept": .object(["t": .string("other")])]), with(["keptAt": .string("x")]),
            with(["restore": .object(["type": .string("run"), "command": .string("rm")])]),
            with(["restore": .object(["type": .string("set"), "kind": .string("space"), "id": .string("s"), "field": .string("name"), "value": .object(["__proto__": .number(1)])])]),
            with(["restore": .object(["type": .string("order"), "list": .string("spaces"), "ids": .array([.number(1)])])]),
            with(["restore": .object(["type": .string("order"), "list": .string("spaces"), "ids": .array((0...SyncConflicts.Limits.maxListIDs).map { .string("i\($0)") })])]),
            with(["entityId": .string(String(repeating: "x", count: 401))]), with(["label": .string(String(repeating: "x", count: 500))]),
            with(["id": .string("e\u{0301}")]), with(["kind": .string("cafe\u{0301}")]), with(["entityId": .string("e\u{0301}")]), with(["field": .string("e\u{0301}")]),
            with(["restore": .object(["type": .string("set"), "kind": .string("space"), "id": .string("e\u{0301}"), "field": .string("name"), "value": .string("b")])]),
            with(["restore": .object(["type": .string("set"), "kind": .string("space"), "id": .string("s"), "field": .string("name"), "value": .object(["e\u{0301}": .number(1)])])]),
            with(["restore": .object(["type": .string("order"), "list": .string("spaces"), "ids": .array([.string("e\u{0301}")])])]),
        ]
        // Each bad line has an id of its own, so that none of them is left out only because it repeats another's.
        let unique: [JSONValue] = bad.enumerated().map { index, entry in
            guard case .object(var object) = entry, object["id"] == nil || object["id"] == .string("a") else { return entry }
            object["id"] = .string("bad\(index)")
            return .object(object)
        }
        let text = SyncCanonical.text(.object(["v": .number(1), "entries": .array([good] + unique)])) ?? ""
        let parsed = SyncConflicts.parse(text, now: now)
        #expect(parsed.entries.map(\.id) == ["a"])
        #expect(parsed.skipped == bad.count)
    }

    @Test func leavesOutALineThatRepeatsTheIDOfAnEarlierOne() {
        let text = SyncCanonical.text(.object(["v": .number(1), "entries": .array([SyncConflicts.json(line("a", now)), SyncConflicts.json(line("a", now - 1)), SyncConflicts.json(line("b", now))])])) ?? ""
        let parsed = SyncConflicts.parse(text, now: now)
        #expect(parsed.entries.map(\.id) == ["a", "b"])
        #expect(parsed.skipped == 1)
    }

    @Test func readsAtMostFourHundredLinesAndKeepsTwoHundredTheLinesAfterTheFourHundredthAreNotReadEvenTheNewest() {
        // The later the line, the newer: if every line were read, the newest 200 would be the last ones.
        let entries = (0..<500).map { SyncConflicts.json(line("id\($0)", now - (499 - $0))) }
        let parsed = SyncConflicts.parse(SyncCanonical.text(.object(["v": .number(1), "entries": .array(entries)])) ?? "", now: now)
        #expect(parsed.entries.count == SyncConflicts.Limits.maxEntries)
        #expect(parsed.entries.first?.id == "id399")
    }

    @Test func saysAJournalThatIsValidButTooLargeIsUnreadableBeforeItIsRead() {
        let padded = "{\"v\":1,\"entries\":[],\"pad\":\"" + String(repeating: "x", count: SyncConflicts.Limits.maxFileChars) + "\"}"
        #expect(SyncConflicts.parse(padded, now: now) == SyncConflicts.Parsed(entries: [], skipped: 0, tooNew: false, unreadable: true))
    }

    @Test func namesATabByItsCustomTitleElseItsTitleElseItsAddressAndAFavouriteByItsTitleElseItsAddress() {
        #expect(SyncConflicts.label(kind: "tab", fields: ["customTitle": .string("Mine"), "title": .string("Theirs"), "anchorUrl": .string("https://a.example/")]) == "Mine")
        #expect(SyncConflicts.label(kind: "tab", fields: ["title": .string("Theirs"), "anchorUrl": .string("https://a.example/")]) == "Theirs")
        #expect(SyncConflicts.label(kind: "tab", fields: ["anchorUrl": .string("https://a.example/")]) == "https://a.example/")
        #expect(SyncConflicts.label(kind: "favorite", fields: ["title": .string("T"), "url": .string("https://a.example/")]) == "T")
        #expect(SyncConflicts.label(kind: "archived", fields: ["url": .string("https://a.example/")]) == "https://a.example/")
        #expect(SyncConflicts.label(kind: "tab", fields: [:]) == nil)
        #expect(SyncConflicts.label(kind: "setting", fields: ["value": .bool(true)]) == nil)
        #expect(SyncConflicts.label(kind: "space", fields: ["name": .string(String(repeating: "x", count: 200))]) == String(repeating: "x", count: SyncConflicts.Limits.maxLabelChars) + "…")
    }

    @Test func showsTheFolderATabWasPutInByItsNameAndAValueCutTo80Characters() throws {
        func snapshot(_ fields: [String: JSONValue], _ mark: String) throws -> SyncSnapshot {
            try Contract.snapshot(.object(["entities": .object([
                "folder": .object(["f1": .object(["fields": .object(["spaceId": .string("s1"), "name": .string("Réunions")]), "stamps": .object([:])]),
                                   "f2": .object(["fields": .object(["spaceId": .string("s1"), "name": .string("Lecture")]), "stamps": .object([:])])]),
                "space": .object(["s1": .object(["fields": .object(["name": .string("S")]), "stamps": .object([:])])]),
                "tab": .object(["t1": .object(["fields": .object(fields.merging(["spaceId": .string("s1"), "pinned": .bool(true)]) { mine, _ in mine }), "stamps": .object(fields.mapValues { _ in .string(mark) })])]),
            ])]))
        }
        func settle(_ fieldsLocal: [String: JSONValue], _ fieldsRemote: [String: JSONValue]) throws -> [SettledConflict] {
            let local = try snapshot(fieldsLocal, "1790000000003-0000-mac")
            let remote = try snapshot(fieldsRemote, "1790000000007-0000-phone")
            let merged = SyncMerge.merge(base: nil, local: local, remote: remote)
            return SyncConflicts.settle(conflicts: merged.conflicts, local: local, remote: remote, merged: merged.snapshot, now: now, peer: .ios)
        }
        let folder = try #require(try settle(["folderId": .string("f1")], ["folderId": .string("f2")]).first)
        #expect(folder.kept == .text("Lecture") && folder.lost == .text("Réunions"))
        #expect(folder.restore == .set(kind: "tab", id: "t1", field: "folderId", value: .string("f1")))
        let long = try #require(try settle(["customTitle": .string(String(repeating: "😀", count: 100))], ["customTitle": .string("b")]).first)
        #expect(long.lost == .text(String(repeating: "😀", count: 80) + "…"))
    }

    @Test func doesNotShowAProfileIDAndKeepsAValueOfExactly4096CharactersButNotOneOf4097() throws {
        func settle(_ fieldsLocal: [String: JSONValue], _ fieldsRemote: [String: JSONValue], kind: String = "favorite") throws -> [SettledConflict] {
            func snapshot(_ fields: [String: JSONValue], _ mark: String) throws -> SyncSnapshot {
                try Contract.snapshot(.object(["entities": .object([kind: .object(["v1": .object(["fields": .object(fields), "stamps": .object(fields.mapValues { _ in .string(mark) })])])])]))
            }
            let local = try snapshot(fieldsLocal, "1790000000003-0000-mac")
            let remote = try snapshot(fieldsRemote, "1790000000007-0000-phone")
            let merged = SyncMerge.merge(base: nil, local: local, remote: remote)
            return SyncConflicts.settle(conflicts: merged.conflicts, local: local, remote: remote, merged: merged.snapshot, now: now, peer: .ios)
        }
        let profile = try #require(try settle(["profileId": .string("p1")], ["profileId": .string("p2")]).first)
        #expect(profile.kept == .complex && profile.lost == .complex)
        #expect(profile.restore == .set(kind: "favorite", id: "v1", field: "profileId", value: .string("p1")))
        let fits = try #require(try settle(["name": .string(String(repeating: "x", count: SyncConflicts.Limits.maxValueChars - 2))], ["name": .string("court")], kind: "space").first)
        #expect(fits.restore != nil)
        let large = try #require(try settle(["name": .string(String(repeating: "x", count: SyncConflicts.Limits.maxValueChars - 1))], ["name": .string("court")], kind: "space").first)
        #expect(large.restore == nil && large.lost == .complex)
    }

    @Test func cutsATextByScalarAndReadsTheTimeOfAMark() {
        #expect(SyncConflicts.clip("abc", 5) == "abc")
        #expect(SyncConflicts.clip("abcdef", 3) == "abc…")
        #expect(SyncConflicts.clip("😀😀😀😀", 2) == "😀😀…")
        #expect(SyncConflicts.stampTime("1790000000007-0000-mac") == 1_790_000_000_007)
        #expect(SyncConflicts.stampTime("0") == nil)
    }

    @Test func namesTheDeviceThatWonFromThePointOfViewOfTheDeviceThatTellsIt() {
        func outcome(_ peer: SyncPlatform, _ winner: SyncConflictSide) -> String {
            var entry = line("a", now)
            entry.peer = peer
            entry.winner = winner
            return SyncConflicts.view(of: entry).outcome.key
        }
        #expect(outcome(.ios, .local) == "sync-conflict.outcome-newer-mac")
        #expect(outcome(.ios, .remote) == "sync-conflict.outcome-newer-ios")
        #expect(outcome(.mac, .local) == "sync-conflict.outcome-newer-ios")
        #expect(outcome(.mac, .remote) == "sync-conflict.outcome-newer-mac")
    }

    @Test func tellsATieADeletionThatLostAnOrderAFieldANewVersionAddedAndASetting() {
        var tie = line("a", now)
        tie.reason = .deviceID
        #expect(SyncConflicts.view(of: tie).outcome.key == "sync-conflict.outcome-tie-ios")
        var deleted = line("a", now)
        deleted.reason = .modificationOverDeletion
        deleted.field = nil
        deleted.kept = .absent
        deleted.lost = .absent
        let view = SyncConflicts.view(of: deleted)
        #expect(view.outcome.key == "sync-conflict.outcome-kept")
        #expect(view.rows.map(\.text.key).sorted() == ["sync-conflict.row-deleted", "sync-conflict.row-modified"])
        #expect(!view.compare)
        var order = line("a", now)
        order.kind = "order"
        order.field = nil
        order.reason = .order
        #expect(SyncConflicts.view(of: order).outcome.key == "sync-conflict.outcome-order-ios")
        #expect(SyncConflicts.view(of: order).compare)
        var future = line("a", now)
        future.kind = "widget"
        future.field = "futureField"
        #expect(SyncConflicts.view(of: future).title.key == "sync-conflict.kind-other")
        #expect(SyncConflicts.view(of: future).rows.first?.text.params.first == .literal("futureField"))
        var setting = line("a", now)
        setting.kind = "setting"
        setting.entityID = "sendGpc"
        setting.field = "value"
        setting.label = nil
        #expect(SyncConflicts.view(of: setting).title == SyncText("sync-conflict.kind-setting-named", .text(SyncText("sync-conflict.setting-send-gpc"))))
        setting.entityID = "weird"
        #expect(SyncConflicts.view(of: setting).title.params == [.literal("weird")])
    }

    @Test func putsTheRowsInTheOrderOfTheirTimeAndBreaksATieByTheNameOfTheDevice() {
        var entry = line("a", now)
        entry.keptAt = 7
        entry.lostAt = nil
        #expect(SyncConflicts.view(of: entry).rows.map(\.kept) == [false, true])
        entry.lostAt = 7
        #expect(SyncConflicts.view(of: entry).rows.map(\.platform) == [.ios, .mac])
    }

    @Test func theTablesOfKeysNameEveryFieldKindAndSettingOnceAndNothingElse() {
        #expect(SyncConflicts.fieldKeys.count == 25)
        #expect(Set(SyncConflicts.fieldKeys.values).count == 25)
        #expect(SyncConflicts.kindKeys.keys.sorted() == ["archived", "favorite", "folder", "order", "space", "tab"])
        #expect(SyncConflicts.settingKeys.count == 8)
        #expect(SyncConflicts.fieldKeys["constructor"] == nil)
    }
}
