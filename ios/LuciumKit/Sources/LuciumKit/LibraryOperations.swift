import Foundation

/// What the lists of a space show (pinned, folders, Today, favourites) and what changes them (pinning, folders, archiving, restoring, favourites).
/// Pure, like `TabOperations.swift`, so that `swift test` proves it on the Mac. Each change mirrors an action of the Mac's reducer
/// (`src/shared/sidebar-*.ts`); the rules that exist on both sides are held by `ios/Contracts/library-vectors.json`, which the Mac's tests and
/// these tests both play.

/// A row of the pinned list: a tab, or a folder with the number of tabs it holds (the folders inside it counted).
public enum PinnedRow: Equatable, Identifiable, Sendable {
    case tab(TabItem)
    case folder(Folder, tabCount: Int)

    public var id: String {
        switch self {
        case .tab(let tab): "tab:" + tab.id
        case .folder(let folder, _): "folder:" + folder.id
        }
    }
}

// MARK: - Reading

extension BrowserState {
    /// The tabs a list shows in a space: the page of a favourite is not a row.
    public func listedTabs(in spaceId: String) -> [TabItem] { tabs.filter { $0.spaceId == spaceId && $0.isListed } }

    /// The Today tabs of a space, in the order of the state (the Mac's order: a new tab goes last).
    public func todayTabs(in spaceId: String) -> [TabItem] { listedTabs(in: spaceId).filter { !$0.pinned } }

    /// The rows of the pinned list at one level: `folderId` nil is the root (the loose pinned tabs, then the folders), a folder id is what is
    /// inside that folder (its own folders, then its tabs).
    public func pinnedRows(in spaceId: String, inside folderId: String? = nil) -> [PinnedRow] {
        let all = folders.filter { $0.spaceId == spaceId }
        let ids = Set(all.map(\.id))
        let pinned = listedTabs(in: spaceId).filter(\.pinned)
        // A folder whose parent is gone, or a tab whose folder is gone, is at the root: nothing is hidden by a broken link.
        let foldersHere = all.filter { folder in
            if let parent = folder.parentId, ids.contains(parent), parent != folder.id { return parent == folderId }
            return folderId == nil
        }
        let tabsHere = pinned.filter { tab in
            if let folder = tab.folderId, ids.contains(folder) { return folder == folderId }
            return folderId == nil
        }
        let counts = tabCounts(of: all, pinned: pinned)
        let folderRows = foldersHere.map { PinnedRow.folder($0, tabCount: counts[$0.id] ?? 0) }
        let tabRows = tabsHere.map(PinnedRow.tab)
        return folderId == nil ? tabRows + folderRows : folderRows + tabRows
    }

    /// How many pinned tabs each folder holds, the folders inside it counted. A loop in a hand-edited tree stops at the first folder seen twice.
    private func tabCounts(of all: [Folder], pinned: [TabItem]) -> [String: Int] {
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var counts: [String: Int] = [:]
        for tab in pinned {
            var seen = Set<String>()
            var current = tab.folderId.flatMap { byId[$0] }
            while let folder = current, seen.insert(folder.id).inserted {
                counts[folder.id, default: 0] += 1
                current = folder.parentId.flatMap { byId[$0] }
            }
        }
        return counts
    }

