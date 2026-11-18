import LuciumKit
import SwiftUI

/// The lists of a space and what the person does with them: favourites, pinned tabs, folders, Today, the archive (docs/ios.md, mockups `C2` and
/// `Commandes`). The rules are in `LuciumKit` (`LibraryOperations.swift`, held by vectors shared with the Mac); here a change also frees what a
/// tab that left holds (its view, its picture, its page state), keeps the state, and tells the screen.
extension BrowserModel {
    // MARK: What the lock hides
    //
    // A space that is locked (or the whole application, when it is) shows nothing of itself: no tab, no folder, no favourite, no archived page, in
    // the sheet of tabs, the command bar or anywhere else. Every list below goes through `isCovered`, and the model's own `activeTabs` and
    // `activeTab` already find nothing: reading `state.tabs` or `state.archive` directly would walk around the lock.

    func isCovered(_ spaceId: String) -> Bool { lock?.covers(space: spaceId) ?? false }

    // MARK: Reading

    var todayTabs: [TabItem] { activeSpaceCovered ? [] : state.todayTabs(in: activeSpace.id) }
    var favorites: [Favorite] { activeSpaceCovered ? [] : state.favorites(inSpace: activeSpace.id) }
    /// What the start page of the blank tab on screen shows under its search field (`StartPageContent`, `StartView.swift`).
    var startPage: StartPageContent {
        StartPageContent.make(in: state, space: activeSpace.id, covered: activeSpaceCovered, isPrivate: activeTab?.isPrivate == true)
    }
    var folders: [Folder] { activeSpaceCovered ? [] : state.folders.filter { $0.spaceId == activeSpace.id } }
    func pinnedRows(inside folderId: String? = nil) -> [PinnedRow] { activeSpaceCovered ? [] : state.pinnedRows(in: activeSpace.id, inside: folderId) }
    func folder(_ id: String) -> Folder? { state.folders.first { $0.id == id && !isCovered($0.spaceId) } }

    /// The archive, newest first, grouped by age (the day is the one of the clock the model was given): without the pages of the spaces that are covered.
    var archiveGroups: [ArchiveGroup] { Library.archiveGroups(visibleArchive, startOfToday: Library.startOfDay(clock())) }
    var archiveCount: Int { visibleArchive.count }
    private var visibleArchive: [ArchivedTab] { state.archive.filter { !isCovered($0.spaceId) } }

    /// The page of a tab is the one on screen.
    func isShown(_ tab: TabItem) -> Bool { tab.id == activeTab?.id }
    func isShown(_ favorite: Favorite) -> Bool { activeTab?.favoriteId == favorite.id }
    func isFavorite(_ tab: TabItem) -> Bool { state.favorites(inSpace: tab.spaceId).contains { $0.url == tab.url } }

    /// What the sheet says of the profile of the active space: the name it was given, else the Mac's "default profile", else its identifier
    /// (`label(ofProfile:)` of `SpacesModel.swift`).
    var profileTitle: String { label(ofProfile: activeSpace.profileId) }

    /// The name of the engine a typed text is searched with, in the profile of the active space.
    var searchEngineName: String { SearchEngine.name(forTemplate: state.searchTemplate(forSpace: activeSpace.id)) }

    /// The open tabs of the active space that answer a text typed in the sheet; every one of them, best first.
    func tabsMatching(_ query: String) -> [TabItem] {
        activeSpaceCovered ? [] : CommandSearch.tabs(in: state, matching: query, space: activeSpace.id, limit: nil)
    }

    /// The open tabs of every space that answer a text typed in the command bar, best first, without those of the spaces that are covered.
    func commandTabs(matching query: String) -> [TabItem] {
        Array(CommandSearch.tabs(in: state, matching: query, limit: nil).filter { !isCovered($0.spaceId) }.prefix(CommandSearch.maxTabs))
    }

    /// The favourites the command bar offers for a text typed: those of the profile of the active space, none while that space is covered.
    func commandFavorites(matching query: String) -> [Favorite] {
        activeSpaceCovered ? [] : CommandSearch.favorites(in: state, space: activeSpace.id, matching: query)
    }

    // MARK: Changing the lists

    func pin(_ tab: TabItem) { if !isCovered(tab.spaceId) { change { $0.pin(tabId: tab.id) } } }
    func unpin(_ tab: TabItem) { if !isCovered(tab.spaceId) { change { $0.unpin(tabId: tab.id) } } }
    func move(_ tab: TabItem, toFolder folderId: String?) { if !isCovered(tab.spaceId) { change { $0.move(tabId: tab.id, toFolder: folderId) } } }

    @discardableResult
    func newFolder(named name: String, inside parentId: String? = nil) -> Folder? {
        var made: Folder?
        change { made = $0.createFolder(id: UUID().uuidString.lowercased(), name: name, fallbackName: String(localized: "folder.untitled"), in: activeSpace.id, parentId: parentId) }
        return made
    }

    func renameFolder(_ id: String, to name: String) { change { $0.renameFolder(id: id, to: name) } }
    func deleteFolder(_ id: String) { change { $0.deleteFolder(id: id) } }

