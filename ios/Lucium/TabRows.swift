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
                        title.font(.subheadline).fontWeight(shown ? .semibold : .regular).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
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

    /// The title of a page is data, not a text of the interface: it is never looked up in the catalogue.
    @ViewBuilder private var title: some View {
        if tab.isBlank {
            Text("tabs.blank")
        } else {
            Text(verbatim: tab.title.isEmpty ? AddressResolver.host(of: tab.url) : tab.title)
        }
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
