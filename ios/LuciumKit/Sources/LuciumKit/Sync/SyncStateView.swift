import Foundation

/// What the synchronisation reads of the phone's state (docs/synchronisation.md §8.3, §10): the Swift twin of `src/main/sync/state-view.ts`, played against the same
/// vectors (`ios/Contracts/sync-state-vectors.json`, which the Mac's own `trackedViewOf` and `snapshotOf` play too). The entities with their synchronised fields and
/// the order of their lists, then the snapshot a session freezes from them with the marks the book gave.
///
///   `trackedView`  everything that is synchronised, in every category, for the book of marks to follow;
///   `snapshot`     what one session sends: the categories both devices ticked, without the spaces set aside (§18 [Q4], the locked ones), without what the person must
///                  not see sent (a private tab, a tab that is not pinned), with the seed fields of the entities the other device does not have yet.
///
/// Nothing here reads the disk or the clock; both are pure functions of what they are given.

/// Everything that is synchronised: kind → id → followed fields, and the ids of every list in order.
public struct SyncTrackedView: Equatable, Sendable {
    public var entities: [String: [String: [String: JSONValue]]]
    public var order: [String: [String]]

    public init(entities: [String: [String: [String: JSONValue]]] = [:], order: [String: [String]] = [:]) {
        self.entities = entities
        self.order = order
    }
}

/// A tab announced to the other device when "Open tabs" is common (§10.4).
public struct SyncOpenTab: Equatable, Sendable {
    public let id: String
    public let spaceId: String
    public let url: String
    public let title: String
    public let lastActiveAt: Int

    public init(id: String, spaceId: String, url: String, title: String, lastActiveAt: Int) {
        self.id = id
        self.spaceId = spaceId
        self.url = url
        self.title = title
        self.lastActiveAt = lastActiveAt
    }
}

public enum SyncStateView {
    private static let dash = "-"

    // MARK: The entities, as JSON

    /// One entity of the state with every field it holds, the identifier included (the fields it does not type are in `rest`, and cross with it).
    struct Entry {
        let id: String
        let fields: [String: JSONValue]
    }

    static func entry(of space: Space) -> Entry {
        var fields = space.rest
        fields["id"] = .string(space.id)
        fields["name"] = .string(space.name)
        fields["emoji"] = .string(space.emoji)
        fields["profileId"] = .string(space.profileId)
        return Entry(id: space.id, fields: fields)
    }

    static func entry(of tab: TabItem) -> Entry {
        var fields = tab.rest
        fields["id"] = .string(tab.id)
        fields["spaceId"] = .string(tab.spaceId)
        fields["url"] = .string(tab.url)
        fields["title"] = .string(tab.title)
        fields["pinned"] = .bool(tab.pinned)
        return Entry(id: tab.id, fields: fields)
    }

    static func entry(ofJSON json: JSONValue, id: String) -> Entry {
        if case .object(let fields) = json { return Entry(id: id, fields: fields) }
        return Entry(id: id, fields: ["id": .string(id)])
    }

    /// A favourite with no profile is given to the default one, as the Mac's `normalize` does: the two devices then say the same thing.
    static func entry(of favorite: Favorite) -> Entry {
        var fields = entry(ofJSON: favorite.json, id: favorite.id).fields
        if fields["profileId"] == nil { fields["profileId"] = .string(Library.defaultProfile) }
        return Entry(id: favorite.id, fields: fields)
    }

    /// The pinned tabs that are synchronised: pinned, and never private.
    static func isSyncedTab(_ tab: TabItem) -> Bool { tab.pinned && !tab.isPrivate }

    /// The archived tabs that are sent: the latest `archivePerSpaceSent` of each space, newest first, then by identifier.
    private static func archivedSent(_ state: BrowserState) -> [ArchivedTab] {
        var kept: [String: Int] = [:]
        let newestFirst = state.archive.sorted { a, b in a.archivedAt != b.archivedAt ? a.archivedAt > b.archivedAt : SyncCanonical.compare(a.id, b.id) < 0 }
        return newestFirst.filter { entry in
            let count = (kept[entry.spaceId] ?? 0) + 1
            kept[entry.spaceId] = count
            return count <= SyncFieldClasses.archivePerSpaceSent
        }
    }

    /// Every synchronised entity of the state, by kind, with all its fields.
    private static func entries(of state: BrowserState) -> [String: [Entry]] {
        var out: [String: [Entry]] = [:]
        out["space"] = state.spaces.map(entry(of:))
        out["folder"] = state.folders.map { entry(ofJSON: $0.json, id: $0.id) }
        out["tab"] = state.tabs.filter(isSyncedTab).map(entry(of:))
        out["favorite"] = state.favorites.map(entry(of:))
        out["archived"] = archivedSent(state).map { entry(ofJSON: $0.json, id: $0.id) }
        return out
    }

