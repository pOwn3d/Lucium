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

    /// The name of an appearance, as the page and the row's value say it.
    static func name(of appearance: InterfaceAppearance) -> LocalizedStringKey {
        switch appearance {
        case .auto: "settings.appearance.system"
        case .light: "settings.appearance.light"
        case .dark: "settings.appearance.dark"
        }
    }

    // MARK: Rows

    @ViewBuilder private func rowView(_ row: SettingsRow) -> some View {
        switch row {
        case .searchEngine:
            link(row, "settings.search.title") { Text(verbatim: SearchEngine.name(forTemplate: model.searchTemplate)) }
        case .tabs:
            link(row, "settings.tabs.title") { TabsSettingsScreen.archiveName(hours: model.archiveHours) }
        case .appearance:
            link(row, "settings.appearance.title") { Text(Self.name(of: model.interfaceAppearance)) }
        case .history:
            link(row, "settings.history.title") { Text(model.recordsHistory ? "settings.lock.on" : "settings.lock.off") }
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
        case .tabs: TabsSettingsScreen(model: model)
        case .appearance: AppearanceScreen(model: model)
        case .history: HistorySettingsScreen(model: model)
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

/// The tab settings: how long an idle Today tab waits before it is archived (per profile, the Mac's `autoArchiveHours`) and how many tabs keep a live
/// page (the Mac's `sleepAwakeMax`, a setting of this device). Both are written where the Mac reads them (`BrowserState.chooseArchiveDelay`,
/// `chooseAwakeTabLimit`, proved in `LuciumKit`).
struct TabsSettingsScreen: View {
    @Bindable var model: BrowserModel

    /// The name of a delay: the four the screen offers by their own words, any other number the Mac wrote by its hours.
    static func archiveName(hours: Double) -> Text {
        // A number the Mac wrote that the screen does not offer; kept in a constant so that the key reads as a count.
        let count = Int(hours.rounded())
        switch hours {
        case 0: return Text("settings.tabs.archive.never")
        case 12: return Text("settings.tabs.archive.twelve-hours")
        case 24: return Text("settings.tabs.archive.one-day")
        case 168: return Text("settings.tabs.archive.seven-days")
        default: return Text("settings.tabs.archive.hours \(count)")
        }
    }

    var body: some View {
        let choice = model.archiveChoice
        let defaultDelay = Self.archiveName(hours: model.state.autoArchiveHours(forSpace: model.state.spaces.first { $0.profileId == BrowserState.defaultProfileId }?.id ?? ""))
        List {
            Section {
                if model.settingsProfileId != BrowserState.defaultProfileId {
                    SettingsChoiceRow(title: Text("settings.tabs.archive.inherited"), detail: defaultDelay, selected: choice == .inherited) { model.chooseArchiveDelay(.inherited) }
                }
                ForEach(BrowserState.archiveDelayPresets, id: \.self) { hours in
                    SettingsChoiceRow(title: Self.archiveName(hours: hours), selected: choice == .hours(hours)) { model.chooseArchiveDelay(.hours(hours)) }
                }
                if case .hours(let hours) = choice, !BrowserState.archiveDelayPresets.contains(hours) {
                    // Typed on the Mac: it stays until another delay is chosen.
                    SettingsChoiceRow(title: Self.archiveName(hours: hours), selected: true) {}
                }
            } header: {
                Text("settings.tabs.archive.header")
            } footer: {
                Text("settings.tabs.archive.footer \(model.profileTitle)")
            }
            Section {
                ForEach(BrowserState.awakeLimitPresets, id: \.self) { limit in
                    SettingsChoiceRow(title: Self.awakeName(limit), selected: model.awakeLimit == limit) { model.chooseAwakeTabLimit(limit) }
                }
                if !BrowserState.awakeLimitPresets.contains(model.awakeLimit) {
                    SettingsChoiceRow(title: Self.awakeName(model.awakeLimit), selected: true) {}
                }
            } header: {
                Text("settings.tabs.awake.header")
            } footer: {
                Text("settings.tabs.awake.footer")
            }
        }
        .navigationTitle("settings.tabs.title")
        .navigationBarTitleDisplayMode(.inline)
    }

    private static func awakeName(_ limit: Int) -> Text {
        limit == 0 ? Text("settings.tabs.awake.unlimited") : Text("settings.tabs.awake.count \(limit)")
    }
}

/// The history of this phone: kept or not, for how long, and cleared in one gesture. The history is the iPhone's own: it is not in the state file the
/// synchronisation carries, and a private tab never writes to it (the footers say both).
struct HistorySettingsScreen: View {
    @Bindable var model: BrowserModel
    @State private var confirmingClear = false

    static func retentionName(days: Int) -> Text {
        switch days {
        case 1: Text("settings.history.keep.one-day")
        case 7: Text("settings.history.keep.seven-days")
        case 30: Text("settings.history.keep.thirty-days")
        case 90: Text("settings.history.keep.ninety-days")
        default: Text("settings.history.keep.days \(days)")
        }
    }

    var body: some View {
        let count = model.historyCount
        List {
            Section {
                Toggle("settings.history.record", isOn: Binding(get: { model.recordsHistory }, set: { model.chooseRecordsHistory($0) }))
                    .frame(minHeight: 44)
            } footer: {
                Text("settings.history.record.footer \(model.profileTitle)")
            }
            Section {
                ForEach(HistoryBook.retentionPresets, id: \.self) { days in
                    SettingsChoiceRow(title: Self.retentionName(days: days), selected: model.history.retentionDays == days) { model.chooseHistoryRetention(days: days) }
                }
            } header: {
                Text("settings.history.keep.header")
            } footer: {
                Text("settings.history.keep.footer")
            }
            Section {
                Button("settings.history.clear", role: .destructive) { confirmingClear = true }
                    .frame(minHeight: 44)
                    .disabled(count == 0)
                    .confirmationDialog("settings.history.clear.title \(model.profileTitle)", isPresented: $confirmingClear, titleVisibility: .visible) {
                        Button("settings.history.clear.action", role: .destructive) { model.clearHistory() }
                        Button("tabs.cancel", role: .cancel) {}
                    } message: {
                        Text("settings.history.clear.message")
                    }
            } footer: {
                Text("settings.history.count \(count)")
            }
        }
        .navigationTitle("settings.history.title")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A choice of a list: its name, and a check on the one that is in force. VoiceOver reads it as selected; the row is at least 44 pt high.
struct SettingsChoiceRow: View {
    let title: Text
    /// What the choice stands for, when its name does not say it (the delay the default profile has): read by VoiceOver after the name.
    var detail: Text?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Gap.m) {
                title.foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                if let detail { detail.foregroundStyle(Color.secondary) }
                if selected { IconView(.check).foregroundStyle(.accentText) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
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

/// System, light or dark for the whole application. It is written where the Mac keeps it (`settings.interfaceAppearance`) and stays on this device: the
/// synchronisation does not carry it. With "System", the space on screen may still ask for its own appearance (the `appearance` of its theme).
struct AppearanceScreen: View {
    @Bindable var model: BrowserModel

    var body: some View {
        List {
            Section {
                ForEach(InterfaceAppearance.allCases) { appearance in
                    let selected = model.interfaceAppearance == appearance
                    Button { model.chooseInterfaceAppearance(appearance) } label: {
                        HStack(spacing: Gap.m) {
                            Text(SettingsScreen.name(of: appearance)).foregroundStyle(Color.primary)
                            Spacer(minLength: 8)
                            if selected { IconView(.check).foregroundStyle(.accentText) }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            } footer: {
                Text("settings.appearance.footer")
            }
        }
        .navigationTitle("settings.appearance.title")
        .navigationBarTitleDisplayMode(.inline)
    }
}
