import Foundation
import Testing
@testable import LuciumKit

/// `ios/Contracts/library-vectors.json` and `match-vectors.json` are played by the Mac's tests against the Mac's reducer
/// (`src/shared/ios-library-contract.test.ts`) and here against LuciumKit. A rule changed on one side and not on the other fails one of the two.
private enum Vectors {
    static func data(_ name: String) throws -> Data {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/\(name)")
        return try Data(contentsOf: url)
    }

    static func json(_ name: String) throws -> [String: JSONValue] {
        guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: data(name)) else { return [:] }
        return fields
    }

    static func list(_ value: JSONValue?) -> [[String: JSONValue]] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap { if case .object(let fields) = $0 { fields } else { nil } }
    }

    static func texts(_ value: JSONValue?) -> [String] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap { if case .string(let text) = $0 { text } else { nil } }
    }

    static func scenarios() -> [Scenario] {
        let all = (try? json("library-vectors.json")).map { list($0["scenarios"]) } ?? []
        return all.map(Scenario.init)
    }
}

struct Scenario: CustomTestStringConvertible, @unchecked Sendable {
    let fields: [String: JSONValue]
    init(_ fields: [String: JSONValue]) { self.fields = fields }
    var testDescription: String { fields.string("name") ?? "?" }
    var now: Double { fields.number("now") ?? 0 }
    var state: [String: JSONValue] { if case .object(let state)? = fields["state"] { state } else { [:] } }
    var action: [String: JSONValue] { if case .object(let action)? = fields["action"] { action } else { [:] } }
    var expect: [String: JSONValue] { if case .object(let expect)? = fields["expect"] { expect } else { [:] } }
}

/// The state a scenario describes, in LuciumKit's terms.
private func browserState(of vector: [String: JSONValue], now: Double) -> BrowserState {
    var state = BrowserState(
        revision: 2,
        spaces: Vectors.list(vector["spaces"]).map { Space(id: $0.string("id") ?? "", name: $0.string("id") ?? "", emoji: "🏠", profileId: $0.string("profileId") ?? "") },
        activeSpaceId: vector.string("activeSpaceId") ?? "")
    if case .object(let pointers)? = vector["activeTabBySpace"] {
        for (space, value) in pointers { if case .string(let id) = value { state.activeTabBySpace[space] = .some(id) } else { state.activeTabBySpace[space] = .some(nil) } }
    }
    state.tabs = Vectors.list(vector["tabs"]).map { fields in
        let id = fields.string("id") ?? ""
        let url = fields.string("url") ?? "https://\(id).example/"
        var tab = TabItem(id: id, spaceId: fields.string("spaceId") ?? "", url: url, title: fields.string("title") ?? id, pinned: fields.bool("pinned") ?? false)
        tab.createdAt = now - 1000
        tab.lastActiveAt = fields.number("lastActiveAt") ?? now - 1000
        tab.folderId = fields.string("folderId")
        tab.favoriteId = fields.string("favoriteId")
        if tab.pinned { tab.anchorUrl = url }
        return tab
    }
    state.folders = Vectors.list(vector["folders"]).map { Folder(id: $0.string("id") ?? "", spaceId: $0.string("spaceId") ?? "", name: $0.string("id") ?? "", parentId: $0.string("parentId")) }
    state.favorites = Vectors.list(vector["favorites"]).map {
        Favorite(id: $0.string("id") ?? "", url: $0.string("url") ?? "", title: $0.string("title") ?? "", profileId: $0.string("profileId"))
    }
    state.archive = Vectors.list(vector["archive"]).map {
        ArchivedTab(id: $0.string("id") ?? "", spaceId: $0.string("spaceId") ?? "", url: $0.string("url") ?? "", title: $0.string("title") ?? "",
                    archivedAt: $0.number("archivedAt") ?? 0, pinned: $0.bool("pinned") ?? false, anchorUrl: $0.string("anchorUrl"), folderId: $0.string("folderId"))
    }
    if case .object(let settings)? = vector["settings"] { state.rest["settings"] = .object(settings) }
    return state
}

