import Foundation

/// The bookmarks and the "Read later" list (`Bookmark` and `ReadLaterItem` of `src/shared/model.ts`; rules of `bookmarks.ts` and `read-later.ts`).
///
/// Like the other lists of the library they stay in `BrowserState.rest` as the Mac writes them: the typed lists are a view over that JSON, and
/// what an entry holds that this build does not type (the folder of a read-later page, the note and the tags of a bookmark) is kept in its own
/// `rest` or its own field and written back. Both lists are shared by every space, and the iPhone does not synchronise them yet
/// (`docs/synchronisation.md`: the `library` category is reserved), so they are the device's own. Everything that comes from a page or a file is
/// hostile: addresses, titles and notes are bounded and made printable here, and nothing in an entry is ever executed.

/// A page kept to be read later. `savedAt` is a number of milliseconds, as `Date.now()` writes it.
public struct ReadLaterItem: Equatable, Identifiable, Sendable, LibraryEntry {
    public var id: String
    public var url: String
    public var title: String
    public var faviconUrl: String?
    public var savedAt: Double
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "url", "title", "faviconUrl", "savedAt"]

    public init(id: String, url: String, title: String, faviconUrl: String? = nil, savedAt: Double, rest: [String: JSONValue] = [:]) {
        self.id = id; self.url = url; self.title = title; self.faviconUrl = faviconUrl; self.savedAt = savedAt; self.rest = rest
    }

    init?(json: JSONValue) {
        guard case .object(let fields) = json, let id = fields.string("id"), let url = fields.string("url"), let title = fields.string("title") else { return nil }
        self.init(id: id, url: url, title: title, faviconUrl: fields.string("faviconUrl"), savedAt: fields.number("savedAt") ?? 0, rest: fields.without(Self.known))
    }

    var json: JSONValue {
        var fields = rest
        fields["id"] = .string(id)
        fields["url"] = .string(url)
        fields["title"] = .string(title)
        fields["faviconUrl"] = faviconUrl.map(JSONValue.string)
        fields["savedAt"] = .number(savedAt)
        return .object(fields)
    }
}

/// A page kept for good, with the tags and the note its owner gave it (on the Mac: the setting `bookmarkManager`). `addedAt` is in milliseconds.
public struct Bookmark: Equatable, Identifiable, Sendable, LibraryEntry {
    public var id: String
    public var url: String
    public var title: String
    public var tags: [String]
    public var note: String?
    public var faviconUrl: String?
    public var addedAt: Double
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "url", "title", "tags", "note", "faviconUrl", "addedAt"]

    public init(id: String, url: String, title: String, tags: [String] = [], note: String? = nil, faviconUrl: String? = nil, addedAt: Double,
                rest: [String: JSONValue] = [:]) {
        self.id = id; self.url = url; self.title = title; self.tags = tags; self.note = note; self.faviconUrl = faviconUrl; self.addedAt = addedAt; self.rest = rest
    }

    init?(json: JSONValue) {
        guard case .object(let fields) = json, let id = fields.string("id"), let url = fields.string("url"), let title = fields.string("title") else { return nil }
        var tags: [String] = []
        if case .array(let values)? = fields["tags"] { tags = values.compactMap { if case .string(let tag) = $0 { tag } else { nil } } }
        self.init(id: id, url: url, title: title, tags: tags, note: fields.string("note"), faviconUrl: fields.string("faviconUrl"),
                  addedAt: fields.number("addedAt") ?? 0, rest: fields.without(Self.known))
    }

    var json: JSONValue {
        var fields = rest
        fields["id"] = .string(id)
        fields["url"] = .string(url)
        fields["title"] = .string(title)
        fields["tags"] = .array(tags.map(JSONValue.string))
        fields["note"] = note.map(JSONValue.string)
        fields["faviconUrl"] = faviconUrl.map(JSONValue.string)
        fields["addedAt"] = .number(addedAt)
        return .object(fields)
    }
}

/// What saving a page does to a list: the Mac's `ReadLaterOutcome` and `BookmarkOutcome`. A page already in the list stays where it is, a full list
/// refuses the new page (nothing the person kept is dropped behind their back), and what is not a web page is not kept.
public enum KeepOutcome: Equatable, Sendable {
    case saved, already, full, unsupported
}