    /// The levels of folders from the root to this one (1 for a root folder), 0 when it does not exist. A loop stops at the first folder seen twice.
    public func folderDepth(_ id: String) -> Int {
        let byId = Dictionary(folders.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        var current = byId[id]
        while let folder = current, seen.insert(folder.id).inserted { current = folder.parentId.flatMap { byId[$0] } }
        return seen.count
    }

    /// The folders from the root down to this one, for the title of a folder page.
    public func folderPath(_ id: String) -> [Folder] {
        let byId = Dictionary(folders.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var path: [Folder] = []
        var seen = Set<String>()
        var current = byId[id]
        while let folder = current, seen.insert(folder.id).inserted {
            path.insert(folder, at: 0)
            current = folder.parentId.flatMap { byId[$0] }
        }
        return path
    }

    /// The favourites a space lists: those of its profile, in the order of the state (`favoritesOfSpace` of the Mac).
    public func favorites(inSpace spaceId: String) -> [Favorite] {
        guard let space = spaces.first(where: { $0.id == spaceId }) else { return [] }
        return favorites.filter { ($0.profileId ?? Library.defaultProfile) == space.profileId }
    }

    /// The tab that is the page of a favourite in a space, when it is open.
    public func favoriteTab(_ favoriteId: String, in spaceId: String) -> TabItem? {
        tabs.first { $0.favoriteId == favoriteId && $0.spaceId == spaceId }
    }

    /// Hours of idleness after which a Today tab goes to the archive (0 = never): the value of the space's profile, else the general one, else
    /// 12, the Mac's default (`autoArchiveHours`, `profileArchiveHours`). Read from the settings the Mac wrote; the iPhone has no screen for it yet.
    public func autoArchiveHours(forSpace spaceId: String) -> Double {
        func hours(_ value: JSONValue?) -> Double? {
            if case .number(let number)? = value, number.isFinite, number >= 0 { return number }
            return nil
        }
        guard case .object(let settings)? = rest["settings"] else { return Self.defaultAutoArchiveHours }
        if let profile = spaces.first(where: { $0.id == spaceId })?.profileId, case .object(let profiles)? = settings["profiles"],
           case .object(let own)? = profiles[profile], let value = hours(own["autoArchiveHours"]) {
            return value
        }
        return hours(settings["autoArchiveHours"]) ?? Self.defaultAutoArchiveHours
    }

    public static let defaultAutoArchiveHours = 12.0
}

// MARK: - Pinning and folders

extension BrowserState {
    /// Pins a tab (`tab/pin`): it keeps the address it has now as its anchor and goes to the end of the pinned list. A private tab, a blank tab
    /// and a tab that is pinned already are left alone.
    public mutating func pin(tabId: String) {
        guard var tab = tabs.first(where: { $0.id == tabId }), !tab.pinned, !tab.isPrivate, !tab.isBlank else { return }
        tab.anchorUrl = tab.url
        // A pinned tab is not the page of a favourite (the Mac's `pruneFavoriteTabs`).
        tab.favoriteId = nil
        place(tab, pinned: true)
    }

    /// Unpins a tab (`tab/unpin`): it loses its anchor and its folder and becomes the first Today tab, where the person just looked.
    public mutating func unpin(tabId: String) {
        guard var tab = tabs.first(where: { $0.id == tabId }), tab.pinned else { return }
        tab.anchorUrl = nil
        tab.folderId = nil
        place(tab, pinned: false)
    }

    /// Puts a tab in a folder of its space, or at the root of the pinned list when `folderId` is nil or names no folder of that space
    /// (`tab/move` with `pinned: true`). A tab that was in Today is pinned by it.
    public mutating func move(tabId: String, toFolder folderId: String?) {
        guard var tab = tabs.first(where: { $0.id == tabId }), !tab.isPrivate else { return }
        let target = folders.first { $0.id == folderId && $0.spaceId == tab.spaceId }?.id
        tab.anchorUrl = tab.anchorUrl ?? tab.url
        tab.favoriteId = nil
        tab.folderId = target
        var others = tabs.filter { $0.id != tabId }
        tab.pinned = true
        // At the end of the pinned list of its space, as the Mac puts a tab dropped there (`moveTabs` with an index past the end).
        let group = others.filter { $0.spaceId == tab.spaceId && $0.pinned && $0.isListed }
        let at = group.last.flatMap { last in others.firstIndex { $0.id == last.id }.map { $0 + 1 } } ?? others.count
        others.insert(tab, at: at)
        tabs = others
    }

    /// The Mac's `moveToGroup`: pinned tabs go to the end of the pinned ones (before the first tab of the space when there is none), an unpinned
    /// tab becomes the first Today tab.
    private mutating func place(_ moved: TabItem, pinned: Bool) {
        var tab = moved
        tab.pinned = pinned
        var others = tabs.filter { $0.id != moved.id }
        let group = others.filter { $0.spaceId == tab.spaceId && $0.pinned == pinned && $0.isListed }
        let at: Int
        if pinned {
            at = group.last.flatMap { last in others.firstIndex { $0.id == last.id }.map { $0 + 1 } }
                ?? others.firstIndex { $0.spaceId == tab.spaceId } ?? others.count
        } else {
            at = group.first.flatMap { first in others.firstIndex { $0.id == first.id } } ?? others.count
        }
        others.insert(tab, at: at)
        tabs = others
    }

    /// A text typed for a name: trimmed, cut at the Mac's limit, and `fallback` when nothing is left (`typedName`).
    static func typedName(_ text: String, fallback: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : String(trimmed.prefix(Library.nameMax))
    }

    /// Creates a folder (`folder/create`), at the root of a space or inside another folder while a level is left. Answers it, or nil when the
    /// parent does not exist or is at the deepest level. A space that does not exist is the one on screen.
    @discardableResult
    public mutating func createFolder(id: String, name: String, fallbackName: String, in spaceId: String? = nil, parentId: String? = nil) -> Folder? {
        var all = folders
        guard !all.contains(where: { $0.id == id }) else { return nil }
        var space = spaces.contains { $0.id == spaceId } ? spaceId! : activeSpaceId
        if let parentId {
            guard let parent = all.first(where: { $0.id == parentId }), folderDepth(parentId) < Library.folderMaxDepth else { return nil }
            space = parent.spaceId
        }
        let folder = Folder(id: id, spaceId: space, name: Self.typedName(name, fallback: fallbackName), parentId: parentId)
        all.append(folder)
        folders = all
        return folder
    }

    /// Renames a folder (`folder/rename`); a blank name keeps the old one.
    public mutating func renameFolder(id: String, to name: String) {
        let trimmed = Self.typedName(name, fallback: "")
        var all = folders
        guard !trimmed.isEmpty, let index = all.firstIndex(where: { $0.id == id }), all[index].name != trimmed else { return }
        all[index].name = trimmed
        folders = all
    }

    /// Deletes a folder (`folder/delete`): what was inside, tabs and folders, moves up to the parent folder, or to the root of the pinned list.
    public mutating func deleteFolder(id: String) {
        guard let folder = folders.first(where: { $0.id == id }) else { return }
        folders = folders.filter { $0.id != id }.map { child in
            guard child.parentId == id else { return child }
            var moved = child
            moved.parentId = folder.parentId
            return moved
        }
        for index in tabs.indices where tabs[index].folderId == id { tabs[index].folderId = folder.parentId }
    }
}

// MARK: - Archive

extension BrowserState {
    /// Moves tabs to the archive (`archiveTabs`): each leaves its list and becomes the newest entries, the last of the list first, as on the Mac.
    /// A pinned tab keeps its anchor and its folder in its entry. A private tab and a blank tab leave without an entry (nothing to bring back).
    /// A space that showed one of them shows the most recently used tab left in it, or none. Answers the entries made.
    @discardableResult
    public mutating func archive(tabIds: [String], source: ArchivedTab.Source, now: Double) -> [ArchivedTab] {
        let leaving = Set(tabIds)
        let going = tabs.filter { leaving.contains($0.id) }
        guard !going.isEmpty else { return [] }
        let entries = going.filter { !$0.isPrivate && !$0.isBlank }.map { tab in
            ArchivedTab(id: tab.id, spaceId: tab.spaceId, url: tab.url, title: tab.title, archivedAt: now, source: source, pinned: tab.pinned,
                        anchorUrl: tab.pinned ? tab.anchorUrl : nil, folderId: tab.pinned ? tab.folderId : nil)
        }
        tabs.removeAll { leaving.contains($0.id) }
        for (spaceId, shown) in activeTabBySpace {
            guard let id = shown, leaving.contains(id) else { continue }
            activeTabBySpace[spaceId] = .some(tabs(in: spaceId).max { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }?.id)
        }
        // An entry with the id of a tab leaving (a copy restored and archived again) is replaced: the archive keeps an id once.
        let made = Set(entries.map(\.id))
        let older = archive.filter { !made.contains($0.id) }
        archive = Array((entries.reversed() + older).prefix(Library.archiveLimit))
        return entries
    }

    /// "Archive all" (`today/clear`): the Today tabs of a space go to the archive, except the ones on screen.
    @discardableResult
    public mutating func archiveToday(in spaceId: String, keeping shown: Set<String> = [], now: Double) -> [ArchivedTab] {
        let kept = shown.union(activeTabBySpace[spaceId].flatMap { $0 }.map { [$0] } ?? [])
        return archive(tabIds: todayTabs(in: spaceId).map(\.id).filter { !kept.contains($0) }, source: .manual, now: now)
    }

    /// The automatic archive (`archive/sweep`): a Today tab left idle past the delay of its profile goes to the archive. A pinned tab, the page of a
    /// favourite and a tab on screen (the one each space shows, and `shown`) never do. A delay of 0 turns it off for that profile.
    @discardableResult
    public mutating func sweepIdleTabs(now: Double, keeping shown: Set<String> = []) -> [ArchivedTab] {
        let onScreen = shown.union(activeTabBySpace.values.compactMap { $0 })
        var hoursBySpace: [String: Double] = [:]
        let stale = tabs.filter { tab in
            guard tab.isListed, !tab.pinned, !onScreen.contains(tab.id) else { return false }
            let hours = hoursBySpace[tab.spaceId] ?? autoArchiveHours(forSpace: tab.spaceId)
            hoursBySpace[tab.spaceId] = hours
            // A tab without a date is not known to be idle: it is left alone.
            guard hours > 0, let last = tab.lastActiveAt ?? tab.createdAt else { return false }
            return last < now - hours * Library.hourMilliseconds
        }
        return archive(tabIds: stale.map(\.id), source: .auto, now: now)
    }

    /// Brings an archived tab back (`archive/restore`): a new tab in its space (the one on screen when that space is gone), shown, with the title
    /// it had; a tab that was pinned comes back pinned, at its anchor, in its folder while that folder exists. The entry leaves the archive. An
    /// address the application would not load stays in the archive and nothing changes. Answers the new tab.
    @discardableResult
    public mutating func restore(archiveId: String, newTabId: String, now: Double) -> TabItem? {
        let entries = archive
        guard let entry = entries.first(where: { $0.id == archiveId }), Library.isLoadable(entry.url) else { return nil }
        let space = spaces.contains { $0.id == entry.spaceId } ? entry.spaceId : activeSpaceId
        guard openTab(id: newTabId, in: space, url: entry.url, title: entry.title, now: now) != nil else { return nil }
        archive = entries.filter { $0.id != archiveId }
        if entry.pinned {
            pin(tabId: newTabId)
            if let anchor = entry.anchorUrl, let index = tabs.firstIndex(where: { $0.id == newTabId }) { tabs[index].anchorUrl = anchor }
            if let folder = entry.folderId, folders.contains(where: { $0.id == folder && $0.spaceId == space }),
               let index = tabs.firstIndex(where: { $0.id == newTabId }) {
                tabs[index].folderId = folder
            }
        }
        return tabs.first { $0.id == newTabId }
    }

    /// Empties the archive (`archive/clear`).
    public mutating func clearArchive() { archive = [] }
}

// MARK: - Favourites

extension Library {
    /// An address the application loads: http or https, with a host. The Mac's `isLoadableUrl` also loads local files; the iPhone has no such page.
    public static func isLoadable(_ address: String) -> Bool {
        guard let components = URLComponents(string: address), let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty else { return false }
        return true
    }
}

extension BrowserState {
    /// Adds a favourite to the profile of a space (`favorite/add`): refused for an address that is not loadable, a space that does not exist, and an
    /// address that is a favourite of that profile already. The title is the page's, cut at the Mac's limit, else the host.
    @discardableResult
    public mutating func addFavorite(id: String, url: String, title: String, faviconUrl: String? = nil, in spaceId: String) -> Favorite? {
        guard Library.isLoadable(url), let space = spaces.first(where: { $0.id == spaceId }),
              !favorites(inSpace: spaceId).contains(where: { $0.url == url }) else { return nil }
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let favorite = Favorite(id: id, url: url, title: name.isEmpty ? (AddressResolver.host(of: url).isEmpty ? url : AddressResolver.host(of: url)) : String(name.prefix(Library.titleMax)),
                                faviconUrl: faviconUrl, profileId: space.profileId)
        favorites = favorites + [favorite]
        return favorite
    }

    /// Removes a favourite (`favorite/remove`); the tab that was its page becomes an ordinary Today tab.
    public mutating func removeFavorite(id: String) {
        guard favorites.contains(where: { $0.id == id }) else { return }
        favorites = favorites.filter { $0.id != id }
        for index in tabs.indices where tabs[index].favoriteId == id { tabs[index].favoriteId = nil }
    }

    /// Opens a favourite in a space (`favorite/open`): its page when it is open, else a new tab marked as its page. A favourite of another profile is
    /// not opened here (its page would have the cookies of this space's profile). Answers the tab shown.
    @discardableResult
    public mutating func openFavorite(id: String, in spaceId: String, newTabId: String, now: Double) -> String? {
        guard let favorite = favorites.first(where: { $0.id == id }), let space = spaces.first(where: { $0.id == spaceId }),
              (favorite.profileId ?? Library.defaultProfile) == space.profileId else { return nil }
        if let page = favoriteTab(id, in: spaceId) {
            show(tabId: page.id, now: now)
            return page.id
        }
        guard var tab = openTab(id: newTabId, in: spaceId, url: favorite.url, title: favorite.title, now: now) else { return nil }
        tab.favoriteId = favorite.id
        if let index = tabs.firstIndex(where: { $0.id == newTabId }) { tabs[index] = tab }
        return newTabId
    }
}
