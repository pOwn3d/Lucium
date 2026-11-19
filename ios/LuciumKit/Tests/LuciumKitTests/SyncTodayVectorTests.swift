import Foundation
import Testing
@testable import LuciumKit

/// The shared Today tabs of docs/synchronisation.md §27 (card 507), played against the vectors that the Mac's TypeScript plays too:
/// `ios/Contracts/sync-today-vectors.json` (`src/shared/ios-sync-today-contract.test.ts`). The admission, the door and the moves are `SyncToday`; the merge of the
/// vectors' `merge` cases is `SyncMerge`, which has no rule of its own for a Today tab: they are cases of its rules (§27.9).

private enum TodayVectors {
    static let file: JSONValue = {
        do { return try Contract.load("sync-today-vectors.json") } catch {
            Issue.record("the Today vectors do not load: \(error)")
            return .object([:])
        }
    }()

    static func section(_ name: String) -> [JSONValue] { file[name]?.items ?? [] }

    static func entity(_ value: JSONValue?) -> SyncEntity {
        var entity = SyncEntity()
        if case .object(let fields)? = value?["fields"] { entity.fields = fields }
        if case .object(let stamps)? = value?["stamps"] { entity.stamps = stamps.compactMapValues(\.text) }
        return entity
    }

    static func entities(_ value: JSONValue?) -> [String: SyncEntity] {
        guard case .object(let byID)? = value else { return [:] }
        return byID.mapValues { entity($0) }
    }

    static func ids(_ value: JSONValue?) -> [String] { (value?.items ?? []).compactMap(\.text) }

    static func number(_ value: JSONValue?) -> Double {
        if case .number(let n)? = value { return n }
        return .nan
    }

    static func candidate(_ raw: JSONValue) -> SyncToday.Candidate {
        var c = SyncToday.Candidate(id: raw["id"]?.text ?? "", url: raw["url"]?.text ?? "", ageMilliseconds: Int(number(raw["ageMs"])), lastActiveAt: number(raw["lastActiveAt"]))
        c.isPrivate = raw["private"]?.flag ?? false
        c.inPrivateWindow = raw["privateWindow"]?.flag ?? false
        c.isFavoritePage = raw["favorite"]?.flag ?? false
        c.inContainer = raw["container"]?.flag ?? false
        c.spaceLocked = raw["spaceLocked"]?.flag ?? false
        c.admitted = raw["admitted"]?.flag ?? false
        c.adopted = raw["adopted"]?.flag ?? false
        return c
    }

    static func intOrNil(_ value: JSONValue?) -> Int? {
        if case .number(let n)? = value { return Int(n) }
        return nil
    }
}

@Suite("Shared Today tabs: the numbers and the classes (§27.2, §27.4)")
struct SyncTodayNumbersTests {
    @Test func statesTheLimitsTheCodeHolds() {
        let limits = TodayVectors.file["limits"]
        #expect(TodayVectors.intOrNil(limits?["todayTabCap"]) == SyncToday.cap)
        #expect(TodayVectors.intOrNil(limits?["todayTabGate"]) == SyncToday.gate)
        #expect(TodayVectors.intOrNil(limits?["urlMaxBytes"]) == SyncToday.urlMaxBytes)
        #expect(TodayVectors.intOrNil(limits?["titleMaxBytes"]) == SyncToday.titleMaxBytes)
        #expect(TodayVectors.intOrNil(limits?["minAgeMs"]) == SyncToday.minAgeMilliseconds)
        #expect(TodayVectors.intOrNil(limits?["activeAtStepMs"]) == SyncToday.activeAtStepMilliseconds)
        // The decisions of the project lead [Q12]: 200 at the entry, 500 at the door, 20 seconds, ten minutes.
        let held: [Int] = [SyncToday.cap, SyncToday.gate, SyncToday.minAgeMilliseconds, SyncToday.activeAtStepMilliseconds]
        #expect(held == [200, 500, 20_000, 600_000])
    }

