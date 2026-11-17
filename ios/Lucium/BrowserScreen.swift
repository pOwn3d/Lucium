import SwiftUI

/// The screen: the page, and under it the bottom bar of approach C (docs/ios.md, "Navigation").
struct BrowserScreen: View {
    @Bindable var model: BrowserModel

    var body: some View {
        VStack(spacing: 0) {
            WebViewHost(webView: model.webView)
                .id(model.activeSpace.id)
            BottomBar(model: model)
        }
        .task { await model.prepare() }
        .sheet(isPresented: $model.tabsSheetShown) {
            TabsSheet(model: model)
        }
    }
}
