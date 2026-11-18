import Foundation

/// The one way a synchronisation session writes into the phone's state (docs/synchronisation.md §8.5): the Swift twin of the action `sync/apply` of the Mac's
/// reducer (`src/shared/sidebar-sync.ts`). It takes the patch the session worked out between the snapshot it froze and the merged one, and changes only what the
/// patch names:
///
///   - a field is set only if the state still holds what it held when the session froze its snapshot (`expect`): what the person changed meanwhile keeps their
///     change, and the next session sends it;
///   - an entity is removed only if it is still as it was frozen;
///   - an entity that arrives is made with the defaults the model needs, then its fields, each rebounded like a field read from a file (`clean`); an entity that
///     cannot be made (no name, no address) is left out and counted;
///   - what the state holds that this version does not type (`rest` of every entity) is kept as it is, and so is every field the patch does not name;
///   - the lists are reordered group by group (the spaces, the folders of a folder, the pinned tabs of a folder, the favourites of a profile), in the places the
///     members already hold, so that what is not synchronised (the Today tabs) does not move;
///   - the settings are the closed list of §10.3, and nothing else;
///   - what points at nothing is cut (a tab of a space that is gone, a folder that is gone), the pointers of the state are put right, and a state is never left
///     with no space.
public enum SyncApply {
    public struct Outcome: Equatable, Sendable {
        public var state: BrowserState
        public var createdSpaceIDs: [String] = []
        public var removedSpaceIDs: [String] = []
        /// The tabs that are no longer in the state (an entity removed, or a tab of a space that went): their web views and files are the application's to drop.
        public var removedTabIDs: [String] = []
        /// What the patch asked and was not written, and why (for the log and the tests): a value that does not pass `clean`, an entity that cannot be made.
        public var rejected: [String] = []
        public var changed: Bool

        public init(state: BrowserState, createdSpaceIDs: [String] = [], removedSpaceIDs: [String] = [], removedTabIDs: [String] = [], rejected: [String] = [], changed: Bool = false) {
            self.state = state
            self.createdSpaceIDs = createdSpaceIDs
            self.removedSpaceIDs = removedSpaceIDs
            self.removedTabIDs = removedTabIDs
            self.rejected = rejected
            self.changed = changed
        }
    }

    // MARK: Rules of the values

    /// A text as a file would hold it: control characters become a space, cut to `maximum` UTF-16 units on a character boundary.
    static func printable(_ text: String, maximum: Int) -> String {
        var out = String.UnicodeScalarView()
        var units = 0
        for scalar in text.unicodeScalars {
            let width = scalar.value > 0xFFFF ? 2 : 1
            if units + width > maximum { break }
            units += width
            out.append(scalar.value < 0x20 || scalar.value == 0x7F ? " " : scalar)
        }
        return String(out)
    }

    private static let tabAddressMax = 65_536
    private static let tabNameMax = 200

    /// Which values a field of a kind may take. Fields this version does not know have no rule: they cross as they are (§11.6).
    private enum Rule {
        case name(Int)
        case text(Int)
        case bool
        case object
        case emoji
        case address
        case profile
        case identifier
        case number
        case oneOf([String])
    }

    private static func rule(_ kind: SyncFieldClasses.Kind, _ name: String) -> Rule? {
        switch (kind, name) {
        case (.space, "name"), (.folder, "name"): .name(Library.nameMax)
        case (.space, "emoji"), (.folder, "icon"), (.tab, "icon"): .emoji
        case (.space, "profileId"), (.favorite, "profileId"): .profile
        case (.space, "theme"): .object
        case (.space, "hideHeader"), (.space, "iconRound"), (.folder, "atBottom"), (.folder, "atTodayStart"), (.folder, "noWake"), (.folder, "collapsed"), (.tab, "pinned"), (.tab, "keepAwake"),
             (.archived, "pinned"): .bool
        case (.space, "iconKind"): .oneOf(["emoji", "letter", "image"])
        case (.space, "iconLetter"): .text(4)
        case (.space, "iconColor"): .text(32)
        case (.folder, "spaceId"), (.folder, "parentId"), (.tab, "spaceId"), (.tab, "folderId"), (.archived, "spaceId"), (.archived, "folderId"): .identifier
        case (.tab, "anchorUrl"), (.tab, "url"), (.favorite, "url"), (.archived, "url"), (.archived, "anchorUrl"): .address
        case (.tab, "customTitle"): .text(tabNameMax)
        case (.tab, "title"), (.favorite, "title"), (.archived, "title"): .text(Library.titleMax)
        case (.archived, "archivedAt"): .number
        case (.archived, "source"): .oneOf(["auto", "manual", "little", "sync"])
        default: nil
        }
    }

