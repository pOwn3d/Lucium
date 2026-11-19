import LuciumKit
import SwiftUI

/// A link handed over by another application (the default-browser requirement of Apple, docs/ios.md §9.4). It opens in a new tab of the active space,
/// by the ordinary load of a tab (`wake`: HTTPS first, the blockers and the privacy filters apply as for any page). While the application, or the space
/// on screen, is locked, the link waits in memory: nothing opens, shows or names a site until the owner has unlocked, then the tab opens.
extension BrowserModel {
    /// The entry point of `onOpenURL`: anything that is not a plain http(s) address is dropped without a trace.
    func receive(_ url: URL) {
        guard let address = ExternalLink.address(from: url) else {
            print("[link] a link from another application was refused (not a plain http or https address)")
            return
        }
        pendingExternalAddress = address
        openPendingExternalLink()
    }

    /// Opens the waiting link when nothing covers the screen. Called on arrival and after each change of the lock.
    func openPendingExternalLink() {
        guard let address = pendingExternalAddress, !(lock?.appLocked ?? false), !activeSpaceCovered else { return }
        pendingExternalAddress = nil
        tabsSheetShown = false
        commandBarShown = false
        settingsShown = false
        spacesSheetShown = false
        drawerEvent(.pageShown)
        leaveActiveTab()
        guard state.openTab(id: UUID().uuidString.lowercased(), in: state.activeSpaceId, url: address, now: clock()) != nil else { return }
        arrive()
    }
}
