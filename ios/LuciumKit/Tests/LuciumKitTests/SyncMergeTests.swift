import Foundation
import Testing
@testable import LuciumKit

/// The three-way merge of docs/synchronisation.md §11 and what goes with it (the canonical form of §8.4, the door a snapshot comes in by, §8.3), played
/// against the vectors that the Mac's TypeScript plays too: `ios/Contracts/sync-merge-vectors.json`, `sync-merge-draws.json` (60 random states with the
/// result of the Mac's merge), `sync-snapshot-vectors.json` and, for the canonical form, `sync-message-vectors.json`. Then the properties of §11.9 on the
/// same states: convergence, idempotence, unknown fields kept, no dangling reference, no loop, a space set aside, the first exchange.
///
/// Swift's dictionaries are seeded differently in every process: the order a merge walks its entities in changes from one run to the next, so a rule
/// that depended on it would fail here some of the time.

// MARK: - The files

enum Contract {
    static func load(_ name: String) throws -> JSONValue {
        // …/ios/LuciumKit/Tests/LuciumKitTests/SyncMergeTests.swift → …/ios/Contracts/<name>
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/\(name)")
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    /// A snapshot read through the same door as a received one: a vector the form refuses is a vector that is wrong.
    static func snapshot(_ value: JSONValue?) throws -> SyncSnapshot {
        switch SyncSnapshot.read(try #require(value)) {
        case .success(let snapshot): return snapshot
        case .failure(let problem): throw problem
        }
    }

    static func optionalSnapshot(_ value: JSONValue?) throws -> SyncSnapshot? {
        if case .null? = value { return nil }
        return try snapshot(value)
    }

    static func conflicts(_ value: JSONValue?) throws -> [SyncConflict] {
        guard case .array(let items)? = value else { throw ContractError.missing("conflicts") }
        return try items.map { item in
            guard case .string(let kind)? = item["kind"], case .string(let id)? = item["id"], case .string(let winner)? = item["winner"], case .string(let reason)? = item["reason"],
                  let side = SyncConflictSide(rawValue: winner), let why = SyncConflictReason(rawValue: reason) else { throw ContractError.missing("a conflict") }
            var field: String?
            if case .string(let name)? = item["field"] { field = name }
            return SyncConflict(kind: kind, id: id, field: field, winner: side, reason: why)
        }
    }

    enum ContractError: Error { case missing(String) }
}

extension JSONValue {
    subscript(key: String) -> JSONValue? {
        if case .object(let members) = self { return members[key] }
        return nil
    }
    var items: [JSONValue] {
        if case .array(let values) = self { return values }
        return []
    }
    var text: String? {
        if case .string(let value) = self { return value }
        return nil
    }
    var flag: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}

struct MergeCase: Sendable, CustomTestStringConvertible {
    let name: String
    let base: SyncSnapshot?
    let local: SyncSnapshot
    let remote: SyncSnapshot
    let withheld: [String]
    let expectedSnapshot: SyncSnapshot
    /// The lists a vector names: only these are compared (the draws name every list).
    let namedLists: [String]
    let expectedConflicts: [SyncConflict]
    let swap: Bool
    let digest: String?
    var testDescription: String { name }

    func merged() -> SyncMergeResult { SyncMerge.merge(base: base, local: local, remote: remote, withheld: withheld) }
}

enum Cases {
    static func vectors() -> [MergeCase] {
        do {
            return try Contract.load("sync-merge-vectors.json")["cases"]!.items.map { raw in
                let expect = try #require(raw["expect"])
                var expected = SyncSnapshot.read(.object(["entities": expect["entities"] ?? .object([:]), "tombstones": expect["tombstones"] ?? .object([:])]))
                var named: [String] = []
                if case .object(let lists)? = expect["order"] { named = Array(lists.keys) }
                let order: JSONValue = expect["order"] ?? .object([:])
                if case .success(var snapshot) = expected {
                    snapshot = try Contract.snapshot(.object(["entities": expect["entities"] ?? .object([:]), "tombstones": expect["tombstones"] ?? .object([:]), "order": order]))
                    expected = .success(snapshot)
                }
                return MergeCase(
                    name: try #require(raw["name"]?.text), base: try Contract.optionalSnapshot(raw["base"]), local: try Contract.snapshot(raw["local"]), remote: try Contract.snapshot(raw["remote"]),
                    withheld: (raw["withheld"]?.items ?? []).compactMap(\.text), expectedSnapshot: try expected.get(), namedLists: named,
                    expectedConflicts: try Contract.conflicts(expect["conflicts"]), swap: raw["swap"]?.flag ?? false, digest: nil)
            }
        } catch {
            Issue.record("the merge vectors do not load: \(error)")
            return []
        }
    }