    /// The value as this version would keep it, or nil when it is not one (the field is then not written).
    static func clean(_ kind: SyncFieldClasses.Kind, _ name: String, _ value: JSONValue) -> JSONValue? {
        guard let rule = rule(kind, name) else { return value }
        switch (rule, value) {
        case (.name(let maximum), .string(let text)):
            let cut = printable(text, maximum: maximum).trimmingCharacters(in: .whitespacesAndNewlines)
            return cut.isEmpty ? nil : .string(cut)
        case (.text(let maximum), .string(let text)): return .string(printable(text, maximum: maximum))
        case (.bool, .bool), (.object, .object): return value
        case (.emoji, .string(let text)): return BrowserState.isOneEmoji(text) ? value : nil
        case (.address, .string(let text)): return text.utf16.count <= tabAddressMax && SyncInbound.isWebAddress(value) ? value : nil
        case (.profile, .string(let text)): return BrowserState.isProfileId(text) ? value : .string(Library.defaultProfile)
        case (.identifier, .string(let text)): return (1...128).contains(text.utf16.count) ? value : nil
        case (.number, .number(let number)): return number.isFinite ? value : nil
        case (.oneOf(let allowed), .string(let text)): return allowed.contains(text) ? value : nil
        default: return nil
        }
    }

    /// The fields an entity cannot be without: a patch never takes one away.
    private static func isRequired(_ kind: SyncFieldClasses.Kind, _ name: String) -> Bool {
        switch kind {
        case .space: ["id", "name", "emoji", "profileId"].contains(name)
        case .folder: ["id", "spaceId", "name"].contains(name)
        case .tab: ["id", "spaceId", "pinned", "url", "title"].contains(name)
        case .favorite: ["id", "url", "title"].contains(name)
        case .archived: ["id", "spaceId", "url", "title", "archivedAt"].contains(name)
        }
    }

    /// What a new entity holds before the fields of the patch are put on it. A name or an address is never invented: an entity that lacks one is not made.
    private static func made(_ kind: SyncFieldClasses.Kind, id: String, now: Double) -> [String: JSONValue] {
        switch kind {
        case .space: ["id": .string(id), "emoji": .string("✨"), "profileId": .string(BrowserState.defaultProfileId), "theme": SpaceTheme.make(hue: 250)]
        case .folder: ["id": .string(id), "collapsed": .bool(false)]
        case .tab: ["id": .string(id), "pinned": .bool(true), "createdAt": .number(now), "lastActiveAt": .number(now)]
        case .favorite: ["id": .string(id), "profileId": .string(Library.defaultProfile)]
        case .archived: ["id": .string(id), "archivedAt": .number(now)]
        }
    }

    /// Whether the entity of a kind has what it cannot be without.
    private static func isComplete(_ kind: SyncFieldClasses.Kind, _ fields: [String: JSONValue]) -> Bool {
        func has(_ name: String) -> Bool { if case .string(let text)? = fields[name] { return !text.isEmpty }; return false }
        switch kind {
        case .space: return has("name") && has("emoji")
        case .folder: return has("spaceId") && has("name")
        case .tab: return has("spaceId") && (has("url") || has("anchorUrl"))
        case .favorite: return has("url")
        case .archived: return has("spaceId") && has("url")
        }
    }

    // MARK: Applying

    /// An entity of the state, as JSON, with the typed value it was made from (kept when nothing of it changed).
    private struct Slot<T> {
        var id: String
        var fields: [String: JSONValue]
        var original: T?
        var changed: Bool
    }

