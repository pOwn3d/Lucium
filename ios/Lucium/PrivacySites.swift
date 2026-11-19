import LuciumKit
import SwiftUI

/// A list of sites the person edits: a field and a button to add one, the page they are on to add in one tap, and the sites with a way to remove each.
/// The two pages below use it (the sites where nothing is blocked, the sites whose data is erased on close).
struct SiteListEditor: View {
    let sites: [String]
    let emptyText: LocalizedStringKey
    let fieldPrompt: LocalizedStringKey
    let addTitle: LocalizedStringKey
    let removeTitle: LocalizedStringKey
    /// The site of the page on screen, offered as a one-tap addition when it is not in the list yet.
    let currentSite: String?
    /// Tries to add what was typed; answers the sentence that says why not, or nil when it was added.
    let add: (String) -> LocalizedStringKey?
    let remove: (String) -> Void
    /// The text a person typed is a host to show; a site is shown as it is kept.
    @State private var typed = ""
    @State private var problem: LocalizedStringKey?
    @FocusState private var focused: Bool

    var body: some View {
        Section {
            if sites.isEmpty {
                Text(emptyText).foregroundStyle(.secondary)
            }
            ForEach(sites, id: \.self) { site in
                Text(verbatim: site)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .swipeActions {
                        Button(role: .destructive) { remove(site) } label: { Text(removeTitle) }
                    }
                    // Swipe is not the only way: VoiceOver and Switch Control get the same action by name.
                    .accessibilityAction(named: Text(removeTitle)) { remove(site) }
            }
        }
        Section {
            if let currentSite, !sites.contains(currentSite) {
                Button { submit(currentSite) } label: { Text("privacy.exceptions.add-current \(currentSite)").frame(minHeight: 44) }
            }
            TextField(fieldPrompt, text: $typed)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused)
                .onSubmit { submit(typed) }
                .frame(minHeight: 44)
            Button { submit(typed) } label: { Text(addTitle).frame(minHeight: 44) }
                .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
        } footer: {
            if let problem { Text(problem) }
        }
    }

    private func submit(_ text: String) {
        problem = add(text)
        if problem == nil {
            typed = ""
            focused = false
        }
    }
}

/// « Sites sans blocage »: where the blocker does nothing (the Mac's `blockExceptions`). A site covers its subdomains; the lists come off the page's view
/// as the page loads (`BrowserModel.blockerLists`), so a page of the site is not blocked from its first request.
struct BlockExceptionsPage: View {
    @Bindable var model: BrowserModel

    var body: some View {
        Form {
            Section { EmptyView() } footer: { Text("privacy.exceptions.help") }
            SiteListEditor(sites: model.privacySettings.blockExceptions, emptyText: "privacy.exceptions.empty", fieldPrompt: "privacy.exceptions.field",
                           addTitle: "privacy.exceptions.add", removeTitle: "privacy.exceptions.remove", currentSite: currentSite,
                           add: add, remove: remove)
        }
        .navigationTitle("privacy.exceptions.title")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The host of the page on screen, as the list keeps it.
    private var currentSite: String? { model.siteOfActivePage.flatMap(BlockHost.normalize) }

    private func add(_ text: String) -> LocalizedStringKey? {
        switch BlockHost.check(text, in: model.privacySettings.blockExceptions) {
        case .host(let host):
            model.updatePrivacy { $0.blockExceptions.append(host) }
            return nil
        case .invalid: return "privacy.exceptions.invalid"
        case .alreadyListed: return "privacy.exceptions.already"
        case .coveredBy(let parent): return "privacy.exceptions.covered \(parent)"
        case .full: return "privacy.exceptions.full"
        }
    }

    private func remove(_ site: String) {
        model.updatePrivacy { $0.blockExceptions.removeAll { $0 == site } }
    }
}

/// « Effacer à la fermeture » (the Mac's `siteDataClearOnClose`): the data of the sites of the list is erased when their last tab closes, and, if asked,
/// when the application starts again (`BrowserModel+SiteClear.swift`).
struct ClearOnClosePage: View {
    @Bindable var model: BrowserModel

    var body: some View {
        Form {
            Section {
                Toggle("privacy.clear.switch", isOn: binding(\.enabled)).frame(minHeight: 44)
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("privacy.clear.help")
                    Text("privacy.clear.private")
                }
            }
            SiteListEditor(sites: model.privacySettings.clearOnClose.sites, emptyText: "privacy.clear.empty", fieldPrompt: "privacy.clear.field",
                           addTitle: "privacy.clear.add", removeTitle: "privacy.clear.remove", currentSite: currentSite, add: add, remove: remove)
            Section {
                Toggle("privacy.clear.quit", isOn: binding(\.onQuit)).frame(minHeight: 44)
            } footer: {
                Text("privacy.clear.quit-help")
            }
        }
        .navigationTitle("privacy.clear.title")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The host (with its port) of the page on screen, as the list keeps it.
    private var currentSite: String? { model.siteOfActivePage.flatMap(SiteHostEntry.parseTyped) }

    private func binding(_ keyPath: WritableKeyPath<PrivacySettings.ClearOnClose, Bool>) -> Binding<Bool> {
        Binding(get: { model.privacySettings.clearOnClose[keyPath: keyPath] }, set: { value in model.updatePrivacy { $0.clearOnClose[keyPath: keyPath] = value } })
    }

    private func add(_ text: String) -> LocalizedStringKey? {
        guard let host = SiteHostEntry.parseTyped(text) else { return "privacy.clear.invalid" }
        let sites = model.privacySettings.clearOnClose.sites
        if sites.contains(host) { return "privacy.clear.already" }
        if sites.count >= SiteHostEntry.max { return "privacy.clear.full" }
        model.setClearOnClose(site: host, on: true)
        return nil
    }

    private func remove(_ site: String) {
        model.setClearOnClose(site: site, on: false)
    }
}
