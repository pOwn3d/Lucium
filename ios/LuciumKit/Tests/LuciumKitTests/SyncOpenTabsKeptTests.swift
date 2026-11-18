import Foundation
import Testing
@testable import LuciumKit

/// Review n° 13 of the synchronisation (docs/securite-synchronisation.md): the open tabs of a space that another device deleted go to the archive first. The Mac's twin is
/// `archiveOpenTabsOfRemovedSpaces` of `src/shared/sidebar-sync.ts`.
@Suite("Synchronisation: the open tabs of a space that went")
struct SyncOpenTabsKeptTests {
    private let now = 1_790_000_000_000

    // MARK: n° 13, the open tabs of a space that went

    private func twoSpaces() -> BrowserState {
        var state = BrowserState(spaces: [Space(id: "sp-main", name: "Perso", emoji: "🏠", profileId: "default"), Space(id: "sp-work", name: "Travail", emoji: "💼", profileId: "default")],
                                 tabs: [], activeSpaceId: "sp-main", activeTabBySpace: ["sp-main": nil, "sp-work": nil])
        var pinned = TabItem(id: "pinned-work", spaceId: "sp-work", url: "https://pinned.example/", title: "Pinned", pinned: true)
        pinned.anchorUrl = "https://pinned.example/"
        var secret = TabItem(id: "today-private", spaceId: "sp-work", url: "https://secret.example/", title: "Private")
        secret.rest["private"] = .bool(true)
        state.tabs = [TabItem(id: "today-1", spaceId: "sp-work", url: "https://read.example/a", title: "A page being read"), TabItem(id: "today-2", spaceId: "sp-work", url: "https://read.example/b", title: "Another"),
                      secret, pinned, TabItem(id: "today-home", spaceId: "sp-main", url: "https://home.example/", title: "Home")]
        return state
    }

    @Test func theOpenTabsOfASpaceThatWentAreKeptInTheArchiveAsSyncInTheSpaceThePersonIsIn() {
        var patch = SyncPatch()
        patch.removals = [SyncPatch.Removal(kind: .space, id: "sp-work", expect: ["name": .string("Travail")])]
        let outcome = SyncApply.apply(patch, to: twoSpaces(), now: Double(now))
        #expect(outcome.state.spaces.map(\.id) == ["sp-main"])
        #expect(outcome.state.archive.map(\.id).sorted() == ["today-1", "today-2"])
        #expect(outcome.state.archive.allSatisfy { $0.source == "sync" && $0.spaceId == "sp-main" && $0.archivedAt == Double(now) })
        #expect(outcome.state.archive.first { $0.id == "today-1" }?.title == "A page being read")
        #expect(outcome.state.tabs.map(\.id) == ["today-home"], "the private tab and the pinned tab are not kept, what is in another space stays")
    }

    @Test func aSpaceThePersonChangedMeanwhileIsNotRemovedAndNothingMoves() {
        var state = twoSpaces()
        state.spaces[1].name = "Renamed meanwhile"
        var patch = SyncPatch()
        patch.removals = [SyncPatch.Removal(kind: .space, id: "sp-work", expect: ["name": .string("Travail")])]
        let outcome = SyncApply.apply(patch, to: state, now: Double(now))
        #expect(outcome.state.spaces.count == 2)
        #expect(outcome.state.archive.isEmpty)
        #expect(outcome.state.tabs.count == 5)
    }
}