    private struct Lists {
        var spaces: [Slot<Space>]
        var folders: [Slot<Folder>]
        var tabs: [Slot<TabItem>]
        var favorites: [Slot<Favorite>]
        var archive: [Slot<ArchivedTab>]
    }

    private static func slots<T>(_ items: [T], _ entry: (T) -> SyncStateView.Entry) -> [Slot<T>] {
        items.map { item in
            let one = entry(item)
            return Slot(id: one.id, fields: one.fields, original: item, changed: false)
        }
    }

    /// Whether the entity still holds, for every name given, what the session froze (`expect`; absent: it was absent).
    private static func unchanged(_ fields: [String: JSONValue], expect: [String: JSONValue], names: some Sequence<String>) -> Bool {
        names.allSatisfy { SyncCanonical.same(fields[$0], expect[$0]) }
    }

    private static func upsert<T>(_ list: inout [Slot<T>], kind: SyncFieldClasses.Kind, change: SyncPatch.Upsert, now: Double, rejected: inout [String]) {
        if let at = list.firstIndex(where: { SyncCanonical.identical($0.id, change.id) }) {
            var fields = list[at].fields
            var touched = false
            for (name, value) in change.fields.sorted(by: { SyncCanonical.compare($0.key, $1.key) < 0 }) where name != "id" && unchanged(fields, expect: change.expect, names: [name]) {
                guard let cleaned = clean(kind, name, value) else {
                    rejected.append("\(kind.rawValue) \(change.id): \(name) is not a value this version keeps")
                    continue
                }
                if !SyncCanonical.same(fields[name], cleaned) { fields[name] = cleaned; touched = true }
            }
            for name in change.remove where name != "id" && !isRequired(kind, name) && unchanged(fields, expect: change.expect, names: [name]) {
                if fields[name] != nil { fields[name] = nil; touched = true }
            }
            if touched { list[at].fields = fields; list[at].changed = true }
            return
        }
        guard change.create else { return }
        var fields = made(kind, id: change.id, now: now)
        for (name, value) in change.fields.sorted(by: { SyncCanonical.compare($0.key, $1.key) < 0 }) where name != "id" {
            if let cleaned = clean(kind, name, value) { fields[name] = cleaned } else { rejected.append("\(kind.rawValue) \(change.id): \(name) is not a value this version keeps") }
        }
        // A pinned tab that comes back without the page it was on (its seed fields are sent only with a new entity) opens at the page it returns to.
        if kind == .tab, fields["url"] == nil, case .string(let anchor)? = fields["anchorUrl"] {
            fields["url"] = .string(anchor)
            if fields["title"] == nil { fields["title"] = fields["customTitle"] ?? .string(AddressResolver.host(of: anchor)) }
        }
        if (kind == .tab || kind == .favorite || kind == .archived), fields["title"] == nil, case .string(let address)? = fields["url"] { fields["title"] = .string(AddressResolver.host(of: address)) }
        guard isComplete(kind, fields) else {
            rejected.append("\(kind.rawValue) \(change.id): not made, it lacks a name or an address")
            return
        }
        list.append(Slot(id: change.id, fields: fields, original: nil, changed: true))
    }

    private static func remove<T>(_ list: inout [Slot<T>], _ removal: SyncPatch.Removal) {
        guard let at = list.firstIndex(where: { SyncCanonical.identical($0.id, removal.id) }), unchanged(list[at].fields, expect: removal.expect, names: removal.expect.keys) else { return }
        list.remove(at: at)
    }

    // MARK: The order

    private static func dash(_ value: JSONValue?) -> String { if case .string(let text)? = value { return text }; return "-" }

    /// The members of one list put in `ids` order, in the places the members held; a member that `ids` does not name goes after those it does, in its own order.
    private static func reordered<T>(_ list: [Slot<T>], member: ([String: JSONValue]) -> Bool, ids: [String]) -> (list: [Slot<T>], moved: Bool) {
        let positions = list.indices.filter { member(list[$0].fields) }
        guard positions.count >= 2 else { return (list, false) }
        var rank: [String: Int] = [:]
        for (index, id) in ids.enumerated() where rank[id] == nil { rank[id] = index }
        let sorted = positions.sorted { a, b in
            let x = rank[list[a].id] ?? Int.max, y = rank[list[b].id] ?? Int.max
            return x != y ? x < y : a < b
        }
        var out = list
        var moved = false
        for (place, source) in zip(positions, sorted) where place != source {
            out[place] = list[source]
            out[place].changed = true
            moved = true
        }
        return (out, moved)
    }

