import LuciumKit
import SwiftUI

/// The lock (`LuciumKit.LockController` holds what is locked and asks the owner); this is what the browser does about it. A covered space has no
/// tab on screen (`activeTab` is nil, which is also why no view is made for it), and the pages of every covered space are put to sleep: their views are
/// gone, nothing of them plays or loads, and they wake where they were left once the owner has opened them. Their pictures and page states stay in the
/// application's folder like all the others: this is a lock of the interface, not of the disk (docs/ios.md, "Verrou").
extension BrowserModel {
    /// The space on screen is locked, or the whole application is.
    var activeSpaceCovered: Bool { lock?.covers(space: state.activeSpaceId) ?? false }

    /// Starts listening to the lock. Called once, by `launch`.
    func attach(_ lock: LockController) {
        self.lock = lock
        lock.reconcile(spaceIds: Set(state.spaces.map(\.id)))
        lock.onChange = { [weak self] in self?.applyLock() }
    }

    /// What follows every change of what is locked: the pages that are covered go to sleep, the sheets that would show them close, and the bar follows
    /// what is on screen (nothing of a covered page: no address, no title). A tab that is no longer covered wakes.
    func applyLock() {
        guard let lock else { return }
        for tab in state.tabs where lock.covers(space: tab.spaceId) { putToSleep(tab.id) }
        if lock.appLocked {
            sync?.applicationLocked()
            closePresentedScreens()
        } else if activeSpaceCovered {
            closePagePrompts()
        }
        if isReady, let tab = activeTab { syncFrom(wake(tab)) } else { syncFrom(nil) }
        openPendingExternalLink()
    }

    /// Every sheet, cover and prompt of `BrowserScreen`, closed: none may stay over the lock screen (they name sites, tabs and spaces, and the settings hold
    /// the lock's own switches). A new sheet is added here as well: `ios-contract.test.ts` reads the sheets of `BrowserScreen` and fails on one that is not.
    private func closePresentedScreens() {
        tabsSheetShown = false
        spacesSheetShown = false
        settingsShown = false
        commandBarShown = false
        downloads.sheetShown = false
        drawerEvent(.applicationLocked)
        closePagePrompts()
    }

    /// The questions and notices about a page name its site: they do not outlive the lock of the space the page is in. The sheet of the spaces stays
    /// when only a space is locked: it says "locked" and is where the owner opens it.
    private func closePagePrompts() {
        siteDataAsked = nil
        privacyPrompts = PrivacyPrompts()
    }

    /// The button of the lock screen: asks the owner for the application, or for the space on screen.
    func requestUnlock() {
        guard let lock else { return }
        if lock.appLocked {
            Task { await lock.unlockApp() }
        } else if activeSpaceCovered {
            let space = state.activeSpaceId
            Task { await lock.unlock(space: space) }
        }
    }

    /// The model of the running application, with the lock of this phone: its settings are read from their own file next to the state.
    static func launchWithLock() -> BrowserModel {
        let file = LockSettingsFile(url: supportDirectory().appending(path: LockSettingsFile.fileName))
        let model = launch(lock: LockController(authenticator: SystemAuthenticator(), file: file))
        model.attach(SyncController(file: SyncSettingsFile(url: supportDirectory().appending(path: SyncSettingsFile.fileName)), exchangeHost: SyncModelHost(model: model),
                                    isAppLocked: { [weak model] in model?.lock?.appLocked ?? false }))
        return model
    }

    /// Gives the model its synchronisation, and starts the first session the rules allow (off by default: nothing happens until the person turned it on).
    func attach(_ sync: SyncController) {
        self.sync = sync
        sync.launched()
    }

    /// What the lock does as the scene changes. The cover goes up first: the system takes its picture of the application (the app switcher) as the
    /// scene stops being active. Leaving locks at once; coming back asks the owner once if the application is locked.
    func sceneChanged(to phase: ScenePhase, cover: PrivacyCover) {
        // A private page must not show in the app switcher either, lock or no lock: the same window, with the private mark instead of the lock.
        let lockCover = lock?.coversScreen(sceneActive: phase == .active) ?? false
        let privateCover = phase != .active && activeTab?.isPrivate == true
        cover.set(shown: lockCover || privateCover, lock: lockCover)
        switch phase {
        case .background:
            lockOnLeaving()
            sync?.leftScreen()
            Task { await enterBackground() }
        case .active:
            didBecomeActive()
            sync?.becameActive()
            lock?.recheckDevice()
            Task { await lock?.promptIfPending() }
        default: break
        }
    }

    /// Lucium is left: what is set to be locked is locked now, before anything else is done in the background.
    func lockOnLeaving() { lock?.lockAll() }
}