    @Test func areTheClassesOfTheVectors() {
        let classes = TodayVectors.file["fieldClasses"]?["todayTab"]
        #expect(TodayVectors.ids(classes?["synced"]) == SyncToday.fieldClasses.synced)
        #expect(TodayVectors.ids(classes?["seed"]) == SyncToday.fieldClasses.seed)
        #expect(TodayVectors.ids(classes?["local"]) == SyncToday.fieldClasses.local)
        #expect(TodayVectors.ids(classes?["notApplicable"]) == SyncToday.notApplicable)
        // Every field is in one class only, and the page a tab is on is a seed ([Q14]).
        let all = SyncToday.fieldClasses.synced + SyncToday.fieldClasses.seed + SyncToday.fieldClasses.local + SyncToday.notApplicable
        #expect(Set(all).count == all.count)
        #expect(SyncToday.fieldClasses.seed == ["url", "title"])
        #expect(SyncToday.fieldClasses.local.contains("private"))
        #expect(SyncToday.fieldClasses.local.contains("container"))
    }

    @Test func roundsTheActivityDownToTenMinutes() {
        let cases = TodayVectors.file["activeAt"]?["round"]?.items ?? []
        #expect(cases.count >= 5)
        for c in cases { #expect(Double(SyncToday.roundActiveAt(TodayVectors.number(c["lastActiveAt"]))) == TodayVectors.number(c["expect"]), "\(TodayVectors.number(c["lastActiveAt"]))") }
        #expect(SyncToday.roundActiveAt(.nan) == 0)
        #expect(SyncToday.roundActiveAt(.infinity) == 0)
    }

    @Test func writesTheGreaterOfTheTwoAsLastActiveAt() {
        let cases = TodayVectors.file["activeAt"]?["lastActive"]?.items ?? []
        #expect(cases.count >= 3)
        for c in cases { #expect(SyncToday.lastActive(local: TodayVectors.number(c["local"]), received: TodayVectors.number(c["received"])) == TodayVectors.number(c["expect"])) }
    }
}

@Suite("Shared Today tabs: the address (§27.3, §27.7)")
struct SyncTodayAddressTests {
    @Test func playsTheVectors() {
        let cases = TodayVectors.section("address")
        #expect(cases.count >= 12)
        for c in cases {
            #expect(SyncToday.isShareableAddress(c["url"]) == (c["expect"]?.flag == true), "\(c["name"]?.text ?? "")")
        }
        #expect(!SyncToday.isShareableAddress(.number(5)))
        #expect(!SyncToday.isShareableAddress(nil))
    }
}

@Suite("Shared Today tabs: the admission (§27.3, §27.4)")
struct SyncTodayAdmissionTests {
    @Test func playsTheVectors() {
        let cases = TodayVectors.section("admission")
        #expect(cases.count >= 25)
        var reasons = Set<String>()
        for c in cases {
            let name = c["name"]?.text ?? ""
            let result = SyncToday.admit((c["candidates"]?.items ?? []).map(TodayVectors.candidate), cap: TodayVectors.intOrNil(c["cap"]) ?? SyncToday.cap)
            #expect(result.admitted == TodayVectors.ids(c["expect"]?["admitted"]), "\(name)")
            let expected = (c["expect"]?["refused"]?.items ?? []).map { ($0["id"]?.text ?? "", $0["reason"]?.text ?? "") }
            #expect(result.refused.map { $0.id } == expected.map { $0.0 }, "\(name)")
            #expect(result.refused.map { $0.reason.rawValue } == expected.map { $0.1 }, "\(name)")
            reasons.formUnion(expected.map { $0.1 })
        }
        // A vector for each refusal, so that a condition that is removed has one to fail.
        #expect(reasons == ["private", "private-window", "favorite", "container", "space-locked", "not-web-address", "url-too-long", "too-young", "full"])
    }

    private func tab(_ n: Int, admitted: Bool = false) -> SyncToday.Candidate {
        var c = SyncToday.Candidate(id: "t" + String(format: "%04d", n), url: "https://a.example/", ageMilliseconds: 60_000, lastActiveAt: 1_790_000_000_000 + Double(n))
        c.admitted = admitted
        return c
    }

    @Test func holdsTwoHundredTabsAtMost() {
        let result = SyncToday.admit((0..<201).map { tab($0) })
        #expect(result.admitted.count == 200)
        #expect(result.refused.map { $0.id } == ["t0000"])
        #expect(result.refused.map { $0.reason } == [.full])
    }

    @Test func neverTakesOutATabThatIsAdmitted() {
        #expect(SyncToday.admit((0..<230).map { tab($0, admitted: true) }).admitted.count == 230)
    }
}

@Suite("Shared Today tabs: the door (§27.4, §27.7)")
struct SyncTodayGateTests {
    @Test func playsTheVectors() {
        let cases = TodayVectors.section("gate")
        #expect(cases.count >= 18)
        var reasons = Set<String>()
        for c in cases {
            let name = c["name"]?.text ?? ""
            var base: [String: SyncEntity]?
            if case .object? = c["base"] { base = TodayVectors.entities(c["base"]) }
            let result = SyncToday.gate(TodayVectors.entities(c["entities"]), base: base, limit: TodayVectors.intOrNil(c["limit"]) ?? SyncToday.gate)
            #expect(result.entities == TodayVectors.entities(c["expect"]?["entities"]), "\(name)")
            let expected = (c["expect"]?["refused"]?.items ?? []).map { ($0["id"]?.text ?? "", $0["reason"]?.text ?? "") }
            #expect(result.refused.map { $0.id } == expected.map { $0.0 }, "\(name)")
            #expect(result.refused.map { $0.reason.rawValue } == expected.map { $0.1 }, "\(name)")
            reasons.formUnion(expected.map { $0.1 })
        }
        #expect(reasons == ["invalid-url", "invalid-value", "too-many-today-tabs"])
    }

    private func entity(_ n: Int) -> SyncEntity {
        SyncEntity(fields: ["spaceId": .string("s1"), "activeAt": .number(Double(n * SyncToday.activeAtStepMilliseconds))], stamps: ["spaceId": SyncStamp.zero, "activeAt": SyncStamp.zero])
    }

    @Test func keepsFiveHundredEntitiesAtMost() {
        let over = Dictionary(uniqueKeysWithValues: (0..<501).map { ("t" + String(format: "%04d", $0), entity($0 + 1)) })
        let gated = SyncToday.gate(over)
        #expect(gated.entities.count == 500)
        #expect(gated.refused.map { $0.id } == ["t0000"])
        #expect(gated.refused.map { $0.reason } == [.tooManyTodayTabs])
        let exact = Dictionary(uniqueKeysWithValues: (0..<500).map { ("t" + String(format: "%04d", $0), entity($0 + 1)) })
        #expect(SyncToday.gate(exact).entities.count == 500)
        #expect(SyncToday.gate(exact).refused.isEmpty)
    }
}

@Suite("Shared Today tabs: pinning and detaching (§27.2)")
struct SyncTodayMovesTests {
    @Test func playsTheVectors() {
        let cases = TodayVectors.section("moves")
        #expect(cases.count >= 6)
        func pairs(_ value: JSONValue?) -> [(kind: String, id: String)] { (value?.items ?? []).map { ($0["kind"]?.text ?? "", $0["id"]?.text ?? "") } }
        for c in cases {
            let moves = SyncToday.moves(removed: pairs(c["removed"]), created: pairs(c["created"]))
            let expected = (c["expect"]?.items ?? []).map { SyncToday.Move(id: $0["id"]?.text ?? "", from: $0["from"]?.text ?? "", to: $0["to"]?.text ?? "") }
            #expect(moves == expected, "\(c["name"]?.text ?? "")")
        }
    }
}

// MARK: - The merge

private struct TodayMergeCase: Sendable, CustomTestStringConvertible {
    let name: String
    let base: SyncSnapshot?
    let local: SyncSnapshot
    let remote: SyncSnapshot
    let withheld: [String]
    let expected: SyncSnapshot
    /// The lists a vector names, and what each must be: nil for "absent".
    let lists: [String: [String]?]
    let conflicts: [SyncConflict]
    var testDescription: String { name }

    static func all() -> [TodayMergeCase] {
        do {
            let merge = try #require(TodayVectors.file["merge"])
            return try merge["cases"]!.items.map { raw in
                let expect = try #require(raw["expect"])
                var lists: [String: [String]?] = [:]
                if case .object(let named)? = expect["order"] {
                    for (key, value) in named {
                        if case .array = value { lists[key] = .some(TodayVectors.ids(value)) } else { lists[key] = .some(nil) }
                    }
                }
                return TodayMergeCase(
                    name: try #require(raw["name"]?.text), base: try Contract.optionalSnapshot(raw["base"]), local: try Contract.snapshot(raw["local"]), remote: try Contract.snapshot(raw["remote"]),
                    withheld: (raw["withheld"]?.items ?? []).compactMap(\.text),
                    expected: try Contract.snapshot(.object(["entities": expect["entities"] ?? .object([:]), "tombstones": expect["tombstones"] ?? .object([:])])), lists: lists,
                    conflicts: try Contract.conflicts(expect["conflicts"]))
            }
        } catch {
            Issue.record("the Today merge vectors do not load: \(error)")
            return []
        }
    }

    func merged() -> SyncMergeResult { SyncMerge.merge(base: base, local: local, remote: remote, withheld: withheld) }
}

@Suite("Shared Today tabs: the merge (§27.9, §27.10)")
struct SyncTodayMergeTests {
    private static let cases = TodayMergeCase.all()

    @Test func thereAreCasesToRun() {
        #expect(Self.cases.count >= 18)
        #expect(Set(Self.cases.map(\.name)).count == Self.cases.count)
        #expect(Self.cases.contains { $0.base == nil })
        #expect(Self.cases.contains { !$0.withheld.isEmpty })
        #expect(Set(Self.cases.flatMap { $0.conflicts.map(\.reason) }) == Set([.newer, .modificationOverDeletion, .order]))
    }

    @Test(arguments: SyncTodayMergeTests.cases)
    fileprivate func playsTheCase(_ c: TodayMergeCase) {
        let merged = c.merged()
        #expect(merged.snapshot.entities == c.expected.entities)
        #expect(merged.snapshot.tombstones == c.expected.tombstones)
        #expect(merged.conflicts == c.conflicts)
        for (key, ids) in c.lists { #expect(merged.snapshot.order[key] == ids, "the list \(key)") }
    }

    @Test(arguments: SyncTodayMergeTests.cases)
    fileprivate func convergesWhenLocalAndRemoteAreExchanged(_ c: TodayMergeCase) {
        let there = c.merged()
        let back = SyncMerge.merge(base: c.base, local: c.remote, remote: c.local, withheld: c.withheld)
        #expect(back.snapshot == there.snapshot)
        #expect(back.snapshot.digest == there.snapshot.digest)
        #expect(back.conflicts == there.conflicts.map(\.seenFromTheOtherDevice).sorted(by: SyncConflict.precedes))
    }

    @Test(arguments: SyncTodayMergeTests.cases)
    fileprivate func isIdempotent(_ c: TodayMergeCase) {
        let first = c.merged()
        let again = SyncMerge.merge(base: first.snapshot, local: first.snapshot, remote: first.snapshot, withheld: c.withheld)
        #expect(again.snapshot == first.snapshot)
        #expect(again.conflicts.isEmpty)
    }
}
