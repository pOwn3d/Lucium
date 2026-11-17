import Foundation
import Testing
@testable import LuciumKit

/// `ios/Contracts/state-reference.json` is a state file written by the Mac's own store (`src/main/ios-state-contract.test.ts` makes it and
/// refuses it when it drifts). These tests are the iPhone's half of the contract: read it, write it back, compare.
///
/// What they hold: a field the Mac adds and this build does not read goes through `rest` and the tests keep passing; a field this build reads
/// and the Mac changes (renamed, retyped, dropped) makes them fail, and so does a build that loses something when it writes.
private enum Reference {
    /// …/ios/LuciumKit/Tests/LuciumKitTests/StateContractTests.swift → …/ios/Contracts/state-reference.json
    static func data() throws -> Data {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/state-reference.json")
        return try Data(contentsOf: url)
    }

    static func json() throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: data()) }

    static func object(_ value: JSONValue?) -> [String: JSONValue] {
        if case .object(let fields)? = value { return fields }
        return [:]
    }

    static func objects(_ value: JSONValue?) -> [[String: JSONValue]] {
        guard case .array(let items)? = value else { return [] }
        return items.map { object($0) }
    }
}

@Suite("State reference written by the Mac")
struct StateContractTests {
    @Test func theReferenceIsNotEmpty() throws {
        let raw = try Reference.object(Reference.json())
        // An empty or missing file would make every other test here pass for nothing.
        #expect(Reference.objects(raw["spaces"]).count >= 2)
        #expect(Reference.objects(raw["tabs"]).count >= 3)
        #expect(raw.count > 10)
    }

    @Test func readsTheFormatVersionTheMacWrites() throws {
        let state = try BrowserState.decode(Reference.data())
        #expect(state.version == BrowserState.supportedVersion)
    }

    @Test func readsEveryFieldItTypesAsTheMacWroteIt() throws {
        let raw = try Reference.object(Reference.json())
        let state = try BrowserState.decode(Reference.data())
        #expect(JSONValue.string(state.activeSpaceId) == raw["activeSpaceId"])
        #expect(state.spaces.map { JSONValue.string($0.id) } == Reference.objects(raw["spaces"]).compactMap { $0["id"] })
        // Compared field by field, so that a field the Mac renames or changes the meaning of is named in the failure.
        for (typed, written) in zip(state.spaces, Reference.objects(raw["spaces"])) {
            #expect(JSONValue.string(typed.name) == written["name"], "space \(typed.id): name")
            #expect(JSONValue.string(typed.emoji) == written["emoji"], "space \(typed.id): emoji")
            #expect(JSONValue.string(typed.profileId) == written["profileId"], "space \(typed.id): profileId")
        }
        #expect(state.tabs.count == Reference.objects(raw["tabs"]).count)
        for (typed, written) in zip(state.tabs, Reference.objects(raw["tabs"])) {
            #expect(JSONValue.string(typed.id) == written["id"], "tab \(typed.id): id")
            #expect(JSONValue.string(typed.spaceId) == written["spaceId"], "tab \(typed.id): spaceId")
            #expect(JSONValue.string(typed.url) == written["url"], "tab \(typed.id): url")
            #expect(JSONValue.string(typed.title) == written["title"], "tab \(typed.id): title")
            #expect(JSONValue.bool(typed.pinned) == written["pinned"], "tab \(typed.id): pinned")
        }
    }

    @Test func theReferenceHoldsTogetherAsTheMacKeepsIt() throws {
        // The rules the Mac's own repair enforces (`normalize`): a tab lives in a space that exists, and a space shows one of its own tabs or none.
        let state = try BrowserState.decode(Reference.data())
        let spaceIds = Set(state.spaces.map(\.id))
        #expect(spaceIds.contains(state.activeSpaceId))
        #expect(state.tabs.allSatisfy { spaceIds.contains($0.spaceId) })
        for (spaceId, tabId) in state.activeTabBySpace {
            #expect(spaceIds.contains(spaceId))
            if let tabId { #expect(state.tabs.first { $0.id == tabId }?.spaceId == spaceId, "the active tab of \(spaceId) is one of its own") }
        }
    }

    @Test func keepsEverythingItDoesNotReadInRest() throws {
        let raw = try Reference.object(Reference.json())
        let state = try BrowserState.decode(Reference.data())
        // Whatever the Mac writes at the top level that is not one of the typed fields: the folders, the settings, the writer of the file…
        let typedAtTop: Set<String> = ["version", "revision", "spaces", "tabs", "activeSpaceId", "activeTabBySpace"]
        #expect(Set(state.rest.keys) == Set(raw.keys).subtracting(typedAtTop))
        #expect(state.rest["settings"] != nil)
        // The same in a space (its theme) and in a tab (a favicon, an auto-reload…).
        #expect(state.spaces.contains { $0.rest["theme"] != nil })
        #expect(state.tabs.contains { $0.rest["autoReload"] != nil })
    }

    @Test func writesTheReferenceBackUnchanged() throws {
        let state = try BrowserState.decode(Reference.data())
        let rewritten = try JSONEncoder().encode(state)
        // Compared as JSON values, not as bytes: the order of the keys is not part of the format.
        #expect(try JSONDecoder().decode(JSONValue.self, from: rewritten) == Reference.json())
    }

    @Test func aChangeMadeOnTheIPhoneChangesOnlyItsOwnField() throws {
        var state = try BrowserState.decode(Reference.data())
        state.tabs[0].title = "Renamed on the iPhone"
        state.activeSpaceId = state.spaces[0].id
        let rewritten = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state))

        // The same edit made to the raw reference: what the iPhone writes must be exactly that, nothing more and nothing less.
        var expected = try Reference.object(Reference.json())
        var tabs = Reference.objects(expected["tabs"])
        tabs[0]["title"] = .string("Renamed on the iPhone")
        expected["tabs"] = .array(tabs.map { .object($0) })
        expected["activeSpaceId"] = .string(state.spaces[0].id)
        #expect(rewritten == .object(expected))
    }
}
