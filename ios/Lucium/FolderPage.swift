import LuciumKit
import SwiftUI

/// What is inside a folder of the pinned list (its own folders, then its tabs), reached by a tap on its row. The folder can be renamed, given a
/// folder of its own (while there is a level left) or deleted: what it held then goes up one level, nothing is closed.
struct FolderPage: View {
    @Bindable var model: BrowserModel
    let folderId: String
    @Binding var path: [SheetRoute]
    @State private var naming: Naming?
    @State private var nameText = ""
    @State private var confirmsDelete = false

    enum Naming: Identifiable {
        case newFolder, rename
        var id: Self { self }
    }

    var body: some View {
        let rows = model.pinnedRows(inside: folderId)
        List {
            if rows.isEmpty {
                Text("folder.empty").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                switch row {
                case .tab(let tab): TabRowView(model: model, tab: tab)
                case .folder(let folder, let count): FolderRowView(folder: folder, count: count) { path.append(.folder(folder.id)) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(Text(verbatim: model.folder(folderId)?.name ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if model.state.folderDepth(folderId) < Library.folderMaxDepth {
                        Button { nameText = ""; naming = .newFolder } label: { Label { Text("folder.new") } icon: { IconView(.folderPlus) } }
                    }
                    Button { nameText = model.folder(folderId)?.name ?? ""; naming = .rename } label: { Label { Text("folder.rename") } icon: { IconView(.rename) } }
                    Button(role: .destructive) { confirmsDelete = true } label: { Label { Text("folder.delete") } icon: { IconView(.trash) } }
                } label: { IconView(.more).frame(width: 44, height: 44) }
                    .accessibilityLabel(Text("folder.actions"))
            }
        }
        .alert(naming == .rename ? "folder.rename.title" : "folder.new.title", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("folder.name", text: $nameText)
            Button("folder.save") {
                if naming == .rename { model.renameFolder(folderId, to: nameText) } else { model.newFolder(named: nameText, inside: folderId) }
                naming = nil
            }
            Button("tabs.cancel", role: .cancel) { naming = nil }
        }
        .confirmationDialog("folder.delete.title", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("folder.delete", role: .destructive) {
                model.deleteFolder(folderId)
                if !path.isEmpty { path.removeLast() }
            }
        } message: {
            Text("folder.delete.message")
        }
    }
}
