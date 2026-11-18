import Foundation

/// The Swift twin of `src/shared/sync-conflicts.ts`: what the person is told after two devices changed the same thing (docs/synchronisation.md §11.7.3 and
/// §13.4, the mockup « Conflit réglé »): the journal of the conflicts the merge settled, kept on the device for 30 days so that « Comparer » can show both
/// versions and « Rétablir » can put the one that lost back, and the description of each conflict as sentences (keys of the catalogue and the words to put
/// in them). Checked by the same vectors as the Mac (`ios/Contracts/sync-conflict-vectors.json`): change one side and the other fails.
///
/// The journal holds titles and addresses (what the person typed): it stays on the device, it is never sent, and it goes with the device that is forgotten
/// (§12). It never holds a secret, a password or a lock: those are never synchronised.

public enum SyncPlatform: String, Sendable {
    case mac, ios

    public var other: SyncPlatform { self == .mac ? .ios : .mac }
}

/// A value as the person reads it.
public enum SyncShown: Equatable, Sendable {
    case text(String)
    case bool(Bool)
    case absent
    case complex
}

/// What to do to put back the version that lost: an ordinary change of the state, which goes out at the next session like any other.
public enum SyncChange: Equatable, Sendable {
    case set(kind: String, id: String, field: String, value: JSONValue)
    case unset(kind: String, id: String, field: String)
    case delete(kind: String, id: String)
    case order(list: String, ids: [String])
}

public struct SettledConflict: Equatable, Sendable {
    /// The same thing settled again replaces its line: `[kind, id, field]` written as JSON.
    public var id: String
    /// When the session ended, on the clock of the device (ms). Every line of one session has the same value.
    public var settledAt: Int
    /// The other device.
    public var peer: SyncPlatform
    public var kind: String
    public var entityID: String
    public var field: String?
    public var reason: SyncConflictReason
    /// From the point of view of this device.
    public var winner: SyncConflictSide
    /// The name of the thing at that time: what the person typed.
    public var label: String?
    public var kept: SyncShown
    public var lost: SyncShown
    /// When each side made its change (ms, from the marks), or nil for a mark of zero.
    public var keptAt: Int?
    public var lostAt: Int?
    public var restore: SyncChange?

    public init(id: String, settledAt: Int, peer: SyncPlatform, kind: String, entityID: String, field: String?, reason: SyncConflictReason, winner: SyncConflictSide,
                label: String?, kept: SyncShown, lost: SyncShown, keptAt: Int?, lostAt: Int?, restore: SyncChange?) {
        self.id = id
        self.settledAt = settledAt
        self.peer = peer
        self.kind = kind
        self.entityID = entityID
        self.field = field
        self.reason = reason
        self.winner = winner
        self.label = label
        self.kept = kept
        self.lost = lost
        self.keptAt = keptAt
        self.lostAt = lostAt
        self.restore = restore
    }
}

public enum SyncConflicts {
    public enum Limits {
        /// §11.7.3: at most 200 lines.
        public static let maxEntries = 200
        /// §11.5: a thing that was settled is kept 30 days.
        public static let retentionMs = 30 * 24 * 60 * 60 * 1000
        /// A value too large to keep is shown as « another value » and cannot be put back.
        public static let maxValueChars = 4096
        public static let maxShownChars = 80
        public static let maxLabelChars = 120
        public static let maxListIDs = 500
        /// A journal file is read only up to this size (a hostile or damaged file is bounded before it is read).
        public static let maxFileChars = 4 * 1024 * 1024
    }

    /// `[kind, id, field]` written as JSON: one thing, one line.
    public static func entryID(kind: String, id: String, field: String?) -> String {
        SyncCanonical.text(.array([.string(kind), .string(id), field.map { .string($0) } ?? .null])) ?? ""
    }

    /// The time a mark says (its first 13 digits), or nil for the mark of zero.
    public static func stampTime(_ mark: String) -> Int? {
        if mark == SyncStamp.zero { return nil }
        let digits = String(mark.prefix(13))
        guard digits.count == 13, digits.utf8.allSatisfy({ (0x30...0x39).contains($0) }) else { return nil }
        return Int(digits)
    }