    static func draws() -> [MergeCase] {
        do {
            return try Contract.load("sync-merge-draws.json")["cases"]!.items.map { raw in
                let expect = try #require(raw["expect"])
                let snapshot = try Contract.snapshot(expect["snapshot"])
                return MergeCase(
                    name: try #require(raw["name"]?.text), base: try Contract.optionalSnapshot(raw["base"]), local: try Contract.snapshot(raw["local"]), remote: try Contract.snapshot(raw["remote"]),
                    withheld: (raw["withheld"]?.items ?? []).compactMap(\.text), expectedSnapshot: snapshot, namedLists: Array(snapshot.order.keys),
                    expectedConflicts: try Contract.conflicts(expect["conflicts"]), swap: true, digest: expect["digest"]?.text)
            }
        } catch {
            Issue.record("the corpus of draws does not load: \(error)")
            return []
        }
    }
}

private func swapped(_ conflicts: [SyncConflict]) -> [SyncConflict] {
    conflicts.map(\.seenFromTheOtherDevice).sorted(by: SyncConflict.precedes)
}

// MARK: - The vectors of the merge

@Suite("Sync merge: the vectors shared with the Mac")
struct SyncMergeVectorTests {
    private static let vectors = Cases.vectors()
    private static let draws = Cases.draws()

    @Test func thereAreVectorsToRun() {
        #expect(Self.vectors.count >= 34)
        #expect(Self.draws.count >= 60)
        #expect(Self.vectors.contains { $0.base == nil })
        #expect(Self.vectors.contains { !$0.withheld.isEmpty })
        #expect(Set(Self.vectors.flatMap { $0.expectedConflicts.map(\.reason) }) == Set([.newer, .deviceID, .value, .modificationOverDeletion, .order]))
    }

