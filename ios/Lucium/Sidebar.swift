import LuciumKit
import SwiftUI

/// The iPad held in landscape (mockup `iPad · paysage`): the permanent sidebar on the colours of the space, and the page on a card beside it. It
/// holds what the sheet of tabs holds (favourites, pinned tabs and folders, Today, the archive), laid out for a wide screen, and everything it
/// lists is read through the model, so a space that is locked shows nothing of itself here either (`BrowserModel+Library.swift`).
struct SidebarLayout: View {
    @Bindable var model: BrowserModel
    @Binding var sidebarShown: Bool
    @Binding var expandedFolders: Set<String>

    var body: some View {
        HStack(spacing: 0) {
            if sidebarShown {
                Sidebar(model: model, sidebarShown: $sidebarShown, expandedFolders: $expandedFolders)
                    .frame(width: NavigationLayout.sidebarWidth)
            }
            PageCard(model: model, sidebarShown: $sidebarShown)
                .padding(.leading, sidebarShown ? 0 : 8)
                .padding(.trailing, Gap.s)
                .padding(.top, 6)
                .padding(.bottom, Gap.s)
        }
        .background { SidebarGround(model: model) }
        .ignoresSafeArea(.container, edges: .bottom)
    }
}

/// The ground of the sidebar, the iPad's permanent one and the iPhone's that slides out: the colours of the space on screen. They are strong (they colour a
/// whole window on the Mac); behind the lists they are laid pale on the ground, as on the mockup and on the sheet of tabs, and they follow the space.
struct SidebarGround: View {
    let model: BrowserModel

    var body: some View {
        ZStack {
            Color(.systemBackground)
            SpaceGradient(colors: model.colors(of: model.activeSpace))
        }
        .ignoresSafeArea()
    }
}

/// A button of the chrome (the sidebar's rows of buttons, the toolbar of the page): an icon of the project at 44 pt, the least a finger needs.
struct ChromeButton: View {
    let icon: Icon
    let label: LocalizedStringKey
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) { IconView(icon).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .foregroundStyle(enabled ? Color.primary.opacity(0.74) : Color.secondary.opacity(0.5))
            .disabled(!enabled)
            .accessibilityLabel(Text(label))
    }
}

// MARK: - The page

/// The page on its card, under a toolbar that holds the address (the idle host, centred: a tap opens the command bar, as the pill of the bottom bar does)
/// and, when the sidebar is hidden, the button that brings it back.
struct PageCard: View {
    @Bindable var model: BrowserModel
    @Binding var sidebarShown: Bool

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            SyncClosedBanner(model: model)
            KeepBanner(model: model)
            PageArea(model: model)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: Radius.l, style: .continuous))
        .shadow(color: Color.primary.opacity(0.12), radius: 1.5, y: 1)
    }

    private var toolbar: some View {
        ZStack {
            HStack {
                if !sidebarShown { ChromeButton(icon: .sidebar, label: "sidebar.show") { sidebarShown = true } }
                Spacer(minLength: 0)
                // Share, save as PDF, downloads: the bottom bar's menu, in the place the mockup gives "Partager".
                PageActionsMenu(model: model)
            }
            Button { model.commandBarShown = true } label: {
                AddressLabel(model: model)
                    .font(.subheadline)
                    .lineLimit(1)
                    .frame(maxWidth: 420, minHeight: 44)
                    .padding(.horizontal, 56)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("bar.address.placeholder"))
            .accessibilityValue(Text(verbatim: model.host))
            .contextMenu {
                if let site = model.siteOfActivePage {
                    Button("sitedata.menu \(site)") { model.siteDataAsked = site }
                }
            }
        }
        .padding(.horizontal, 6)
        .frame(height: 50)
        .background(Color(.secondarySystemBackground))
    }
}

// MARK: - The sidebar

/// What a change of a folder from the sidebar asks the person for: a name, or a yes.
private enum FolderEdit: Equatable {
    case new(parent: String?)
    case rename(String)
    case delete(String)
}

