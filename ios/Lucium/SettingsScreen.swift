import LuciumKit
import SwiftUI

/// The settings (decision of the project lead, 18 November 2026): one screen, opened by the gear of the bottom bar and of the iPad's sidebar, that holds
/// what used to be three rows hidden at the bottom of the tabs sheet and the search engine of the profile. The sections and their order are
/// `SettingsLayout` (`LuciumKit`, proved there); each row opens a page on this screen's own navigation stack, so Back always returns to the list.
/// Every page is the screen that existed before (privacy, lock, spaces, licenses), but for the search engine, which is new.
struct SettingsScreen: View {
    @Bindable var model: BrowserModel
    @State private var path: [SettingsRow]

    init(model: BrowserModel) {
        self.model = model
        _path = State(initialValue: model.settingsStart.map { [$0] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(SettingsLayout.groups(lockAvailable: model.lock != nil)) { group in
                    Section {
                        ForEach(group.rows) { row in rowView(row) }
                    } header: {
                        if let title = Self.title(of: group.section) { Text(title) }
                    }
                }
            }
            .navigationTitle("settings.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("tabs.done") { model.settingsShown = false } } }
            .navigationDestination(for: SettingsRow.self) { row in page(row) }
        }
        .onDisappear { model.settingsStart = nil }
    }

    /// The heading of a section. The synchronisation has none yet: its page comes with the phase 2 (docs/ios.md, section 13), and so does its text.
    static func title(of section: SettingsSection) -> LocalizedStringKey? {
        switch section {
        case .navigation: "settings.section.navigation"
        case .privacy: "settings.section.privacy"
        case .spaces: "settings.section.spaces"
        case .sync: nil
        case .about: "settings.section.about"
        }
    }

    // MARK: Rows

    @ViewBuilder private func rowView(_ row: SettingsRow) -> some View {
        switch row {
        case .searchEngine:
            link(row, "settings.search.title") { Text(verbatim: SearchEngine.name(forTemplate: model.searchTemplate)) }
        case .privacy:
            link(row, "settings.privacy") { Text(model.privacyLevelSummary) }
        case .lock:
            link(row, "lock.settings.title") { Text(model.lock?.isActive == true ? "settings.lock.on" : "settings.lock.off") }
        case .spaces:
            link(row, "spaces.title") { EmptyView() }
        case .licenses:
            link(row, "licenses.title") { EmptyView() }
        case .sync:
            EmptyView()  // phase 2: `SettingsLayout` does not list it yet
        }
    }

    /// A row that opens a page: its name, and what it is set to on the right. The value is read by VoiceOver after the name, and wraps under it with the
    /// larger texts (`LabeledContent`).
    private func link<Value: View>(_ row: SettingsRow, _ title: LocalizedStringKey, @ViewBuilder value: () -> Value) -> some View {
        NavigationLink(value: row) {
            LabeledContent { value() } label: { Text(title) }
                .frame(minHeight: 44)
        }
    }

    @ViewBuilder private func page(_ row: SettingsRow) -> some View {
        switch row {
        case .searchEngine: SearchEngineScreen(model: model)
        case .privacy: PrivacyForm(model: model)
        case .lock:
            if let lock = model.lock { LockSettingsForm(lock: lock, spaces: model.spaces) }
        // Choosing a space to browse in leaves the settings, as it leaves the sheet of the spaces.
        case .spaces: SpacesList(model: model) { model.settingsShown = false }
        case .licenses: LicensesScreen()
        case .sync: EmptyView()
        }
    }
}

/// The search engine of the profile of the space on screen, among the engines the Mac offers (`SearchEngine.presets`). It is written in the state as
/// the Mac writes it (`BrowserState.chooseSearchEngine`), so the Mac reads the same choice. A profile other than the default one may also follow the
/// default profile's engine, which is the Mac's "Comme le profil par défaut". An engine of one's own that the Mac wrote is shown as it is.
struct SearchEngineScreen: View {
    @Bindable var model: BrowserModel

    var body: some View {
        let choice = model.searchChoice
        let defaultEngine = SearchEngine.name(forTemplate: model.state.searchTemplate(forProfile: BrowserState.defaultProfileId))
        List {
            Section {
                if model.settingsProfileId != BrowserState.defaultProfileId {
                    row(Text("settings.search.inherited \(defaultEngine)"), selected: choice == .inherited) { model.chooseSearchEngine(.inherited) }
                }
                ForEach(SearchEngine.presets, id: \.url) { preset in
                    row(Text(verbatim: preset.name), selected: choice == .engine(preset.url)) { model.chooseSearchEngine(.engine(preset.url)) }
                }
                if case .engine(let template) = choice, !SearchEngine.isPreset(template) {
                    // Typed on the Mac, where the address can be checked: it stays until another engine is chosen.
                    let customEngine = SearchEngine.name(forTemplate: template)
                    row(Text("settings.search.custom \(customEngine)"), selected: true) {}
                }
            } footer: {
                Text("settings.search.footer \(model.profileTitle)")
            }
        }
        .navigationTitle("settings.search.title")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// A choice: its name, and a check on the one that is in force. VoiceOver reads it as selected.
    private func row(_ title: Text, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                title.foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                if selected { IconView(.check).foregroundStyle(Color.accentColor) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