    @Test(arguments: SyncMergeVectorTests.vectors)
    fileprivate func playsTheVector(_ vector: MergeCase) {
        let merged = vector.merged()
        #expect(merged.snapshot.entities == vector.expectedSnapshot.entities)
        #expect(merged.snapshot.tombstones == vector.expectedSnapshot.tombstones)
        #expect(merged.conflicts == vector.expectedConflicts)
        for key in vector.namedLists { #expect(merged.snapshot.order[key] == vector.expectedSnapshot.order[key], "the list \(key)") }
    }

    @Test(arguments: SyncMergeVectorTests.draws)
    fileprivate func playsTheDrawOfTheMac(_ draw: MergeCase) {
        let merged = draw.merged()
        // The whole snapshot and the whole list of conflicts, as the Mac's merge gave them, and the digest of the canonical form both devices compare.
        #expect(merged.snapshot == draw.expectedSnapshot)
        #expect(merged.conflicts == draw.expectedConflicts)
        if let digest = draw.digest { #expect(merged.snapshot.digest == digest) }
    }
}

// MARK: - The properties of §11.9

@Suite("Sync merge: the properties of the specification")
struct SyncMergePropertyTests {
    private static let all = Cases.vectors() + Cases.draws()

    @Test(arguments: SyncMergePropertyTests.all.filter(\.swap))
    fileprivate func convergesWhenLocalAndRemoteAreExchanged(_ c: MergeCase) {
        let there = c.merged()
        let back = SyncMerge.merge(base: c.base, local: c.remote, remote: c.local, withheld: c.withheld)
        #expect(back.snapshot == there.snapshot)
        #expect(back.snapshot.digest == there.snapshot.digest)
        #expect(back.conflicts == swapped(there.conflicts))
    }

    @Test(arguments: SyncMergePropertyTests.all)
    fileprivate func isIdempotent(_ c: MergeCase) {
        let first = c.merged()
        // The result merged with itself, on itself as base.
        let again = SyncMerge.merge(base: first.snapshot, local: first.snapshot, remote: first.snapshot, withheld: c.withheld)
        #expect(again.snapshot == first.snapshot)
        #expect(again.conflicts.isEmpty)
        // The result merged with either parent, on the same base: nothing changes, whichever side the result is on.
        for parent in [c.local, c.remote] {
            #expect(SyncMerge.merge(base: c.base, local: first.snapshot, remote: parent, withheld: c.withheld).snapshot == first.snapshot)
            #expect(SyncMerge.merge(base: c.base, local: parent, remote: first.snapshot, withheld: c.withheld).snapshot == first.snapshot)
        }
    }

    @Test(arguments: SyncMergePropertyTests.all)
    fileprivate func leavesNoDanglingReferenceNoLoopAndCoherentLists(_ c: MergeCase) {
        let snapshot = c.merged().snapshot
        let spaces = snapshot.entities["space"] ?? [:]
        let folders = snapshot.entities["folder"] ?? [:]
        for kind in ["folder", "tab", "archived"] {
            for (id, entity) in snapshot.entities[kind] ?? [:] {
                guard case .string(let space)? = entity.fields["spaceId"] else {
                    Issue.record("\(kind) \(id) has no space")
                    continue
                }
                #expect(spaces[space] != nil, "\(kind) \(id) in a space that is not there")
                let field = kind == "folder" ? "parentId" : "folderId"
                if case .string(let target)? = entity.fields[field] { #expect(folders[target] != nil, "\(kind) \(id).\(field)") }
            }
        }
        for start in folders.keys {
            var seen = Set<String>()
            var at: String? = start
            while let current = at, let folder = folders[current] {
                // A loop ends the walk: without this a folder that loops would make the test itself loop for ever.
                guard seen.insert(current).inserted else {
                    Issue.record("a loop through \(current)")
                    break
                }
                if case .string(let parent)? = folder.fields["parentId"] { at = parent } else { at = nil }
            }
        }
        // A list holds each member once, only members that are there, and only the members its key names.
        var expected: [String: Set<String>] = [:]
        for (kind, byID) in snapshot.entities {
            for (id, entity) in byID {
                func text(_ name: String) -> String { if case .string(let value)? = entity.fields[name] { return value }; return "-" }
                let key: String? = switch kind {
                case "space": "spaces"
                case "folder": "folders:\(text("spaceId")):\(text("parentId"))"
                case "tab": "tabs:\(text("spaceId")):\(text("folderId"))"
                case "favorite": "favorites:\(text("profileId"))"
                default: nil
                }
                if let key { expected[key, default: []].insert(id) }
            }
        }
        for (key, ids) in snapshot.order {
            #expect(Set(ids).count == ids.count, "\(key) repeats an id")
            #expect(Set(ids) == expected[key], "\(key)")
        }
        #expect(Set(snapshot.order.keys) == Set(expected.keys))
    }

    @Test(arguments: SyncMergePropertyTests.all.filter { $0.withheld.isEmpty })
    fileprivate func keepsWhatItDoesNotKnow(_ c: MergeCase) {
        let merged = SyncMerge.merge(base: c.base, local: c.local, remote: c.remote).snapshot
        for (side, other) in [(c.local, c.remote), (c.remote, c.local)] {
            for (kind, byID) in side.entities {
                for (id, entity) in byID {
                    guard let kept = merged.entities[kind]?[id] else { continue }
                    let base = c.base?.entities[kind]?[id]
                    for (name, value) in entity.fields where base?.fields[name] == nil && other.entities[kind]?[id]?.fields[name] == nil && name != "folderId" && name != "parentId" {
                        // A field only this side has, never in the base, is an addition on this side: it is in the result, with its mark (the mark of zero when it had none).
                        #expect(kept.fields[name] == value, "\(kind).\(id).\(name)")
                        #expect(kept.stamps[name] == (entity.stamps[name] ?? SyncStamp.zero), "\(kind).\(id).\(name)")
                    }
                }
            }
        }
    }

    @Test(arguments: SyncMergePropertyTests.all)
    fileprivate func invents_nothing(_ c: MergeCase) {
        let merged = c.merged().snapshot
        let inputs = [c.base, c.local, c.remote].compactMap { $0 }
        for (kind, byID) in merged.entities {
            for id in byID.keys { #expect(inputs.contains { $0.entities[kind]?[id] != nil }, "\(kind) \(id) is in no input") }
        }
        for (kind, byID) in merged.tombstones {
            for id in byID.keys { #expect(inputs.contains { $0.entities[kind]?[id] != nil || $0.tombstones[kind]?[id] != nil }, "tombstone \(kind) \(id) is from nowhere") }
        }
    }

    @Test(arguments: SyncMergePropertyTests.all.filter { !$0.withheld.isEmpty })
    fileprivate func takesNothingOfASpaceSetAside(_ c: MergeCase) {
        let aside = Set(c.withheld)
        let snapshot = c.merged().snapshot
        for (kind, byID) in snapshot.entities {
            for (id, entity) in byID {
                #expect(!(kind == "space" && aside.contains(id)), "the space \(id)")
                if case .string(let space)? = entity.fields["spaceId"] { #expect(!aside.contains(space), "\(kind) \(id) of a space set aside") }
            }
        }
    }

    @Test func aSpaceSetAsideOnOneDeviceOnlyDoesNotTravelEither() throws {
        let base = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": entity(["name": .string("Travail")])])])]))
        let remote = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": entity(["name": .string("Renommé")])])])]))
        #expect(SyncMerge.merge(base: base, local: base, remote: remote, withheld: ["s1"]).snapshot.entities["space"] == nil)
        #expect(SyncMerge.merge(base: base, local: base, remote: remote).snapshot.entities["space"]?["s1"]?.fields["name"] == .string("Renommé"))
    }

    @Test func aDeviceNeverModifiedSendsAnEmptySnapshotAndTheOthersStateIsTheResult() throws {
        let mac = try Contract.snapshot(.object([
            "entities": .object([
                "space": .object(["s1": entity(["name": .string("Travail")]), "s2": entity(["name": .string("Maison")])]),
                "tab": .object(["t1": entity(["spaceId": .string("s1"), "pinned": .bool(true), "anchorUrl": .string("https://a.example/")])]),
            ]),
            "order": .object(["spaces": .array([.string("s1"), .string("s2")]), "tabs:s1:-": .array([.string("t1")])]),
        ]))
        let onMac = SyncMerge.merge(base: nil, local: mac, remote: .empty)
        let onPhone = SyncMerge.merge(base: nil, local: .empty, remote: mac)
        #expect(onPhone.snapshot == onMac.snapshot)
        #expect(onMac.snapshot == mac)
        #expect(onMac.conflicts.isEmpty)
        #expect(onMac.snapshot.digest == mac.digest)
    }

    @Test func theFirstExchangeIsTheUnionOfBothStatesAndSettlesAFieldByItsMark() throws {
        let a = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": entity(["name": .string("Mac")], "1790000000003-0000-mac")])])]))
        let b = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": entity(["name": .string("iPhone")], "1790000000004-0000-phone"), "p1": entity(["name": .string("Espace 1")])])])]))
        let merged = SyncMerge.merge(base: nil, local: a, remote: b)
        #expect(merged.snapshot.entities["space"]?["s1"]?.fields["name"] == .string("iPhone"))
        #expect(merged.snapshot.entities["space"]?["p1"] != nil)
        #expect(merged.conflicts == [SyncConflict(kind: "space", id: "s1", field: "name", winner: .remote, reason: .newer)])
        #expect(SyncMerge.merge(base: nil, local: b, remote: a).conflicts == [SyncConflict(kind: "space", id: "s1", field: "name", winner: .local, reason: .newer)])
    }

    @Test func compareTwoValuesNoMarkCanTellApartByUTF16CodeUnitNotByUTF8Byte() throws {
        // "😀" is D83D DE00 in UTF-16 and F0 9F 98 80 in UTF-8; "～" is FF5E and EF BD 9E: the two orders disagree.
        let a = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": .object(["fields": .object(["name": .string("😀")]), "stamps": .object([:])])])])]))
        let b = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": .object(["fields": .object(["name": .string("～")]), "stamps": .object([:])])])])]))
        let merged = SyncMerge.merge(base: nil, local: a, remote: b)
        #expect(merged.snapshot.entities["space"]?["s1"]?.fields["name"] == .string("～"))
        #expect(merged.conflicts == [SyncConflict(kind: "space", id: "s1", field: "name", winner: .remote, reason: .value)])
    }

    @Test func cutsAChainOf20000FoldersWithoutTakingAQuadraticTime() throws {
        var folders: [String: JSONValue] = [:]
        for index in 0..<20_000 { folders["f\(index)"] = entity(["spaceId": .string("s1"), "name": .string("F"), "parentId": .string("f\((index + 1) % 20_000)")]) }
        let snapshot = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": entity(["name": .string("S")])]), "folder": .object(folders)])]))
        let started = Date()
        let merged = SyncMerge.merge(base: nil, local: snapshot, remote: .empty).snapshot
        #expect(Date().timeIntervalSince(started) < 10)
        #expect((merged.entities["folder"] ?? [:]).values.filter { $0.fields["parentId"] == nil }.count == 1)
    }

    @Test func listsTheConflictsByKindIdAndFieldEachByUTF16CodeUnitAWholeEntityBeforeItsFields() {
        let list = [("tab", "t1", "b"), ("tab", "t1", nil), ("tab", "T1", "a"), ("order", "spaces", nil), ("tab", "t1", "a")].map {
            SyncConflict(kind: $0.0, id: $0.1, field: $0.2, winner: .local, reason: .newer)
        }
        #expect(list.sorted(by: SyncConflict.precedes).map { "\($0.kind)/\($0.id)/\($0.field ?? "nil")" } == ["order/spaces/nil", "tab/T1/a", "tab/t1/nil", "tab/t1/a", "tab/t1/b"])
    }

    @Test func repairsACopyAndAFolderThatIsItsOwnParentLosesTheLink() throws {
        let tab = entity(["spaceId": .string("s1"), "pinned": .bool(true), "anchorUrl": .string("https://a.example/"), "folderId": .string("f9")])
        let mine = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": entity(["name": .string("S")])]), "tab": .object(["t1": tab]),
                                                                       "folder": .object(["z": entity(["spaceId": .string("s1"), "name": .string("Z"), "parentId": .string("z")])])])]))
        let merged = SyncMerge.merge(base: nil, local: mine, remote: .empty).snapshot
        #expect(merged.entities["tab"]?["t1"]?.fields["folderId"] == nil)
        #expect(mine.entities["tab"]?["t1"]?.fields["folderId"] == .string("f9"))
        #expect(merged.entities["folder"]?["z"]?.fields["parentId"] == nil)
    }

    @Test func writesNoMarkForAFieldThatIsAbsentAndWhoseMarkIsZero() throws {
        let side = try Contract.snapshot(.object(["entities": .object(["space": .object(["s1": .object(["fields": .object(["name": .string("A")]), "stamps": .object(["name": .string("1790000000001-0000-mac"), "ghost": .string("0")])])])])]))
        #expect(SyncMerge.merge(base: nil, local: side, remote: side).snapshot.entities["space"]?["s1"]?.stamps == ["name": "1790000000001-0000-mac"])
    }

    private func entity(_ fields: [String: JSONValue], _ mark: String = "1790000000001-0000-mac") -> JSONValue {
        .object(["fields": .object(fields), "stamps": .object(fields.mapValues { _ in .string(mark) })])
    }
}

// MARK: - The door a snapshot comes in by

@Suite("Sync snapshot: the vectors shared with the Mac")
struct SyncSnapshotVectorTests {
    struct Vector: Sendable, CustomTestStringConvertible {
        let name: String
        let json: String
        let accepted: Bool
        let canonical: String?
        var testDescription: String { name }
    }