    /// A text cut to a number of characters (scalars, as JavaScript's code points: a smiley is one), with « … » when something was cut.
    public static func clip(_ text: String, _ maximum: Int) -> String {
        let scalars = Array(text.unicodeScalars)
        if scalars.count <= maximum { return text }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars.prefix(maximum))
        return String(out) + "…"
    }

    private static func string(_ fields: [String: JSONValue], _ name: String) -> String? {
        if case .string(let value)? = fields[name], !value.isEmpty { return value }
        return nil
    }

    /// What the person calls an entity (§11.7.3): the name of a space or a folder, the title of a tab, a favourite or an archived tab, else its address.
    public static func label(kind: String, fields: [String: JSONValue]) -> String? {
        let text: String?
        switch kind {
        case "space", "folder": text = string(fields, "name")
        case "tab": text = string(fields, "customTitle") ?? string(fields, "title") ?? string(fields, "anchorUrl")
        case "favorite", "archived": text = string(fields, "title") ?? string(fields, "url")
        default: text = nil
        }
        return text.map { clip($0, Limits.maxLabelChars) }
    }

    // MARK: - Settling

    /// The journal lines of the conflicts a merge settled: what each side had, who won, and what puts the other version back. `local` and `remote` are what each
    /// device froze at the start of the session, `merged` what the merge gave, `now` the end of the session on this device's clock, `peer` the other device.
    public static func settle(conflicts: [SyncConflict], local: SyncSnapshot, remote: SyncSnapshot, merged: SyncSnapshot, now: Int, peer: SyncPlatform) -> [SettledConflict] {
        func side(_ which: SyncConflictSide) -> SyncSnapshot { which == .local ? local : remote }
        func entity(_ kind: String, _ id: String) -> SyncEntity? { merged.entities[kind]?[id] ?? local.entities[kind]?[id] ?? remote.entities[kind]?[id] }
        func name(_ kind: String, _ id: String) -> String? { entity(kind, id).flatMap { label(kind: kind, fields: $0.fields) } }
        func shown(_ field: String, _ value: JSONValue?) -> SyncShown {
            guard let value else { return .absent }
            switch value {
            case .bool(let flag): return .bool(flag)
            case .number: return .text(SyncCanonical.text(value) ?? "")
            case .string(let text):
                let target: String? = field == "spaceId" ? "space" : (field == "parentId" || field == "folderId") ? "folder" : nil
                if let target { return name(target, text).map { .text($0) } ?? .complex }
                return field == "profileId" ? .complex : .text(clip(text, Limits.maxShownChars))
            default: return .complex
            }
        }
        var lines: [SettledConflict] = []
        for conflict in conflicts {
            let kind = conflict.kind, id = conflict.id, field = conflict.field, winner = conflict.winner
            let loser = winner.other
            let line: (String?, SyncShown, SyncShown, Int?, Int?, SyncChange?) // label, kept, lost, keptAt, lostAt, restore
            if kind == "order" {
                let ids = side(loser).order[id] ?? []
                line = (orderLabel(id, name), .complex, .complex, stampTime(side(winner).orderStamps[id] ?? SyncStamp.zero), stampTime(side(loser).orderStamps[id] ?? SyncStamp.zero),
                        !ids.isEmpty && ids.count <= Limits.maxListIDs ? .order(list: id, ids: ids) : nil)
            } else if field == nil {
                // A deletion that lost: the entity is kept on both devices, and putting the other version back means deleting it.
                let kept = entity(kind, id)
                let tombstone = side(loser).tombstones[kind]?[id] ?? SyncStamp.zero
                line = (kept.flatMap { label(kind: kind, fields: $0.fields) }, .absent, .absent,
                        stampTime(SyncStamp.max(of: Array(side(winner).entities[kind]?[id]?.stamps.values ?? [:].values))), stampTime(tombstone), .delete(kind: kind, id: id))
            } else if let field {
                let winning = side(winner).entities[kind]?[id]
                let losing = side(loser).entities[kind]?[id]
                let lostValue = losing?.fields[field]
                let tooLarge = lostValue.map { (SyncCanonical.text($0) ?? "").utf16.count > Limits.maxValueChars } ?? false
                let restore: SyncChange? = tooLarge ? nil : lostValue.map { .set(kind: kind, id: id, field: field, value: $0) } ?? .unset(kind: kind, id: id, field: field)
                line = (name(kind, id), shown(field, winning?.fields[field]), tooLarge ? .complex : shown(field, lostValue),
                        stampTime(winning?.stamps[field] ?? SyncStamp.zero), stampTime(losing?.stamps[field] ?? SyncStamp.zero), restore)
            } else {
                continue
            }
            lines.append(SettledConflict(id: entryID(kind: kind, id: id, field: field), settledAt: now, peer: peer, kind: kind, entityID: id, field: field, reason: conflict.reason,
                                         winner: winner, label: line.0, kept: line.1, lost: line.2, keptAt: line.3, lostAt: line.4, restore: line.5))
        }
        return lines
    }

    /// The name of the container of a list (the space of its tabs or folders), or nil: the lists of spaces and of favourites have none.
    private static func orderLabel(_ key: String, _ name: (String, String) -> String?) -> String? {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count > 1, parts[0] == "tabs" || parts[0] == "folders", parts[1] != "-" else { return nil }
        return name("space", parts[1])
    }

    // MARK: - The journal

    /// The lines newer than 30 days, the newest first (then by id), at most 200. A line from the future (a clock that went back) is kept until its turn comes.
    public static func prune(_ entries: [SettledConflict], now: Int) -> [SettledConflict] {
        Array(entries
            .filter { now - $0.settledAt <= Limits.retentionMs }
            .sorted { $0.settledAt != $1.settledAt ? $0.settledAt > $1.settledAt : SyncCanonical.compare($0.id, $1.id) < 0 }
            .prefix(Limits.maxEntries))
    }

    /// What a session settled goes in, a line that settles the same thing again replaces the older one, and the journal is pruned.
    public static func add(_ settled: [SettledConflict], to journal: [SettledConflict], now: Int) -> [SettledConflict] {
        let replaced = Set(settled.map(\.id))
        return prune(journal.filter { !replaced.contains($0.id) } + settled, now: now)
    }

    /// « D'accord » on a line, or « Rétablir » done: the line goes.
    public static func remove(_ id: String, from journal: [SettledConflict]) -> [SettledConflict] {
        journal.filter { !SyncCanonical.identical($0.id, id) }
    }

    /// The lines of the last session (those with the greatest `settledAt`): the content of the « Conflit réglé » screen.
    public static func lastSession(_ journal: [SettledConflict]) -> [SettledConflict] {
        guard let last = journal.map(\.settledAt).max() else { return [] }
        return journal.filter { $0.settledAt == last }.sorted {
            let kind = SyncCanonical.compare($0.kind, $1.kind)
            if kind != 0 { return kind < 0 }
            let id = SyncCanonical.compare($0.entityID, $1.entityID)
            if id != 0 { return id < 0 }
            return SyncCanonical.compare($0.field ?? "", $1.field ?? "") < 0
        }
    }

    // MARK: - Reading a file

    public struct Parsed: Equatable, Sendable {
        public var entries: [SettledConflict]
        public var skipped: Int
        public var tooNew: Bool
        public var unreadable: Bool
    }

    /// A name used to find a line or an entity: not empty, not too long, and in normalization form C (a Swift string or dictionary does not tell two forms apart,
    /// JavaScript does).
    private static func isName(_ value: JSONValue?, _ maximum: Int) -> String? {
        guard case .string(let text)? = value, text.utf16.count >= 1, text.utf16.count <= maximum, text.unicodeScalars.elementsEqual(text.precomposedStringWithCanonicalMapping.unicodeScalars) else { return nil }
        return text
    }

    private static func time(_ value: JSONValue?) -> Int? {
        guard case .number(let number)? = value, number >= 0, number == number.rounded(), number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }

    private static func jsonOK(_ value: JSONValue, depth: Int = 0) -> Bool {
        if depth > SyncSnapshot.Limits.maxJSONDepth { return false }
        switch value {
        case .null, .bool, .string: return true
        case .number(let number): return number.isFinite
        case .array(let items): return items.allSatisfy { jsonOK($0, depth: depth + 1) }
        case .object(let members):
            return members.allSatisfy { key, member in
                !SyncCanonical.identical(key, "__proto__") && key.unicodeScalars.elementsEqual(key.precomposedStringWithCanonicalMapping.unicodeScalars) && jsonOK(member, depth: depth + 1)
            }
        }
    }

    private static func readShown(_ value: JSONValue?) -> SyncShown? {
        guard case .object(let members)? = value, case .string(let type)? = members["t"] else { return nil }
        switch type {
        case "text":
            guard case .string(let text)? = members["text"], text.utf16.count <= Limits.maxShownChars * 2 else { return nil }
            return .text(text)
        case "bool":
            guard case .bool(let flag)? = members["value"] else { return nil }
            return .bool(flag)
        case "absent": return .absent
        case "complex": return .complex
        default: return nil
        }
    }

    /// `.some(nil)` is a restore that is null (nothing to put back); `nil` is a restore that is not in the form.
    private static func readChange(_ value: JSONValue?) -> SyncChange?? {
        guard let value else { return nil }
        if case .null = value { return .some(nil) }
        guard case .object(let members) = value, case .string(let type)? = members["type"] else { return nil }
        switch type {
        case "set", "unset", "delete":
            guard let kind = isName(members["kind"], SyncSnapshot.Limits.maxKindChars), let id = isName(members["id"], SyncSnapshot.Limits.maxIDChars) else { return nil }
            if type == "delete" { return .some(.delete(kind: kind, id: id)) }
            guard let field = isName(members["field"], SyncSnapshot.Limits.maxFieldNameChars) else { return nil }
            if type == "unset" { return .some(.unset(kind: kind, id: id, field: field)) }
            guard let content = members["value"], jsonOK(content), (SyncCanonical.text(content) ?? "").utf16.count <= Limits.maxValueChars else { return nil }
            return .some(.set(kind: kind, id: id, field: field, value: content))
        case "order":
            guard let list = isName(members["list"], SyncSnapshot.Limits.maxListKeyChars), case .array(let raw)? = members["ids"], raw.count <= Limits.maxListIDs else { return nil }
            var ids: [String] = []
            for item in raw {
                guard let id = isName(item, SyncSnapshot.Limits.maxIDChars) else { return nil }
                ids.append(id)
            }
            return .some(.order(list: list, ids: ids))
        default: return nil
        }
    }

    /// One line read from a file: its form or nil. Nothing of what a file says is trusted: every member is checked, bounded and copied.
    public static func read(_ value: JSONValue) -> SettledConflict? {
        guard case .object(let members) = value else { return nil }
        guard let id = isName(members["id"], 1024), let settledAt = time(members["settledAt"]), case .string(let peerText)? = members["peer"], let peer = SyncPlatform(rawValue: peerText) else { return nil }
        guard let kind = isName(members["kind"], SyncSnapshot.Limits.maxKindChars), let entityID = isName(members["entityId"], SyncSnapshot.Limits.maxListKeyChars) else { return nil }
        var field: String?
        switch members["field"] {
        case .null?: field = nil
        case let other?:
            guard let name = isName(other, SyncSnapshot.Limits.maxFieldNameChars) else { return nil }
            field = name
        case nil: return nil
        }
        guard case .string(let reasonText)? = members["reason"], let reason = SyncConflictReason(rawValue: reasonText),
              case .string(let winnerText)? = members["winner"], let winner = SyncConflictSide(rawValue: winnerText) else { return nil }
        var label: String?
        switch members["label"] {
        case .null?: label = nil
        case .string(let text)?:
            guard text.unicodeScalars.count <= Limits.maxLabelChars + 1 else { return nil }
            label = text
        default: return nil
        }
        guard let kept = readShown(members["kept"]), let lost = readShown(members["lost"]), let restore = readChange(members["restore"]) else { return nil }
        var keptAt: Int?
        switch members["keptAt"] {
        case .null?: keptAt = nil
        case let other?:
            guard let at = time(other) else { return nil }
            keptAt = at
        case nil: return nil
        }
        var lostAt: Int?
        switch members["lostAt"] {
        case .null?: lostAt = nil
        case let other?:
            guard let at = time(other) else { return nil }
            lostAt = at
        case nil: return nil
        }
        return SettledConflict(id: id, settledAt: settledAt, peer: peer, kind: kind, entityID: entityID, field: field, reason: reason, winner: winner, label: label,
                               kept: kept, lost: lost, keptAt: keptAt, lostAt: lostAt, restore: restore)
    }

    /// The journal read from the text of its file, `{ "v": 1, "entries": [...] }`: the lines that are well formed, pruned. A line that is not well formed is left
    /// out and counted in `skipped`, never fatal. A file that is too large, that is not JSON or not that form, gives no line and `unreadable` (the caller says
    /// so in its log and starts a new journal: the screen has nothing to compare, the session goes on); a file of a newer version gives no line and `tooNew`
    /// (the caller must not overwrite it).
    public static func parse(_ text: String, now: Int) -> Parsed {
        func nothing(unreadable: Bool, tooNew: Bool = false) -> Parsed { Parsed(entries: [], skipped: 0, tooNew: tooNew, unreadable: unreadable) }
        if text.utf16.count > Limits.maxFileChars { return nothing(unreadable: true) }
        guard let root = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)), case .object(let members) = root, case .array(let raw)? = members["entries"] else {
            return nothing(unreadable: true)
        }
        if case .number(let version)? = members["v"], version > 1 { return nothing(unreadable: false, tooNew: true) }
        guard case .number(let version)? = members["v"], version == 1 else { return nothing(unreadable: true) }
        var entries: [SettledConflict] = []
        var skipped = 0
        var seen = Set<String>()
        for item in raw.prefix(Limits.maxEntries * 2) {
            if let entry = read(item), seen.insert(entry.id).inserted { entries.append(entry) } else { skipped += 1 }
        }
        return Parsed(entries: prune(entries, now: now), skipped: skipped, tooNew: false, unreadable: false)
    }

    // MARK: - Writing a file

    /// The journal as the JSON value of its file (`{ "v": 1, "entries": [...] }`).
    public static func json(_ journal: [SettledConflict]) -> JSONValue {
        .object(["v": .number(1), "entries": .array(journal.map(json))])
    }

    public static func serialize(_ journal: [SettledConflict]) -> String {
        SyncCanonical.text(json(journal)).map { $0 + "\n" } ?? ""
    }

    static func json(_ entry: SettledConflict) -> JSONValue {
        func number(_ value: Int?) -> JSONValue { value.map { .number(Double($0)) } ?? .null }
        return .object([
            "id": .string(entry.id), "settledAt": .number(Double(entry.settledAt)), "peer": .string(entry.peer.rawValue), "kind": .string(entry.kind), "entityId": .string(entry.entityID),
            "field": entry.field.map { .string($0) } ?? .null, "reason": .string(entry.reason.rawValue), "winner": .string(entry.winner.rawValue), "label": entry.label.map { .string($0) } ?? .null,
            "kept": json(entry.kept), "lost": json(entry.lost), "keptAt": number(entry.keptAt), "lostAt": number(entry.lostAt), "restore": entry.restore.map(json) ?? .null,
        ])
    }

    static func json(_ shown: SyncShown) -> JSONValue {
        switch shown {
        case .text(let text): return .object(["t": .string("text"), "text": .string(text)])
        case .bool(let flag): return .object(["t": .string("bool"), "value": .bool(flag)])
        case .absent: return .object(["t": .string("absent")])
        case .complex: return .object(["t": .string("complex")])
        }
    }

    static func json(_ change: SyncChange) -> JSONValue {
        switch change {
        case .set(let kind, let id, let field, let value): return .object(["type": .string("set"), "kind": .string(kind), "id": .string(id), "field": .string(field), "value": value])
        case .unset(let kind, let id, let field): return .object(["type": .string("unset"), "kind": .string(kind), "id": .string(id), "field": .string(field)])
        case .delete(let kind, let id): return .object(["type": .string("delete"), "kind": .string(kind), "id": .string(id)])
        case .order(let list, let ids): return .object(["type": .string("order"), "list": .string(list), "ids": .array(ids.map { .string($0) })])
        }
    }
}

