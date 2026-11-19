import Foundation
import Testing
@testable import LuciumKit

/// `SyncApply` after it was made linear (second pass of the security review of the synchronisation, the twin of `src/main/sync/patch-oracle.test.ts`): the same state as the slow
/// one it replaced (`SyncApplyReference`, copied as it was) on patches drawn at random, and fast on a large one. A device that sends forty thousand new entities, twenty thousand
/// lists to order or a chain of two thousand folders held the main thread for seconds, and it works out the same merge, so its digest agrees.
@Suite("Synchronisation: applying a patch in linear time")
struct SyncApplyLinearTests {
    /// A small deterministic generator (mulberry32): a failure names its seed and is replayed by it.
    private struct Random {
        var a: UInt32
        mutating func next() -> Double {
            a = a &+ 0x6D2B79F5
            var t = (a ^ (a >> 15)) &* (1 | a)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double((t ^ (t >> 14))) / 4294967296.0
        }
        mutating func pick<T>(_ items: [T]) -> T { items[Int(next() * Double(items.count)) % items.count] }
        mutating func chance(_ p: Double) -> Bool { next() < p }
    }

    private func drawn(_ seed: UInt32) -> (state: BrowserState, patch: SyncPatch) {
        var r = Random(a: seed)
        let spaceIDs = Array(["sp-a", "sp-b", "sp-c"].prefix(1 + Int(r.next() * 3)))
        let spaces = spaceIDs.map { Space(id: $0, name: $0, emoji: "🏠", profileId: "default") }
        var folders: [Folder] = []
        for n in 0..<Int(r.next() * 6) {
            var folder = Folder(id: "fo-\(n)", spaceId: r.pick(spaceIDs), name: "fo-\(n)")
            if n > 0 && r.chance(0.4) { folder.parentId = "fo-\(n - 1)" }
            folders.append(folder)
        }
        var tabs: [TabItem] = []
        for n in 0..<Int(r.next() * 14) {
            var tab = TabItem(id: "tab-\(n)", spaceId: r.pick(spaceIDs), url: "https://t\(n).example/", title: "t\(n)", pinned: r.chance(0.8))
            tab.anchorUrl = tab.url
            if r.chance(0.15) { tab.rest["private"] = .bool(true) }
            if r.chance(0.3), !folders.isEmpty { tab.folderId = r.pick(folders).id }
            tabs.append(tab)
        }
        let favorites = (0..<Int(r.next() * 6)).map { Favorite(id: "fav-\($0)", url: "https://f\($0).example/", title: "Fav \($0)", profileId: r.pick(["default", "work"])) }
        var state = BrowserState(spaces: spaces, tabs: tabs, activeSpaceId: spaceIDs[0], activeTabBySpace: Dictionary(uniqueKeysWithValues: spaceIDs.map { ($0, nil) }))
        state.folders = folders
        state.favorites = favorites
        state.archive = (0..<Int(r.next() * 3)).map { ArchivedTab(id: "ar-\($0)", spaceId: spaceIDs[0], url: "https://a\($0).example/", title: "A\($0)", archivedAt: 1) }

        var existing: [(SyncFieldClasses.Kind, String, [String: JSONValue])] = []
        existing += state.spaces.map { (.space, $0.id, SyncStateView.entry(of: $0).fields) }
        existing += state.folders.map { (.folder, $0.id, SyncStateView.entry(ofJSON: $0.json, id: $0.id).fields) }
        existing += state.tabs.map { (.tab, $0.id, SyncStateView.entry(of: $0).fields) }
        existing += state.favorites.map { (.favorite, $0.id, SyncStateView.entry(of: $0).fields) }
        var patch = SyncPatch()
        for n in 0..<(1 + Int(r.next() * 10)) {
            let roll = r.next()
            if roll < 0.3, !existing.isEmpty {
                let target = r.pick(existing)
                let field = r.pick(["name", "customTitle", "folderId", "parentId", "profileId", "url", "title", "hideHeader"])
                let before = target.2[field]
                patch.upserts.append(.init(kind: target.0, id: target.1, create: false, fields: r.chance(0.7) ? [field: .string("v\(n)")] : [:], remove: r.chance(0.3) ? [field] : [],
                                           expect: r.chance(0.8) ? (before.map { [field: $0] } ?? [:]) : [:]))
            } else if roll < 0.55 {
                let kind = r.pick([SyncFieldClasses.Kind.tab, .folder, .favorite, .space])
                let id = r.chance(0.2) && !existing.isEmpty ? r.pick(existing).1 : "new-\(kind.rawValue)-\(n)"
                var fields: [String: JSONValue]
                switch kind {
                case .tab: fields = ["spaceId": .string(r.pick(spaceIDs)), "pinned": .bool(true), "anchorUrl": .string("https://n\(n).example/")]
                    if r.chance(0.4), !folders.isEmpty { fields["folderId"] = .string(r.pick(folders).id) }
                case .folder: fields = ["spaceId": .string(r.pick(spaceIDs)), "name": .string("F\(n)")]
                    if r.chance(0.3), !folders.isEmpty { fields["parentId"] = .string(r.pick(folders).id) }
                case .favorite: fields = ["url": .string("https://f\(n).example/"), "title": .string("Fav \(n)"), "profileId": .string(r.pick(["default", "work"]))]
                default: fields = ["name": .string("S\(n)")]
                }
                patch.upserts.append(.init(kind: kind, id: id, create: true, fields: fields, remove: [], expect: [:]))
            } else if roll < 0.75, !existing.isEmpty {
                let target = r.pick(existing)
                let kept = target.2.filter { ["name", "spaceId", "url"].contains($0.key) }
                patch.removals.append(.init(kind: target.0, id: r.chance(0.9) ? target.1 : "nothing-here", expect: r.chance(0.8) ? kept : ["name": .string("changed meanwhile")]))
            } else {
                var lists = ["spaces", "favorites:default", "favorites:work", "tabs:nowhere:-", "folders:sp-a:a:b", "favorites:a:b", "elsewhere", "spaces:x"]
                for space in spaceIDs { for head in ["folders", "tabs"] { lists.append("\(head):\(space):-"); for folder in folders { lists.append("\(head):\(space):\(folder.id)") } } }
                var ids = (existing.map(\.1) + ["unknown-id"]).filter { _ in r.chance(0.7) }
                if ids.count > 1 { for at in stride(from: ids.count - 1, to: 0, by: -1) { ids.swapAt(at, Int(r.next() * Double(at + 1))) } }
                patch.order[r.pick(lists)] = ids
            }
        }
        return (state, patch)
    }

