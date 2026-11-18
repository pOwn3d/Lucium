import Foundation
import Testing
@testable import LuciumKit

/// Review n° 14, 16 and 20 of the synchronisation (docs/securite-synchronisation.md): the tombstones that come in, the profile that a list key is made of, and a key written
/// twice. The Mac's twin is `inbound-filter.ts` and `messages.ts`; the vectors are `inboundTombstones`, `inbound`, `duplicateKeys` and `limits` of
/// `ios/Contracts/sync-message-vectors.json`.
@Suite("Synchronisation: what the two languages read differently")
struct SyncHostileInputTests {
    private let vectors = (try? Contract.load("sync-message-vectors.json")) ?? .null
    private let now = 1_790_000_000_000
    private func mark(_ ms: Int, _ device: String = "phone-0000000001") -> String { String(format: "%013ld-0000-", ms) + device }

    // MARK: n° 14, the tombstones

    private func snapshot(tombstones: [String: [String: String]]) -> SyncSnapshot { SyncSnapshot(entities: [:], tombstones: tombstones, order: [:], orderStamps: [:]) }

    @Test func theTombstonesOfTheVectorsAreFilteredAsTheMacFiltersThem() throws {
        for item in try #require(vectors["inboundTombstones"]).items {
            var tombstones: [String: [String: String]] = [:]
            if case .object(let kinds)? = item["tombstones"] {
                for (kind, byID) in kinds { if case .object(let ids) = byID { for (id, stamp) in ids { tombstones[kind, default: [:]][id] = stamp.text ?? "" } } }
            }
            let cleaned = SyncInbound.clean(snapshot(tombstones: tombstones), now: now)
            var kept: [String: JSONValue] = [:]
            for (kind, byID) in cleaned.snapshot.tombstones { kept[kind] = .object(byID.mapValues { .string($0) }) }
            #expect(JSONValue.object(kept) == item["expect"]?["kept"], "\(item["name"]?.text ?? "?")")
            let refusedNeverSynced = cleaned.refused.filter { $0.reason == .neverSynced }.map(\.id).sorted()
            #expect(refusedNeverSynced == (item["expect"]?["refused"]?.items.compactMap(\.text) ?? []), "\(item["name"]?.text ?? "?")")
        }
    }

    @Test func aSideKeepsTheNewestTombstonesAndSaysItDroppedTheRest() {
        if case .number(let bound)? = vectors["limits"]?["maxTombstonesPerSnapshot"] { #expect(SyncLimits.maxTombstonesPerSnapshot == Int(bound)) } else { Issue.record("the bound is not in the vectors") }
        var many: [String: String] = [:]
        for n in 0..<(SyncLimits.maxTombstonesPerSnapshot + 25) { many[String(format: "t%06d", n)] = mark(now - n) }
        let cleaned = SyncInbound.clean(snapshot(tombstones: ["tab": many]), now: now)
        let ids = cleaned.snapshot.tombstones["tab"] ?? [:]
        #expect(ids.count == SyncLimits.maxTombstonesPerSnapshot)
        #expect(ids["t000000"] != nil)
        #expect(ids[String(format: "t%06d", SyncLimits.maxTombstonesPerSnapshot + 24)] == nil, "the oldest went")
        #expect(cleaned.refused.contains(SyncInbound.Refused(kind: "tombstone", id: "*", reason: .tooManyTombstones)))
        // Under the bound nothing is dropped.
        let few = SyncInbound.clean(snapshot(tombstones: ["tab": ["a": mark(now), "b": mark(now)], "space": ["z": mark(now)]]), now: now)
        #expect(few.refused.isEmpty)
    }

    // MARK: n° 16, the profile

    @Test func aProfileThatIsNotAnIdentifierOfTheMacIsRefusedForASpaceAndAFavourite() {
        for profile in [String(repeating: "p", count: 33), "e\u{0301}", "é", "with space", "a:b", "", "__proto__", String(repeating: "x", count: 500)] {
            #expect(SyncInbound.filter(kind: "space", id: "s", fields: ["name": .string("A"), "profileId": .string(profile)]) == .refused(.invalidValue), "\(profile)")
            #expect(SyncInbound.filter(kind: "favorite", id: "f", fields: ["url": .string("https://a.example/"), "profileId": .string(profile)]) == .refused(.invalidValue), "\(profile)")
        }
        #expect(SyncInbound.filter(kind: "space", id: "s", fields: ["name": .string("A"), "profileId": .number(3)]) == .refused(.invalidValue))
        for profile in ["default", "work", "p-1_B", String(repeating: "x", count: 32)] {
            if case .refused = SyncInbound.filter(kind: "space", id: "s", fields: ["name": .string("A"), "profileId": .string(profile)]) { Issue.record("\(profile) was refused") }
        }
    }

    // MARK: n° 20, a key written twice

    @Test func aMessageThatNamesAKeyTwiceIsRefusedWhateverTheWayItIsWritten() throws {
        for item in try #require(vectors["duplicateKeys"]).items {
            let raw = try #require(item["raw"]?.text)
            let result = SyncMessageCodec.decode(Data(raw.utf8))
            if item["duplicate"]?.flag == true {
                guard case .failure(let failure) = result else { Issue.record("read, but it names a key twice: \(item["name"]?.text ?? "?")"); continue }
                #expect(failure.code == .badMessage)
            } else if case .failure(let failure) = result {
                Issue.record("refused (\(failure)): \(item["name"]?.text ?? "?")")
            }
        }
    }
}