/// Numbers and rules the iPhone shares with the Mac; `ios/Contracts/bookmark-vectors.json` and `src/shared/ios-contract.test.ts` hold them.
public enum Keepsakes {
    public static let bookmarksLimit = 5000
    public static let bookmarkTitleMax = 300
    public static let bookmarkUrlMax = 4096
    public static let readLaterLimit = 500
    public static let readLaterTitleMax = 300
    public static let readLaterUrlMax = 4096

    /// An http or https address with a host that fits in `max` characters (`isWebAddress`).
    public static func isWebAddress(_ value: String, max: Int) -> Bool {
        let lower = value.lowercased()
        return value.utf16.count <= max && (lower.hasPrefix("http://") || lower.hasPrefix("https://")) && Library.isLoadable(value)
    }

    /// The key two entries of the same page share: the address as the URL parser of the Mac prints it, so that "https://Exemple.fr" and
    /// "https://exemple.fr/" are one page (`bookmarkKey`). Only what the vectors prove is normalised: the case of the scheme and of the host, the
    /// empty path, and the port the scheme has by default. Anything else is left as written.
    public static func key(of address: String) -> String {
        guard var parts = URLComponents(string: address), let scheme = parts.scheme?.lowercased(), parts.host != nil else { return address }
        parts.scheme = scheme
        parts.host = parts.host?.lowercased()
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) { parts.port = nil }
        if parts.path.isEmpty { parts.path = "/" }
        return parts.string ?? address
    }

    /// Lower case without accents: the form a search compares in (`foldAccents`: the marks U+0300–U+036F only, non-breaking spaces made ordinary).
    public static func fold(_ text: String) -> String {
        var folded = String.UnicodeScalarView()
        for scalar in text.decomposedStringWithCanonicalMapping.unicodeScalars {
            switch scalar.value {
            case 0x0300...0x036F: continue
            case 0x00A0, 0x202F: folded.append(" ")
            default: folded.append(scalar)
            }
        }
        return String(folded).lowercased()
    }

    /// A text a page or a file wrote, made printable and cut to `max` UTF-16 units without splitting a pair (`printable`).
    static func printable(_ text: String, max: Int) -> String {
        var out = String.UnicodeScalarView()
        var units = 0
        for scalar in text.unicodeScalars {
            let kept: Unicode.Scalar = scalar.properties.generalCategory == .control ? " " : scalar
            units += kept.utf16.count
            if units > max { break }
            out.append(kept)
        }
        return String(out)
    }

    /// The title an entry shows: the page's, else its host, else its address.
    static func title(_ raw: String, url: String, max: Int) -> String {
        let text = printable(raw, max: max).trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        let host = AddressResolver.host(of: url)
        return printable(host.isEmpty ? url : host, max: max)
    }

    /// The icon of a page kept as the tab had it: a web address, or a small `data:` image; nothing else.
    static func favicon(_ value: String?) -> String? {
        guard let value else { return nil }
        if isWebAddress(value, max: 2048) { return value }
        return nil
    }

    /// The bookmarks a search keeps. Every word must be found in the title, the address, the note or a tag; a word that starts with "#" is a tag (its
    /// beginning is enough). `tags` are tags chosen in the screen: a bookmark must carry all of them (`filterBookmarks`).
    public static func filter(_ list: [Bookmark], query: String, tags: [String] = []) -> [Bookmark] {
        let words = fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
        let wanted = tags.map(fold)
        if words.isEmpty && wanted.isEmpty { return list }
        return list.filter { bookmark in
            let own = bookmark.tags.map(fold)
            guard wanted.allSatisfy(own.contains) else { return false }
            let haystack = fold("\(bookmark.title) \(bookmark.url) \(bookmark.note ?? "") \(bookmark.tags.joined(separator: " "))")
            return words.allSatisfy { word in
                if word.hasPrefix("#") { return word.count > 1 ? own.contains { $0.hasPrefix(String(word.dropFirst())) } : true }
                return haystack.contains(word)
            }
        }
    }

    /// The pages of the read-later list whose title or address contain what was typed (`filterReadLater`); all of them for an empty text.
    public static func filter(_ list: [ReadLaterItem], query: String) -> [ReadLaterItem] {
        let needle = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        return needle.isEmpty ? list : list.filter { fold($0.title).contains(needle) || fold($0.url).contains(needle) }
    }

    /// The tags in use with how many bookmarks carry each, the most used first, then by name (`tagCounts`).
    public static func tagCounts(_ list: [Bookmark]) -> [(tag: String, count: Int)] {
        var counts: [String: (tag: String, count: Int)] = [:]
        for bookmark in list {
            for tag in bookmark.tags {
                let key = fold(tag)
                counts[key] = (counts[key]?.tag ?? tag, (counts[key]?.count ?? 0) + 1)
            }
        }
        return counts.values.sorted { $0.count != $1.count ? $0.count > $1.count : $0.tag.localizedCompare($1.tag) == .orderedAscending }
    }
}