// MARK: - The sentences

/// A sentence: the key of the catalogue and what goes in it, in the order the sentence reads them (a word of the catalogue, or what the person typed).
public struct SyncText: Equatable, Sendable {
    public var key: String
    public var params: [Param]

    public enum Param: Equatable, Sendable {
        case literal(String)
        case text(SyncText)
    }

    public init(_ key: String, _ params: Param...) {
        self.key = key
        self.params = params
    }
}

public struct ConflictRow: Equatable, Sendable {
    public var platform: SyncPlatform
    /// Whether this device's change is the one that is in force now.
    public var kept: Bool
    public var text: SyncText
    public var at: Int?
}

public struct ConflictView: Equatable, Sendable {
    public var id: String
    public var title: SyncText
    /// What the person calls it; nil when it has no name.
    public var label: String?
    public var rows: [ConflictRow]
    public var outcome: SyncText
    /// « Comparer » has two versions to show (a field or a list). A deletion that lost has no « Comparer »: it offers « Le supprimer partout ».
    public var compare: Bool
    public var restore: SyncChange?
}

public extension SyncConflicts {
    // The keys of the catalogues, written out (a key is looked up in a table, so that a field a newer version added is never taken for a key).
    /// The fields the catalogues name; any other one (a field a newer version added) is shown by its own name.
    static let fieldKeys: [String: String] = [
        "name": "sync-conflict.field-name", "emoji": "sync-conflict.field-emoji", "theme": "sync-conflict.field-theme", "profileId": "sync-conflict.field-profile-id",
        "hideHeader": "sync-conflict.field-hide-header", "iconKind": "sync-conflict.field-icon-kind", "iconLetter": "sync-conflict.field-icon-letter",
        "iconColor": "sync-conflict.field-icon-color", "iconRound": "sync-conflict.field-icon-round", "spaceId": "sync-conflict.field-space-id",
        "parentId": "sync-conflict.field-parent-id", "atBottom": "sync-conflict.field-at-bottom", "atTodayStart": "sync-conflict.field-at-today-start",
        "noWake": "sync-conflict.field-no-wake", "icon": "sync-conflict.field-icon", "pinned": "sync-conflict.field-pinned", "anchorUrl": "sync-conflict.field-anchor-url",
        "customTitle": "sync-conflict.field-custom-title", "folderId": "sync-conflict.field-folder-id", "keepAwake": "sync-conflict.field-keep-awake",
        "url": "sync-conflict.field-url", "title": "sync-conflict.field-title", "archivedAt": "sync-conflict.field-archived-at", "source": "sync-conflict.field-source",
        "value": "sync-conflict.field-value",
    ]
    /// The kinds the catalogues name (a setting is told by the name of the setting: `kind-setting-named`).
    static let kindKeys: [String: String] = [
        "space": "sync-conflict.kind-space", "folder": "sync-conflict.kind-folder", "tab": "sync-conflict.kind-tab", "favorite": "sync-conflict.kind-favorite",
        "archived": "sync-conflict.kind-archived", "order": "sync-conflict.kind-order",
    ]
    /// The settings of the closed list of §10.3.
    static let settingKeys: [String: String] = [
        "httpsUpgrade": "sync-conflict.setting-https-upgrade", "sendGpc": "sync-conflict.setting-send-gpc", "stripTrackingParams": "sync-conflict.setting-strip-tracking-params",
        "stripCopiedLinks": "sync-conflict.setting-strip-copied-links", "protectionBaseline": "sync-conflict.setting-protection-baseline",
        "autoArchiveHours": "sync-conflict.setting-auto-archive-hours", "searchUrlTemplate": "sync-conflict.setting-search-url-template", "profileNames": "sync-conflict.setting-profile-names",
    ]

