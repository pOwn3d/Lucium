import SwiftUI
import UIKit

/// The screen: the page, and under it the bottom bar of approach C (docs/ios.md, "Navigation").
struct BrowserScreen: View {
    @Bindable var model: BrowserModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            if let view = model.webView {
                WebViewHost(webView: view).id(model.activeTab?.id)
            } else {
                Color(.systemBackground)  // until the blocker is ready no page is made, so that none loads unfiltered
            }
            BottomBar(model: model)
        }
        .privacyPrompts(model)
        .task { await model.prepare() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: Task { await model.enterBackground() }
            case .active: model.didBecomeActive()
            default: break
            }
        }
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

    /// What the person is told when the saved state could not be read (the file is kept aside, never deleted).
    private var notice: LocalizedStringKey {
        switch model.startup {
        case .setAside(.future, _, _): "state.notice.future"
        case .held: "state.notice.held"
        default: "state.notice.corrupt"
        }
    }
}
