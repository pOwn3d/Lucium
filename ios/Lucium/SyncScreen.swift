import LuciumKit
import SwiftUI

/// The page "Synchronization" of the settings (docs/synchronisation.md §13.2): the switch (off), what is sent, the Mac this phone is paired with, and the state in
/// words. Everything here goes through `SyncController`; nothing runs while the switch is off.
struct SyncScreen: View {
    @Bindable var controller: SyncController
    @State private var pairing = false
    @State private var forgetting = false
    @State private var identityFailed = false
    @State private var showingConflicts = false

    var body: some View {
        Form {
            Section {
                Toggle("sync.toggle", isOn: enabled)
                    .frame(minHeight: 44)
            } footer: {
                Text("sync.toggle.footer")
            }
            if controller.settings.enabled {
                macSection
                if controller.settings.mac != nil { intervalSection }
                if let last = controller.lastExchange, controller.settings.mac != nil { lastExchangeSection(last) }
                if !controller.lastConflicts.isEmpty { conflictsSection }
                categoriesSection
            }
            Section {
                SyncTexts.status(controller.status)
                    .accessibilityAddTraits(.updatesFrequently)
            } header: {
                Text("sync.status.header")
            } footer: {
                Text("sync.limits")
            }
        }
        .navigationTitle("sync.title")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $pairing) { SyncPairingSheet(controller: controller) }
        .sheet(isPresented: $showingConflicts) {
            SyncConflictScreen(entries: controller.lastConflicts, onClose: { showingConflicts = false }, onRestore: { change, line in controller.restore(change, lineID: line) })
        }
        .alert("sync.error.identity", isPresented: $identityFailed) { Button("state.notice.ok") {} }
        .confirmationDialog(forgetTitle, isPresented: $forgetting, titleVisibility: .visible) {
            Button("sync.mac.forget", role: .destructive) { controller.forgetMac() }
            Button("tabs.cancel", role: .cancel) {}
        } message: {
            Text("sync.mac.forget.message")
        }
    }

    private var enabled: Binding<Bool> {
        Binding(get: { controller.settings.enabled }, set: { on in if !controller.setEnabled(on) { identityFailed = true } })
    }

    private var forgetTitle: LocalizedStringKey { "sync.mac.forget.title \(controller.settings.mac?.name ?? "")" }

    // MARK: The Mac

    @ViewBuilder private var macSection: some View {
        Section {
            if let mac = controller.settings.mac {
                LabeledContent {
                    EmptyView()
                } label: {
                    Text(verbatim: mac.name)
                }
                .frame(minHeight: 44)
                Button("sync.mac.now") { controller.requestSession(.manual) }
                    .frame(minHeight: 44)
                    .disabled(!controller.status.canStartSession)
                Button("sync.mac.forget", role: .destructive) { forgetting = true }
                    .frame(minHeight: 44)
            } else {
                Button("sync.mac.add") { pairing = true }
                    .frame(minHeight: 44)
            }
        } header: {
            Text("sync.mac.header")
        }
    }

    // MARK: The interval

    /// How often the phone synchronizes by itself while Lucium is on the screen (card 505). The footer says what the system lets it do: nothing in the background.
    @ViewBuilder private var intervalSection: some View {
        Section {
            Picker("sync.interval.picker", selection: Binding(get: { controller.interval }, set: { controller.setInterval($0) })) {
                ForEach(SyncInterval.allCases) { interval in
                    Text(Self.title(of: interval)).tag(interval)
                }
            }
            .frame(minHeight: 44)
        } header: {
            Text("sync.interval.header")
        } footer: {
            Text("sync.interval.footer")
        }
    }

    static func title(of interval: SyncInterval) -> LocalizedStringKey {
        switch interval {
        case .seconds30: "sync.interval.half-minute"
        case .minute1: "sync.interval.minute"
        case .minutes5: "sync.interval.five-minutes"
        case .minutes15: "sync.interval.quarter-hour"
        }
    }

    // MARK: « Dernier échange »

    /// What the last session did, in words: « À jour » alone cannot be told from « nothing crossed » (a category ticked here and not on the Mac crosses nothing). Kept in
    /// memory with the session, so the section is there from the first exchange of this run on.
    private func lastExchangeSection(_ last: SyncExchangeSummary) -> some View {
        let lines = Array(SyncLastExchange.lines(of: last, ticked: controller.settings.categories).enumerated())
        return Section {
            ForEach(lines, id: \.offset) { _, line in
                SyncTexts.lastExchange(line)
                    .frame(minHeight: 44, alignment: .leading)
            }
        } header: {
            Text("sync.last.header")
        }
    }

    // MARK: « Conflit réglé »

    /// The line that opens « Conflit réglé » (§13.4): shown when the last session that had conflicts settled some, never a question that blocks.
    @ViewBuilder private var conflictsSection: some View {
        Section {
            Button { showingConflicts = true } label: {
                HStack {
                    Text("sync.conflicts.last")
                    Spacer()
                    Text("conflict.count \(controller.lastConflicts.count)").foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 44)
        }
    }

    // MARK: What is sent

    @ViewBuilder private var categoriesSection: some View {
        Section {
            ForEach(SyncCategory.allCases) { category in
                // « Onglets d'Aujourd'hui » needs « Espaces et dossiers »: greyed while that one is unticked, and the row says why. The controller drops it with the structure, so
                // what the page shows is what goes.
                let blocked = category.needsStructure && !controller.isOn(.structure)
                Toggle(isOn: Binding(get: { controller.isOn(category) && !blocked }, set: { controller.setCategory(category, on: $0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.title(of: category))
                        Text(blocked ? Self.needs(of: category) : Self.detail(of: category)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .disabled(blocked)
                .frame(minHeight: 44)
            }
        } header: {
            Text("sync.categories.header")
        } footer: {
            Text("sync.categories.footer")
        }
    }

    static func title(of category: SyncCategory) -> LocalizedStringKey {
        switch category {
        case .structure: "sync.category.structure"
        case .settings: "sync.category.settings"
        case .archive: "sync.category.archive"
        case .todayTabs: "sync.category.today-tabs"
        }
    }

    /// What the row says while it is greyed for want of « Espaces et dossiers » (only the categories that `needsStructure` are ever greyed).
    static func needs(of category: SyncCategory) -> LocalizedStringKey {
        category == .archive ? "sync.category.archive.needs" : "sync.category.today-tabs.needs"
    }

    static func detail(of category: SyncCategory) -> LocalizedStringKey {
        switch category {
        case .structure: "sync.category.structure.detail"
        case .settings: "sync.category.settings.detail"
        case .archive: "sync.category.archive.detail"
        case .todayTabs: "sync.category.today-tabs.detail"
        }
    }
}

extension SyncCategory: Identifiable {
    public var id: String { rawValue }
}