    static let vectors: [Vector] = {
        do {
            return try Contract.load("sync-snapshot-vectors.json")["cases"]!.items.map { raw in
                Vector(name: try #require(raw["name"]?.text), json: try #require(raw["json"]?.text), accepted: try #require(raw["expect"]?["accepted"]?.flag), canonical: raw["expect"]?["canonical"]?.text)
            }
        } catch {
            Issue.record("the snapshot vectors do not load: \(error)")
            return []
        }
    }()

    @Test func thereAreVectorsToRun() {
        #expect(Self.vectors.count >= 30)
        #expect(Self.vectors.filter { !$0.accepted }.count > 15)
    }

    @Test(arguments: SyncSnapshotVectorTests.vectors)
    func readsOrRefusesLikeTheMac(_ vector: Vector) throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(vector.json.utf8))
        switch SyncSnapshot.read(value) {
        case .success(let snapshot):
            #expect(vector.accepted, "accepted, and the Mac refuses it")
            if let canonical = vector.canonical { #expect(SyncCanonical.text(snapshot.json) == canonical) }
        case .failure(let problem):
            #expect(!vector.accepted, "refused (\(problem)), and the Mac accepts it")
        }
    }

    @Test func refusesTooManyEntitiesAndTooManyTombstones() {
        var many: [String: JSONValue] = [:]
        for index in 0...SyncSnapshot.Limits.maxEntities { many["t\(index)"] = .object(["fields": .object([:]), "stamps": .object([:])]) }
        #expect(SyncSnapshot.read(.object(["entities": .object(["tab": .object(many)])])).isFailure)
        var tombs: [String: JSONValue] = [:]
        for index in 0...SyncSnapshot.Limits.maxEntities { tombs["t\(index)"] = .string("1790000000001-0000-mac") }
        #expect(SyncSnapshot.read(.object(["tombstones": .object(["tab": .object(tombs)])])).isFailure)
    }

