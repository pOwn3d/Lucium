import LuciumKit
import SwiftUI

/// "Espaces et profils" (mockup `Espaces et profils`): the spaces grouped by profile, the private tab, a new space and a new profile. A profile keeps
/// cookies and site data; several spaces can share one.
struct SpacesSheet: View {
    @Bindable var model: BrowserModel
    @State private var adding = false
    @State private var editing: String?  // the id of the space being changed
    @State private var askingProfileName = false
    @State private var profileName = ""
    @State private var deletion: Space?
    @State private var profileRemoval: String?
    @State private var failure: BrowserModel.SpaceFailure?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.state.profileIds, id: \.self) { profileId in profileSection(profileId) }
                Section {} footer: { Text("spaces.profile.explain") }
                privateSection
                Section {
                    row(icon: .plus, title: "spaces.new.space", accent: true) { adding = true }
                    row(icon: .person, title: "spaces.new.profile", accent: true) {
                        profileName = ""
                        askingProfileName = true
                    }
                }
            }
            .navigationTitle("spaces.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("spaces.done") { model.spacesSheetShown = false } } }
            .navigationDestination(isPresented: $adding) { SpaceForm(model: model, mode: .add) }
            .navigationDestination(item: $editing) { id in SpaceForm(model: model, mode: .edit(id)) }
        }
        .presentationDetents([.large])
        .alert("spaces.new.profile", isPresented: $askingProfileName) {
            TextField("spaces.profile.placeholder", text: $profileName)
            Button("spaces.create") { if case .failure(let error) = model.addProfile(named: profileName) { failure = error } }
            Button("spaces.cancel", role: .cancel) {}
        } message: {
            Text("spaces.profile.explain")
        }
        .confirmationDialog("spaces.delete.title", isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible, presenting: deletion) { space in
            Button("spaces.delete.confirm \(space.name)", role: .destructive) { if case .failure(let error) = model.deleteSpace(space.id) { failure = error } }
            Button("spaces.cancel", role: .cancel) {}
        } message: { _ in
            Text("spaces.delete.message")
        }
        .confirmationDialog("spaces.profile.remove.title", isPresented: Binding(get: { profileRemoval != nil }, set: { if !$0 { profileRemoval = nil } }), titleVisibility: .visible, presenting: profileRemoval) { id in
            let label = model.label(ofProfile: id)
            Button("spaces.profile.remove.confirm \(label)", role: .destructive) {
                Task { if case .failure(let error) = await model.removeProfile(id) { failure = error } }
            }
            Button("spaces.cancel", role: .cancel) {}
        } message: { _ in
            Text("spaces.profile.remove.message")
        }
        .alert("spaces.error.title", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("spaces.ok") {}
        } message: {
            Text(Self.message(of: failure))
        }
    }

    // MARK: Parts

    @ViewBuilder private func profileSection(_ profileId: String) -> some View {
        let spaces = model.state.spaces(of: profileId)
        let label = model.label(ofProfile: profileId)
        Section {
            ForEach(spaces) { space in spaceRow(space) }
            if spaces.isEmpty {
                Text("spaces.profile.empty").foregroundStyle(Color.secondary)
                Button("spaces.profile.remove", role: .destructive) { profileRemoval = profileId }
            }
        } header: {
            Text("spaces.profile.of \(label)")
        }
    }

    private func spaceRow(_ space: Space) -> some View {
        let selected = space.id == model.activeSpace.id
        return Button {
            model.selectSpace(space.id)
            model.spacesSheetShown = false
        } label: {
            HStack(spacing: 12) {
                SpacePastille(space: space, colors: model.colors(of: space), selected: selected)
                VStack(alignment: .leading, spacing: 2) {
                    // A name is data, never looked up in the catalogue. Colours are given as colours: a style such as `.primary` would take the tint of the button.
                    Text(verbatim: space.name).foregroundStyle(Color.primary).fontWeight(.semibold)
                    Text(Self.count(model.tabCount(in: space))).font(.footnote).foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
                if selected { ProjectIcon(name: .check).foregroundStyle(Color.accentColor) }
            }
            .frame(minHeight: 44)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .swipeActions(edge: .trailing) {
            if model.spaces.count > 1 { Button("spaces.delete", role: .destructive) { deletion = space } }
            Button("spaces.edit") { editing = space.id }.tint(.accentColor)
        }
    }

    private var privateSection: some View {
        Section {
            Button { model.newPrivateTab() } label: {
                HStack(spacing: 12) {
                    ProjectIcon(name: .privateMask, size: 18)
                        .foregroundStyle(Color(.systemBackground))
                        .frame(width: 36, height: 36)
                        .background(Color(.label), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text("spaces.private").foregroundStyle(Color.primary)
                        Text("spaces.private.detail").font(.footnote).foregroundStyle(Color.secondary)
                    }
                }
                .frame(minHeight: 44)
            }
            if !model.state.privateTabs.isEmpty {
                Button("spaces.private.close", role: .destructive) { model.closePrivateTabs() }
            }
        }
    }

    private func row(icon: ProjectIcon.Name, title: LocalizedStringKey, accent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ProjectIcon(name: icon).frame(width: 36, height: 36)
                Text(title)
            }
            .foregroundStyle(accent ? Color.accentColor : Color.primary)
            .frame(minHeight: 44)
        }
    }

    /// "1 tab", "3 tabs": a count is two keys, so that each language says it as it says it.
    static func count(_ number: Int) -> LocalizedStringKey {
        let text = String(number)
        return number == 1 ? "spaces.tabs.one" : "spaces.tabs.other \(text)"
    }

    static func message(of failure: BrowserModel.SpaceFailure?) -> LocalizedStringKey {
        switch failure {
        case .invalid(.emptyName): "spaces.error.name"
        case .invalid(.notOneEmoji): "spaces.error.emoji"
        case .invalid(.profileNameTaken): "spaces.error.profiletaken"
        case .invalid(.lastSpace): "spaces.error.last"
        case .eraseFailed(let why): "spaces.error.erase \(why)"
        case .invalid, nil: "spaces.error.other"
        }
    }
}

