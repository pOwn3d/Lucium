import LuciumKit
import SwiftUI

/// The tabs of the active space (mockup `C2 · Onglets de l'espace`): the spaces and the profile on top, a search of the tabs, the favourites as
/// tiles, the pinned tabs and folders, Today (with "Archive all"), and under it the archive. A full screen, closed by "Done".
struct TabsSheet: View {
    @Bindable var model: BrowserModel
    @State private var path: [SheetRoute] = []
    @State private var query = ""
    @State private var namingFolder = false
    @State private var nameText = ""

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                header
                searchField
                content
            }
            .background(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .bottom, spacing: 0) { footer }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: SheetRoute.self) { route in
                switch route {
                case .folder(let id): FolderPage(model: model, folderId: id, path: $path)
                case .archive: ArchiveScreen(model: model)
                }
            }
        }
        .alert("folder.new.title", isPresented: $namingFolder) {
            TextField("folder.name", text: $nameText)
            Button("folder.save") { model.newFolder(named: nameText) }
            Button("tabs.cancel", role: .cancel) {}
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.spaces) { space in spacePill(space) }
                    Button {
                        // The spaces sheet takes this one's place, as it did before this screen was drawn.
                        model.tabsSheetShown = false
                        model.spacesSheetShown = true
                    } label: { IconView(.more).frame(width: 44, height: 44).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("spaces.title"))
                }
            }
            HStack(spacing: 6) {
                IconView(.person, size: 14)
                Text("tabs.profile \(model.profileTitle)")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The colours of the theme are strong (they colour a whole window on the Mac); under text they are laid pale on the ground, as on the mockup.
        .background { SpaceGradient(colors: model.colors(of: model.activeSpace)).ignoresSafeArea(edges: .top) }
    }

    private func spacePill(_ space: Space) -> some View {
        let active = space.id == model.activeSpace.id
        return Button { model.selectSpace(space.id) } label: {
            HStack(spacing: 7) {
                SpacePastille(space: space, colors: model.colors(of: space), size: 28)
                Text(verbatim: space.name).font(.subheadline).fontWeight(active ? .semibold : .regular).lineLimit(1)
            }
            .padding(.leading, 8)
            .padding(.trailing, 12)
            .frame(height: 44)
            .background(active ? Color(.systemBackground).opacity(0.72) : Color.clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("bar.space.of \(space.name)"))
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            IconView(.search, size: 17).foregroundStyle(.secondary)
            TextField("tabs.search", text: $query)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: { IconView(.close, size: 14).frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(Text("tabs.search.clear"))
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .disabled(model.activeSpaceCovered)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    // MARK: Lists

    @ViewBuilder private var content: some View {
        let searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        List {
            if searching {
                searchResults
            } else {
                if model.activeSpaceCovered { lockedNotice } else { library }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    /// A locked space lists nothing: not a title, not a site, not a favourite (the lists of the model are empty; this says why).
    @ViewBuilder private var lockedNotice: some View {
        Section {
            Text("lock.sheet.locked")
            Button("lock.screen.unlock") { model.requestUnlock() }
        }
    }

    @ViewBuilder private var searchResults: some View {
        let hits = model.tabsMatching(query)
        Section {
            if hits.isEmpty {
                Text("tabs.search.none").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(hits) { tab in TabRowView(model: model, tab: tab, showsClose: !tab.pinned) }
        } header: {
            sectionTitle(Text("tabs.search.results \(hits.count)"))
        }
    }

    @ViewBuilder private var library: some View {
        let favorites = model.favorites
        let pinned = model.pinnedRows()
        let today = model.todayTabs
        if !favorites.isEmpty {
            Section {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                    ForEach(favorites) { favorite in FavoriteTile(model: model, favorite: favorite) }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        Section {
            if pinned.isEmpty { Text("tabs.pinned.empty").font(.subheadline).foregroundStyle(.secondary) }
            ForEach(pinned) { row in
                switch row {
                case .tab(let tab): TabRowView(model: model, tab: tab)
                case .folder(let folder, let count): FolderRowView(folder: folder, count: count) { path.append(.folder(folder.id)) }
                }
            }
        } header: {
            HStack {
                sectionTitle(Text("tabs.pinned"))
                Spacer()
                Button { nameText = ""; namingFolder = true } label: { IconView(.folderPlus, size: 20).frame(width: 44, height: 32).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel(Text("folder.new"))
            }
        }
        if !today.isEmpty {
            Section {
                ForEach(today) { tab in TabRowView(model: model, tab: tab, showsClose: true) }
            } header: {
                HStack {
                    sectionTitle(Text("tabs.today \(today.count)"))
                    Spacer()
                    Button("tabs.archive-all") { model.archiveToday() }
                        .font(.footnote.weight(.semibold))
                        .textCase(nil)
                        .frame(minHeight: 32)
                        .disabled(today.allSatisfy { model.isShown($0) })
                }
            }
        }
        if model.archiveCount > 0 {
            Section {
                Button { path.append(.archive) } label: {
                    HStack(spacing: 12) {
                        IconView(.archive, size: 22).foregroundStyle(.secondary)
                        Text("archive.title").font(.subheadline)
                        Spacer(minLength: 8)
                        Text("archive.count \(model.archiveCount)").font(.footnote).foregroundStyle(.secondary)
                        IconView(.chevron, size: 16).foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func sectionTitle(_ text: Text) -> some View {
        text.font(.caption.weight(.semibold)).tracking(0.6).textCase(.uppercase).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 10) {
            Button { model.newTab() } label: {
                HStack(spacing: 6) {
                    IconView(.plus, size: 18)
                    Text("tabs.new").fontWeight(.semibold)
                }
                // The text takes the colour of the ground (white on the accent in the light scheme, black on the lighter accent in the dark one).
                .foregroundStyle(Color(.systemBackground))
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(model.activeSpaceCovered)
            .opacity(model.activeSpaceCovered ? 0.4 : 1)
            Button { model.tabsSheetShown = false } label: {
                Text("tabs.done").fontWeight(.semibold)
                    .padding(.horizontal, 18)
                    .frame(minHeight: 46)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.1), lineWidth: 1) }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}