    @Test func refusesAStringTooLongAndAcceptsOneAtTheBound() {
        func snapshot(_ text: String) -> JSONValue { .object(["entities": .object(["space": .object(["s1": .object(["fields": .object(["a": .string(text)]), "stamps": .object([:])])])])]) }
        #expect(SyncSnapshot.read(snapshot(String(repeating: "x", count: SyncSnapshot.Limits.maxStringChars))).isFailure == false)
        #expect(SyncSnapshot.read(snapshot(String(repeating: "x", count: SyncSnapshot.Limits.maxStringChars + 1))).isFailure)
    }

    @Test func readsAMarkOnlyInTheFormOfTheSpecification() {
        #expect(SyncStamp.isValid("1790000000001-0000-mac"))
        #expect(SyncStamp.isValid("0"))
        for bad in ["", "00", "1790000000001-0000", "179000000001-0000-mac", "1790000000001-000G-mac", "1790000000001-0000-", "1790000000001-0000-a b", "1790000000001-0000-" + String(repeating: "a", count: 65), "1790000000001-000A-mac"] {
            #expect(!SyncStamp.isValid(bad), "\(bad.debugDescription)")
        }
    }
}

private extension Result {
    var isFailure: Bool { if case .failure = self { return true } else { return false } }
}

// MARK: - The canonical form

@Suite("Sync canonical form: the vectors shared with the Mac")
struct SyncCanonicalTests {
    struct Vector: Sendable, CustomTestStringConvertible {
        let name: String
        let value: JSONValue
        let canonical: String
        let sha256: String
        var testDescription: String { name }
    }

