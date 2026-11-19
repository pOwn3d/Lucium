import LuciumKit
import SwiftUI
import WebKit

/// How a tab shows its page: the desktop version of the site, and the size of the page's text. The choice is per tab (`PageDisplay`): kept in the
/// folder of the tab so that it survives sleep and restart, never in the state file, never for a private tab.
extension BrowserModel {
    /// The display of a tab: what was changed, or the standard one. Read from the folder of the tab the first time, then from memory.
    func display(of tab: TabItem) -> PageDisplay { display(ofTab: tab.id, isPrivate: tab.isPrivate) }

    private func display(ofTab id: String, isPrivate: Bool) -> PageDisplay {
        if let known = pageDisplays[id] { return known }
        guard !isPrivate else { return .standard }
        let read = PageDisplay.read(sideStore?.read(.display, for: id))
        if read.unreadable { print("[display] the kept display of tab \(id) does not read, the standard one is used") }
        if !read.display.isStandard { pageDisplays[id] = read.display }
        return read.display
    }

    /// The display of the tab on screen (the menu of the page reads it).
    var activeDisplay: PageDisplay { activeTab.map(display(of:)) ?? .standard }

    /// Only an iPhone asks for the desktop version: the iPad's `recommended` already is it.
    var offersDesktopVersion: Bool { isPhone }

    /// What WebKit is asked for the next navigation of a tab.
    func contentMode(ofTab id: String) -> WKWebpagePreferences.ContentMode {
        guard isPhone, let tab = state.tabs.first(where: { $0.id == id }) else { return .recommended }
        return display(of: tab).desktop ? .desktop : .recommended
    }

    /// The page can be shown differently when it is a web page: the start page and a local file have nothing to zoom or to ask a site for.
    var canChangeDisplay: Bool { shareURL != nil }

    func setDesktopVersion(_ desktop: Bool) {
        guard let tab = activeTab, isPhone else { return }
        var next = display(of: tab)
        guard next.desktop != desktop else { return }
        next.desktop = desktop
        keep(next, for: tab)
        // The version is chosen when a page is requested: the page is asked for again, with the new preference (see `contentMode`).
        webViews[tab.id]?.reload()
    }

    func zoomPageIn() { changeZoom { $0.zoomIn() } }
    func zoomPageOut() { changeZoom { $0.zoomOut() } }
    func resetPageZoom() { changeZoom { $0.resetZoom() } }

    private func changeZoom(_ change: (inout PageDisplay) -> Void) {
        guard let tab = activeTab else { return }
        var next = display(of: tab)
        let before = next
        change(&next)
        guard next != before else { return }
        keep(next, for: tab)
        webViews[tab.id]?.pageZoom = next.zoomFactor
    }

    /// Remembers a tab's display and writes it to the tab's folder (nothing is written for a private tab, or when it is back to the standard one).
    private func keep(_ next: PageDisplay, for tab: TabItem) {
        if next.isStandard { pageDisplays[tab.id] = nil } else { pageDisplays[tab.id] = next }
        if tab.isPrivate { return }
        guard let sideStore else { return }
        if next.isStandard {
            sideStore.remove(.display, for: tab.id)
            storageProblems[.display] = nil
            return
        }
        do {
            try sideStore.write(try next.encoded(), kind: .display, for: tab.id)
            storageProblems[.display] = nil
        } catch {
            report(.display, "the display of tab \(tab.id) was not kept: \(error)")
        }
    }
}
