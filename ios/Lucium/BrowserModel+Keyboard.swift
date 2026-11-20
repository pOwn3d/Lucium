import LuciumKit
import SwiftUI

/// What a hardware keyboard does (docs/ios.md §3.5). One place for the action and for whether it applies, so that the menu greys what cannot be done
/// and a test can play every shortcut without a keyboard.
extension BrowserModel {
    /// Whether `command` can be done now. A locked space has no tab (`activeTab` is nil), so what needs a tab is off there: the shortcuts do not walk around the lock.
    func canPerform(_ command: ShortcutCommand) -> Bool {
        switch command {
        case .newTab, .openLocation, .tabSearch, .nextSpace, .previousSpace, .settings, .toggleSidebar: true
        case .closeTab, .pin: activeTab != nil
        case .restoreClosed: lastClosed != nil
        case .nextTab, .previousTab: activeTabs.count > 1
        case .back: canGoBack
        case .forward: canGoForward
        case .reload: activeTab != nil
        case .find: canFindInPage
        case .zoomIn: canChangeDisplay && activeDisplay.canZoomIn
        case .zoomOut: canChangeDisplay && activeDisplay.canZoomOut
        case .zoomReset: canChangeDisplay && activeDisplay.isZoomed
        }
    }

    func perform(_ command: ShortcutCommand) {
        guard canPerform(command) else { return }
        switch command {
        case .newTab: newTab()
        case .closeTab: if let tab = activeTab { archive(tab) }
        case .restoreClosed: if let entry = lastClosed { restore(entry) }
        case .openLocation: commandBarShown = true
        case .tabSearch: tabsSheetShown = true
        case .nextTab: stepTab(1)
        case .previousTab: stepTab(-1)
        case .nextSpace: stepSpace(1)
        case .previousSpace: stepSpace(-1)
        case .back: goBack()
        case .forward: goForward()
        case .reload: reloadOrStop()
        case .find: findInPage()
        case .zoomIn: zoomPageIn()
        case .zoomOut: zoomPageOut()
        case .zoomReset: resetPageZoom()
        case .toggleSidebar: if isPhone { toggleDrawer() } else { padSidebarShown.toggle() }
        case .pin: if let tab = activeTab { if tab.pinned { unpin(tab) } else { pin(tab) } }
        case .settings: openSettings()
        }
    }

    /// The tab closed last in the spaces that are not locked, as the Mac's "Reopen the last closed tab".
    var lastClosed: ArchivedTab? { visibleArchive.max { $0.archivedAt < $1.archivedAt } }

    private func stepTab(_ step: Int) {
        guard let id = ShortcutCycle.neighbour(of: activeTab?.id, in: activeTabs.map(\.id), step: step),
              let tab = activeTabs.first(where: { $0.id == id }) else { return }
        openTab(tab)
    }

    private func stepSpace(_ step: Int) {
        guard let id = ShortcutCycle.neighbour(of: state.activeSpaceId, in: spaces.map(\.id), step: step) else { return }
        selectSpace(id)
    }
}
