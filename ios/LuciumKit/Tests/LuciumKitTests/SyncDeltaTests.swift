import Foundation
import Testing
@testable import LuciumKit

/// The difference between a snapshot and the base two devices share (docs/synchronisation.md §31), played against the vectors that the Mac's TypeScript plays too
/// (`ios/Contracts/sync-delta-vectors.json`: hand-written cases, the 60 draws of two devices and the failures of a rebuild), then the way it travels in parts and is put
/// back together, and how the phone's reader refuses what a difference may not be.

private struct DeltaCase: Sendable, CustomTestStringConvertible {
    let name: String
    let base: SyncSnapshot
    let snapshot: SyncSnapshot?
    let delta: SyncDelta
    let digest: String?
    let problem: String?
    var testDescription: String { name }
}

private enum DeltaCases {
    /// The wire form of a difference in the vectors: a snapshot's four members, then the three lists of removals.
    static func delta(_ value: JSONValue?) throws -> SyncDelta {
        let wire = try #require(value)
        let snapshot = try Contract.snapshot(.object(["entities": wire["entities"] ?? .object([:]), "tombstones": wire["tombstones"] ?? .object([:]), "order": wire["order"] ?? .object([:]), "orderStamps": wire["orderStamps"] ?? .object([:])]))
        func removals(_ name: String) -> [SyncDelta.Removal] { (wire[name]?.items ?? []).compactMap { one in one["kind"]?.text.flatMap { kind in one["id"]?.text.map { SyncDelta.Removal(kind: kind, id: $0) } } } }
        return SyncDelta(snapshot: snapshot, removedEntities: removals("removedEntities"), removedTombstones: removals("removedTombstones"), removedLists: (wire["removedLists"]?.items ?? []).compactMap(\.text))
    }

    static func all() -> [DeltaCase] {
        do {
            let file = try Contract.load("sync-delta-vectors.json")
            var cases: [DeltaCase] = []
            for group in ["cases", "draws"] {
                for raw in try #require(file[group]).items {
                    cases.append(DeltaCase(name: "\(group): \(try #require(raw["name"]?.text))", base: try Contract.snapshot(raw["base"]), snapshot: try Contract.snapshot(raw["snapshot"]), delta: try delta(raw["delta"]), digest: raw["digest"]?.text, problem: nil))
                }
            }
            for raw in try #require(file["failures"]).items {
                cases.append(DeltaCase(name: "failure: \(try #require(raw["name"]?.text))", base: try Contract.snapshot(raw["base"]), snapshot: nil, delta: try delta(raw["delta"]), digest: nil, problem: raw["problem"]?.text))
            }
            return cases
        } catch {
            Issue.record("the vectors of the differences do not load: \(error)")
            return []
        }
    }
}

@Suite("Synchronisation: the differences with the base, the vectors shared with the Mac")
struct SyncDeltaVectorTests {
    private static let cases = DeltaCases.all()

    @Test func theCorpusIsThere() {
        #expect(Self.cases.filter { $0.name.hasPrefix("cases") }.count >= 10)
        #expect(Self.cases.filter { $0.name.hasPrefix("draws") }.count >= 100)
        #expect(Self.cases.filter { $0.name.hasPrefix("failure") }.count >= 6)
    }

    @Test(arguments: SyncDeltaVectorTests.cases)
    fileprivate func theSameDifferenceAndTheSameRebuildAsTheMac(_ one: DeltaCase) throws {
        if let problem = one.problem {
            switch SyncDelta.apply(one.delta, to: one.base) {
            case .success: Issue.record("a rebuild that must fail went through: \(one.name)")
            case .failure(let failure): #expect(failure.message == problem)
            }
            return
        }
        let snapshot = try #require(one.snapshot)
        let computed = SyncDelta.diff(base: one.base, snapshot: snapshot)
        #expect(computed == one.delta, "the difference of the Swift is not the Mac's: \(one.name)")
        let rebuilt = try SyncDelta.apply(one.delta, to: one.base).get()
        #expect(rebuilt.digest == one.digest, "the rebuilt snapshot has not the digest of the Mac's: \(one.name)")
    }
}

