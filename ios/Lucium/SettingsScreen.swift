import LuciumKit
import SwiftUI

/// The settings (decision of the project lead, 18 November 2026): one screen, opened by the gear of the bottom bar and of the iPad's sidebar, that holds
/// what used to be three rows hidden at the bottom of the tabs sheet and the search engine of the profile. The sections and their order are
/// `SettingsLayout` (`LuciumKit`, proved there); each row opens a page on this screen's own navigation stack, so Back always returns to the list.
/// Every page is the screen that existed before (privacy, lock, spaces, licenses), but for the search engine, which is new.
struct SettingsScreen: View {
    @Bindable var model: BrowserModel
    @State private var path: [SettingsRow]
    @State private var confirmingReset = false
    @Environment(\.locale) private var locale

    init(model: BrowserModel) {
        self.model = model
        _path = State(initialValue: model.settingsStart.map { [$0] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(Self.groups(for: model)) { group in
                    Section {
                        ForEach(group.rows) { row in rowView(row) }
                    } header: {
                        if let title = Self.title(of: group.section) { Text(title) }
                    } footer: {
                        footer(of: group.section)
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

    /// What the list holds for this copy: the lock when it has a controller, the synchronisation when it has one (docs/ios.md, sections 3.3 and 13.7).
    static func groups(for model: BrowserModel) -> [SettingsGroup] {
        SettingsLayout.groups(lockAvailable: model.lock != nil, syncAvailable: model.sync != nil)
    }

    /// The heading of a section. The synchronisation has none: its row says what it is.
    static func title(of section: SettingsSection) -> LocalizedStringKey? {
        switch section {
        case .navigation: "settings.section.navigation"
        case .privacy: "settings.section.privacy"
        case .spaces: "settings.section.spaces"
        case .sync: nil
        case .about: "settings.section.about"
        case .reset: nil
        }
    }

    @ViewBuilder private func footer(of section: SettingsSection) -> some View {
        switch section {
        case .reset: Text(model.changedSettingsRows.isEmpty ? "settings.reset.none" : "settings.reset.footer")
        default: EmptyView()
        }
    }

    // MARK: Rows

    @ViewBuilder private func rowView(_ row: SettingsRow) -> some View {
        switch row {
        case .searchEngine:
            link(row, "settings.search.title") { Text(verbatim: SearchEngine.name(forTemplate: model.searchTemplate)) }
        case .privacy:
            link(row, "settings.privacy") { Text(model.privacyLevelSummary) }
        case .passwords:
            link(row, "settings.passwords.title") { Text("settings.passwords.value") }
        case .lock:
            link(row, "lock.settings.title") { Text(model.lock?.isActive == true ? "settings.lock.on" : "settings.lock.off") }
        case .spaces:
            link(row, "spaces.title") { EmptyView() }
        case .licenses:
            link(row, "licenses.title") { EmptyView() }
        case .sync:
            link(row, "sync.title") { Text(model.sync?.settings.enabled == true ? "settings.lock.on" : "settings.lock.off") }
        case .about:
            link(row, "settings.about.title") { EmptyView() }
        case .reset:
            // Destructive and one tap away from the list: it asks first, and says what it leaves alone.
            Button("settings.reset.button", role: .destructive) { confirmingReset = true }
                .frame(minHeight: 44)
                .disabled(model.changedSettingsRows.isEmpty)
                .confirmationDialog("settings.reset.confirm.title", isPresented: $confirmingReset, titleVisibility: .visible) {
                    Button("settings.reset.confirm.action", role: .destructive) { model.resetSettings() }
                    Button("tabs.cancel", role: .cancel) {}
                } message: {
                    Text("settings.reset.confirm.message \(model.profileTitle)")
                }
        }
    }

    /// A row that opens a page: its name, and what it is set to on the right. The value is read by VoiceOver after the name, and wraps under it with the
    /// larger texts (`LabeledContent`).
    private func link<Value: View>(_ row: SettingsRow, _ title: LocalizedStringKey, @ViewBuilder value: () -> Value) -> some View {
        NavigationLink(value: row) {
            LabeledContent {
                HStack(spacing: 8) {
                    value()
                    if model.changedSettingsRows.contains(row) { ChangedMark() }
                }
            } label: { Text(title) }
                .frame(minHeight: 44)
        }
    }

    @ViewBuilder private func page(_ row: SettingsRow) -> some View {
        switch row {
        case .searchEngine: SearchEngineScreen(model: model)
        case .privacy: PrivacyForm(model: model)
        case .passwords: PasswordsScreen()
        case .lock:
            if let lock = model.lock { LockSettingsForm(lock: lock, spaces: model.spaces) }
        // Choosing a space to browse in leaves the settings, as it leaves the sheet of the spaces.
        case .spaces: SpacesList(model: model) { model.settingsShown = false }
        case .licenses: LicensesScreen()
        case .sync:
            if let sync = model.sync { SyncScreen(controller: sync) }
        case .about: AboutScreen(languageCode: locale.language.languageCode?.identifier)
        case .reset: EmptyView()
        }
    }
}

/// The dot that says a row's page is no longer at its original value. A dot alone says nothing to VoiceOver and little to a person who does not see
/// the colour, so it carries the word "Changed" (read after the value) and is a plain shape, not a text that would wrap with the larger sizes.
private struct ChangedMark: View {
    var body: some View {
        Circle()
            .fill(.accentFill)
            .frame(width: 8, height: 8)
            .accessibilityLabel(Text("settings.changed"))
    }
}

/// The version of the application and the two pages of the project's site. The version is read from the bundle, so it is never written twice. The links
/// open in Safari, on the tap and not before: nothing is sent by the application itself.
struct AboutScreen: View {
    let languageCode: String?

    var body: some View {
        List {
            Section {
                LabeledContent("settings.about.version") { Text(verbatim: Self.versionText).textSelection(.enabled) }
                    .frame(minHeight: 44)
                Link("settings.about.site", destination: AboutLinks.site(languageCode: languageCode)).frame(minHeight: 44)
                Link("settings.about.help", destination: AboutLinks.help(languageCode: languageCode)).frame(minHeight: 44)
            } footer: {
                Text("settings.about.footer")
            }
        }
        .navigationTitle("settings.about.title")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// "1.1.2 (34)": the marketing version and the build, as the App Store shows them.
    static var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        guard let build = info?["CFBundleVersion"] as? String else { return version }
        return "\(version) (\(build))"
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
            HStack(spacing: Gap.m) {
                title.foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                if selected { IconView(.check).foregroundStyle(.accentText) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// What Lucium says of passwords and passkeys (docs/ios.md, "AutoFill et passkeys"). It states only what is known: Lucium keeps no password, the system
/// may offer its own, and passkeys are not promised. Nothing here reads or stores a credential.
struct PasswordsScreen: View {
    var body: some View {
        List {
            Section {
                Text("settings.passwords.none")
                Text("settings.passwords.autofill")
                Text("settings.passwords.passkeys")
            }
        }
        .navigationTitle("settings.passwords.title")
        .navigationBarTitleDisplayMode(.inline)
    }
}
