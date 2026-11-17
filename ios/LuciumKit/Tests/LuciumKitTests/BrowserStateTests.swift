import Foundation
import Testing
@testable import LuciumKit

/// A state in the shape of the Mac's state.json, with fields this build does not know (a theme, a setting, a field of a newer revision).
private let macState = """
{
  "version": 1,
  "revision": 2,
  "spaces": [
    { "id": "s1", "name": "Travail", "emoji": "💼", "profileId": "work",
      "theme": { "mode": "dark", "colors": ["#bbc8fd", "#c8c2fc"] }, "hideHeader": true },
    { "id": "s2", "name": "Maison", "emoji": "🏠", "profileId": "home" }
  ],
  "tabs": [
    { "id": "t1", "spaceId": "s1", "url": "https://carnet.example/", "title": "Carnet", "pinned": true,
      "faviconUrl": "https://carnet.example/i.png", "autoReload": { "seconds": 60 } },
    { "id": "t2", "spaceId": "s2", "url": "https://recettes.example/", "title": "Recettes", "pinned": false, "futureField": [1, 2, { "a": null }] }
  ],
  "folders": [],
  "activeSpaceId": "s1",
  "activeTabBySpace": { "s1": "t1", "s2": null },
  "settings": { "blockAds": true, "searchUrlTemplate": "https://duckduckgo.com/?q=%s" },
  "somethingFromTheFuture": { "n": 1.5, "ok": false }
}
"""

@Suite("State format shared with the Mac")
struct BrowserStateTests {
    @Test func readsTheFieldsItKnows() throws {
        let state = try BrowserState.decode(Data(macState.utf8))
        #expect(state.spaces.map(\.name) == ["Travail", "Maison"])
        #expect(state.tabs.first?.pinned == true)
        #expect(state.activeSpaceId == "s1")
        #expect(state.activeTabBySpace["s2"] == .some(nil))
    }

    @Test func writesBackEverythingItDidNotUnderstand() throws {
        let original = Data(macState.utf8)
        let state = try BrowserState.decode(original)
        let rewritten = try JSONEncoder().encode(state)
        // Compared as JSON values, not as bytes: key order is not part of the format.
        let before = try JSONDecoder().decode(JSONValue.self, from: original)
        let after = try JSONDecoder().decode(JSONValue.self, from: rewritten)
        #expect(before == after)
    }

    @Test func aChangeStaysInsideItsField() throws {
        var state = try BrowserState.decode(Data(macState.utf8))
        state.tabs[0].title = "Carnet de notes"
        let rewritten = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state))
        guard case .object(let root) = rewritten, case .array(let tabs)? = root["tabs"], case .object(let first) = tabs[0] else {
            Issue.record("unexpected shape"); return
        }
        #expect(first["title"] == .string("Carnet de notes"))
        #expect(first["autoReload"] == .object(["seconds": .number(60)]))
        #expect(root["somethingFromTheFuture"] != nil)
    }

    @Test func refusesAStateOfANewerFormatInsteadOfRewritingIt() {
        let newer = Data(#"{ "version": 2, "spaces": [], "tabs": [], "activeSpaceId": "", "activeTabBySpace": {} }"#.utf8)
        #expect(throws: BrowserState.StateError.newerVersion(2)) { try BrowserState.decode(newer) }
    }
}