@Suite("Synchronisation: a difference on the wire")
struct SyncDeltaPartsTests {
    private func entity(_ name: String, at counter: Int = 0) -> SyncEntity {
        SyncEntity(fields: ["name": .string(name)], stamps: ["name": String(format: "%013ld-%04lx-vector-mac-0000000001", 1_790_000_000_000, counter)])
    }

    private var base: SyncSnapshot {
        SyncSnapshot(entities: ["space": ["s1": entity("One"), "s2": entity("Two")], "tab": ["t1": entity("T")]], tombstones: ["tab": ["t0": "1790000000000-0000-vector-mac-0000000001"]],
                     order: ["spaces": ["s1", "s2"]], orderStamps: ["spaces": "1790000000000-0000-vector-mac-0000000001"])
    }

    private func assemble(_ parts: [[String: JSONValue]], on base: (snapshot: SyncSnapshot, hash: String)?, of snapshot: SyncSnapshot) throws -> SyncSnapshotParts.Assembler.Outcome {
        var assembler = SyncSnapshotParts.Assembler(differencesAgreed: base != nil)
        for part in parts { try assembler.add(.object(part)) }
        return try assembler.end(entityCount: snapshot.entities.values.reduce(0) { $0 + $1.count }, digest: snapshot.digest, rebuildOn: base)
    }

    @Test func aDifferenceSaysItsBaseInTheFirstPartAndIsRebuiltOnTheBase() throws {
        var changed = base
        changed.entities["space"]?["s1"] = entity("Uno", at: 1)
        changed.entities["space"]?["s2"] = nil
        let parts = SyncSnapshotParts.parts(differingFrom: base, hash: base.digest, of: changed, withheld: ["locked"])
        #expect(parts.count == 1)
        #expect(parts[0]["base"] == .string(base.digest))
        #expect(parts[0]["removedEntities"]?.items.count == 1)
        #expect(parts[0]["withheld"] == .array([.string("locked")]))
        let outcome = try assemble(parts, on: (base, base.digest), of: changed)
        guard case .assembled(let got) = outcome else { Issue.record("did not rebuild: \(outcome)"); return }
        #expect(got.snapshot == changed && got.withheld == ["locked"])
    }

    @Test func aDifferenceThatDoesNotRebuildIsNotAnErrorButTheReasonToAskForTheWholeSnapshot() throws {
        var changed = base
        changed.entities["space"]?["s1"] = entity("Uno", at: 1)
        var parts = SyncSnapshotParts.parts(differingFrom: base, hash: base.digest, of: changed, withheld: [])
        // The changed entity is lost on the way: the rebuilt snapshot is the base, whose digest is not the announced one.
        parts[0]["entities"] = .array([])
        guard case .didNotRebuild(let digest) = try assemble(parts, on: (base, base.digest), of: changed) else { Issue.record("it rebuilt"); return }
        #expect(digest.contains("digest"))
        // Another base than the one this device holds, or a removal of what the base does not hold.
        guard case .didNotRebuild(let other) = try assemble(SyncSnapshotParts.parts(differingFrom: base, hash: base.digest, of: changed, withheld: []), on: (base, String(repeating: "a", count: 64)), of: changed) else { Issue.record("it rebuilt"); return }
        #expect(other.contains("base"))
        var removing = SyncSnapshotParts.parts(differingFrom: base, hash: base.digest, of: changed, withheld: [])
        removing[0]["removedEntities"] = .array([.object(["kind": .string("space"), "id": .string("nowhere")])])
        guard case .didNotRebuild(let removal) = try assemble(removing, on: (base, base.digest), of: changed) else { Issue.record("it rebuilt"); return }
        #expect(removal.contains("removed entity"))
    }

