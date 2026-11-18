import Foundation
import Testing
@testable import LuciumKit

private func stateWithAPrivateTab() -> BrowserState {
    var state = BrowserState(revision: 2,
                             spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work"), Space(id: "s2", name: "Home", emoji: "🏠", profileId: "home")],
                             activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil])
    state.openTab(id: "normal", in: "s1", url: "https://a.example/", title: "A", now: 10)
    state.openPrivateTab(id: "secret", in: "s1", now: 20)
    state.record(tabId: "secret", url: "https://secret.example/medical", title: "Private page")
    return state
}

private final class Sandbox {
    let directory: URL
    init() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-private-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    var file: URL { directory.appending(path: "state.json") }
    deinit { try? FileManager.default.removeItem(at: directory) }
}

@Suite("Private tabs in the state")
struct PrivateTabsTests {
    @Test func aPrivateTabIsATabOfItsSpaceThatCarriesTheMacsFlag() throws {
        let state = stateWithAPrivateTab()
        let tab = try #require(state.tabs.first { $0.id == "secret" })
        #expect(tab.isPrivate && tab.spaceId == "s1" && tab.rest["private"] == .bool(true))
        #expect(state.activeTab(in: "s1")?.id == "secret", "opening a private tab shows it")
        #expect(state.privateTabs.map(\.id) == ["secret"])
        #expect(state.tabs.first { $0.id == "normal" }?.isPrivate == false)
        var again = state
        #expect(again.openPrivateTab(id: "secret", in: "s1", now: 1) == nil, "an id is one tab")
        #expect(again.openPrivateTab(id: "x", in: "nowhere", now: 1) == nil)
        #expect(again == state, "a refused tab changes nothing")
    }

    @Test func thePersistableStateHasNoPrivateTabAndNothingPointsAtOne() {
        let state = stateWithAPrivateTab()
        let kept = state.persistable()
        #expect(kept.tabs.map(\.id) == ["normal"])
        #expect(kept.activeTab(in: "s1")?.id == "normal", "the space shows the most recent tab left, not a tab that is gone")
        #expect(kept.consistent() == kept)
        #expect(state.tabs.count == 2, "the state in memory keeps its private tab: only what is written loses it")
        // A state with no private tab is returned as it is.
        #expect(kept.persistable() == kept)
    }

    @Test func aSpaceWhoseOnlyTabIsPrivateShowsNoneWhenItIsKept() {
        var state = stateWithAPrivateTab()
        state.close(tabId: "normal")
        state.show(tabId: "secret", now: 30)
        let kept = state.persistable()
        #expect(kept.tabs.isEmpty)
        #expect(kept.activeTab(in: "s1") == nil)
        #expect(kept.activeTabBySpace["s1"] == .some(nil), "written as null, as the Mac writes a space with no tab")
    }

    @Test func noWriteOfTheStateFileKeepsThePageOrTheTitleOfAPrivateTab() throws {
        let box = try Sandbox()
        var file = StateFile(url: box.file)
        try file.save(stateWithAPrivateTab())
        let text = try String(contentsOf: box.file, encoding: .utf8)
        #expect(!text.contains("secret"), "no trace of the private tab, its id or its page: \(text)")
        #expect(!text.contains("medical") && !text.contains("Private page") && !text.contains("\"private\""))
        #expect(text.contains("normal"))
        var again = StateFile(url: box.file)
        guard case .loaded(let loaded) = again.load() else { Issue.record("not loaded"); return }
        #expect(loaded.tabs.map(\.id) == ["normal"])
    }

    @Test func aPrivateTabFoundInAFileIsNotATabOfThisRun() throws {
        let box = try Sandbox()
        // A file written by something else (a Mac, an older build) that holds a private tab: it is dropped as the file is read.
        var withIt = stateWithAPrivateTab()
        withIt.activeTabBySpace["s1"] = .some("secret")
        try JSONEncoder().encode(withIt).write(to: box.file)
        var file = StateFile(url: box.file)
        guard case .loaded(let loaded) = file.load() else { Issue.record("not loaded"); return }
        #expect(loaded.tabs.map(\.id) == ["normal"])
        #expect(loaded.activeTab(in: "s1")?.id == "normal")
    }
}