    /// Moves a tab to the archive: its view, its picture and its page state go with it (what it comes back with is its address and its title).
    func archive(_ tab: TabItem) {
        guard !isCovered(tab.spaceId) else { return }
        release(after: { $0.archive(tabIds: [tab.id], source: .manual, now: clock()) })
    }

    /// "Archive all": the Today tabs of the active space, except the one on screen.
    func archiveToday() {
        guard !activeSpaceCovered else { return }
        release(after: { $0.archiveToday(in: activeSpace.id, now: clock()) })
    }

    /// The automatic archive: a Today tab left idle past the delay of its profile (12 hours unless the Mac wrote another). Run when the application
    /// starts and when it comes back; the tab each space shows is never swept.
    func sweepIdleTabs() { release(after: { $0.sweepIdleTabs(now: clock()) }) }

    /// Brings an archived tab back: a new tab in its space, shown (the space too, when it is another one).
    func restore(_ entry: ArchivedTab) {
        // The page of a space that is covered is not brought back (it is not even listed, and a stale row must not walk around the lock), nor is one
        // that would open in the space on screen while that one is covered.
        guard !isCovered(entry.spaceId), !(activeSpaceCovered && !state.spaces.contains { $0.id == entry.spaceId }) else { return }
        leaveActiveTab()
        var restored: TabItem?
        mutate { restored = $0.restore(archiveId: entry.id, newTabId: UUID().uuidString.lowercased(), now: clock()) }
        guard let restored else { return }
        if restored.spaceId != state.activeSpaceId { state.selectSpace(restored.spaceId) }
        tabsSheetShown = false
        drawerEvent(.pageShown)
        arrive()
    }

    /// Empties the archive that shows: the pages of a space that is covered are not forgotten with the rest (the Mac's `archive/clear` keeps them too).
    func clearArchive() {
        change { state in
            state.archive = state.archive.filter { isCovered($0.spaceId) }
        }
    }

    // MARK: Favourites

    /// Adds the page on screen to the favourites of the active profile. A blank tab has no page to add.
    func addFavorite(_ tab: TabItem) {
        // A private tab is never a favourite (the Mac's `favorite/add` refuses an address that only private tabs are on).
        guard !tab.isBlank, !tab.isPrivate, !isCovered(tab.spaceId) else { return }
        change { $0.addFavorite(id: UUID().uuidString.lowercased(), url: tab.url, title: tab.title, in: tab.spaceId) }
    }

    func removeFavorite(_ favorite: Favorite) { change { $0.removeFavorite(id: favorite.id) } }

    /// Shows the page of a favourite (opening it when it was not), and closes the sheets. A blank tab on screen (the start page, where the favourites
    /// are tiles) is not left behind: it has nothing to keep, and a tap on a tile would otherwise add a tab to Today each time.
    func openFavorite(_ favorite: Favorite) {
        guard !activeSpaceCovered else { return }
        let blank = activeTab.flatMap { $0.isBlank ? $0.id : nil }
        leaveActiveTab()
        var shown: String?
        mutate { shown = $0.openFavorite(id: favorite.id, in: activeSpace.id, newTabId: UUID().uuidString.lowercased(), now: clock()) }
        guard let shown else { return }
        tabsSheetShown = false
        commandBarShown = false
        drawerEvent(.pageShown)
        arrive()
        // The favourite's tab is on screen now: closing the blank one frees its view and files and only keeps the state.
        if let blank, blank != shown, let tab = state.tabs.first(where: { $0.id == blank }) { close(tab) }
    }

    // MARK: From the command bar

    /// Shows a tab of any space: the space first when it is another one.
    func show(_ tab: TabItem) {
        commandBarShown = false
        guard !isCovered(tab.spaceId) else { return }
        if tab.spaceId != state.activeSpaceId { selectSpace(tab.spaceId) }
        openTab(tab)
    }

    /// Opens what was typed: an address, or a search with the engine of the profile (the Mac's rules, `AddressResolver`).
    func open(_ text: String) {
        commandBarShown = false
        guard let request = request(for: text) else { return }
        webView?.load(request)
    }

    /// The request a typed text stands for in the active space: an address, or a search with the engine of its profile.
    func request(for text: String) -> URLRequest? {
        Self.request(for: text, searchTemplate: state.searchTemplate(forSpace: activeSpace.id))
    }

    // MARK: Plumbing

    /// A change of the state that is not about the tab on screen: made, kept.
    private func change(_ edit: (inout BrowserState) -> Void) {
        mutate(edit)
        scheduleSave()
    }

    private func mutate(_ edit: (inout BrowserState) -> Void) {
        var next = state
        edit(&next)
        state = next
    }

    /// A change that makes tabs leave (archived): the views, pictures and page states of the tabs that are gone are let go, and a space that
    /// showed one of them shows another (or a blank one).
    private func release(after edit: (inout BrowserState) -> Void) {
        let before = Set(state.tabs.map(\.id))
        let shown = activeTab?.id
        mutate(edit)
        let gone = before.subtracting(state.tabs.map(\.id))
        guard !gone.isEmpty else { return }
        for id in gone {
            if let view = webViews[id] { free(view, tabId: id) }
            sideStore?.remove(for: id)
            thumbnailCache[id] = nil
        }
        thumbnailRevision += 1
        ensureActiveTab()
        if let shown, gone.contains(shown) { arrive() } else { scheduleSave() }
    }
}