    /// The fields the book follows: all but the identifier, the seeds and the local ones.
    private static func followed(_ kind: SyncFieldClasses.Kind, _ fields: [String: JSONValue]) -> [String: JSONValue] {
        guard let classes = SyncFieldClasses.classes[kind] else { return fields }
        return fields.filter { $0.key != "id" && !classes.local.contains($0.key) && !classes.seed.contains($0.key) }
    }

    /// The seed fields of an entity: copied when it is created on the other device, then local.
    private static func seeds(_ kind: SyncFieldClasses.Kind, _ fields: [String: JSONValue]) -> [String: JSONValue] {
        guard let classes = SyncFieldClasses.classes[kind] else { return [:] }
        return fields.filter { classes.seed.contains($0.key) }
    }

    /// The settings of the closed list that the state holds: the id of the entity is the name of the setting, and its only field is `value`.
    private static func settings(of state: BrowserState) -> [String: [String: JSONValue]] {
        guard case .object(let all)? = state.rest["settings"] else { return [:] }
        var out: [String: [String: JSONValue]] = [:]
        for key in SyncFieldClasses.settingKeys {
            if let value = all[key] { out[key] = ["value": value] }
        }
        return out
    }

    // MARK: The keys of the lists (§11.4)

    private static func folderList(_ spaceId: String, _ parentId: String?) -> String { "folders:\(spaceId):\(parentId ?? dash)" }
    private static func tabList(_ spaceId: String, _ folderId: String?) -> String { "tabs:\(spaceId):\(folderId ?? dash)" }
    private static func favoriteList(_ profileId: String?) -> String { "favorites:\(profileId ?? Library.defaultProfile)" }

    // MARK: Tracked view

    public static func trackedView(of state: BrowserState) -> SyncTrackedView {
        var view = SyncTrackedView()
        let all = entries(of: state)
        for kind in SyncFieldClasses.Kind.allCases {
            var byID: [String: [String: JSONValue]] = [:]
            for entry in all[kind.rawValue] ?? [] { byID[entry.id] = followed(kind, entry.fields) }
            view.entities[kind.rawValue] = byID
        }
        view.entities["setting"] = settings(of: state)
        view.order["spaces"] = state.spaces.map(\.id)
        for folder in state.folders { view.order[folderList(folder.spaceId, folder.parentId), default: []].append(folder.id) }
        for tab in state.tabs.filter(isSyncedTab) { view.order[tabList(tab.spaceId, tab.folderId), default: []].append(tab.id) }
        for favorite in state.favorites { view.order[favoriteList(favorite.profileId), default: []].append(favorite.id) }
        return view
    }

    // MARK: Snapshot

    /// Whether `kind` is one of the kinds the categories of a session allow.
    private static func allowedKinds(_ categories: Set<SyncCategory>) -> Set<String> {
        var kinds = Set<String>()
        if categories.contains(.structure) { kinds.formUnion(["space", "folder", "tab", "favorite"]) }
        if categories.contains(.archive) { kinds.insert("archived") }
        if categories.contains(.settings) { kinds.insert("setting") }
        return kinds
    }

    /// The snapshot a session freezes and sends. The marks must be up to date (`SyncMarkBook.update`) before it is made.
    /// - Parameters:
    ///   - categories: the categories both devices ticked.
    ///   - withheld: the spaces set aside for this session (the locked ones): nothing of them is sent.
    ///   - base: the base of this device with that one: the entities it does not hold are new to the other device, and carry their seed fields.
    public static func snapshot(of state: BrowserState, marks: SyncMarkBook, categories: Set<SyncCategory>, withheld: Set<String>, base: SyncSnapshot?) -> SyncSnapshot {
        let view = trackedView(of: state)
        let all = entries(of: state)
        let kinds = allowedKinds(categories)
        func isWithheld(kind: String, fields: [String: JSONValue], id: String) -> Bool {
            if kind == "space" { return withheld.contains(id) }
            if case .string(let space)? = fields["spaceId"] { return withheld.contains(space) }
            return false
        }
        var full: [String: [String: [String: JSONValue]]] = [:]
        for (kind, list) in all { for entry in list { full[kind, default: [:]][entry.id] = entry.fields } }
        var snapshot = SyncSnapshot()
        for kind in kinds.sorted() {
            for (id, fields) in view.entities[kind] ?? [:] where !isWithheld(kind: kind, fields: fields, id: id) {
                var stamps = marks.stamps(of: kind, id: id)
                var entity = SyncEntity(fields: fields, stamps: [:])
                // An entity the other device may not have: its seed fields go with it, marked with the earliest mark it has, so that no later change of its own is older than them.
                if let known = SyncFieldClasses.kind(kind), base?.entities[kind]?[id] == nil {
                    let first = SyncStamp.min(of: Array(stamps.values))
                    for (name, value) in seeds(known, full[kind]?[id] ?? [:]) {
                        entity.fields[name] = value
                        stamps[name] = first
                    }
                }
                entity.stamps = stamps
                snapshot.entities[kind, default: [:]][id] = entity
            }
        }
        for (key, ids) in view.order {
            let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            let head = parts[0]
            let kind = head == "spaces" ? "space" : head == "folders" ? "folder" : head == "tabs" ? "tab" : "favorite"
            if !kinds.contains(kind) || (parts.count > 1 && head != "favorites" && withheld.contains(parts[1])) { continue }
            snapshot.order[key] = ids.filter { snapshot.entities[kind]?[$0] != nil }
            snapshot.orderStamps[key] = marks.orderStamp(of: key)
        }
        for (kind, byID) in marks.tombstonesOfAllKinds() where kinds.contains(kind) || (SyncFieldClasses.kind(kind) == nil && kind != "setting") {
            snapshot.tombstones[kind] = byID
        }
        return snapshot
    }

