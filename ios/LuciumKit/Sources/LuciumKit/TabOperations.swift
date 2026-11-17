import Foundation

/// The fields a tab carries for the Mac that the iPhone does not need to type: read and written through `rest`, so that the stored shape
/// stays the Mac's (`createdAt` and `lastActiveAt` are numbers of milliseconds, as `Date.now()` writes them).
extension TabItem {
    public var createdAt: Double? {
        get { number("createdAt") }
        set { setNumber(newValue, for: "createdAt") }
    }

    /// When the tab was last shown. The Mac archives a "Today" tab by this field, so a tab used on the iPhone must keep it current.
    public var lastActiveAt: Double? {
        get { number("lastActiveAt") }
        set { setNumber(newValue, for: "lastActiveAt") }
    }

    /// "Never put this tab to sleep" (`keepAwake` on the Mac).
    public var keepAwake: Bool {
        if case .bool(let value)? = rest["keepAwake"] { return value }
        return false
    }

    /// A tab that shows the start page: it has no address of its own yet.
    public var isBlank: Bool { url == BrowserState.blankURL }

    private func number(_ key: String) -> Double? {
        if case .number(let value)? = rest[key] { return value }
        return nil
    }

    private mutating func setNumber(_ value: Double?, for key: String) {
        rest[key] = value.map(JSONValue.number)
    }
}

/// What a tab does in the state: opening, showing, closing, following its page. Pure, so that `swift test` proves it on the Mac. On the Mac
/// the same changes go through the reducer (`src/shared/sidebar.ts`); the iPhone keeps to the same shape and the same pointers
/// (`activeSpaceId`, `activeTabBySpace`), which `consistent()` checks.
extension BrowserState {
    /// What a new tab holds before it has a page (the Mac's blank tab).
    public static let blankURL = "about:blank"

    public func tabs(in spaceId: String) -> [TabItem] { tabs.filter { $0.spaceId == spaceId } }

    /// The tab a space shows, when it shows one.
    public func activeTab(in spaceId: String) -> TabItem? {
        guard let id = shownTabId(in: spaceId) else { return nil }
        return tabs.first { $0.id == id && $0.spaceId == spaceId }
    }

    /// Opens a tab in a space and shows it. `now` is in milliseconds. Throws nothing: a space that does not exist is a programming error, so the
    /// tab is simply not added and `nil` comes back.
    @discardableResult
    public mutating func openTab(id: String, in spaceId: String, url: String = BrowserState.blankURL, title: String = "", now: Double) -> TabItem? {
        guard spaces.contains(where: { $0.id == spaceId }), !tabs.contains(where: { $0.id == id }) else { return nil }
        var tab = TabItem(id: id, spaceId: spaceId, url: url, title: title)
        tab.createdAt = now
        tab.lastActiveAt = now
        tabs.append(tab)
        activeTabBySpace[spaceId] = .some(id)
        return tab
    }

    /// Shows a tab (it becomes the one of its space) and notes when. The space is not changed: `selectSpace` does that.
    public mutating func show(tabId: String, now: Double) {
        guard let index = tabs.firstIndex(where: { $0.id == tabId }) else { return }
        tabs[index].lastActiveAt = now
        activeTabBySpace[tabs[index].spaceId] = .some(tabId)
    }

    /// Makes a space the one on screen. An unknown space is refused (nothing changes).
    public mutating func selectSpace(_ spaceId: String) {
        guard spaces.contains(where: { $0.id == spaceId }) else { return }
        activeSpaceId = spaceId
    }

    /// Closes a tab. When it was the one its space showed, the space shows the most recently used tab left in it (the Mac's rule for a closed
    /// blank tab, `replacementAfterBlankClose`), or none. Answers the tab the space shows now.
    @discardableResult
    public mutating func close(tabId: String) -> String? {
        guard let closed = tabs.first(where: { $0.id == tabId }) else { return nil }
        tabs.removeAll { $0.id == tabId }
        let spaceId = closed.spaceId
        guard shownTabId(in: spaceId) == tabId else { return shownTabId(in: spaceId) }
        let next = tabs(in: spaceId).max { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }?.id
        activeTabBySpace[spaceId] = .some(next)
        return next
    }

    /// The id a space points at: `activeTabBySpace` holds `null` for "no tab", which Swift reads as a double optional.
    private func shownTabId(in spaceId: String) -> String? { activeTabBySpace[spaceId] ?? nil }

    /// The page a tab shows changed (its address, its title). A blank page leaves what the tab had: the start page is not a page to remember.
    public mutating func record(tabId: String, url: String?, title: String?) {
        guard let index = tabs.firstIndex(where: { $0.id == tabId }) else { return }
        if let url, !url.isEmpty, !url.hasPrefix("about:") { tabs[index].url = url }
        if let title, !title.isEmpty { tabs[index].title = title }
    }

    /// The pointers of a state read from a file, put right when they point at nothing: the active space is one that exists, and a space shows
    /// one of its own tabs or none. Nothing is removed: a tab of a space this build does not show is kept, and written back as it was.
    /// The state is refused (`nil`) when it has no space at all, which is not a state this build can show.
    public func consistent() -> BrowserState? {
        guard let first = spaces.first else { return nil }
        var state = self
        if !spaces.contains(where: { $0.id == activeSpaceId }) { state.activeSpaceId = first.id }
        for space in spaces {
            if let id = shownTabId(in: space.id), !tabs.contains(where: { $0.id == id && $0.spaceId == space.id }) {
                state.activeTabBySpace[space.id] = .some(nil)
            }
        }
        return state
    }
}
