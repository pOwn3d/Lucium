import LuciumKit
import SwiftUI

/// Where a push in the sheet of tabs goes: a folder of the pinned list, or the archive.
enum SheetRoute: Hashable {
    case folder(String)
    case archive
}

/// A tab as a row of the sheet (mockup `C2`): its tile, its title, its site (and "on screen" for the one that is), a check for the one on screen,
/// a button to close a Today tab. A swipe pins or archives it, a long press opens the other things one can do (favourites, folders, closing).
struct TabRowView: View {
    @Bindable var model: BrowserModel
    let tab: TabItem
    var showsClose = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let shown = model.isShown(tab)
        HStack(spacing: 12) {
            Button { model.openTab(tab) } label: {
                HStack(spacing: 12) {
                    SiteTile(address: tab.url, size: 22)
                    if tab.isPrivate { ProjectIcon(name: .privateMask, size: 18).foregroundStyle(Color.secondary) }
                    VStack(alignment: .leading, spacing: 1) {
                        // The largest sizes of text give a title room to be read: three lines instead of one.
                        TabTitle(tab: tab).font(.subheadline).fontWeight(shown ? .semibold : .regular).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                        detail(shown: shown).font(.caption).foregroundStyle(.secondary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    }
                    Spacer(minLength: 8)
                    if shown && tab.pinned { IconView(.check, size: 18).foregroundStyle(Color.accentColor) }
                }
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showsClose {
                Button { model.close(tab) } label: { IconView(.close, size: 15).frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(Text("tabs.close"))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(shown ? .isSelected : [])
        .tabActions(tab, model: model)
    }

    @ViewBuilder private func detail(shown: Bool) -> some View {
        let host = AddressResolver.host(of: tab.url)
        if tab.isBlank {
            if shown { Text("tabs.on-screen") }
        } else if shown {
            Text("tabs.site-on-screen \(host)")
        } else {
            Text(verbatim: host)
        }
    }
}

/// The title of a tab as a line shows it: a text of the interface for a blank tab; otherwise the title of its page, which is data and never looked up
/// in the catalogue, or its host when the page has no title.
struct TabTitle: View {
    let tab: TabItem

    var body: some View {
        if tab.isBlank {
            Text("tabs.blank")
        } else {
            Text(verbatim: tab.title.isEmpty ? AddressResolver.host(of: tab.url) : tab.title)
        }
    }
}

extension View {
    /// What the person can do with a tab of a list: a swipe pins or archives it, a long press opens the other things (favourites, folders,
    /// closing). The sheet of tabs and the sidebar of the iPad draw their lines differently and give them the same gestures.
    func tabActions(_ tab: TabItem, model: BrowserModel) -> some View { modifier(TabActions(model: model, tab: tab)) }
}

private struct TabActions: ViewModifier {
    @Bindable var model: BrowserModel
    let tab: TabItem

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading) {
                if tab.pinned {
                    Button { model.unpin(tab) } label: { Label { Text("tabs.unpin") } icon: { IconView(.pin) } }.tint(.indigo)
                } else if !tab.isBlank {
                    Button { model.pin(tab) } label: { Label { Text("tabs.pin") } icon: { IconView(.pin) } }.tint(.indigo)
                }
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { model.close(tab) } label: { Label { Text("tabs.close") } icon: { IconView(.close) } }
                if !tab.isBlank {
                    Button { model.archive(tab) } label: { Label { Text("tabs.archive") } icon: { IconView(.archive) } }.tint(.orange)
                }
            }
            .contextMenu {
                if !tab.isBlank {
                    if tab.pinned {
                        Button { model.unpin(tab) } label: { Label { Text("tabs.unpin") } icon: { IconView(.pin) } }
                    } else {
                        Button { model.pin(tab) } label: { Label { Text("tabs.pin") } icon: { IconView(.pin) } }
                    }
                    if !tab.isPrivate, !model.isFavorite(tab) {
                        Button { model.addFavorite(tab) } label: { Label { Text("tabs.add-favorite") } icon: { IconView(.star) } }
                    }
                    Menu {
                        if tab.folderId != nil { Button("tabs.move.root") { model.move(tab, toFolder: nil) } }
                        ForEach(model.folders.filter { $0.id != tab.folderId }) { folder in
                            Button { model.move(tab, toFolder: folder.id) } label: { Text(verbatim: folder.name) }
                        }
                    } label: { Label { Text("tabs.move") } icon: { IconView(.folder) } }
                        .disabled(model.folders.isEmpty && tab.folderId == nil)
                    Button { model.archive(tab) } label: { Label { Text("tabs.archive") } icon: { IconView(.archive) } }
                }
                Button(role: .destructive) { model.close(tab) } label: { Label { Text("tabs.close") } icon: { IconView(.close) } }
            }
    }
}

/// A folder as a row: its drawing, its name, how many tabs it holds (the folders inside it counted), a chevron: a tap goes into it.
struct FolderRowView: View {
    let folder: Folder
    let count: Int
    let open: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                IconView(.folder, size: 22).foregroundStyle(.secondary)
                Text(verbatim: folder.name).font(.subheadline).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                Spacer(minLength: 8)
                Text("folder.tabs \(count)").font(.footnote).foregroundStyle(.secondary)
                IconView(.chevron, size: 16).foregroundStyle(.secondary)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

/// A favourite: the tile of its site on a card; the one whose page is on screen is ringed. A tap shows its page, a long press removes it.
struct FavoriteTile: View {
    @Bindable var model: BrowserModel
    let favorite: Favorite
    var height: CGFloat = 52
    var fill = Color(.secondarySystemGroupedBackground)

    var body: some View {
        Button { model.openFavorite(favorite) } label: {
            SiteTile(address: favorite.url, size: 26)
                .frame(maxWidth: .infinity)
                .frame(height: height)
                .background(fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay { if model.isShown(favorite) { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2) } }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: favorite.title))
        .accessibilityAddTraits(model.isShown(favorite) ? .isSelected : [])
        .contextMenu {
            Button(role: .destructive) { model.removeFavorite(favorite) } label: { Label { Text("tabs.remove-favorite") } icon: { IconView(.trash) } }
        }
    }
}
