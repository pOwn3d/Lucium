import LuciumKit
import SwiftUI

/// The tabs of the active space (mockup C2, reduced to a list). Opening a tab loads its address in the space's web view.
struct TabsSheet: View {
    @Bindable var model: BrowserModel

    var body: some View {
        NavigationStack {
            List(model.activeTabs) { tab in
                Button { model.openTab(tab) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tab.title)
                        Text(AddressResolver.host(of: tab.url)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(model.activeSpace.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("tabs.done") { model.tabsSheetShown = false } }
                ToolbarItem(placement: .bottomBar) { Button("tabs.new") { model.newTab() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
