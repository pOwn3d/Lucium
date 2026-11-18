import Foundation

/// A line of the pinned outline of the sidebar: a tab or a folder, and how deep it sits.
public struct OutlineRow: Equatable, Identifiable, Sendable {
    public var row: PinnedRow
    /// 0 for the root of the pinned list; a folder's content is one deeper than the folder.
    public var depth: Int
    /// Only a folder can be open; its content follows it in the outline when it is.
    public var isExpanded: Bool

    public var id: String { row.id }

    public init(row: PinnedRow, depth: Int, isExpanded: Bool = false) {
        self.row = row; self.depth = depth; self.isExpanded = isExpanded
    }
}

/// The pinned list as the sidebar draws it: one column where a folder opens in place (the sheet of the iPhone goes into a folder instead).
public enum SidebarOutline {
    /// The rows to draw, from the root, the content of each open folder right under it. `children` gives what is at one level (nil is the root,
    /// a folder id is what is inside that folder): the caller passes the model's reader, which already says nothing for a locked space, so this
    /// never walks around the lock. A folder that is open and is its own ancestor in a hand-edited tree opens once, and nothing goes deeper than
    /// `Library.folderMaxDepth` levels.
    public static func rows(children: (String?) -> [PinnedRow], expanded: Set<String>) -> [OutlineRow] {
        var rows: [OutlineRow] = []
        func walk(_ folderId: String?, depth: Int, path: Set<String>) {
            for row in children(folderId) {
                guard case .folder(let folder, _) = row else {
                    rows.append(OutlineRow(row: row, depth: depth))
                    continue
                }
                let opens = expanded.contains(folder.id) && !path.contains(folder.id) && depth < Library.folderMaxDepth
                rows.append(OutlineRow(row: row, depth: depth, isExpanded: opens))
                if opens { walk(folder.id, depth: depth + 1, path: path.union([folder.id])) }
            }
        }
        walk(nil, depth: 0, path: [])
        return rows
    }
}