    @Test func givesTheSameStateAsTheSlowOneOnFourHundredPatchesDrawnAtRandom() {
        for seed in 1...400 {
            let (state, patch) = drawn(UInt32(seed))
            let fast = SyncApply.apply(patch, to: state, now: 1_790_000_000_000)
            let slow = SyncApplyReference.apply(patch, to: state, now: 1_790_000_000_000)
            #expect(fast.state == slow.state, "seed \(seed): the state")
            #expect(fast.createdSpaceIDs == slow.createdSpaceIDs && fast.removedSpaceIDs == slow.removedSpaceIDs && fast.removedTabIDs == slow.removedTabIDs, "seed \(seed): what was made and removed")
            #expect(fast.rejected == slow.rejected && fast.changed == slow.changed, "seed \(seed): what was rejected")
        }
    }

    private func big(_ count: Int) -> (BrowserState, SyncPatch) {
        let state = BrowserState(spaces: [Space(id: "sp", name: "sp", emoji: "🏠", profileId: "default")], tabs: [], activeSpaceId: "sp", activeTabBySpace: ["sp": nil])
        var patch = SyncPatch()
        for n in 0..<count { patch.upserts.append(.init(kind: .tab, id: "t\(n)", create: true, fields: ["spaceId": .string("sp"), "pinned": .bool(true), "anchorUrl": .string("https://n\(n).example/")], remove: [], expect: [:])) }
        patch.order["tabs:sp:-"] = (0..<count).reversed().map { "t\($0)" }
        return (state, patch)
    }

    // The bounds are generous (a loaded machine, a debug build): the slow one took tens of seconds for these in a debug build, the linear one a fraction of a second.
    @Test func tenThousandNewEntitiesAndAnOrderOfThemAreAppliedInSeconds() {
        let (state, patch) = big(10_000)
        let clock = ContinuousClock()
        let took = clock.measure { _ = SyncApply.apply(patch, to: state, now: 1_790_000_000_000) }
        #expect(took < .seconds(8), "took \(took)")
    }

    @Test func twelveThousandListsToOrderAreAppliedInSeconds() {
        var state = BrowserState(spaces: [Space(id: "sp", name: "sp", emoji: "🏠", profileId: "default")], tabs: [], activeSpaceId: "sp", activeTabBySpace: ["sp": nil])
        state.folders = (0..<12_000).map { Folder(id: "f\($0)", spaceId: "sp", name: "f\($0)") }
        var patch = SyncPatch()
        for n in 0..<12_000 { patch.order["folders:sp:f\(n)"] = ["f\(n)"] }
        let clock = ContinuousClock()
        let took = clock.measure { _ = SyncApply.apply(patch, to: state, now: 1_790_000_000_000) }
        #expect(took < .seconds(8), "took \(took)")
    }

    @Test func aChainOfFifteenHundredFoldersIsAppliedInSeconds() {
        var state = BrowserState(spaces: [Space(id: "sp", name: "sp", emoji: "🏠", profileId: "default")], tabs: [], activeSpaceId: "sp", activeTabBySpace: ["sp": nil])
        state.folders = (0..<1_500).map { n in var folder = Folder(id: "f\(n)", spaceId: "sp", name: "f\(n)"); if n > 0 { folder.parentId = "f\(n - 1)" }; return folder }
        var patch = SyncPatch()
        patch.upserts.append(.init(kind: .folder, id: "f0", create: false, fields: ["name": .string("renamed")], remove: [], expect: [:]))
        let clock = ContinuousClock()
        var outcome: SyncApply.Outcome?
        let took = clock.measure { outcome = SyncApply.apply(patch, to: state, now: 1_790_000_000_000) }
        #expect(took < .seconds(8), "took \(took)")
        #expect(outcome?.state.folders.count == 1_500 && outcome?.state.folders[1_499].parentId == "f1498", "the chain is left as it was")
    }
}
