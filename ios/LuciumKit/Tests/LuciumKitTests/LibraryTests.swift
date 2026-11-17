import Foundation
import Testing
@testable import LuciumKit

private func twoSpaces() -> BrowserState {
    BrowserState(revision: 2,
                 spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work"), Space(id: "s2", name: "Home", emoji: "🏠", profileId: "home")],
                 activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil])
}

private func referenceState() throws -> BrowserState {
    let file = URL(fileURLWithPath: #filePath)
    let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Contracts/state-reference.json")
    return try BrowserState.decode(Data(contentsOf: url))
}

@Suite("Lists of a space")
struct LibraryTests {
    // MARK: What the Mac wrote

    @Test func readsTheFoldersAndThePinnedRowsTheMacWrote() throws {
        let state = try referenceState()
        let space = try #require(state.spaces.first).id
        #expect(state.folders.map(\.name) == ["Lectures"])
        let rows = state.pinnedRows(in: space)
        // The loose pinned tab first, then the folder with the tab it holds counted.
        guard case .tab(let loose) = rows.first, case .folder(let folder, let count) = rows.last else { Issue.record("rows: \(rows)"); return }
        #expect(loose.title == "Carnet" && loose.anchorUrl == "https://carnet.example/notes")
        #expect(folder.name == "Lectures" && count == 1)
        #expect(state.pinnedRows(in: space, inside: folder.id).map(\.id) == ["tab:id-5"])
    }

    @Test func readingAndWritingTheListsChangesNothingTheyDidNotChange() throws {
        var state = try referenceState()
        let before = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state))
        state.folders = state.folders
        state.favorites = state.favorites
        state.archive = state.archive
        #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(state)) == before)
    }

    @Test func aStateThatNeverHadTheListsDoesNotGainEmptyOnes() {
        var state = twoSpaces()
        state.folders = []
        state.favorites = []
        state.archive = []
        #expect(state.rest["folders"] == nil && state.rest["favorites"] == nil && state.rest["archive"] == nil)
        state.createFolder(id: "f1", name: "Reading", fallbackName: "Untitled")
        #expect(state.rest["folders"] != nil)
    }

    @Test func whatAnEntryHoldsThatThisBuildDoesNotTypeComesBackOut() throws {
        var state = twoSpaces()
        state.rest["folders"] = .array([.object(["id": .string("f1"), "spaceId": .string("s1"), "name": .string("Old"), "collapsed": .bool(false),
                                                  "noWake": .bool(true), "icon": .string("📚")])])
        state.rest["archive"] = .array([.object(["id": .string("a1"), "spaceId": .string("s1"), "url": .string("https://a.example/"), "title": .string("A"),
                                                  "archivedAt": .number(1), "history": .object(["index": .number(2)])])])
        state.renameFolder(id: "f1", to: "New")
        state.archive(tabIds: [], source: .manual, now: 5)
        state.openTab(id: "t1", in: "s1", url: "https://b.example/", title: "B", now: 2)
        state.archive(tabIds: ["t1"], source: .manual, now: 6)
        guard case .array(let folders)? = state.rest["folders"], case .object(let folder)? = folders.first else { Issue.record("no folders"); return }
        #expect(folder["name"] == .string("New") && folder["noWake"] == .bool(true) && folder["icon"] == .string("📚"))
        guard case .array(let archive)? = state.rest["archive"], case .object(let old)? = archive.last else { Issue.record("no archive"); return }
        #expect(archive.count == 2 && old["history"] == .object(["index": .number(2)]), "the older entry keeps its history")
    }

    @Test func anEntryThatDoesNotReadIsCountedAndLeftOutOfTheView() {
        var state = twoSpaces()
        state.rest["folders"] = .array([.object(["id": .string("f1"), "spaceId": .string("s1"), "name": .string("Good")]), .object(["id": .string("bad")]), .string("nonsense")])
        #expect(state.folders.map(\.id) == ["f1"])
        #expect(state.unreadableLibraryEntries == ["folders": 2])
        // It is gone the next time the list is written, as the Mac's own repair drops it.
        state.renameFolder(id: "f1", to: "Better")
        #expect(state.unreadableLibraryEntries.isEmpty)
    }

    @Test func aStateWhoseEveryEntryReadsReportsNothing() throws {
        #expect(try referenceState().unreadableLibraryEntries.isEmpty)
    }

    // MARK: Pinned rows and folders

    @Test func aFolderHoldsItsFoldersFirstThenItsTabsAndCountsWhatIsBelow() {
        var state = twoSpaces()
        state.createFolder(id: "f1", name: "Top", fallbackName: "?", in: "s1")
        state.createFolder(id: "f2", name: "Inner", fallbackName: "?", parentId: "f1")
        for id in ["a", "b", "c"] { state.openTab(id: id, in: "s1", url: "https://\(id).example/", title: id, now: 1) }
        state.move(tabId: "a", toFolder: "f1")
        state.move(tabId: "b", toFolder: "f2")
        state.move(tabId: "c", toFolder: nil)
        #expect(state.pinnedRows(in: "s1").map(\.id) == ["tab:c", "folder:f1"])
        #expect(state.pinnedRows(in: "s1", inside: "f1").map(\.id) == ["folder:f2", "tab:a"])
        guard case .folder(_, let count) = state.pinnedRows(in: "s1").last else { Issue.record("no folder row"); return }
        #expect(count == 2, "the tab of the folder and the one of the folder inside it")
    }

    @Test func aBrokenLinkNeverHidesATab() {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", url: "https://a.example/", title: "a", now: 1)
        state.pin(tabId: "a")
        var tab = state.tabs[0]
        tab.folderId = "gone"
        state.tabs[0] = tab
        state.rest["folders"] = .array([.object(["id": .string("f1"), "spaceId": .string("s1"), "name": .string("Orphan"), "parentId": .string("gone")])])
        #expect(Set(state.pinnedRows(in: "s1").map(\.id)) == ["tab:a", "folder:f1"], "a tab whose folder is gone and a folder whose parent is gone are at the root")
    }

    @Test func aLoopInAHandEditedTreeDoesNotHangAndKeepsEveryFolder() {
        var state = twoSpaces()
        state.rest["folders"] = .array([
            .object(["id": .string("f1"), "spaceId": .string("s1"), "name": .string("One"), "parentId": .string("f2")]),
            .object(["id": .string("f2"), "spaceId": .string("s1"), "name": .string("Two"), "parentId": .string("f1")]),
            .object(["id": .string("f3"), "spaceId": .string("s1"), "name": .string("Self"), "parentId": .string("f3")]),
        ])
        #expect(state.folderDepth("f1") == 2 && state.folderDepth("f3") == 1)
        #expect(state.folderPath("f1").count == 2)
        _ = state.pinnedRows(in: "s1")
    }

    @Test func aFolderIsAtMostFourLevelsDeep() {
        var state = twoSpaces()
        state.createFolder(id: "f1", name: "1", fallbackName: "?")
        state.createFolder(id: "f2", name: "2", fallbackName: "?", parentId: "f1")
        state.createFolder(id: "f3", name: "3", fallbackName: "?", parentId: "f2")
        state.createFolder(id: "f4", name: "4", fallbackName: "?", parentId: "f3")
        #expect(state.createFolder(id: "f5", name: "5", fallbackName: "?", parentId: "f4") == nil)
        #expect(state.createFolder(id: "f6", name: "6", fallbackName: "?", parentId: "missing") == nil)
        #expect(state.createFolder(id: "f1", name: "again", fallbackName: "?") == nil, "an id is one folder")
        #expect(state.folders.count == 4 && state.folderDepth("f4") == 4)
    }

    @Test func aFolderNameIsTrimmedCutAndNeverBlank() {
        var state = twoSpaces()
        #expect(state.createFolder(id: "f1", name: "  Reading  ", fallbackName: "Untitled")?.name == "Reading")
        #expect(state.createFolder(id: "f2", name: "   ", fallbackName: "Untitled")?.name == "Untitled")
        #expect(state.createFolder(id: "f3", name: String(repeating: "x", count: 500), fallbackName: "Untitled")?.name.count == Library.nameMax)
        state.renameFolder(id: "f1", to: "")
        #expect(state.folders.first?.name == "Reading")
    }

    @Test func aFolderOfASpaceThatDoesNotExistIsCreatedInTheOneOnScreen() {
        var state = twoSpaces()
        #expect(state.createFolder(id: "f1", name: "x", fallbackName: "?", in: "gone")?.spaceId == "s1")
        #expect(state.createFolder(id: "f2", name: "x", fallbackName: "?", in: "s2")?.spaceId == "s2")
    }

    // MARK: Archive

    @Test func theArchiveKeepsTheFiveHundredNewest() {
        var state = twoSpaces()
        state.archive = (0..<500).map { ArchivedTab(id: "old\($0)", spaceId: "s1", url: "https://o\($0).example/", title: "o", archivedAt: Double($0)) }
        state.openTab(id: "fresh", in: "s1", url: "https://fresh.example/", title: "Fresh", now: 9)
        state.archive(tabIds: ["fresh"], source: .manual, now: 1000)
        #expect(state.archive.count == Library.archiveLimit && state.archive.first?.id == "fresh" && state.archive.last?.id == "old498")
    }

    @Test func aBlankTabLeavesWithoutAnEntryAndASpaceThenShowsAnotherOrNone() {
        var state = twoSpaces()
        state.openTab(id: "old", in: "s1", url: "https://old.example/", title: "Old", now: 1)
        state.openTab(id: "blank", in: "s1", now: 5)
        let made = state.archive(tabIds: ["blank"], source: .manual, now: 9)
        #expect(made.isEmpty && state.archive.isEmpty && state.tabs.map(\.id) == ["old"])
        #expect(state.activeTab(in: "s1")?.id == "old", "the space shows the most recently used tab left")
        state.archive(tabIds: ["old"], source: .manual, now: 10)
        #expect(state.activeTab(in: "s1") == nil && state.tabs.isEmpty)
    }

    @Test func aPrivateTabLeavesWithoutAnEntry() {
        var state = twoSpaces()
        state.openTab(id: "p", in: "s1", url: "https://private.example/", title: "P", now: 1)
        state.tabs[0].rest["private"] = .bool(true)
        #expect(state.archive(tabIds: ["p"], source: .manual, now: 2).isEmpty)
        #expect(state.archive.isEmpty && state.tabs.isEmpty, "the page is not kept anywhere")
    }

    @Test func aTabWithNoDateIsNotKnownToBeIdleAndIsLeftAlone() {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", url: "https://a.example/", title: "A", now: 1)
        state.openTab(id: "b", in: "s1", url: "https://b.example/", title: "B", now: 1)
        state.activeTabBySpace["s1"] = .some("b")
        state.tabs[0].rest["lastActiveAt"] = nil
        state.tabs[0].rest["createdAt"] = nil
        #expect(state.sweepIdleTabs(now: 1_000_000_000_000).isEmpty)
    }

    @Test func theDelayIsReadFromTheMacsSettingsAndNonsenseIsIgnored() {
        var state = twoSpaces()
        #expect(state.autoArchiveHours(forSpace: "s1") == 12)
        state.rest["settings"] = .object(["autoArchiveHours": .number(24), "profiles": .object(["work": .object(["autoArchiveHours": .number(3)])])])
        #expect(state.autoArchiveHours(forSpace: "s1") == 3 && state.autoArchiveHours(forSpace: "s2") == 24)
        state.rest["settings"] = .object(["autoArchiveHours": .string("often"), "profiles": .object(["work": .object(["autoArchiveHours": .number(-5)])])])
        #expect(state.autoArchiveHours(forSpace: "s1") == 12 && state.autoArchiveHours(forSpace: "nowhere") == 12)
    }

    @Test func theArchiveIsGroupedByAgeNewestFirstAndEmptyGroupsAreDropped() {
        let day = 86_400_000.0
        let midnight = 1_790_000_000_000.0
        func entry(_ id: String, _ at: Double) -> ArchivedTab { ArchivedTab(id: id, spaceId: "s1", url: "https://\(id).example/", title: id, archivedAt: at) }
        let groups = Library.archiveGroups([entry("old", midnight - 90 * day), entry("today-early", midnight + 1), entry("yesterday", midnight - 1),
                                            entry("week", midnight - 5 * day), entry("month", midnight - 20 * day), entry("today-late", midnight + 5000)], startOfToday: midnight)
        #expect(groups.map(\.bucket) == [.today, .yesterday, .week, .month, .older])
        #expect(groups[0].entries.map(\.id) == ["today-late", "today-early"])
        #expect(Library.archiveGroups([], startOfToday: midnight).isEmpty)
        #expect(Library.archiveGroups([entry("a", midnight - 2 * day)], startOfToday: midnight).map(\.bucket) == [.week], "no yesterday group when nothing is from yesterday")
        #expect(Library.archiveGroups([entry("edge", midnight)], startOfToday: midnight).map(\.bucket) == [.today], "midnight itself is today")
    }

    // MARK: Favourites and the search

    @Test func aFavouriteWithoutATitleTakesTheHost() {
        var state = twoSpaces()
        #expect(state.addFavorite(id: "f", url: "https://www.recettes.example/page", title: "  ", in: "s1")?.title == "recettes.example")
    }

    @Test func onlyWebAddressesAreLoadable() {
        #expect(Library.isLoadable("https://a.example/") && Library.isLoadable("HTTP://a.example/x"))
        #expect(!Library.isLoadable("javascript:alert(1)") && !Library.isLoadable("file:///etc/passwd") && !Library.isLoadable("about:blank") && !Library.isLoadable("https://"))
        // A scheme with a host is not a web address for that: only http and https are.
        #expect(!Library.isLoadable("ftp://files.example/x") && !Library.isLoadable("lucium://tabs/1"))
    }

    @Test func theSearchRanksPrefixThenWordThenInsideAndTheMostRecentAmongEquals() {
        var state = twoSpaces()
        state.openTab(id: "inside", in: "s1", url: "https://i.example/", title: "Assemblée", now: 10)  // "sem" inside a word: 50
        state.openTab(id: "word-old", in: "s1", url: "https://w1.example/", title: "La semaine", now: 20)  // word start: 70
        state.openTab(id: "word-new", in: "s2", url: "https://w2.example/", title: "Une semaine", now: 30)
        state.openTab(id: "prefix", in: "s2", url: "https://p.example/", title: "Semis", now: 5)  // prefix: 100
        state.openTab(id: "blank", in: "s1", now: 99)
        state.openTab(id: "fav-page", in: "s1", url: "https://f.example/", title: "Semaine fav", now: 99)
        state.tabs[state.tabs.firstIndex { $0.id == "fav-page" }!].favoriteId = "fav1"
        #expect(CommandSearch.tabs(in: state, matching: "sem").map(\.id) == ["prefix", "word-new", "word-old", "inside"])
        #expect(CommandSearch.tabs(in: state, matching: "sem", limit: 2).map(\.id) == ["prefix", "word-new"])
        #expect(CommandSearch.tabs(in: state, matching: "").map(\.id) == ["word-new", "word-old", "inside", "prefix"], "nothing typed: the most recent, no blank tab, no page of a favourite")
        #expect(CommandSearch.tabs(in: state, matching: "zzz").isEmpty)
    }

    @Test func aSearchCanBeKeptToOneSpaceAndLetEveryAnswerThrough() {
        var state = twoSpaces()
        for index in 0..<8 { state.openTab(id: "w\(index)", in: "s1", url: "https://w\(index).example/", title: "Semaine \(index)", now: Double(index)) }
        state.openTab(id: "h", in: "s2", url: "https://h.example/", title: "Semaine maison", now: 50)
        #expect(CommandSearch.tabs(in: state, matching: "semaine").count == CommandSearch.maxTabs)
        #expect(CommandSearch.tabs(in: state, matching: "semaine", space: "s1", limit: nil).count == 8)
        #expect(CommandSearch.tabs(in: state, matching: "semaine", space: "s2", limit: nil).map(\.id) == ["h"])
    }

    @Test func theSearchOffersTheFavouritesOfTheProfileOfTheSpaceOnly() {
        var state = twoSpaces()
        state.addFavorite(id: "w", url: "https://agenda.example/", title: "Agenda de la semaine", in: "s1")
        state.addFavorite(id: "h", url: "https://jardin.example/", title: "Jardin de la semaine", in: "s2")
        #expect(CommandSearch.favorites(in: state, space: "s1", matching: "sem").map(\.id) == ["w"])
        #expect(CommandSearch.favorites(in: state, space: "s2", matching: "").map(\.id) == ["h"])
        #expect(CommandSearch.favorites(in: state, space: "nowhere", matching: "").isEmpty)
    }
}

