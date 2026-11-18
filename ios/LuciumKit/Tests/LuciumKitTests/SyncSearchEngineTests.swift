import Foundation
import Testing
@testable import LuciumKit

/// Review n° 10 of the synchronisation (docs/securite-synchronisation.md): only the search engines Lucium offers cross, in both directions. The Mac's twin is
/// `src/main/sync/inbound-filter.ts` and `session.ts`; the vectors are `searchEngines` and `inbound` of `ios/Contracts/sync-message-vectors.json`.
@Suite("Synchronisation: the search engine")
struct SyncSearchEngineTests {
    private let vectors = (try? Contract.load("sync-message-vectors.json")) ?? .null
    private let now = 1_790_000_000_000

    @Test func theEnginesOfTheVectorsAreTheOnesTheMacOffersAndTheOnesThePhoneOffers() throws {
        let engines = try #require(vectors["searchEngines"]).items.compactMap(\.text)
        #expect(engines.count >= 6)
        for engine in engines { #expect(SearchEngine.isPreset(engine), "\(engine)") }
        #expect(Set(SearchEngine.presets.map(\.url)) == Set(engines), "the list of the Mac and the list of the phone are one list")
    }

    @Test func onlyAnEngineOfTheListIsKeptAndAnEngineOfOnesOwnStaysWhereItIs() {
        #expect(SyncInbound.filter(kind: "setting", id: "searchUrlTemplate", fields: ["value": .string("https://search.example.com/?q=%s")]) == .refused(.invalidValue))
        #expect(SyncInbound.filter(kind: "setting", id: "searchUrlTemplate", fields: ["value": .string("http://duckduckgo.com/?q=%s")]) == .refused(.invalidValue))
        #expect(SyncInbound.filter(kind: "setting", id: "searchUrlTemplate", fields: ["value": .string("https://duckduckgo.com/?q=%s&x=https://evil.example/")]) == .refused(.invalidValue))
        var state = BrowserState(spaces: [Space(id: "s1", name: "A", emoji: "🏠", profileId: "default")], tabs: [], activeSpaceId: "s1", activeTabBySpace: ["s1": nil])
        state.rest["settings"] = .object(["searchUrlTemplate": .string("https://search.example.com/?q=%s")])
        var patch = SyncPatch()
        patch.settings = ["searchUrlTemplate": .string("https://search.brave.com/search?q=%s"), "sendGpc": .bool(true)]
        let outcome = SyncApply.apply(patch, to: state, now: Double(now))
        guard case .object(let settings)? = outcome.state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(settings["searchUrlTemplate"] == .string("https://search.example.com/?q=%s"), "an engine of one's own is not replaced by the other device's")
        #expect(settings["sendGpc"] == .bool(true), "the other settings are written")
        // A known engine is replaced by another known one.
        state.rest["settings"] = .object(["searchUrlTemplate": .string("https://duckduckgo.com/?q=%s")])
        guard case .object(let after)? = SyncApply.apply(patch, to: state, now: Double(now)).state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(after["searchUrlTemplate"] == .string("https://search.brave.com/search?q=%s"))
    }
}
