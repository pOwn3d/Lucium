import LuciumKit
import SwiftUI

/// The command bar (mockup `Commandes`): a full screen opened by the address pill. What is typed finds the open tabs (of every space, each with
/// its space), the commands, the favourites of the profile, and ends with what Enter does: open the address, or search with the engine of the
/// profile. The sources are the ones the Mac's bar has that the iPhone has too (docs/ios.md, §4.1): not "On the Mac" (synchronisation is phase 2)
/// and not "History" (the iPhone keeps none yet), which the drawing shows.
struct CommandBar: View {
    @Bindable var model: BrowserModel
    @State private var text: String
    @State private var filter: Filter?
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    enum Filter { case commands, tabs }

    /// `text` and `filter` are what the bar opens with: nothing, for the person; something, for the tests that look at a screen.
    init(model: BrowserModel, text: String = "", filter: Filter? = nil) {
        self.model = model
        _text = State(initialValue: text)
        _filter = State(initialValue: filter)
    }

    var body: some View {
        VStack(spacing: 0) {
            // The band of the status bar takes the colour of the space, as on the drawing.
            Color.clear.frame(height: 0).background(LinearGradient(colors: model.colors(of: model.activeSpace).map { $0.opacity(0.35) }, startPoint: .topLeading, endPoint: .bottomTrailing), ignoresSafeAreaEdges: .top)
            field
            chips
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) { results }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Color(.systemBackground))
        .onAppear { focused = true }
    }

    // MARK: Field and filters

    private var field: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                IconView(.search, size: 18).foregroundStyle(.secondary)
                TextField("bar.address.placeholder", text: $text)
                    .font(.body)
                    .focused($focused)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { model.open(text) }
                    .accessibilityLabel(Text("bar.address.placeholder"))
            }
            .padding(.horizontal, 12)
            .frame(height: 48)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2) }
            Button("command.cancel") { model.commandBarShown = false }
                .frame(minHeight: 44)
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.top, 4)
    }

    private var chips: some View {
        HStack(spacing: 8) {
            chip(.commands, icon: .commands, title: "command.filter.commands")
            chip(.tabs, icon: .tabs, title: "command.filter.tabs")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private func chip(_ value: Filter, icon: Icon, title: LocalizedStringKey) -> some View {
        let on = filter == value
        return Button { filter = on ? nil : value } label: {
            HStack(spacing: 6) {
                IconView(icon, size: 15)
                Text(title).font(.footnote)
            }
            .foregroundStyle(on ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(on ? Color.accentColor.opacity(0.14) : Color(.systemBackground), in: Capsule())
            .overlay { Capsule().strokeBorder(on ? Color.accentColor : Color.primary.opacity(0.1), lineWidth: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: Results

    private var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    // Every list goes through the model, which knows what the lock hides: the tabs of a locked space are never offered, nor its favourites.
    private var tabs: [TabItem] { filter == .commands ? [] : model.commandTabs(matching: text) }
    private var favorites: [Favorite] { filter == nil ? model.commandFavorites(matching: text) : [] }
    private var commands: [CommandItem] {
        guard filter != .tabs else { return [] }
        let all = CommandItem.available(in: model)
        if filter == .commands { return query.isEmpty ? all : all.filter { Match.score($0.title, query: query) > 0 } }
        // Among the other answers, a command shows only when what is typed names it (a word start or more).
        return query.isEmpty ? [] : all.filter { Match.score($0.title, query: query) >= 50 }
    }

    @ViewBuilder private var results: some View {
        if !tabs.isEmpty {
            header("command.section.tabs")
            ForEach(tabs) { tab in tabRow(tab) }
        }
        if !commands.isEmpty {
            header("command.section.commands")
            ForEach(commands) { item in commandRow(item) }
        }
        if !favorites.isEmpty {
            header("command.section.favorites")
            ForEach(favorites) { favorite in favoriteRow(favorite) }
        }
        if filter == nil, !query.isEmpty, let resolved = AddressResolver.resolve(query, searchTemplate: model.state.searchTemplate(forSpace: model.activeSpace.id)) {
            switch resolved {
            case .url(let address):
                header("command.section.open")
                row(icon: AnyView(plainTile(.link)), title: Text(verbatim: AddressResolver.host(of: address).isEmpty ? address : AddressResolver.host(of: address)),
                    detail: Text(verbatim: address), selected: false) { model.open(query) }
            case .search:
                header("command.section.search")
                row(icon: AnyView(plainTile(.search)), title: Text(verbatim: "« \(query) »"), detail: Text(verbatim: model.searchEngineName), selected: false) { model.open(query) }
            }
        }
    }

    private func header(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .font(.caption.weight(.semibold))
            .tracking(0.6)
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func tabRow(_ tab: TabItem) -> some View {
        let space = model.spaces.first { $0.id == tab.spaceId }
        let shown = model.isShown(tab) && tab.spaceId == model.activeSpace.id
        return row(icon: AnyView(SiteTile(address: tab.url, size: 28)),
                   title: Text(verbatim: tab.title.isEmpty ? AddressResolver.host(of: tab.url) : tab.title),
                   detail: Text(verbatim: AddressResolver.host(of: tab.url)), selected: shown,
                   trailing: space.map { AnyView(spaceChip($0)) }) { model.show(tab) }
    }

    private func favoriteRow(_ favorite: Favorite) -> some View {
        row(icon: AnyView(SiteTile(address: favorite.url, size: 28)), title: Text(verbatim: favorite.title),
            detail: Text(verbatim: AddressResolver.host(of: favorite.url)), selected: model.isShown(favorite),
            trailing: AnyView(IconView(.chevron, size: 18).foregroundStyle(Color.accentColor))) { model.openFavorite(favorite) }
    }

    private func commandRow(_ item: CommandItem) -> some View {
        row(icon: AnyView(plainTile(item.icon)), title: Text(verbatim: item.title), detail: nil, selected: false) {
            model.commandBarShown = false
            item.run(model)
        }
    }

    private func plainTile(_ icon: Icon) -> some View {
        IconView(icon, size: 16).foregroundStyle(.secondary).frame(width: 28, height: 28)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// The space a tab is in: its pastille (the emoji on the colours of its theme), the name beside.
    private func spaceChip(_ space: Space) -> some View {
        let colors = model.colors(of: space)
        return HStack(spacing: 5) {
            SpacePastille(space: space, colors: colors, size: 18)
            Text(verbatim: space.name).font(.caption.weight(.semibold)).lineLimit(1)
        }
        .padding(.leading, 4)
        .padding(.trailing, 9)
        .frame(minHeight: 26)
        .background(LinearGradient(colors: colors.map { $0.opacity(0.35) }, startPoint: .topLeading, endPoint: .bottomTrailing), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func row(icon: AnyView, title: Text, detail: Text?, selected: Bool, trailing: AnyView? = nil, action: @escaping () -> Void) -> some View {
        // At the largest sizes of text a row gives its words the whole width: the chip of the space goes under them, and a title may take lines.
        let large = typeSize.isAccessibilitySize
        return Button(action: action) {
            HStack(alignment: large ? .top : .center, spacing: 12) {
                icon
                VStack(alignment: .leading, spacing: 2) {
                    title.font(.body).lineLimit(large ? 4 : 1)
                    if let detail { detail.font(.footnote).foregroundStyle(.secondary).lineLimit(large ? 3 : 1) }
                    if large, let trailing { trailing.padding(.top, 4) }
                }
                Spacer(minLength: 8)
                if !large { trailing }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 56)
            .background(selected ? Color.accentColor.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A command of the bar: a title in the language of the interface, an icon, and what it does. Which ones are offered depends on the page on screen.
struct CommandItem: Identifiable {
    let id: String
    let title: String
    let icon: Icon
    let run: @MainActor (BrowserModel) -> Void

    @MainActor static func available(in model: BrowserModel) -> [CommandItem] {
        // A locked space has nothing to do from here, not even a new tab (the sheet of tabs does the same).
        if model.activeSpaceCovered { return [] }
        var items = [CommandItem(id: "new-tab", title: String(localized: "command.new-tab"), icon: .plus) { $0.newTab() }]
        if let tab = model.activeTab, !tab.isBlank {
            items.append(CommandItem(id: "reload", title: String(localized: "command.reload"), icon: .reload) { $0.reloadOrStop() })
            items.append(tab.pinned
                ? CommandItem(id: "unpin", title: String(localized: "command.unpin"), icon: .pin) { $0.unpin(tab) }
                : CommandItem(id: "pin", title: String(localized: "command.pin"), icon: .pin) { $0.pin(tab) })
            if !tab.isPrivate, !model.isFavorite(tab) { items.append(CommandItem(id: "favorite", title: String(localized: "command.add-favorite"), icon: .star) { $0.addFavorite(tab) }) }
            items.append(CommandItem(id: "archive", title: String(localized: "command.archive"), icon: .archive) { $0.archive(tab) })
        }
        if let tab = model.activeTab { items.append(CommandItem(id: "close", title: String(localized: "command.close-tab"), icon: .close) { $0.close(tab) }) }
        if model.todayTabs.contains(where: { !model.isShown($0) }) {
            items.append(CommandItem(id: "archive-all", title: String(localized: "tabs.archive-all"), icon: .archive) { $0.archiveToday() })
        }
        return items
    }
}