    private static func applyOrder(_ key: String, ids: [String], to lists: inout Lists) {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        var rest = Array(parts.dropFirst())
        let last = rest.popLast()
        let middle = rest.joined(separator: ":")
        switch parts[0] {
        case "spaces" where parts.count == 1:
            lists.spaces = reordered(lists.spaces, member: { _ in true }, ids: ids).list
        case "folders" where last != nil:
            lists.folders = reordered(lists.folders, member: { fields in dash(fields["spaceId"]) == middle && dash(fields["parentId"]) == last }, ids: ids).list
        case "tabs" where last != nil:
            lists.tabs = reordered(lists.tabs, member: { fields in
                if case .bool(true)? = fields["pinned"], fields["private"] != .bool(true) { return dash(fields["spaceId"]) == middle && dash(fields["folderId"]) == last }
                return false
            }, ids: ids).list
        case "favorites" where rest.isEmpty && last != nil:
            lists.favorites = reordered(lists.favorites, member: { fields in
                if case .string(let profile)? = fields["profileId"] { return profile == last }
                return last == Library.defaultProfile
            }, ids: ids).list
        default:
            break
        }
    }

    // MARK: Applying a patch

    /// The state after a patch. A patch that changes nothing gives back the state it was given.
    public static func apply(_ patch: SyncPatch, to state: BrowserState, now: Double) -> Outcome {
        var rejected: [String] = []
        var lists = Lists(spaces: slots(state.spaces, SyncStateView.entry(of:)), folders: slots(state.folders) { SyncStateView.entry(ofJSON: $0.json, id: $0.id) },
                          tabs: slots(state.tabs, SyncStateView.entry(of:)), favorites: slots(state.favorites, SyncStateView.entry(of:)),
                          archive: slots(state.archive) { SyncStateView.entry(ofJSON: $0.json, id: $0.id) })
        for change in patch.upserts {
            switch change.kind {
            case .space: upsert(&lists.spaces, kind: .space, change: change, now: now, rejected: &rejected)
            case .folder: upsert(&lists.folders, kind: .folder, change: change, now: now, rejected: &rejected)
            case .tab: upsert(&lists.tabs, kind: .tab, change: change, now: now, rejected: &rejected)
            case .favorite: upsert(&lists.favorites, kind: .favorite, change: change, now: now, rejected: &rejected)
            case .archived: upsert(&lists.archive, kind: .archived, change: change, now: now, rejected: &rejected)
            }
        }
        let spacesBefore = Set(lists.spaces.map(\.id))
        for removal in patch.removals {
            switch removal.kind {
            case .space:
                // A state is never left with no space: the last one stays, whatever the merge says.
                if lists.spaces.count > 1 { remove(&lists.spaces, removal) }
            case .folder: remove(&lists.folders, removal)
            case .tab: remove(&lists.tabs, removal)
            case .favorite: remove(&lists.favorites, removal)
            case .archived: remove(&lists.archive, removal)
            }
        }
        keepOpenTabsOfRemovedSpaces(&lists, removed: spacesBefore.subtracting(lists.spaces.map(\.id)), active: state.activeSpaceId, now: now)
        for key in patch.order.keys.sorted(by: { SyncCanonical.compare($0, $1) < 0 }) { applyOrder(key, ids: patch.order[key] ?? [], to: &lists) }
        // A profile lists a page once among its favourites (the same rule as `favorite/add`): two devices that each added the same page under another id keep the first.
        var seen = Set<String>()
        lists.favorites = lists.favorites.filter { slot in
            guard case .string(let url)? = slot.fields["url"] else { return true }
            var profile = Library.defaultProfile
            if case .string(let name)? = slot.fields["profileId"] { profile = name }
            return seen.insert(profile + "\u{0}" + url).inserted
        }
        return finish(lists, patch: patch, state: state, rejected: rejected)
    }

