import LuciumKit
import SwiftUI

/// The tabs of the active space (mockup C2, reduced to a list): the picture a tab was left with, its title, its site. Opening one shows it
/// (waking it if it slept); swiping closes it.
struct TabsSheet: View {
    @Bindable var model: BrowserModel
    @State private var licensesShown = false
    @State private var lockShown = false

    var body: some View {
        NavigationStack {
            List {
                if model.activeSpaceCovered {
                    // A locked space lists nothing: not a title, not a site.
                    Section {
                        Text("lock.sheet.locked")
                        Button("lock.screen.unlock") { model.requestUnlock() }
                    }
                }
                ForEach(model.activeTabs) { tab in
                    Button { model.openTab(tab) } label: { row(tab) }
                        .swipeActions(edge: .trailing) {
                            Button("tabs.close", role: .destructive) { model.close(tab) }
                        }
                        .accessibilityAddTraits(tab.id == model.activeTab?.id ? .isSelected : [])
                }
            }
            .navigationTitle(model.activeSpace.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("tabs.privacy") { model.privacyPrompts.settingsShown = true } }
                ToolbarItem(placement: .confirmationAction) { Button("tabs.done") { model.tabsSheetShown = false } }
                ToolbarItem(placement: .cancellationAction) { Button("tabs.licenses") { licensesShown = true } }
                ToolbarItem(placement: .bottomBar) { Button("tabs.new") { model.newTab() }.disabled(model.activeSpaceCovered) }
                if model.lock != nil {
                    ToolbarItem(placement: .bottomBar) { Button("tabs.lock") { lockShown = true } }
                }
            }
        }
        .sheet(isPresented: $model.privacyPrompts.settingsShown) { PrivacySheet(model: model) }
        .presentationDetents([.medium, .large])
        .sheet(isPresented: $licensesShown) { LicensesSheet() }
        .sheet(isPresented: $lockShown) {
            if let lock = model.lock { LockSettingsSheet(lock: lock, spaces: model.spaces) }
        }
    }

    private func row(_ tab: TabItem) -> some View {
        HStack(spacing: 12) {
            if let picture = model.thumbnail(of: tab) {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 44, height: 60, alignment: .top)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                title(of: tab).fontWeight(tab.id == model.activeTab?.id ? .semibold : .regular)
                if !tab.isBlank { Text(AddressResolver.host(of: tab.url)).font(.footnote).foregroundStyle(.secondary) }
            }
        }
    }

    /// The title of a page is data, not a text of the interface: it is never looked up in the catalogue.
    @ViewBuilder private func title(of tab: TabItem) -> some View {
        if tab.isBlank {
            Text("tabs.blank")
        } else {
            Text(verbatim: tab.title.isEmpty ? AddressResolver.host(of: tab.url) : tab.title)
        }
    }
}
