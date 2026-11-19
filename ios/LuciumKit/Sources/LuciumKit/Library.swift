import Foundation

/// The library of the state: folders, favourites and the archive (`Folder`, `Favorite`, `ArchivedTab` of `src/shared/model.ts`).
///
/// They stay in `BrowserState.rest` as the Mac wrote them, so that the stored shape and the contract with the Mac do not move: the typed
/// lists below are a view over that JSON, and writing one writes it back there. An entry that does not read as its type is left out of the
/// view (`unreadableLibraryEntries` counts them, and the application says so in its log), and it is gone the next time that list is written; the
/// Mac's own repair (`normalize`) drops the same entries, so the two sides agree. What an entry holds that this build does not type (`noWake`,
/// a folder icon, the history of a closed tab…) is kept in its own `rest` and written back.

/// An entry of a list of the library: read from the JSON of the state, written back as JSON. No `Codable`: nothing here can throw, so no error
/// is there to be swallowed; a JSON value that is not an entry is `nil`.
protocol LibraryEntry {
    init?(json: JSONValue)
    var json: JSONValue { get }
}

extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? {
        if case .string(let value)? = self[key] { return value }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        if case .bool(let value)? = self[key] { return value }
        return nil
    }

    func number(_ key: String) -> Double? {
        if case .number(let value)? = self[key], value.isFinite { return value }
        return nil
    }

    func without(_ keys: Set<String>) -> [String: JSONValue] { filter { !keys.contains($0.key) } }
}

/// A folder of the pinned list. The tree is flat in the state (`parentId`); it is at most `Library.folderMaxDepth` levels deep.
public struct Folder: Equatable, Identifiable, Sendable, LibraryEntry {
    public var id: String
    public var spaceId: String
    public var name: String
    public var collapsed: Bool
    /// The folder this one sits in; absent for a folder at the root of the pinned list.
    public var parentId: String?
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "spaceId", "name", "collapsed", "parentId"]

    public init(id: String, spaceId: String, name: String, collapsed: Bool = false, parentId: String? = nil, rest: [String: JSONValue] = [:]) {
        self.id = id; self.spaceId = spaceId; self.name = name; self.collapsed = collapsed; self.parentId = parentId; self.rest = rest
    }

    init?(json: JSONValue) {
        guard case .object(let fields) = json, let id = fields.string("id"), let spaceId = fields.string("spaceId"), let name = fields.string("name") else { return nil }
        self.init(id: id, spaceId: spaceId, name: name, collapsed: fields.bool("collapsed") ?? false, parentId: fields.string("parentId"),
                  rest: fields.without(Self.known))
    }

    var json: JSONValue {
        var fields = rest
        fields["id"] = .string(id)
        fields["spaceId"] = .string(spaceId)
        fields["name"] = .string(name)
        fields["collapsed"] = .bool(collapsed)
        fields["parentId"] = parentId.map(JSONValue.string)
        return .object(fields)
    }
}

/// An icon of the favourites row: shown in every space of one profile, in none of another (`profileId`).
public struct Favorite: Equatable, Identifiable, Sendable, LibraryEntry {
    public var id: String
    public var url: String
    public var title: String
    public var faviconUrl: String?
    /// The profile whose spaces list it; absent means the default profile (the Mac's `favoriteProfile`).
    public var profileId: String?
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "url", "title", "faviconUrl", "profileId"]

    public init(id: String, url: String, title: String, faviconUrl: String? = nil, profileId: String? = nil, rest: [String: JSONValue] = [:]) {
        self.id = id; self.url = url; self.title = title; self.faviconUrl = faviconUrl; self.profileId = profileId; self.rest = rest
    }

    init?(json: JSONValue) {
        guard case .object(let fields) = json, let id = fields.string("id"), let url = fields.string("url"), let title = fields.string("title") else { return nil }
        self.init(id: id, url: url, title: title, faviconUrl: fields.string("faviconUrl"), profileId: fields.string("profileId"),
                  rest: fields.without(Self.known))
    }

    var json: JSONValue {
        var fields = rest
        fields["id"] = .string(id)
        fields["url"] = .string(url)
        fields["title"] = .string(title)
        fields["faviconUrl"] = faviconUrl.map(JSONValue.string)
        fields["profileId"] = profileId.map(JSONValue.string)
        return .object(fields)
    }
}

/// A closed tab kept in the archive, newest first (`ArchivedTab`). `archivedAt` is a number of milliseconds, as `Date.now()` writes it.
public struct ArchivedTab: Equatable, Identifiable, Sendable, LibraryEntry {
    public enum Source: String, Sendable {
        /// Left idle past the delay of the profile.
        case auto
        /// Archived by hand (one tab, or "Archive all").
        case manual
        case little
        /// The open tabs of a space another device deleted, kept when the synchronisation removed the space (docs/synchronisation.md §8.5).
        case sync
    }

