import Foundation
import Testing
@testable import LuciumKit

/// Deletions in both directions (docs/synchronisation.md §11.5, card 505 « Synchro automatique »): what the person deletes on the Mac is deleted on the phone, and what they delete
/// on the phone is deleted on the Mac, for a space, a folder, a favourite and a pinned tab, at the next session. The phone's half is the real one (marks, snapshot, merge, write);
/// the Mac's is `SyncTestMac`, which runs the same Swift merge and answers as §8 says. The same cases are played on the Mac's code, over real sockets, by
/// `src/main/sync/session-deletions.test.ts`.
@Suite("Synchronisation: a deletion crosses in both directions")
struct SyncDeletionTests {
    private let now = SyncStateFixtures.now
    private let macFingerprint = SyncContract.hex("d1e9cc4016253cbcc57d90fa77640b06d550223a14fd582c1c3bf31426e8519f")
    private let phone = SyncDeviceInfo(id: "vector-phone-000000002", name: "iPhone de test", platform: .ios)
    private var peer: SyncPairedMac {
        SyncPairedMac(id: "vector-mac-0000000001", name: "MacBook de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["mac-de-test.local"], pairedAt: 1_790_000_000_000)
    }

    /// What a person can delete, with how the phone's state loses it, and where the entity lives in a snapshot.
    private enum Thing: CaseIterable, CustomStringConvertible {
        case space, folder, favorite, pinnedTab

        var description: String {
            switch self {
            case .space: "a space"
            case .folder: "a folder"
            case .favorite: "a favourite"
            case .pinnedTab: "a pinned tab"
            }
        }

        var kind: String {
            switch self {
            case .space: "space"
            case .folder: "folder"
            case .favorite: "favorite"
            case .pinnedTab: "tab"
            }
        }

        var id: String {
            switch self {
            case .space: "s2"
            case .folder: "f2"
            case .favorite: "fav1"
            case .pinnedTab: "t2"
            }
        }

        /// What the person does on the phone.
        func delete(from state: BrowserState) -> BrowserState {
            var next = state
            switch self {
            case .space:
                next.spaces.removeAll { $0.id == id }
                next.activeTabBySpace[id] = nil
            case .folder: next.folders.removeAll { $0.id == id }
            case .favorite: next.favorites.removeAll { $0.id == id }
            case .pinnedTab: next.tabs.removeAll { $0.id == id }
            }
            return next
        }

        func isIn(_ state: BrowserState) -> Bool {
            switch self {
            case .space: state.spaces.contains { $0.id == id }
            case .folder: state.folders.contains { $0.id == id }
            case .favorite: state.favorites.contains { $0.id == id }
            case .pinnedTab: state.tabs.contains { $0.id == id && $0.pinned }
            }
        }
    }

    private struct Rig {
        let directory: URL
        let host: SyncTestHost
        let marks: SyncMarkKeeper
        let bases: SyncBaseStore
        let body: SyncExchangeBody
        func cleanup() { try? FileManager.default.removeItem(at: directory) }
    }

    private func rig() throws -> Rig {
        let directory = FileManager.default.temporaryDirectory.appending(path: "deletion-\(UUID().uuidString)")
        let host = SyncTestHost(state: try SyncStateFixtures.sample())
        let marks = SyncMarkKeeper(device: phone.id, file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)))
        let bases = SyncBaseStore(directory: directory)
        let now = self.now
        return Rig(directory: directory, host: host, marks: marks, bases: bases, body: SyncExchangeBody(host: host, marks: marks, bases: bases, now: { now }, idleTimeout: .seconds(2)))
    }

    private func stamp(_ ms: Int, _ counter: Int = 0) -> String { String(format: "%013ld-%04lx-vector-mac-0000000001", ms, counter) }

    @discardableResult
    private func session(_ rig: Rig, mac script: SyncTestMac) async throws -> SyncTestMac.Seen {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let at = now
        let macTask = Task { try await script.run(fake, now: at) }
        defer { macTask.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        let baseHash = await rig.body.baseHash(forMac: peer.id)
        _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0", supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16),
                                            baseHash: baseHash, now: { at }, body: rig.body, handshakeTimeout: .seconds(2))
        return (try? await macTask.value) ?? SyncTestMac.Seen()
    }

    /// Two devices that went through a first session: both hold everything the phone had, and the base each keeps is the merged snapshot. Returns what the Mac holds now.
    private func synchronised(_ rig: Rig) async throws -> SyncSnapshot {
        rig.marks.observe(await rig.host.state, now: now - 43_000_000)
        let first = try await session(rig, mac: SyncTestMac(snapshot: SyncSnapshot()))
        return SyncStateView.base(of: try #require(first.merged).snapshot)
    }

    /// The Mac's snapshot once the person deleted `thing` there: the entity is gone from its lists, and a tombstone newer than every mark says so.
    private func macDeleted(_ thing: Thing, from held: SyncSnapshot) -> SyncSnapshot {
        var after = held
        after.entities[thing.kind]?[thing.id] = nil
        after.order = after.order.mapValues { $0.filter { $0 != thing.id } }
        after.tombstones[thing.kind, default: [:]][thing.id] = stamp(now + 5_000, 1)
        return after
    }

    @Test(arguments: Thing.allCases)
    private func aThingDeletedOnTheMacIsDeletedOnThePhone(_ thing: Thing) async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let held = try await synchronised(rig)
        #expect(thing.isIn(await rig.host.state), "\(thing) is on the phone before")
        let seen = try await session(rig, mac: SyncTestMac(snapshot: macDeleted(thing, from: held), base: held))
        let state = await rig.host.state
        #expect(!thing.isIn(state), "\(thing) deleted on the Mac is deleted on the phone")
        #expect(seen.merged?.snapshot.entities[thing.kind]?[thing.id] == nil)
        let patch = try #require(await rig.host.patches.last)
        #expect(patch.removals.contains { $0.kind.rawValue == thing.kind && $0.id == thing.id }, "the write names the removal")
        // The rest is still there: one deletion does not take its neighbours with it.
        #expect(state.spaces.contains { $0.id == "s1" })
        #expect(thing == .favorite || state.favorites.count == 1)
    }

    @Test(arguments: Thing.allCases)
    private func aThingDeletedOnThePhoneIsDeletedOnTheMac(_ thing: Thing) async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let held = try await synchronised(rig)
        // The person deletes on the phone; the book of marks sees it as the model writes the state (docs/synchronisation.md §9.2).
        let before = await rig.host.state
        await rig.host.set(state: thing.delete(from: before))
        rig.marks.observe(await rig.host.state, now: now + 5_000)
        #expect(!thing.isIn(await rig.host.state))
        // The Mac still holds it, with the base it shares with the phone.
        let seen = try await session(rig, mac: SyncTestMac(snapshot: held, base: held))
        #expect(seen.phone.tombstones[thing.kind]?[thing.id] != nil, "the phone says it deleted \(thing)")
        #expect(seen.merged?.snapshot.entities[thing.kind]?[thing.id] == nil, "the Mac's merge drops it")
        #expect(seen.merged?.snapshot.tombstones[thing.kind]?[thing.id] != nil)
        #expect(!thing.isIn(await rig.host.state), "and the phone does not take it back")
    }

    @Test(arguments: Thing.allCases)
    private func aDeletionDoesNotComeBackAtTheSessionsThatFollow(_ thing: Thing) async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        var held = try await synchronised(rig)
        await rig.host.set(state: thing.delete(from: await rig.host.state))
        rig.marks.observe(await rig.host.state, now: now + 5_000)
        for _ in 0..<3 {
            let seen = try await session(rig, mac: SyncTestMac(snapshot: held, base: held))
            held = SyncStateView.base(of: try #require(seen.merged).snapshot)
            #expect(!thing.isIn(await rig.host.state))
            #expect(held.entities[thing.kind]?[thing.id] == nil)
        }
    }

    @Test func deletionsMadeOnBothSidesInTheSameIntervalCrossToTheOther() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let held = try await synchronised(rig)
        await rig.host.set(state: Thing.folder.delete(from: await rig.host.state))
        rig.marks.observe(await rig.host.state, now: now + 5_000)
        let seen = try await session(rig, mac: SyncTestMac(snapshot: macDeleted(.favorite, from: held), base: held))
        let state = await rig.host.state
        #expect(!Thing.favorite.isIn(state) && !Thing.folder.isIn(state))
        #expect(seen.merged?.snapshot.entities["favorite"]?["fav1"] == nil && seen.merged?.snapshot.entities["folder"]?["f2"] == nil)
        #expect(state.spaces.map(\.id).sorted() == ["s1", "s2"])
    }

    /// « Après un changement local » (§8.1): the book says whether what is synchronised changed, so that the phone asks for a session for a deleted space and not for a page loading.
    @Test func theBookSaysWhetherWhatIsSynchronisedChanged() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "observe-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let keeper = SyncMarkKeeper(device: phone.id, file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)))
        var state = try SyncStateFixtures.sample()
        #expect(keeper.observe(state, now: now), "the first look is a change")
        #expect(!keeper.observe(state, now: now + 1), "the same state is not")
        state.tabs[2].title = "Today, another page"
        state.tabs[2].url = "https://today.example/other"
        #expect(!keeper.observe(state, now: now + 2), "a page that loads in a tab of Today is not synchronised")
        #expect(keeper.observe(Thing.favorite.delete(from: state), now: now + 3), "a deleted favourite is")
    }
}