    @Test func aDifferenceNobodyAgreedToAndARemovalInAWholeSnapshotAreBadMessages() throws {
        let parts = SyncSnapshotParts.parts(differingFrom: base, hash: base.digest, of: base, withheld: [])
        var assembler = SyncSnapshotParts.Assembler()
        #expect(throws: SyncFailure.self) { try assembler.add(.object(parts[0])) }
        var whole = SyncSnapshotParts.parts(of: base, withheld: [])
        whole[0]["removedLists"] = .array([.string("spaces")])
        var next = SyncSnapshotParts.Assembler(differencesAgreed: true)
        #expect(throws: SyncFailure.self) { try next.add(.object(whole[0])) }
        // The base is said in the first part only.
        var second = SyncSnapshotParts.Assembler(differencesAgreed: true)
        var first = parts[0]
        first["parts"] = .number(2)
        try second.add(.object(first))
        var later = parts[0]
        later["parts"] = .number(2)
        later["part"] = .number(1)
        #expect(throws: SyncFailure.self) { try second.add(.object(later)) }
    }

    @Test func aWholeSnapshotThatDoesNotMatchItsDigestIsStillTruncated() throws {
        var assembler = SyncSnapshotParts.Assembler(differencesAgreed: true)
        for part in SyncSnapshotParts.parts(of: base, withheld: []) { try assembler.add(.object(part)) }
        #expect(throws: SyncFailure.self) { try assembler.end(entityCount: 3, digest: String(repeating: "0", count: 64), rebuildOn: (base, base.digest)) }
    }

    @Test func aLargeDifferenceIsCutInPartsLikeAWholeSnapshot() throws {
        var big = SyncSnapshot()
        big.entities["tab"] = Dictionary(uniqueKeysWithValues: (0..<1300).map { ("t\($0)", entity("x", at: $0 % 15)) })
        let parts = SyncSnapshotParts.parts(differingFrom: SyncSnapshot(), hash: SyncSnapshot().digest, of: big, withheld: [])
        #expect(parts.count >= 3)
        #expect(parts.allSatisfy { ($0["entities"]?.items.count ?? 0) <= SyncLimits.maxEntitiesPerPart })
        #expect(parts.dropFirst().allSatisfy { $0["base"] == nil })
        guard case .assembled(let got) = try assemble(parts, on: (SyncSnapshot(), SyncSnapshot().digest), of: big) else { Issue.record("did not rebuild"); return }
        #expect(got.snapshot == big)
    }

    @Test func theMessagesOfADifferenceAreReadByTheCodecAndAnythingElseIsRefused() throws {
        let hello = SyncHello(device: SyncDeviceInfo(id: "phone-0001", name: "iPhone", platform: .ios), nonce: Data(repeating: 1, count: 16), categories: ["structure"], baseHash: base.digest, stateVersion: 1, appVersion: "0.1.0", now: 1_790_000_000_000, diff: SyncHello.diffVersion)
        for message in [SyncMessage.hello(hello), .snapshotCheck(ok: true), .snapshotCheck(ok: false)] {
            guard case .success(let read) = SyncMessageCodec.decode(try SyncMessageCodec.encode(message, number: 1)) else { Issue.record("not read back: \(message.type)"); continue }
            #expect(read.message == message)
        }
    }

    @Test func theChannelKeepsWhatTheOrderOfADifferenceAsksOf() {
        // §31.5: the history keeps an end each time and the parts of a snapshot as one entry, and the rules ask how many ends and whether a part came since the last one.
        let history = ["hello", "snapshot.part", "snapshot.end", "snapshot.check", "snapshot.part", "snapshot.end"]
        #expect(SyncTransitions.allows("result", after: history, receiver: .ios, phase: .session))
        #expect(!SyncTransitions.allows("snapshot.part", after: history, receiver: .ios, phase: .session))
        #expect(!SyncTransitions.allows("snapshot.check", after: history, receiver: .ios, phase: .session))
        #expect(!SyncTransitions.allows("snapshot.part", after: ["hello", "snapshot.part", "snapshot.end"], receiver: .ios, phase: .session))
    }
}