/// Making a space, or changing one: its name, its emoji, its colour, and (for a new one) its profile. A space keeps its profile for good: its
/// tabs would have to change data store.
struct SpaceForm: View {
    enum Mode: Hashable {
        case add
        case edit(String)  // the id of the space: the form reads the space as it is now
    }

    @Bindable var model: BrowserModel
    let mode: Mode
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var emoji = "🧩"
    @State private var hue: Double?
    @State private var profileTag = ""
    @State private var newProfileName = ""
    @State private var failure: BrowserModel.SpaceFailure?
    @State private var loaded = false

    private static let newProfileTag = "\u{0}new"
    private static let emojis = ["💼", "🏠", "🧩", "📚", "🎮", "🛒", "✈️", "🎓", "💡", "🎵", "🌿", "❤️", "🔧", "☕️", "🧪", "🎨"]

    var body: some View {
        Form {
            Section("spaces.form.name") {
                TextField("spaces.form.name.placeholder", text: $name)
            }
            Section("spaces.form.emoji") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
                    ForEach(choices, id: \.self) { candidate in
                        Button { emoji = candidate } label: {
                            Text(candidate).font(.title2).frame(maxWidth: .infinity, minHeight: 44)
                                .background(candidate == emoji ? Color.accentColor.opacity(0.2) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(candidate == emoji ? .isSelected : [])
                    }
                }
            }
            Section("spaces.form.color") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 8), spacing: 6) {
                    ForEach(Array(SpaceTheme.huePresets.enumerated()), id: \.offset) { index, candidate in
                        let number = ordinal(index)
                        Button { hue = candidate } label: {
                            Circle().fill(swatch(forHue: candidate)).frame(width: 30, height: 30)
                                .overlay { if hue == candidate { Circle().strokeBorder(Color.accentColor, lineWidth: 2).padding(-3) } }
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("spaces.form.color.option \(number)"))
                        .accessibilityAddTraits(hue == candidate ? .isSelected : [])
                    }
                }
            }
            if case .add = mode {
                Section {
                    Picker("spaces.form.profile", selection: $profileTag) {
                        ForEach(model.state.profileIds, id: \.self) { id in Text(verbatim: model.label(ofProfile: id)).tag(id) }
                        Text("spaces.new.profile").tag(Self.newProfileTag)
                    }
                    if profileTag == Self.newProfileTag { TextField("spaces.profile.placeholder", text: $newProfileName) }
                } footer: {
                    Text("spaces.form.profile.explain")
                }
            }
            if let failure { Section { Text(SpacesSheet.message(of: failure)).foregroundStyle(.red) } }
        }
        .navigationTitle(mode == .add ? LocalizedStringKey("spaces.new.space") : LocalizedStringKey("spaces.edit"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("spaces.save", action: save) } }
        .onAppear(perform: load)
    }

    /// The emojis to pick from, and the one the space wears already when it is not one of them.
    private var choices: [String] { Self.emojis.contains(emoji) ? Self.emojis : [emoji] + Self.emojis }

    /// "1", "2"…: the number of a swatch, said to VoiceOver (a colour has no name here).
    private func ordinal(_ index: Int) -> String { String(index + 1) }

    private func load() {
        guard !loaded else { return }  // the form can appear again (a sheet over it closes): what was typed stays
        loaded = true
        switch mode {
        case .add:
            hue = SpaceTheme.huePresets[0]
            profileTag = model.activeSpace.profileId
        case .edit(let id):
            guard let space = model.state.spaces.first(where: { $0.id == id }) else { return }
            name = space.name
            emoji = space.emoji
            hue = SpaceTheme.hue(of: space).flatMap { current in SpaceTheme.huePresets.first { $0 == current } }
        }
    }

    private func save() {
        switch mode {
        case .add:
            let profile: BrowserModel.ProfileChoice = profileTag == Self.newProfileTag ? .new(newProfileName) : .existing(profileTag)
            finish(model.addSpace(name: name, emoji: emoji, profile: profile, hue: hue ?? SpaceTheme.huePresets[0]).map { _ in () })
        case .edit(let id):
            // A colour that was not touched leaves the theme the Mac made as it is.
            let current = model.state.spaces.first(where: { $0.id == id }).flatMap(SpaceTheme.hue(of:))
            let picked = hue.flatMap { $0 == current ? nil : $0 }
            finish(model.updateSpace(id, name: name, emoji: emoji, hue: picked))
        }
    }

    private func finish(_ result: Result<Void, BrowserModel.SpaceFailure>) {
        switch result {
        case .success: dismiss()
        case .failure(let error): failure = error
        }
    }
}

/// "Clear this site's data": asks first, erases what the profile of the space holds for the site, and says how much it erased.
struct SiteDataFlow: ViewModifier {
    @Bindable var model: BrowserModel
    @State private var erased: Int?

    func body(content: Content) -> some View {
        let profile = model.label(ofProfile: model.activeSpace.profileId)
        return content
            .confirmationDialog("sitedata.title", isPresented: Binding(get: { model.siteDataAsked != nil }, set: { if !$0 { model.siteDataAsked = nil } }),
                                titleVisibility: .visible, presenting: model.siteDataAsked) { host in
                Button("sitedata.erase \(host)", role: .destructive) { Task { erased = await model.clearSiteData(host: host) } }
                Button("spaces.cancel", role: .cancel) {}
            } message: { host in
                Text("sitedata.message \(host) \(profile)")
            }
            .alert("sitedata.done.title", isPresented: Binding(get: { erased != nil }, set: { if !$0 { erased = nil } })) {
                Button("spaces.ok") {}
            } message: {
                Text(erased == 0 ? LocalizedStringKey("sitedata.done.none") : LocalizedStringKey("sitedata.done"))
            }
    }
}
