import LuciumKit
import SwiftUI
import UIKit

/// The screen: the page, and under it the bottom bar of approach C (docs/ios.md, "Navigation"). While the application is locked it is a lock screen
/// and nothing else; while the space on screen is locked, the page is.
struct BrowserScreen: View {
    @Bindable var model: BrowserModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var cover = PrivacyCover()
    /// What the iPad's sidebar remembers while the window is turned or narrowed and the bottom bar takes over: whether it is shown, and which folders are open.
    @State private var sidebarShown = true
    @State private var expandedFolders: Set<String> = []

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
            // The tabs and the command bar each take the whole screen, as on the mockups (`C2`, `Commandes`).
            .fullScreenCover(isPresented: $model.tabsSheetShown) {
                TabsSheet(model: model)
            }
            .fullScreenCover(isPresented: $model.commandBarShown) {
                CommandBar(model: model)
            }
            .sheet(isPresented: $model.spacesSheetShown) {
                SpacesSheet(model: model)
            }
            .modifier(SiteDataFlow(model: model))
            .sheet(isPresented: Binding(get: { model.downloads.sheetShown }, set: { model.downloads.sheetShown = $0 })) {
                DownloadsSheet(downloads: model.downloads)
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
            // The room the window has decides: the sidebar of the iPad in landscape, the bar at the bottom everywhere else (`NavigationLayout`).
            GeometryReader { geometry in
                switch NavigationLayout.choose(width: geometry.size.width, height: geometry.size.height,
                                               regularWidth: horizontalSizeClass == .regular, regularHeight: verticalSizeClass == .regular,
                                               largeText: typeSize.isAccessibilitySize) {
                case .sidebar:
                    SidebarLayout(model: model, sidebarShown: $sidebarShown, expandedFolders: $expandedFolders)
                case .bottomBar:
                    VStack(spacing: 0) {
                        PageArea(model: model)
                        BottomBar(model: model)
                    }
                }
            }
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

/// The page of the tab on screen: a lock screen while its space is locked, the start page for a blank tab, its web view, or a plain ground until the
/// blocker is ready.
struct PageArea: View {
    @Bindable var model: BrowserModel

    var body: some View {
        if let lock = model.lock, model.activeSpaceCovered {
            LockScreen(kind: .space(name: model.activeSpace.name), lock: lock, unlock: model.requestUnlock)
        } else if model.activeTab?.isBlank == true {
            // No page is loaded for it, so it does not wait for the blocker.
            StartView(model: model)
        } else if let view = model.webView {
            WebViewHost(webView: view).id(model.activeTab?.id)
        } else {
            Color(.systemBackground)  // until the blocker is ready no page is made, so that none loads unfiltered
        }
    }
}
