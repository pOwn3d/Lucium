import LuciumKit
import SwiftUI
import WebKit

/// Spaces, profiles, private tabs and the data of a site: what "Espaces et profils" and the page menus do. The state changes here go through
/// `LuciumKit` (pure, tested on the Mac); what this file adds is what only the application can do: free the web views and the files of a tab,
/// and ask WebKit for the data stores.
extension BrowserModel {
    // MARK: Looking at spaces

    /// The colours a space is drawn with: the first two of its theme (the Mac's), or the system's grey when the Mac never wrote one. The theme is data
    /// of the state, so a colour here is read, never written in the source.
    func colors(of space: Space) -> [Color] {
        let hex = space.themeColors.prefix(2)
        let colors = hex.map { Color(.sRGB, red: Double($0.red) / 255, green: Double($0.green) / 255, blue: Double($0.blue) / 255, opacity: 1) }
        return colors.isEmpty ? [Color(.systemGray3), Color(.systemGray4)] : colors
    }

    /// The name a profile is shown under: the one it was given, else the Mac's "default profile", else its id.
    func label(ofProfile id: String) -> String {
        state.profileNames[id] ?? (id == BrowserState.defaultProfileId ? String(localized: "profile.default") : id)
    }

    func tabCount(in space: Space) -> Int { state.tabs.filter { $0.spaceId == space.id && !$0.isPrivate }.count }

    // MARK: Spaces and profiles

    /// Why a change did not happen (the state is as it was): a rule of the state (`LuciumKit`), or WebKit refusing to erase a profile's data.
    enum SpaceFailure: Error, Equatable {
        case invalid(BrowserState.SpaceError)
        case eraseFailed(String)
    }

    /// Which profile a new space uses: one that exists, or a new one that is made with the space.
    enum ProfileChoice: Equatable {
        case existing(String)
        case new(String)
    }

    @discardableResult
    func addProfile(named name: String) -> Result<String, SpaceFailure> {
        var next = state
        do throws(BrowserState.SpaceError) {
            let id = try next.addProfile(named: name)
            state = next
            scheduleSave()
            return .success(id)
        } catch {
            return .failure(.invalid(error))
        }
    }

    /// Adds a space and shows it. A new profile is made first when `profile` is a name.
    @discardableResult
    func addSpace(name: String, emoji: String, profile: ProfileChoice, hue: Double) -> Result<Space, SpaceFailure> {
        var next = state
        do throws(BrowserState.SpaceError) {
            let profileId: String
            switch profile {
            case .existing(let id): profileId = id
            case .new(let profileName): profileId = try next.addProfile(named: profileName)
            }
            let space = try next.addSpace(id: UUID().uuidString.lowercased(), name: name, emoji: emoji, profileId: profileId, hue: hue)
            state = next
            selectSpace(space.id)  // takes the picture of the tab that leaves the screen
            scheduleSave()
            return .success(space)
        } catch {
            return .failure(.invalid(error))
        }
    }

    func updateSpace(_ id: String, name: String, emoji: String, hue: Double?) -> Result<Void, SpaceFailure> {
        var next = state
        do throws(BrowserState.SpaceError) {
            try next.updateSpace(id, name: name, emoji: emoji, hue: hue)
            state = next
            scheduleSave()
            return .success(())
        } catch {
            return .failure(.invalid(error))
        }
    }

    /// Deletes a space with its tabs: their web views, pictures and page states go too. Its profile stays, with its cookies.
    func deleteSpace(_ id: String) -> Result<Void, SpaceFailure> {
        var next = state
        let removed: [String]
        do throws(BrowserState.SpaceError) {
            removed = try next.deleteSpace(id)
        } catch {
            return .failure(.invalid(error))
        }
        // The tab on screen, when it is one of the space, goes with it: no picture of it (it would be written for a tab that no longer exists).
        let wasShown = id == state.activeSpaceId
        for tabId in removed {
            if let view = webViews[tabId] { free(view, tabId: tabId) }
            sideStore?.remove(for: tabId)
            thumbnailCache[tabId] = nil
        }
        thumbnailRevision += 1
        state = next
        ensureActiveTab()
        if wasShown { arrive() } else { scheduleSave() }
        return .success(())
    }

    /// Removes a profile no space uses, and everything it holds: cookies, storage, caches. The data goes first: when WebKit refuses (the store
    /// is in use), the profile stays in the list and the person is told, so that nothing is left behind unseen.
    func removeProfile(_ id: String) async -> Result<Void, SpaceFailure> {
        var next = state
        do throws(BrowserState.SpaceError) {
            try next.removeProfile(id)
        } catch {
            return .failure(.invalid(error))
        }
        do {
            try await WKWebsiteDataStore.remove(forIdentifier: ProfileStore.identifier(for: id))
        } catch {
            print("[profiles] the data of profile \(id) was not erased: \(error)")
            return .failure(.eraseFailed(error.localizedDescription))
        }
        state = next
        scheduleSave()
        return .success(())
    }

    // MARK: Private tabs

    /// A new private tab in the active space, shown. Its page lives in a data store that exists only in memory.
    func newPrivateTab() {
        tabsSheetShown = false
        spacesSheetShown = false
        leaveActiveTab()
        state.openPrivateTab(id: UUID().uuidString.lowercased(), in: state.activeSpaceId, now: clock())
        arrive()
    }

    /// The data store of the private tabs: one, in memory. It is made with the first private tab and let go with the last private view, and
    /// WebKit forgets what it held (cookies, storage, cache) as it is released.
    func privateDataStore() -> WKWebsiteDataStore {
        if let store = privateStore { return store }
        let store = WKWebsiteDataStore.nonPersistent()
        privateStore = store
        return store
    }

    func releasePrivateStoreIfUnused() {
        guard privateStore != nil else { return }
        let stillShown = webViews.keys.contains { id in state.tabs.first { $0.id == id }?.isPrivate == true }
        if !stillShown { privateStore = nil }
    }

    /// Closes every private tab: the person leaves the private browsing in one gesture.
    func closePrivateTabs() {
        for tab in state.privateTabs { close(tab) }
        releasePrivateStoreIfUnused()
    }

    // MARK: The data of a site

    /// The site of the page on screen, when it has one and the page is not private: the thing "Clear this site's data" can name.
    var siteOfActivePage: String? {
        guard let tab = activeTab, !tab.isPrivate else { return nil }
        return SiteData.host(of: tab.url)
    }

    /// Erases what the profile of the active space holds for a site: cookies, local storage, databases, caches. Answers how many records of WebKit
    /// it erased. The pages of that site that are awake reload, to show themselves signed out rather than as they were.
    func clearSiteData(host: String) async -> Int {
        let profileId = activeSpace.profileId
        let store = WKWebsiteDataStore(forIdentifier: ProfileStore.identifier(for: profileId))
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let matching = await store.dataRecords(ofTypes: types).filter { SiteData.recordMatches($0.displayName, host: host) }
        await store.removeData(ofTypes: types, for: matching)
        for (id, view) in webViews {
            guard let tab = state.tabs.first(where: { $0.id == id }), !tab.isPrivate, state.spaces.first(where: { $0.id == tab.spaceId })?.profileId == profileId,
                  let site = SiteData.host(of: tab.url), SiteData.recordMatches(site, host: host) else { continue }
            view.reload()
        }
        return matching.count
    }
}