    static let vectors: [Vector] = {
        do {
            return try Contract.load("sync-message-vectors.json")["canonical"]!.items.map { raw in
                Vector(name: try #require(raw["name"]?.text), value: try #require(raw["value"]), canonical: try #require(raw["canonical"]?.text), sha256: try #require(raw["sha256Hex"]?.text))
            }
        } catch {
            Issue.record("the canonical vectors do not load: \(error)")
            return []
        }
    }()

    @Test(arguments: SyncCanonicalTests.vectors)
    func writesTheVector(_ vector: Vector) {
        #expect(SyncCanonical.text(vector.value) == vector.canonical)
        #expect(SyncCanonical.digest(of: vector.value) == vector.sha256)
    }

    @Test func writesTheMarksInTheOrderOfTheVectors() throws {
        for raw in try #require(Contract.load("sync-message-vectors.json")["stamps"]).items {
            let a = try #require(raw["a"]?.text), b = try #require(raw["b"]?.text)
            guard case .number(let expected)? = raw["expect"] else { continue }
            #expect(SyncStamp.compare(a, b) == Int(expected), "\(a) ? \(b)")
            #expect(SyncStamp.compare(b, a) == -Int(expected), "\(b) ? \(a)")
        }
    }

    /// What JavaScript's `JSON.stringify` writes for a number: the shortest digits, no exponent between 1e-6 and 1e21, `-0` as `0`.
    @Test(arguments: [
        (0.0, "0"), (-0.0, "0"), (1.0, "1"), (-7.0, "-7"), (1.5, "1.5"), (0.1, "0.1"), (0.5, "0.5"), (100.0, "100"), (123456789012.0, "123456789012"),
        (1e-6, "0.000001"), (1.234e-5, "0.00001234"), (0.000123, "0.000123"), (1e20, "100000000000000000000"), (1.5e20, "150000000000000000000"),
        (4.35, "4.35"), (1.0 / 3.0, "0.3333333333333333"), (2.0 / 3.0, "0.6666666666666666"), (0.30000000000000004, "0.30000000000000004"),
        (9007199254740991.0, "9007199254740991"), (1790000000001.0, "1790000000001"), (3.141592653589793, "3.141592653589793"),
        (1e21, "1e+21"), (1.5e300, "1.5e+300"), (5e-7, "5e-7"), (1.2345e-7, "1.2345e-7"), (5e-324, "5e-324"),
    ] as [(Double, String)])
    func writesANumberAsJavaScriptDoes(_ number: Double, _ text: String) {
        #expect(SyncCanonical.numberText(number) == text)
    }