    /// The ids of the spaces the person has locked and has not opened: a session sets them aside (§18 [Q4]).
    public static func withheldSpaces(in state: BrowserState, isLocked: (String) -> Bool) -> [String] {
        state.spaces.filter { isLocked($0.id) }.map(\.id)
    }

    /// A base the way it is kept: the seed fields are taken off, so that the next session does not see them as changes (they are copied once, when an entity is created).
    public static func base(of merged: SyncSnapshot) -> SyncSnapshot {
        var base = merged
        for (kind, byID) in merged.entities {
            var kept: [String: SyncEntity] = [:]
            for (id, entity) in byID {
                kept[id] = SyncEntity(fields: entity.fields.filter { SyncFieldClasses.follows(kind: kind, field: $0.key) }, stamps: entity.stamps.filter { SyncFieldClasses.follows(kind: kind, field: $0.key) })
            }
            base.entities[kind] = kept
        }
        return base
    }

    // MARK: Open tabs

    private static func isWebPage(_ url: String) -> Bool {
        let lower = url.lowercased()
        return lower.hasPrefix("http://") || lower.hasPrefix("https://")
    }

    /// A text cut to at most `bytes` bytes of UTF-8, on a boundary of characters.
    static func cut(_ text: String, bytes: Int) -> String {
        if text.utf8.count <= bytes { return text }
        var out = String.UnicodeScalarView()
        var size = 0
        for scalar in text.unicodeScalars {
            let width = String(scalar).utf8.count
            if size + width > bytes { break }
            out.append(scalar)
            size += width
        }
        return String(out)
    }

    /// The tabs announced to the other device when "Open tabs" is common (§10.4): web pages the person has open, never a private tab, never a tab of a locked
    /// space, the latest 200. An address longer than the message allows is left out (a cut one would be another page); a title is cut.
    public static func openTabs(of state: BrowserState, isSpaceLocked: (String) -> Bool) -> [SyncOpenTab] {
        let candidates = state.tabs.filter { !$0.isPrivate && isWebPage($0.url) && !isSpaceLocked($0.spaceId) && $0.url.utf8.count <= SyncLimits.maxOpenTabURLBytes }
        let latest = candidates.sorted { a, b in
            let x = a.lastActiveAt ?? 0, y = b.lastActiveAt ?? 0
            return x != y ? x > y : SyncCanonical.compare(a.id, b.id) < 0
        }
        return latest.prefix(SyncLimits.maxOpenTabs).map { tab in
            SyncOpenTab(id: tab.id, spaceId: tab.spaceId, url: tab.url, title: cut(tab.title, bytes: SyncLimits.maxOpenTabTitleBytes), lastActiveAt: Int(max(0, (tab.lastActiveAt ?? 0).rounded(.towardZero))))
        }
    }
}

extension SyncSnapshot {
    /// The kinds the person arranges: what an iPhone that was never modified lets the Mac's state replace (§11.8).
    static let structureKinds: Set<String> = ["space", "folder", "tab", "favorite"]

    /// The snapshot with no space, folder, pinned tab or favourite, nor their tombstones and lists: what a phone that adopts the state of the Mac sends of its structure.
    /// What is not structure (the settings, the archive, a kind this version does not know) stays.
    func withoutStructure() -> SyncSnapshot {
        var copy = self
        copy.entities = entities.filter { !Self.structureKinds.contains($0.key) }
        copy.tombstones = tombstones.filter { !Self.structureKinds.contains($0.key) }
        copy.order = [:]
        copy.orderStamps = [:]
        return copy
    }
}