    public var id: String
    public var spaceId: String
    public var url: String
    public var title: String
    public var archivedAt: Double
    public var source: String?
    /// The tab was pinned: restoring it pins it again, at its anchor address, in its folder while that folder exists.
    public var pinned: Bool
    public var anchorUrl: String?
    public var folderId: String?
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "spaceId", "url", "title", "archivedAt", "source", "pinned", "anchorUrl", "folderId"]

    public init(id: String, spaceId: String, url: String, title: String, archivedAt: Double, source: Source? = nil, pinned: Bool = false,
                anchorUrl: String? = nil, folderId: String? = nil, rest: [String: JSONValue] = [:]) {
        self.id = id; self.spaceId = spaceId; self.url = url; self.title = title; self.archivedAt = archivedAt; self.source = source?.rawValue
        self.pinned = pinned; self.anchorUrl = anchorUrl; self.folderId = folderId; self.rest = rest
    }

    init?(json: JSONValue) {
        guard case .object(let fields) = json, let id = fields.string("id"), let spaceId = fields.string("spaceId"), let url = fields.string("url"),
              let title = fields.string("title"), let archivedAt = fields.number("archivedAt") else { return nil }
        self.init(id: id, spaceId: spaceId, url: url, title: title, archivedAt: archivedAt, pinned: fields.bool("pinned") ?? false,
                  anchorUrl: fields.string("anchorUrl"), folderId: fields.string("folderId"), rest: fields.without(Self.known))
        source = fields.string("source")
    }

    var json: JSONValue {
        var fields = rest
        fields["id"] = .string(id)
        fields["spaceId"] = .string(spaceId)
        fields["url"] = .string(url)
        fields["title"] = .string(title)
        fields["archivedAt"] = .number(archivedAt)
        fields["source"] = source.map(JSONValue.string)
        // The Mac writes `pinned: true` only on an entry that was pinned.
        fields["pinned"] = pinned ? JSONValue.bool(true) : nil
        fields["anchorUrl"] = anchorUrl.map(JSONValue.string)
        fields["folderId"] = folderId.map(JSONValue.string)
        return .object(fields)
    }
}

/// Numbers of the Mac that the iPhone keeps (`FOLDER_MAX_DEPTH`, `ARCHIVE_LIMIT`, `NAME_MAX`, `TITLE_MAX`).
public enum Library {
    public static let folderMaxDepth = 4
    public static let archiveLimit = 500
    public static let nameMax = 200
    public static let titleMax = 1000
    public static let hourMilliseconds = 3_600_000.0
    /// The profile of a favourite that names none.
    public static let defaultProfile = "default"

    /// The entries of a JSON list that read as `T`, in order.
    static func read<T: LibraryEntry>(_ value: JSONValue?) -> [T] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap { T(json: $0) }
    }

    /// How many entries of a JSON list do not read as `T`.
    static func unreadable<T: LibraryEntry>(_ value: JSONValue?, as type: T.Type) -> Int {
        guard case .array(let items)? = value else { return 0 }
        return items.count - items.compactMap { T(json: $0) }.count
    }

    static func write<T: LibraryEntry>(_ entries: [T]) -> JSONValue { .array(entries.map(\.json)) }
}

extension BrowserState {
    /// The folders of every space, in the order of the state.
    public var folders: [Folder] {
        get { Library.read(rest["folders"]) }
        set { store(newValue, key: "folders") }
    }

    /// The favourites of every profile, in the order of the state (each profile's own order is this order, filtered).
    public var favorites: [Favorite] {
        get { Library.read(rest["favorites"]) }
        set { store(newValue, key: "favorites") }
    }

    /// The archive, newest first.
    public var archive: [ArchivedTab] {
        get { Library.read(rest["archive"]) }
        set { store(newValue, key: "archive") }
    }

    private mutating func store<T: LibraryEntry>(_ entries: [T], key: String) {
        // A state that never had the list does not gain an empty one by being read and written.
        if entries.isEmpty, rest[key] == nil { return }
        rest[key] = Library.write(entries)
    }

    /// How many entries of each list (`folders`, `favorites`, `archive`) are not read, and so are lost when that list is next written. Empty when
    /// every entry reads; the application logs what is not.
    public var unreadableLibraryEntries: [String: Int] {
        var counts: [String: Int] = [:]
        counts["folders"] = Library.unreadable(rest["folders"], as: Folder.self)
        counts["favorites"] = Library.unreadable(rest["favorites"], as: Favorite.self)
        counts["archive"] = Library.unreadable(rest["archive"], as: ArchivedTab.self)
        counts["readLater"] = Library.unreadable(rest["readLater"], as: ReadLaterItem.self)
        counts["bookmarks"] = Library.unreadable(rest["bookmarks"], as: Bookmark.self)
        return counts.filter { $0.value > 0 }
    }
}

/// The fields a tab carries for the library, read and written through `rest` so that the stored shape stays the Mac's.
extension TabItem {
    /// The folder a pinned tab sits in.
    public var folderId: String? {
        get { string("folderId") }
        set { rest["folderId"] = newValue.map(JSONValue.string) }
    }

    /// The address a pinned tab returns to; written when a tab is pinned.
    public var anchorUrl: String? {
        get { string("anchorUrl") }
        set { rest["anchorUrl"] = newValue.map(JSONValue.string) }
    }

    /// The favourite this tab is the page of. A favourite opens as a tab that no list shows: its tile stands for it.
    public var favoriteId: String? {
        get { string("favoriteId") }
        set { rest["favoriteId"] = newValue.map(JSONValue.string) }
    }

    /// Whether a list shows the tab (`isListedTab`): the page of a favourite is not a row.
    public var isListed: Bool { favoriteId == nil }

    private func string(_ key: String) -> String? { rest.string(key) }
}
