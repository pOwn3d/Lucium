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
            tabsSheetShown = false
            commandBarShown = false
        }
        if isReady, let tab = activeTab { syncFrom(wake(tab)) } else { syncFrom(nil) }
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
        return launch(lock: LockController(authenticator: SystemAuthenticator(), file: file))
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
            Task { await enterBackground() }
        case .active:
            didBecomeActive()
            lock?.recheckDevice()
            Task { await lock?.promptIfPending() }
        default: break
        }
    }

    /// Lucium is left: what is set to be locked is locked now, before anything else is done in the background.
    func lockOnLeaving() { lock?.lockAll() }
}