struct Sidebar: View {
    @Bindable var model: BrowserModel
    @Binding var sidebarShown: Bool
    @Binding var expandedFolders: Set<String>
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var archiveShown = false
    @State private var folderEdit: FolderEdit?
    @State private var folderName = ""

    var body: some View {
        VStack(spacing: 0) {
            topRow
            favoritesGrid
            spaceHeader
            list
            DownloadStrip(downloads: model.downloads).padding(.horizontal, 10)
            bottomRow
        }
        .sheet(isPresented: $archiveShown) {
            NavigationStack {
                ArchiveScreen(model: model)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("tabs.done") { archiveShown = false } } }
            }
            // Bringing a page back shows it, and the list has nothing more to say.
            .onChange(of: model.activeTab?.id) { archiveShown = false }
        }
        .alert(isRenaming ? "folder.rename.title" : "folder.new.title", isPresented: namingShown) {
            TextField("folder.name", text: $folderName)
            Button("folder.save") { saveFolderName() }
            Button("tabs.cancel", role: .cancel) { folderEdit = nil }
        }
        .confirmationDialog("folder.delete.title", isPresented: deletionShown, titleVisibility: .visible) {
            Button("folder.delete", role: .destructive) {
                if case .delete(let id) = folderEdit {
                    model.deleteFolder(id)
                    expandedFolders.remove(id)
                }
                folderEdit = nil
            }
        } message: {
            Text("folder.delete.message")
        }
    }

    // MARK: Top

    private var topRow: some View {
        HStack(spacing: Gap.hair) {
            ChromeButton(icon: .sidebar, label: "sidebar.hide") { sidebarShown = false }
            Spacer(minLength: 0)
            ChromeButton(icon: .back, label: "bar.back", enabled: model.canGoBack, action: model.goBack)
            ChromeButton(icon: .forward, label: "bar.forward", enabled: model.canGoForward, action: model.goForward)
            ChromeButton(icon: model.isLoading ? .close : .reload, label: model.isLoading ? "bar.stop" : "bar.reload") { model.reloadOrStop() }
        }
        .padding(.horizontal, 10)
        .frame(height: 48)
    }

    /// What the lists show, read through the model so that a locked space has none (`SidebarContent`).
    private var content: SidebarContent { model.sidebarContent(expanded: expandedFolders) }

    @ViewBuilder private var favoritesGrid: some View {
        let favorites = content.favorites
        if !favorites.isEmpty {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Gap.s), count: 4), spacing: Gap.s) {
                ForEach(favorites) { favorite in FavoriteTile(model: model, favorite: favorite, height: 50, fill: Color.primary.opacity(0.07)) }
            }
            .padding(.horizontal, Gap.m)
            .padding(.top, Gap.xs)
            .padding(.bottom, Gap.s)
        }
    }

    /// The space on screen and its profile; a tap lists the spaces (a locked one asks the owner as it is chosen).
    private var spaceHeader: some View {
        Menu {
            ForEach(model.spaces) { space in
                Button { model.selectSpace(space.id) } label: { Text(verbatim: "\(space.emoji) \(space.name)") }
            }
            Divider()
            Button("spaces.title") { model.spacesSheetShown = true }
            Button("spaces.private.new") { model.newPrivateTab() }
        } label: {
            HStack(spacing: 10) {
                SpacePastille(space: model.activeSpace, colors: model.colors(of: model.activeSpace), size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: model.activeSpace.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("sidebar.profile \(model.profileTitle)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                IconView(.chevron, size: 14).rotationEffect(.degrees(90)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, Gap.s)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .accessibilityLabel(Text("bar.space.of \(model.activeSpace.name)"))
        .accessibilityValue(Text("sidebar.profile \(model.profileTitle)"))
    }

    // MARK: The lists

    private var list: some View {
        List {
            if content.isCovered {
                lockedNotice
            } else {
                pinned
                today
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    /// A locked space lists nothing: not a title, not a site (the model's lists are empty; this says why).
    @ViewBuilder private var lockedNotice: some View {
        Text("lock.sheet.locked").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.vertical, 6).sidebarRow()
        Button { model.requestUnlock() } label: { Text("lock.screen.unlock").fontWeight(.semibold).padding(.horizontal, 10).frame(minHeight: 44, alignment: .leading) }
            .buttonStyle(.borderless)
            .sidebarRow()
    }

    @ViewBuilder private var pinned: some View {
        let outline = content.outline
        HStack {
            sectionTitle(Text("tabs.pinned"))
            Spacer()
            Button { folderName = ""; folderEdit = .new(parent: nil) } label: { IconView(.folderPlus, size: 20).frame(width: 44, height: 32).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .accessibilityLabel(Text("folder.new"))
        }
        .sidebarRow()
        if outline.isEmpty { Text("tabs.pinned.empty").font(.subheadline).foregroundStyle(.secondary).sidebarRow() }
        ForEach(outline) { entry in
            switch entry.row {
            case .tab(let tab):
                SidebarTabRow(model: model, tab: tab, depth: entry.depth).sidebarRow()
            case .folder(let folder, let count):
                SidebarFolderRow(folder: folder, count: count, depth: entry.depth, isExpanded: entry.isExpanded) { toggle(folder.id) }
                    .contextMenu { folderMenu(folder) }
                    .sidebarRow()
            }
        }
    }

    @ViewBuilder private var today: some View {
        let today = content.today
        if !today.isEmpty {
            // The largest text leaves no room for the button beside the title (the iPhone's sidebar has it too): it goes under it.
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: Gap.hair)) : AnyLayout(HStackLayout())
            layout {
                sectionTitle(Text("tabs.today \(today.count)"))
                if !typeSize.isAccessibilitySize { Spacer() }
                Button("tabs.archive-all") { model.archiveToday() }
                    .font(.footnote.weight(.semibold))
                    .frame(minHeight: 32)
                    .padding(.leading, typeSize.isAccessibilitySize ? 10 : 0)  // under the title's own inset
                    .disabled(today.allSatisfy { model.isShown($0) })
            }
            .sidebarRow()
        }
        Button { model.newTab() } label: {
            HStack(spacing: 10) {
                IconView(.plus, size: 20)
                Text("tabs.new").font(.subheadline)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .frame(minHeight: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sidebarRow()
        ForEach(today) { tab in SidebarTabRow(model: model, tab: tab, depth: 0, showsClose: true).sidebarRow() }
    }

    private func sectionTitle(_ text: Text) -> some View {
        text.font(.caption.weight(.semibold)).tracking(0.6).textCase(.uppercase).foregroundStyle(.secondary).padding(.leading, 10).accessibilityAddTraits(.isHeader)
    }

    private func toggle(_ folderId: String) {
        if expandedFolders.contains(folderId) { expandedFolders.remove(folderId) } else { expandedFolders.insert(folderId) }
    }

    @ViewBuilder private func folderMenu(_ folder: Folder) -> some View {
        if model.state.folderDepth(folder.id) < Library.folderMaxDepth {
            Button { folderName = ""; folderEdit = .new(parent: folder.id) } label: { Label { Text("folder.new") } icon: { IconView(.folderPlus) } }
        }
        Button { folderName = folder.name; folderEdit = .rename(folder.id) } label: { Label { Text("folder.rename") } icon: { IconView(.rename) } }
        Button(role: .destructive) { folderEdit = .delete(folder.id) } label: { Label { Text("folder.delete") } icon: { IconView(.trash) } }
    }

    // MARK: Folder dialogs

    private var isRenaming: Bool {
        if case .rename = folderEdit { return true }
        return false
    }

    private var namingShown: Binding<Bool> {
        Binding(get: {
            switch folderEdit {
            case .new, .rename: true
            default: false
            }
        }, set: { if !$0, !isDeleting { folderEdit = nil } })
    }

    private var isDeleting: Bool {
        if case .delete = folderEdit { return true }
        return false
    }

    private var deletionShown: Binding<Bool> {
        Binding(get: { isDeleting }, set: { if !$0 { folderEdit = nil } })
    }

    private func saveFolderName() {
        switch folderEdit {
        case .new(let parent):
            model.newFolder(named: folderName, inside: parent)
            if let parent { expandedFolders.insert(parent) }  // a folder made inside one shows at once
        case .rename(let id): model.renameFolder(id, to: folderName)
        default: break
        }
        folderEdit = nil
    }

    // MARK: Bottom

    private var bottomRow: some View {
        HStack(spacing: Gap.hair) {
            ChromeButton(icon: .archive, label: "archive.title") { archiveShown = true }
            ChromeButton(icon: .download, label: "page.downloads") { model.downloads.sheetShown = true }
            // The gear takes the place of the "More" menu, whose three rows (privacy, lock, licenses) are pages of the settings now.
            ChromeButton(icon: .settings, label: "settings.title") { model.openSettings() }
            // Few spaces sit at the right edge; more than the row holds scroll.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Gap.hair) {
                    Spacer(minLength: 0)
                    spaceButtons
                }
                ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: Gap.hair) { spaceButtons } }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 60)
    }

    @ViewBuilder private var spaceButtons: some View {
        ForEach(model.spaces) { space in
            let selected = space.id == model.activeSpace.id
            Button { model.selectSpace(space.id) } label: {
                SpacePastille(space: space, colors: model.colors(of: space), size: 30, selected: selected)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("spaces.title") { model.spacesSheetShown = true }
                Button("spaces.private.new") { model.newPrivateTab() }
            }
            .accessibilityLabel(Text("bar.space.of \(space.name)"))
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }
}

// MARK: - Rows

private extension View {
    /// A row of the sidebar's list: no separator, no ground of its own, a small inset (the mockup's rows are 10 pt from the edge).
    func sidebarRow() -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10)).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

/// A tab of the sidebar: its tile, its title, a close button for a Today tab; the one on screen is on the accent. The same gestures as in the sheet.
struct SidebarTabRow: View {
    @Bindable var model: BrowserModel
    let tab: TabItem
    let depth: Int
    var showsClose = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let shown = model.isShown(tab)
        HStack(spacing: 0) {
            Button { model.openTab(tab) } label: {
                HStack(spacing: 10) {
                    SiteTile(address: tab.url, size: 20)
                    if tab.isPrivate { ProjectIcon(name: .privateMask, size: 16).foregroundStyle(Color.secondary) }
                    TabTitle(tab: tab).font(.subheadline).fontWeight(shown ? .semibold : .regular).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    Spacer(minLength: 4)
                }
                .padding(.leading, 10 + CGFloat(depth) * 18)
                .frame(minHeight: 42)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showsClose {
                Button { model.close(tab) } label: { IconView(.close, size: 14).frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(Text("tabs.close"))
            }
        }
        .padding(.trailing, Gap.xs)
        .background(shown ? Color.accentColor.opacity(0.24) : Color.clear, in: RoundedRectangle(cornerRadius: Radius.m, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(shown ? .isSelected : [])
        .tabActions(tab, model: model)
    }
}

/// A folder of the sidebar: it opens in place (the chevron turns down), where the sheet of the iPhone goes into it.
struct SidebarFolderRow: View {
    let folder: Folder
    let count: Int
    let depth: Int
    let isExpanded: Bool
    let toggle: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 10) {
                IconView(.folder, size: 20)
                if typeSize.isAccessibilitySize {
                    // The largest text leaves a name no room beside its count (the iPhone's sidebar has it too): the count goes under the name.
                    VStack(alignment: .leading, spacing: Gap.hair) {
                        Text(verbatim: folder.name).font(.subheadline).lineLimit(3)
                        Text("folder.tabs \(count)").font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                } else {
                    Text(verbatim: folder.name).font(.subheadline).lineLimit(1)
                    Spacer(minLength: 4)
                    Text("folder.tabs \(count)").font(.footnote).foregroundStyle(.secondary)
                }
                IconView(.chevron, size: 14).rotationEffect(.degrees(isExpanded ? 90 : 0)).foregroundStyle(.secondary)
            }
            .padding(.leading, 10 + CGFloat(depth) * 18)
            .padding(.trailing, Gap.s)
            .frame(minHeight: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(isExpanded ? "sidebar.folder.open" : "sidebar.folder.closed"))
    }
}