@Suite("Match")
struct MatchTests {
    @Test func foldsAccentsQuotesAndSpacesLikeTheMac() {
        #expect(Match.fold("L’Été\u{00A0}Indien") == "l'ete indien")
        #expect(Match.fold("ÀÉÎÕÜ") == "aeiou")
    }

    @Test func anEmptyQueryMatchesNothing() {
        #expect(Match.score("anything", query: "") == 0 && Match.score("anything", query: "  ") == 0)
    }
}

@Suite("Search settings")
struct SearchSettingsTests {
    private func state(_ settings: JSONValue?) -> BrowserState {
        var state = BrowserState(spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work"), Space(id: "s2", name: "Home", emoji: "🏠", profileId: "home")],
                                 activeSpaceId: "s1")
        state.rest["settings"] = settings
        return state
    }

    @Test func theProfileOwnTemplateWinsThenTheGeneralOneThenDuckDuckGo() {
        let own = JSONValue.object(["searchUrlTemplate": .string("https://www.qwant.com/?q=%s"),
                                    "profiles": .object(["work": .object(["searchUrlTemplate": .string("https://www.ecosia.org/search?q=%s")])])])
        #expect(state(own).searchTemplate(forSpace: "s1") == "https://www.ecosia.org/search?q=%s")
        #expect(state(own).searchTemplate(forSpace: "s2") == "https://www.qwant.com/?q=%s")
        #expect(state(nil).searchTemplate(forSpace: "s1") == AddressResolver.defaultSearchTemplate)
    }