    /// The open tabs (the ones of Today: pinned tabs are synchronised, and went with the space on the other device too) of the spaces a patch has removed go to the archive before the
    /// state is cleaned (review n° 13 of the synchronisation; docs/synchronisation.md §8.5). They are not synchronised, so the device that deleted the space did not decide about them;
    /// a deletion made here asks the person first, one that comes from another device does not, and nothing must be lost without a trace. They are kept in the space the person is in
    /// (else the first one left), as `sync`, newest first, before what the archive already held (the same rule as the Mac's `archiveOpenTabsOfRemovedSpaces`).
    private static func keepOpenTabsOfRemovedSpaces(_ lists: inout Lists, removed: Set<String>, active: String, now: Double) {
        guard !removed.isEmpty else { return }
        let leaving = lists.tabs.filter { slot in
            guard case .string(let space)? = slot.fields["spaceId"], removed.contains(space) else { return false }
            if case .bool(true)? = slot.fields["pinned"] { return false }
            if case .bool(true)? = slot.fields["private"] { return false }
            return true
        }
        guard !leaving.isEmpty else { return }
        let target = lists.spaces.contains { $0.id == active } ? active : (lists.spaces.first?.id ?? "")
        let entries: [Slot<ArchivedTab>] = leaving.compactMap { slot in
            guard case .string(let url)? = slot.fields["url"] else { return nil }
            var title = url
            if case .string(let custom)? = slot.fields["customTitle"], !custom.trimmingCharacters(in: .whitespaces).isEmpty { title = custom } else if case .string(let own)? = slot.fields["title"], !own.isEmpty { title = own }
            let fields: [String: JSONValue] = ["id": .string(slot.id), "spaceId": .string(target), "url": .string(url), "title": .string(title), "archivedAt": .number(now), "source": .string("sync")]
            return Slot(id: slot.id, fields: fields, original: nil, changed: true)
        }
        let made = Set(entries.map(\.id))
        lists.tabs.removeAll { slot in made.contains(slot.id) }
        lists.archive = Array((entries + lists.archive.filter { !made.contains($0.id) }).prefix(Library.archiveLimit))
    }

    /// What the typed lists and the settings become, and what no longer points at anything is cut.
    private static func finish(_ lists: Lists, patch: SyncPatch, state: BrowserState, rejected: [String]) -> Outcome {
        var rejected = rejected
        var next = state
        func fold<T>(_ list: [Slot<T>], _ read: ([String: JSONValue]) -> T?, label: String) -> [T] {
            list.compactMap { slot in
                if !slot.changed, let original = slot.original { return original }
                if let made = read(slot.fields) { return made }
                rejected.append("\(label) \(slot.id): it does not read once written, left out")
                return nil
            }
        }
        var spaces = fold(lists.spaces, Space.init(syncFields:), label: "space")
        if spaces.isEmpty { spaces = state.spaces }  // never left with none (the patch cannot ask for it, a rejected field could)
        let spaceIDs = Set(spaces.map(\.id))
        var folders = fold(lists.folders, { Folder(json: .object($0)) }, label: "folder").filter { spaceIDs.contains($0.spaceId) }
        let folderSpace = Dictionary(folders.map { ($0.id, $0.spaceId) }, uniquingKeysWith: { first, _ in first })
        for index in folders.indices {
            if let parent = folders[index].parentId, folderSpace[parent] != folders[index].spaceId { folders[index].parentId = nil }
        }
        breakLoops(&folders)
        var tabs = fold(lists.tabs, TabItem.init(syncFields:), label: "tab").filter { spaceIDs.contains($0.spaceId) }
        for index in tabs.indices {
            if let folder = tabs[index].folderId, folderSpace[folder] != tabs[index].spaceId { tabs[index].folderId = nil }
        }
        var archive = fold(lists.archive, { ArchivedTab(json: .object($0)) }, label: "archived").filter { spaceIDs.contains($0.spaceId) }
        for index in archive.indices {
            if let folder = archive[index].folderId, folderSpace[folder] != archive[index].spaceId { archive[index].folderId = nil }
        }
        let favorites = fold(lists.favorites, { Favorite(json: .object($0)) }, label: "favorite")
        next.spaces = spaces
        next.tabs = tabs
        // `folders`, `favorites` and `archive` are written only if they changed: a state that never had the list does not gain one by being read and written.
        if folders != state.folders { next.folders = folders }
        if favorites != state.favorites { next.favorites = favorites }
        if archive != state.archive { next.archive = archive }
        applySettings(patch.settings, to: &next, rejected: &rejected)
        for id in spaceIDs where next.activeTabBySpace[id] == nil { next.activeTabBySpace[id] = .some(nil) }
        for id in next.activeTabBySpace.keys.filter({ !spaceIDs.contains($0) }) { next.activeTabBySpace[id] = nil }
        next = next.consistent() ?? state
        let removedTabs = state.tabs.map(\.id).filter { id in !next.tabs.contains { $0.id == id } }
        return Outcome(state: next, createdSpaceIDs: spaces.map(\.id).filter { id in !state.spaces.contains { $0.id == id } },
                       removedSpaceIDs: state.spaces.map(\.id).filter { !spaceIDs.contains($0) }, removedTabIDs: removedTabs, rejected: rejected, changed: next != state)
    }

