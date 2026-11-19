import LuciumKit
import SwiftUI

/// « Effacer à la fermeture » (docs/ios.md, section 7.2): the data of the sites on the person's list is erased when the last tab on a site closes, and when
/// the application starts again (iOS never says that an application quits). The rules are `SiteClearPlanner`'s (`LuciumKit`); this keeps the tabs the rules
/// compare with and runs what they say through the erasure of « Effacer les données du site ».
extension BrowserModel {
    /// Starts or stops watching the tabs, as the list says: it costs nothing while the list is off or empty.
    func refreshClearWatch() {
        let rule = privacySettings.clearOnClose
        clearWatch = rule.enabled && !rule.sites.isEmpty ? (clearWatch ?? state.tabs) : nil
    }

    /// The state changed while a list is watched: a tab that is gone is a tab that closed (or was archived, or swept by the delay; a tab that went to
    /// another site is still there and erases nothing).
    func tabsMayHaveClosed() {
        guard let before = clearWatch else { return }
        let now = state.tabs
        guard now.count != before.count || now.map(\.id) != before.map(\.id) else {
            clearWatch = now
            return
        }
        var previous = state
        previous.tabs = before
        clearWatch = now
        let jobs = SiteClearPlanner.onClose(before: previous, after: state, settings: privacySettings)
        guard !jobs.isEmpty else { return }
        Task { await run(jobs) }
    }

    /// The sites to erase now that the application starts: the whole list, in every profile, when the person asked for it.
    func eraseAtLaunch() async {
        await run(SiteClearPlanner.atLaunch(state: state, settings: privacySettings))
    }

    func run(_ jobs: [SiteClearPlanner.Job]) async {
        for job in jobs {
            for site in job.sites { _ = await eraseSiteData(host: SiteClearPlanner.siteName(of: site), profileId: job.profileId) }
        }
    }

    // MARK: What the settings page changes

    /// Adds a site to the list, or takes it out. The list is the Mac's (`siteDataClearOnClose`), written where the Mac reads it.
    func setClearOnClose(site: String, on: Bool) {
        updatePrivacy { $0.clearOnClose.sites = SiteClearPlanner.setting($0.clearOnClose.sites, site: site, on: on) }
    }
}