    private static func fieldName(_ field: String) -> SyncText.Param {
        fieldKeys[field].map { .text(SyncText($0)) } ?? .literal(field)
    }

    private static func sentence(field: String, value: SyncShown) -> SyncText {
        let name = fieldName(field)
        switch value {
        case .text(let text):
            return field == "spaceId" || field == "parentId" || field == "folderId" ? SyncText("sync-conflict.row-moved", .literal(text)) : SyncText("sync-conflict.row-set", name, .literal(text))
        case .bool(let flag): return SyncText(flag ? "sync-conflict.row-on" : "sync-conflict.row-off", name)
        case .absent: return SyncText("sync-conflict.row-unset", name)
        case .complex: return SyncText("sync-conflict.row-other", name)
        }
    }

    /// A line of the journal as the screen tells it (§13.4): the title, one row for each device (what it did and when), and the sentence that says what is in
    /// force. The words are keys of the catalogue (`sync-conflict.*`) and the values the person typed; the screens put them in their own language.
    static func view(of entry: SettledConflict) -> ConflictView {
        let mine = entry.peer.other
        func platform(_ side: SyncConflictSide) -> SyncPlatform { side == .local ? mine : entry.peer }
        let winnerPlatform = platform(entry.winner)
        let loserPlatform = platform(entry.winner.other)
        let isSetting = entry.kind == "setting"
        let title = SyncText(kindKeys[entry.kind] ?? "sync-conflict.kind-other")
        let keptText: SyncText
        let lostText: SyncText
        if entry.kind == "order" {
            keptText = SyncText("sync-conflict.row-reordered")
            lostText = keptText
        } else if let field = entry.field {
            keptText = sentence(field: field, value: entry.kept)
            lostText = sentence(field: field, value: entry.lost)
        } else {
            keptText = SyncText("sync-conflict.row-modified")
            lostText = SyncText("sync-conflict.row-deleted")
        }
        let rows = [
            ConflictRow(platform: winnerPlatform, kept: true, text: keptText, at: entry.keptAt),
            ConflictRow(platform: loserPlatform, kept: false, text: lostText, at: entry.lostAt),
        ].sorted { a, b in
            let left = a.at ?? -1, right = b.at ?? -1
            return left != right ? left < right : SyncCanonical.compare(a.platform.rawValue, b.platform.rawValue) < 0
        }
        let outcome: SyncText
        switch entry.reason {
        case .modificationOverDeletion: outcome = SyncText("sync-conflict.outcome-kept")
        case .order: outcome = SyncText(winnerPlatform == .mac ? "sync-conflict.outcome-order-mac" : "sync-conflict.outcome-order-ios")
        case .newer: outcome = SyncText(winnerPlatform == .mac ? "sync-conflict.outcome-newer-mac" : "sync-conflict.outcome-newer-ios")
        case .deviceID, .value: outcome = SyncText(winnerPlatform == .mac ? "sync-conflict.outcome-tie-mac" : "sync-conflict.outcome-tie-ios")
        }
        let settingName: SyncText.Param? = isSetting ? (settingKeys[entry.entityID].map { .text(SyncText($0)) } ?? .literal(entry.entityID)) : nil
        return ConflictView(
            id: entry.id, title: settingName.map { SyncText("sync-conflict.kind-setting-named", $0) } ?? title, label: isSetting ? nil : entry.label, rows: rows, outcome: outcome,
            compare: entry.field != nil || entry.kind == "order", restore: entry.restore)
    }
}

extension SyncText {
    var json: JSONValue {
        .object(["key": .string(key), "params": .array(params.map { param in
            switch param {
            case .literal(let text): return .string(text)
            case .text(let text): return text.json
            }
        })])
    }
}

extension ConflictView {
    /// The view as the vectors write it (`views` of `sync-conflict-vectors.json`).
    var json: JSONValue {
        .object([
            "id": .string(id), "title": title.json, "label": label.map { .string($0) } ?? .null,
            "rows": .array(rows.map { .object(["platform": .string($0.platform.rawValue), "kept": .bool($0.kept), "text": $0.text.json, "at": $0.at.map { .number(Double($0)) } ?? .null]) }),
            "outcome": outcome.json, "compare": .bool(compare), "restore": restore.map(SyncConflicts.json) ?? .null,
        ])
    }
}
