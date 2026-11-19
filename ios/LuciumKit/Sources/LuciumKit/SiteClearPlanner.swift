import Foundation

/// « Effacer à la fermeture » (docs/ios.md, section 7.2): the data of the sites on a list is erased when the last tab of the site closes, and when the
/// application starts again. The rules are those of the Mac's `sitesToClearOnClose` and `sitesToClearOnQuit` (`src/shared/site-clear.ts`); the erasure
/// itself is the one of « Effacer les données du site » (`SiteData`). Pure: the model asks, then runs what this says.
public enum SiteClearPlanner {
    /// The sites to erase in one profile.
    public struct Job: Equatable, Sendable {
        public var profileId: String
        public var sites: [String]

        public init(profileId: String, sites: [String]) { self.profileId = profileId; self.sites = sites }
    }

    /// The host of a page with its port, as the list spells a site; nil for anything but a page of the web.
    static func listHost(ofPage address: String) -> String? {
        guard let components = URLComponents(string: address), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return nil }
        return SiteHostEntry.parse(components.port.map { "\(host):\($0)" } ?? host)
    }

    /// The name of a site of the list without its port: what WebKit's records are matched with (`SiteData.recordMatches`).
    public static func siteName(of entry: String) -> String {
        if entry.hasPrefix("["), let close = entry.firstIndex(of: "]") { return String(entry[...close]) }
        return String(entry.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    }

    private static func profile(of tab: TabItem, in state: BrowserState) -> String? {
        state.spaces.first { $0.id == tab.spaceId }?.profileId
    }

    /// Whether a tab of `state` in `profileId` is still on the site. WebKit keeps data by site rather than by host (`SiteData.recordMatches`): a tab on
    /// another host of the same site would be signed out by the erasure, so it keeps the data of the site, as a tab on the site itself does.
    private static func siteStillOpen(_ state: BrowserState, profileId: String, entry: String) -> Bool {
        state.tabs.contains { tab in
            guard !tab.isPrivate, profile(of: tab, in: state) == profileId, let host = SiteData.host(of: tab.url) else { return false }
            return SiteData.recordMatches(host, host: siteName(of: entry))
        }
    }

    /// The erasures a change of state calls for: for every tab that is gone (closed, archived, swept by the delay), the listed site it was on, in the
    /// profile it was in, when no other tab of that profile is on the site any more. Only a tab that disappears counts: one that goes to another site keeps
    /// its place and erases nothing (a sign-in goes through other hosts and must not log the person out halfway). A private tab has nothing to erase: its
    /// session lives in memory and goes with it.
    public static func onClose(before: BrowserState, after: BrowserState, settings: PrivacySettings) -> [Job] {
        let rule = settings.clearOnClose
        guard rule.enabled, !rule.sites.isEmpty else { return [] }
        let remaining = Set(after.tabs.map(\.id))
        var byProfile: [String: [String]] = [:]
        for tab in before.tabs where !remaining.contains(tab.id) && !tab.isPrivate {
            guard let host = listHost(ofPage: tab.url), let profileId = profile(of: tab, in: before) else { continue }
            for site in rule.sites where site == host && !siteStillOpen(after, profileId: profileId, entry: site) {
                if byProfile[profileId]?.contains(site) != true { byProfile[profileId, default: []].append(site) }
            }
        }
        return jobs(byProfile, order: before.spaces.map(\.profileId))
    }

    /// The erasures when the application starts: the whole list, in every profile the spaces use, when « à la fermeture de l'application » is on.
    public static func atLaunch(state: BrowserState, settings: PrivacySettings) -> [Job] {
        let rule = settings.clearOnClose
        guard rule.enabled, rule.onQuit, !rule.sites.isEmpty else { return [] }
        var seen = Set<String>(), profiles: [String] = []
        for space in state.spaces where seen.insert(space.profileId).inserted { profiles.append(space.profileId) }
        return profiles.map { Job(profileId: $0, sites: rule.sites) }
    }

    private static func jobs(_ byProfile: [String: [String]], order: [String]) -> [Job] {
        var seen = Set<String>()
        return order.filter { seen.insert($0).inserted }.compactMap { profile in byProfile[profile].map { Job(profileId: profile, sites: $0) } }
    }

    /// The list with a site added or taken out (`setClearedOnClose`): a site that is not a web host changes nothing, nor does adding a site that is on the
    /// list already or taking out one that is not; a full list refuses one more.
    public static func setting(_ sites: [String], site: String, on: Bool) -> [String] {
        guard let host = SiteHostEntry.parseTyped(site) else { return sites }
        if !on { return sites.filter { $0 != host } }
        return sites.contains(host) || sites.count >= SiteHostEntry.max ? sites : sites + [host]
    }
}