    @Test func aTemplateThatIsNotAWebAddressWithAPlaceholderIsIgnored() {
        for bad in ["javascript:alert('%s')", "https://example.org/?q=", "file:///etc/%s", "", "%s", "ftp://files.example/%s"] {
            #expect(state(.object(["searchUrlTemplate": .string(bad)])).searchTemplate(forSpace: "s1") == AddressResolver.defaultSearchTemplate, "general: \(bad)")
            let own = JSONValue.object(["profiles": .object(["work": .object(["searchUrlTemplate": .string(bad)])])])
            #expect(state(own).searchTemplate(forSpace: "s1") == AddressResolver.defaultSearchTemplate, "profile: \(bad)")
        }
    }

    @Test func theEngineIsNamedByItsPresetThenByItsHost() {
        #expect(SearchEngine.name(forTemplate: "https://duckduckgo.com/?q=%s") == "DuckDuckGo")
        #expect(SearchEngine.name(forTemplate: "https://search.example.org/find?q=%s") == "search.example.org")
    }

    @Test func aProfileNameIsTheOneThePersonGaveIt() {
        let named = state(.object(["profileNames": .object(["work": .string("  Travail ")])]))
        #expect(named.profileName("work") == "Travail" && named.profileName("home") == nil && state(nil).profileName("work") == nil)
    }
}

@Suite("Tile style")
struct TileStyleTests {
    @Test func theSameHostAlwaysGetsTheSameColourInsideTheRange() {
        for host in ["recettes.example", "carnet.example", "", "ÉTÉ.example", "x"] {
            let index = TileStyle.colorIndex(forHost: host)
            #expect((0..<TileStyle.colorCount).contains(index) && index == TileStyle.colorIndex(forHost: host))
        }
        #expect(TileStyle.colorIndex(forHost: "Recettes.Example") == TileStyle.colorIndex(forHost: "recettes.example"))
        // Not every host gets the same colour: a tile that never varied would say nothing.
        #expect(Set(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"].map(TileStyle.colorIndex(forHost:))).count > 2)
    }

    @Test func theLetterIsTheFirstLetterOrDigitOfTheHost() {
        #expect(TileStyle.letter(forHost: "recettes.example") == "R" && TileStyle.letter(forHost: "[::1]:8080") == "1")
        #expect(TileStyle.letter(forHost: "") == nil)
    }
}
