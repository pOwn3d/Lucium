import LuciumKit
import SwiftUI
import UIKit

/// The screen: the page, and under it the bottom bar of approach C (docs/ios.md, "Navigation"). While the application is locked it is a lock screen
/// and nothing else; while the space on screen is locked, the page is.
struct BrowserScreen: View {
    @Bindable var model: BrowserModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var cover = PrivacyCover()

    var body: some View {
        content
            // The device lost its passcode, so the lock was turned off: the person is told, once, wherever they are.
            .alert("lock.alert.title", isPresented: switchedOffShown) {
                Button("state.notice.ok") { model.lock?.dismissNotice() }
            } message: {
                Text(LockNotice.switchedOffNoPasscode.text)
            }
            .privacyPrompts(model)
            .task { await model.prepare() }
            .onChange(of: scenePhase, initial: true) { _, phase in model.sceneChanged(to: phase, cover: cover) }
            // iOS ends an application that holds too much: only the tab on screen keeps its view.
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                Task { await model.sleepSurplus(underPressure: true) }
            }
            .sheet(isPresented: $model.tabsSheetShown) {
                TabsSheet(model: model)
            }
            .alert("state.notice.title", isPresented: $model.startupNoticeShown) {
                Button("state.notice.ok") {}
            } message: {
                Text(notice)
            }
    }

    private var switchedOffShown: Binding<Bool> {
        Binding(get: { model.lock?.notice == .switchedOffNoPasscode }, set: { shown in if !shown { model.lock?.dismissNotice() } })
    }

    @ViewBuilder private var content: some View {
        if let lock = model.lock, lock.appLocked {
            LockScreen(kind: .app, lock: lock, unlock: model.requestUnlock)
        } else {
            VStack(spacing: 0) {
                page
                BottomBar(model: model)
            }
        }
    }

    @ViewBuilder private var page: some View {
        if let lock = model.lock, model.activeSpaceCovered {
            LockScreen(kind: .space(name: model.activeSpace.name), lock: lock, unlock: model.requestUnlock)
        } else if let view = model.webView {
            WebViewHost(webView: view).id(model.activeTab?.id)
        } else {
            Color(.systemBackground)  // until the blocker is ready no page is made, so that none loads unfiltered
        }
    }

    /// What the person is told when the saved state could not be read (the file is kept aside, never deleted).
    private var notice: LocalizedStringKey {
        switch model.startup {
        case .setAside(.future, _, _): "state.notice.future"
        case .held: "state.notice.held"
        default: "state.notice.corrupt"
        }
    }
}
