import Foundation
import Testing
@testable import LuciumKit

private func twoSpaces() -> BrowserState {
    BrowserState(revision: 2,
                 spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work"), Space(id: "s2", name: "Home", emoji: "🏠", profileId: "home")],
                 activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil])
}

@Suite("Tabs in the state")
struct TabOperationsTests {
    @Test func openingATabShowsItAndStampsItLikeTheMac() throws {
        var state = twoSpaces()
        let opened = state.openTab(id: "t1", in: "s1", url: "https://a.example/", title: "A", now: 1_790_000_000_000)
        let tab = try #require(opened)
        #expect(state.tabs.map(\.id) == ["t1"])
        #expect(state.activeTab(in: "s1")?.id == "t1")
        #expect(state.activeTab(in: "s2") == nil)
        #expect(tab.createdAt == 1_790_000_000_000 && tab.lastActiveAt == 1_790_000_000_000)
        // The Mac reads these two fields as numbers of milliseconds: written as integers, not as 1.79e+12.
        let json = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        #expect(json.contains("\"lastActiveAt\":1790000000000"), "\(json)")
    }

    @Test func aTabInASpaceThatDoesNotExistOrWithATakenIdIsRefused() {
        var state = twoSpaces()
        #expect(state.openTab(id: "t1", in: "nowhere", now: 1) == nil)
        #expect(state.openTab(id: "t1", in: "s1", now: 1) != nil)
        #expect(state.openTab(id: "t1", in: "s2", now: 2) == nil, "an id is one tab")
        #expect(state.tabs.count == 1)
    }

    @Test func showingATabMakesItTheOneOfItsSpaceAndNotesWhen() {
        var state = twoSpaces()
        state.openTab(id: "t1", in: "s1", now: 1)
        state.openTab(id: "t2", in: "s1", now: 2)
        #expect(state.activeTab(in: "s1")?.id == "t2")
        state.show(tabId: "t1", now: 99)
        #expect(state.activeTab(in: "s1")?.id == "t1")
        #expect(state.tabs.first { $0.id == "t1" }?.lastActiveAt == 99)
        #expect(state.activeSpaceId == "s1", "showing a tab does not move to another space")
    }

    @Test func closingTheShownTabShowsTheMostRecentlyUsedOneOfTheSameSpace() {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", now: 10)
        state.openTab(id: "b", in: "s1", now: 20)
        state.openTab(id: "c", in: "s1", now: 30)
        state.openTab(id: "other", in: "s2", now: 99)
        state.show(tabId: "a", now: 40)
        state.show(tabId: "b", now: 50)  // b is shown and the most recent; a is the next most recent
        #expect(state.close(tabId: "b") == "a")
        #expect(state.activeTab(in: "s1")?.id == "a")
        #expect(state.activeTab(in: "s2")?.id == "other", "another space is left alone")
    }

    @Test func closingATabThatIsNotShownLeavesTheShownOne() {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", now: 1)
        state.openTab(id: "b", in: "s1", now: 2)
        #expect(state.close(tabId: "a") == "b")
        #expect(state.tabs.map(\.id) == ["b"])
    }

    @Test func closingTheLastTabLeavesTheSpaceShowingNoneAndTheFileSaysNull() throws {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", now: 1)
        #expect(state.close(tabId: "a") == nil)
        #expect(state.activeTab(in: "s1") == nil)
        let json = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        #expect(json.contains("\"s1\":null"), "the Mac writes null for a space with no tab: \(json)")
        #expect(state.close(tabId: "unknown") == nil)
    }

    @Test func aPageUpdatesItsTabButTheStartPageAndAnEmptyTitleDoNot() {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", url: "https://a.example/", title: "A", now: 1)
        state.record(tabId: "a", url: "https://a.example/next", title: "Next")
        #expect(state.tabs[0].url == "https://a.example/next" && state.tabs[0].title == "Next")
        state.record(tabId: "a", url: "about:blank", title: "")
        #expect(state.tabs[0].url == "https://a.example/next" && state.tabs[0].title == "Next")
        state.record(tabId: "missing", url: "https://x.example/", title: "X")
        #expect(state.tabs.count == 1)
    }

    @Test func aBlankTabIsOneAtAboutBlank() {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", now: 1)
        #expect(state.tabs[0].isBlank)
        state.record(tabId: "a", url: "https://a.example/", title: nil)
        #expect(!state.tabs[0].isBlank)
    }

    @Test func consistentPutsRightPointersThatPointAtNothingAndKeepsEveryTab() throws {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", now: 1)
        state.tabs.append(TabItem(id: "orphan", spaceId: "gone", url: "https://o.example/", title: "O"))
        state.activeSpaceId = "gone"
        state.activeTabBySpace["s2"] = .some("a")  // a tab of s1, not of s2
        let repaired = try #require(state.consistent())
        #expect(repaired.activeSpaceId == "s1")
        #expect(repaired.activeTab(in: "s2") == nil)
        #expect(repaired.activeTabBySpace["s2"] == .some(nil), "the pointer itself is put right, so that the file says null")
        #expect(repaired.tabs.map(\.id) == ["a", "orphan"], "nothing is dropped: a tab of a space this build does not show is written back")
    }

    @Test func aStateWithoutAnySpaceIsNotOneThisBuildCanShow() {
        #expect(BrowserState().consistent() == nil)
    }
}