/// One action of the Mac's reducer, done by LuciumKit.
private func apply(_ action: [String: JSONValue], to state: inout BrowserState, now: Double) {
    let type = action.string("type") ?? ""
    let id = action.string("id") ?? ""
    switch type {
    case "tab/pin": state.pin(tabId: id)
    case "tab/unpin": state.unpin(tabId: id)
    case "tab/move": state.move(tabId: id, toFolder: action.string("folderId"))
    case "folder/delete": state.deleteFolder(id: id)
    case "folder/rename": state.renameFolder(id: id, to: action.string("name") ?? "")
    case "folder/create":
        state.createFolder(id: "new-1", name: action.string("name") ?? "", fallbackName: "Untitled", in: action.string("spaceId"), parentId: action.string("parentId"))
    case "today/clear": state.archiveToday(in: action.string("spaceId") ?? state.activeSpaceId, now: now)
    case "tab/archive", "tab/remove-pinned": state.archive(tabIds: [id], source: .manual, now: now)
    case "archive/sweep": state.sweepIdleTabs(now: now)
    case "archive/restore": state.restore(archiveId: id, newTabId: "new-1", now: now)
    case "favorite/add": state.addFavorite(id: "new-1", url: action.string("url") ?? "", title: action.string("title") ?? "", in: action.string("spaceId") ?? state.activeSpaceId)
    case "favorite/open": state.openFavorite(id: id, in: action.string("spaceId") ?? state.activeSpaceId, newTabId: "new-1", now: now)
    case "favorite/remove": state.removeFavorite(id: id)
    default: Issue.record("the vector names an action LuciumKit does not know: \(type)")
    }
}

@Suite("Library vectors shared with the Mac")
struct LibraryVectorTests {
    @Test func theFileHasScenariosToRun() {
        // An empty or unreadable file would make every scenario below pass for nothing.
        let all = Vectors.scenarios()
        #expect(all.count > 15)
        #expect(Set(all.compactMap { $0.action.string("type") }).count >= 8)
    }

    @Test(arguments: Vectors.scenarios())
    func playsLikeTheMacsReducer(_ scenario: Scenario) {
        var state = browserState(of: scenario.state, now: scenario.now)
        apply(scenario.action, to: &state, now: scenario.now)
        let spaceIds = Vectors.list(scenario.state["spaces"]).compactMap { $0.string("id") }

        for (key, expected) in scenario.expect {
            switch key {
            case "pinned", "today":
                guard case .object(let perSpace) = expected else { continue }
                for (space, ids) in perSpace {
                    #expect(spaceIds.contains(space))
                    let seen = state.tabs.filter { $0.spaceId == space && $0.isListed && $0.pinned == (key == "pinned") }.map(\.id)
                    #expect(seen == Vectors.texts(ids), "\(scenario.testDescription): \(key).\(space)")
                }
            case "archive":
                #expect(state.archive.map(\.id) == Vectors.texts(expected), "\(scenario.testDescription): archive")
            case "folders":
                let seen = state.folders.map { JSONValue.object(["id": .string($0.id), "parentId": $0.parentId.map(JSONValue.string) ?? .null]) }
                let wanted: [JSONValue]
                if case .array(let items) = expected { wanted = items } else { wanted = [] }
                #expect(seen == wanted, "\(scenario.testDescription): folders")
            case "favorites":
                #expect(state.favorites.map { "\($0.url)@\($0.profileId ?? "default")" } == Vectors.texts(expected), "\(scenario.testDescription): favorites")
            case "folderOf", "anchorOf", "favoriteOf", "titleOf", "shown":
                guard case .object(let wanted) = expected else { continue }
                for (id, value) in wanted {
                    let seen: JSONValue
                    switch key {
                    case "shown": seen = (state.activeTabBySpace[id] ?? nil).map(JSONValue.string) ?? .null
                    default:
                        guard let tab = state.tabs.first(where: { $0.id == id }) else { Issue.record("\(scenario.testDescription): no tab \(id)"); continue }
                        switch key {
                        case "folderOf": seen = tab.folderId.map(JSONValue.string) ?? .null
                        case "anchorOf": seen = tab.anchorUrl.map(JSONValue.string) ?? .null
                        case "favoriteOf": seen = tab.favoriteId.map(JSONValue.string) ?? .null
                        default: seen = .string(tab.title)
                        }
                    }
                    #expect(seen == value, "\(scenario.testDescription): \(key).\(id)")
                }
            default:
                Issue.record("the vector expects \(key), which LuciumKit does not observe")
            }
        }
    }

    @Test(arguments: matchVectors())
    func scoresLikeTheMac(_ vector: MatchVector) {
        #expect(Match.score(vector.text, query: vector.query) == vector.expect, "score(\(vector.text), \(vector.query))")
    }

    @Test func theMatchFileHasVectorsToRun() { #expect(matchVectors().count > 15) }
}

struct MatchVector: CustomTestStringConvertible, Sendable {
    let text: String
    let query: String
    let expect: Int
    var testDescription: String { "score(\(text.debugDescription), \(query.debugDescription)) = \(expect)" }
}

private func matchVectors() -> [MatchVector] {
    guard let fields = try? Vectors.json("match-vectors.json") else { return [] }
    return Vectors.list(fields["score"]).compactMap {
        guard let text = $0.string("text"), let query = $0.string("query"), let expect = $0.number("expect") else { return nil }
        return MatchVector(text: text, query: query, expect: Int(expect))
    }
}