    @Test func escapesAStringAsJSONStringifyDoes() {
        #expect(SyncCanonical.text(.string("a\"b\\c\nd\te\r\u{08}\u{0C}")) == "\"a\\\"b\\\\c\\nd\\te\\r\\b\\f\"")
        #expect(SyncCanonical.text(.string("\u{01}\u{1F}")) == "\"\\u0001\\u001f\"")
        // U+007F, U+2028, U+2029 and the astral plane are written as they are.
        #expect(SyncCanonical.text(.string("\u{7F}\u{2028}\u{2029}😀")) == "\"\u{7F}\u{2028}\u{2029}😀\"")
    }

    @Test func sortsTheKeysByUTF16CodeUnitNotByTheBytesOfUTF8() {
        #expect(SyncCanonical.text(.object(["～": .number(1), "😀": .number(2)])) == "{\"😀\":2,\"～\":1}")
        #expect(SyncCanonical.text(.object(["é": .number(1), "z": .number(2), "Z": .number(3), "a": .number(4)])) == "{\"Z\":3,\"a\":4,\"z\":2,\"é\":1}")
        #expect(SyncCanonical.compare("😀", "～") == -1)
        #expect(SyncCanonical.compare("a", "a") == 0)
        #expect(SyncCanonical.compare("a", "ab") == -1)
        #expect(SyncCanonical.compare("b", "a") == 1)
    }

    @Test func refusesANumberThatHasNoJSONText() {
        #expect(SyncCanonical.text(.number(.nan)) == nil)
        #expect(SyncCanonical.text(.array([.number(.infinity)])) == nil)
    }

    @Test func comparesStringsScalarForScalarNotUpToCanonicalEquivalence() {
        let precomposed = "caf\u{00E9}"
        let decomposed = "cafe\u{0301}"
        #expect(precomposed == decomposed) // Swift says they are the same string; JavaScript does not
        #expect(!SyncCanonical.identical(precomposed, decomposed))
        #expect(!SyncCanonical.same(.string(precomposed), .string(decomposed)))
        #expect(SyncCanonical.same(.object(["a": .number(1), "b": .array([.number(1), .number(2)])]), .object(["b": .array([.number(1), .number(2)]), "a": .number(1)])))
        #expect(!SyncCanonical.same(.array([.number(1), .number(2)]), .array([.number(2), .number(1)])))
        #expect(!SyncCanonical.same(nil, .null))
        #expect(SyncCanonical.same(nil, nil))
        #expect(SyncCanonical.same(.number(1), .number(1.0)))
        #expect(!SyncCanonical.same(.string("1"), .number(1)))
    }
}
