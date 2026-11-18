import Foundation

/// Private tabs. On the Mac a private tab (`TabItem.private`) lives in a throw-away session and "is never written anywhere: not to the state
/// file, the archive, the history, a session, a copy or an export" (`persistableState`, `src/shared/sidebar-state.ts`). The iPhone keeps the same
/// flag in the same place, so that a state that carries one is read the same way, and holds the same promise: `persistable()` is what every write
/// of the state goes through (`StateFile`), and the application keeps no picture and no page state of a private tab either.
extension TabItem {
    public var isPrivate: Bool {
        if case .bool(true)? = rest["private"] { return true }
        return false
    }
}

extension BrowserState {
    /// Opens a private tab in a space and shows it. Same refusals as `openTab`.
    @discardableResult
    public mutating func openPrivateTab(id: String, in spaceId: String, now: Double) -> TabItem? {
        guard openTab(id: id, in: spaceId, now: now) != nil, let index = tabs.firstIndex(where: { $0.id == id }) else { return nil }
        tabs[index].rest["private"] = .bool(true)
        return tabs[index]
    }

    public var privateTabs: [TabItem] { tabs.filter(\.isPrivate) }

    /// The state without its private tabs, and with the pointers that named one put back on the most recently used tab left in the space, or on
    /// none. The same state when there is none (the Mac's `withoutPrivateTabs`).
    public func persistable() -> BrowserState {
        guard tabs.contains(where: \.isPrivate) else { return self }
        var state = self
        let hidden = Set(tabs.filter(\.isPrivate).map(\.id))
        state.tabs.removeAll { hidden.contains($0.id) }
        for (spaceId, shown) in activeTabBySpace {
            guard let shown, hidden.contains(shown) else { continue }
            state.activeTabBySpace[spaceId] = .some(state.tabs(in: spaceId).max { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }?.id)
        }
        return state
    }
}
