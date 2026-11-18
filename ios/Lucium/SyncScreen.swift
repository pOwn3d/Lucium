import LuciumKit
import SwiftUI

/// The page "Synchronization" of the settings (docs/synchronisation.md §13.2): the switch (off), what is sent, the Mac this phone is paired with, and the state in
/// words. Everything here goes through `SyncController`; nothing runs while the switch is off.
struct SyncScreen: View {
    @Bindable var controller: SyncController
    /// The model that opens a page of « Reprise »; nil in a test of the page alone.
    var resumeModel: BrowserModel?
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
                if !controller.lastConflicts.isEmpty { conflictsSection }
                if let resumeModel, controller.settings.mac != nil { resumeSection(resumeModel) }
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

    // MARK: « Reprise »

    /// The way to « Reprendre un onglet du Mac »: always there once a Mac is paired, and the screen says what is missing when the list is not there.
    private func resumeSection(_ model: BrowserModel) -> some View {
        Section {
            NavigationLink { ResumeScreen(model: model) } label: { Text("resume.title") }
                .frame(minHeight: 44)
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
                Toggle(isOn: Binding(get: { controller.isOn(category) }, set: { controller.setCategory(category, on: $0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.title(of: category))
                        Text(Self.detail(of: category)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
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
        case .openTabs: "sync.category.open-tabs"
        }
    }

    static func detail(of category: SyncCategory) -> LocalizedStringKey {
        switch category {
        case .structure: "sync.category.structure.detail"
        case .settings: "sync.category.settings.detail"
        case .archive: "sync.category.archive.detail"
        case .openTabs: "sync.category.open-tabs.detail"
        }
    }
}

extension SyncCategory: Identifiable {
    public var id: String { rawValue }
}