// MARK: - The two lists of the state

extension BrowserState {
    /// The read-later list, newest first.
    public var readLater: [ReadLaterItem] {
        get { Library.read(rest["readLater"]) }
        set { storeKept(newValue, key: "readLater") }
    }

    /// The bookmark library, newest first.
    public var bookmarks: [Bookmark] {
        get { Library.read(rest["bookmarks"]) }
        set { storeKept(newValue, key: "bookmarks") }
    }

    private mutating func storeKept<T: LibraryEntry>(_ entries: [T], key: String) {
        // A state that never had the list does not gain an empty one by being read and written.
        if entries.isEmpty, rest[key] == nil { return }
        rest[key] = Library.write(entries)
    }

    /// What saving a page would do to the bookmarks (`bookmarkOutcome`).
    public func bookmarkOutcome(of url: String) -> KeepOutcome {
        guard Keepsakes.isWebAddress(url, max: Keepsakes.bookmarkUrlMax) else { return .unsupported }
        let list = bookmarks
        let key = Keepsakes.key(of: url)
        if list.contains(where: { Keepsakes.key(of: $0.url) == key }) { return .already }
        return list.count >= Keepsakes.bookmarksLimit ? .full : .saved
    }

    /// What saving a page would do to the read-later list (`readLaterOutcome`): the address is compared as written, as the Mac does.
    public func readLaterOutcome(of url: String) -> KeepOutcome {
        guard Keepsakes.isWebAddress(url, max: Keepsakes.readLaterUrlMax) else { return .unsupported }
        let list = readLater
        if list.contains(where: { $0.url == url }) { return .already }
        return list.count >= Keepsakes.readLaterLimit ? .full : .saved
    }

    /// Adds a page to the bookmarks, newest first (`bookmark/add`). A private tab keeps nothing, so the caller refuses it before asking.
    @discardableResult
    public mutating func addBookmark(id: String, url: String, title: String, faviconUrl: String? = nil, now: Double) -> KeepOutcome {
        let outcome = bookmarkOutcome(of: url)
        guard outcome == .saved else { return outcome }
        let entry = Bookmark(id: id, url: url, title: Keepsakes.title(title, url: url, max: Keepsakes.bookmarkTitleMax), faviconUrl: Keepsakes.favicon(faviconUrl), addedAt: now)
        bookmarks = [entry] + bookmarks
        return .saved
    }

    /// Removes a bookmark (`bookmark/remove`).
    public mutating func removeBookmark(id: String) {
        guard bookmarks.contains(where: { $0.id == id }) else { return }
        bookmarks = bookmarks.filter { $0.id != id }
    }

    /// Adds a page to the top of the read-later list (`readlater/add`, without the closing of the tab, which the model does). A page already in the
    /// list stays where it is.
    @discardableResult
    public mutating func addReadLater(id: String, url: String, title: String, faviconUrl: String? = nil, now: Double) -> KeepOutcome {
        let outcome = readLaterOutcome(of: url)
        guard outcome == .saved else { return outcome }
        let entry = ReadLaterItem(id: id, url: url, title: Keepsakes.title(title, url: url, max: Keepsakes.readLaterTitleMax), faviconUrl: Keepsakes.favicon(faviconUrl), savedAt: now)
        readLater = [entry] + readLater
        return .saved
    }

    /// Removes a page of the read-later list (`readlater/remove`).
    public mutating func removeReadLater(id: String) {
        guard readLater.contains(where: { $0.id == id }) else { return }
        readLater = readLater.filter { $0.id != id }
    }

    /// Empties the read-later list (`readlater/clear`).
    public mutating func clearReadLater() { if !readLater.isEmpty { readLater = [] } }
}