    /// The `parentId` of a folder that is on a loop is cut (the merge cuts the loops of what it gives; this one is for what local folders could add).
    private static func breakLoops(_ folders: inout [Folder]) {
        for start in folders.indices {
            var seen: Set<String> = [folders[start].id]
            var at = folders[start].parentId
            while let current = at {
                if seen.contains(current) {
                    folders[start].parentId = nil
                    break
                }
                seen.insert(current)
                at = folders.first { $0.id == current }?.parentId
            }
        }
    }

    // MARK: The settings

    private static func applySettings(_ values: [String: JSONValue], to state: inout BrowserState, rejected: inout [String]) {
        var accepted = values.filter { key, value in
            guard SyncFieldClasses.settingKeys.contains(key) else { return false }
            if SyncInbound.settingValueIsInvalid(key: key, value: value) {
                rejected.append("setting \(key): not a value this version keeps")
                return false
            }
            return true
        }
        // An engine of search of one's own stays on this device: the engine the other device has does not replace it (docs/synchronisation.md §10.3; review n° 10).
        if case .object(let current)? = state.rest["settings"], case .string(let own)? = current["searchUrlTemplate"], !SearchEngine.isPreset(own) { accepted["searchUrlTemplate"] = nil }
        guard !accepted.isEmpty else { return }
        // A state with no settings at all is a new profile for the privacy rules: the keys it would be missing are what an earlier profile had (HTTPS first only), so the
        // five a new profile starts with are written first, as `setProfileName` does.
        if state.rest["settings"] == nil { PrivacySettings.newProfile.write(into: &state) }
        var settings: [String: JSONValue] = [:]
        if case .object(let current)? = state.rest["settings"] { settings = current }
        for (key, value) in accepted { settings[key] = value }
        state.rest["settings"] = .object(settings)
    }
}

// MARK: - Typed values from the fields of an entity

extension Space {
    /// A space from its fields (the identifier, the name, the emoji and the profile, and everything else in `rest`), or nil when one of the four is missing.
    init?(syncFields fields: [String: JSONValue]) {
        guard case .string(let id)? = fields["id"], case .string(let name)? = fields["name"], case .string(let emoji)? = fields["emoji"], case .string(let profileId)? = fields["profileId"] else { return nil }
        self.init(id: id, name: name, emoji: emoji, profileId: profileId, rest: fields.without(["id", "name", "emoji", "profileId"]))
    }
}

extension TabItem {
    /// A tab from its fields, or nil when its identifier, space, address or title is missing.
    init?(syncFields fields: [String: JSONValue]) {
        guard case .string(let id)? = fields["id"], case .string(let spaceId)? = fields["spaceId"], case .string(let url)? = fields["url"], case .string(let title)? = fields["title"] else { return nil }
        var pinned = false
        if case .bool(let flag)? = fields["pinned"] { pinned = flag }
        self.init(id: id, spaceId: spaceId, url: url, title: title, pinned: pinned, rest: fields.without(["id", "spaceId", "url", "title", "pinned"]))
    }
}
