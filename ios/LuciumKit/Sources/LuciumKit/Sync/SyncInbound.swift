import Foundation

/// What an entity that comes in may carry before it reaches the merge and the state (docs/synchronisation.md §8.5, §10): the Swift twin of
/// `src/main/sync/inbound-filter.ts`, played against the same vectors (`inbound` of `ios/Contracts/sync-message-vectors.json`). It is a gate applied to every
/// entity of a received snapshot, in addition to the bounds of the form (`SyncSnapshot.read`), and to this phone's own entities before they are sent: the two
/// merges must start from the same inputs, so what a device sends is what the other would accept.
///
///   - a kind that is code or a secret is refused (`never-synced`), whatever the device says;
///   - a setting is accepted only if it is in the closed list and its value is one this version would write (`not-synced`, `invalid-value`);
///   - a tab is accepted only if it is pinned and not private (`not-pinned`, `private`): the Today tabs are not entities;
///   - an address is accepted only if it is an http or https address (`invalid-url`): a page, never a script or a file;
///   - the fields of the class "local" are taken off: a device does not tell this one what its local files are;
///   - the search engine is accepted only if it is one of those the Mac offers (`SearchEngine.presets`, all https): an engine of one's own stays where it is, and a device cannot send
///     the searches of another to a server of its choice (`invalid-value`; review n° 10);
///   - an entity of a kind this version does not know, and a field of a known kind it does not know, cross as they are (§11.6);
///   - the profile of a space or a favourite must be an identifier of the Mac (`BrowserState.isProfileId`): the key of a list is made of it (`invalid-value`; review n° 16);
///   - the tombstones of a kind that is code or a secret are refused (`never-synced`), and a side keeps at most `maxTombstonesPerSnapshot` of the newest (review n° 14).
/// A refused entity is dropped, counted and logged: never fatal (§8.5).
public enum SyncInbound {
    public enum Refusal: String, Sendable {
        case neverSynced = "never-synced"
        case notSynced = "not-synced"
        case invalidValue = "invalid-value"
        case notPinned = "not-pinned"
        case `private`
        case invalidURL = "invalid-url"
        case futureMark = "future-mark"
        case tooManyTombstones = "too-many-tombstones"
    }

    public enum Verdict: Equatable, Sendable {
        case accepted(fields: [String: JSONValue])
        case refused(Refusal)
    }

    public struct Refused: Equatable, Sendable {
        public let kind: String
        public let id: String
        public let reason: Refusal
    }

    /// What a device sent, cut down to the kinds this session exchanges (§5 [Q2], §11.6): an honest device sends nothing of a category that is not common, so what is left
    /// out came from one that does not keep to them, and it is not applied (the settings of privacy, the archive, the spaces of a device whose structure is not ticked here).
    /// The twin of `onlyExchanged` in `src/main/sync/state-view.ts`: the kinds this version does not know cross whatever is ticked, and a list is of the kind it orders.
    public static func onlyExchanged(_ snapshot: SyncSnapshot, categories: Set<SyncCategory>) -> (snapshot: SyncSnapshot, refused: [Refused]) {
        var refused: [Refused] = []
        func kept(_ kind: String) -> Bool { SyncStateView.isExchanged(kind: kind, categories: categories) }
        func listKept(_ key: String) -> Bool { SyncMarkBook.listKind(of: key).map(kept) ?? true }
        var result = SyncSnapshot()
        for (kind, byID) in snapshot.entities {
            if kept(kind) { result.entities[kind] = byID } else { refused += byID.keys.map { Refused(kind: kind, id: $0, reason: .notSynced) } }
        }
        for (kind, byID) in snapshot.tombstones {
            if kept(kind) { result.tombstones[kind] = byID } else { refused += byID.keys.map { Refused(kind: "tombstone", id: "\(kind)/\($0)", reason: .notSynced) } }
        }
        for (key, ids) in snapshot.order {
            if listKept(key) { result.order[key] = ids } else { refused.append(Refused(kind: "order", id: key, reason: .notSynced)) }
        }
        for (key, stamp) in snapshot.orderStamps where listKept(key) { result.orderStamps[key] = stamp }
        refused.sort { a, b in
            let kind = SyncCanonical.compare(a.kind, b.kind)
            return kind != 0 ? kind < 0 : SyncCanonical.compare(a.id, b.id) < 0
        }
        return (result, refused)
    }

    public struct Cleaned: Equatable, Sendable {
        public var snapshot: SyncSnapshot
        /// Sorted by kind then id, so that a log line does not depend on the order of a dictionary.
        public var refused: [Refused]
    }

    /// A mark more than seven days ahead of this device's clock: the device that wrote it has the wrong time, and its entity would win every conflict for ever (§9.3).
    public static let futureRefusalMilliseconds = 604_800_000

    /// The refusals that say "this cannot be sent now" (the marks, the address, the value): the version of the base stands in.
    private static let standsInAsInTheBase: Set<Refusal> = [.futureMark, .invalidURL, .invalidValue]

    /// The ceiling of a delay of automatic archiving accepted from another device: a year of hours.
    private static let archiveHoursMax = 24.0 * 366

    /// The longest name of a profile (`PROFILE_NAME_MAX` of the Mac, in UTF-16 units like JavaScript's `length`).
    private static let profileNameMax = 40

    // MARK: An address

    /// An http or https address that parses: the only kind of page worth synchronising (a script, a file or a data address is refused). The scheme is read like the
    /// Mac's (`/^https?:\/\//i`), and what follows must have a host: the Mac asks `URL.canParse`, this asks `URL(string:)`. The two parsers read the same way every
    /// address a person opens; an exotic one that only one of them reads is refused on that side alone, which the digests of the session turn into `divergence`
    /// (nothing is written), never into a wrong state.
    public static func isWebAddress(_ value: JSONValue?) -> Bool {
        guard case .string(let text)? = value else { return false }
        let lower = text.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return false }
        // Extra slashes after the scheme are ignored by the web's URL parser (`https:///a.example/`): the same is done here before the host is looked for.
        guard let colon = text.firstIndex(of: ":") else { return false }
        var rest = text[text.index(after: colon)...]
        while rest.hasPrefix("/") { rest = rest.dropFirst() }
        guard let url = URL(string: String(text[...colon]) + "//" + String(rest)), let host = url.host(percentEncoded: true), !host.isEmpty else { return false }
        return true
    }

    // MARK: An entity

    private static let urlFields: [SyncFieldClasses.Kind: [String]] = [.tab: ["url", "anchorUrl"], .favorite: ["url"], .archived: ["url", "anchorUrl"]]

    /// Whether a value is not one this version would write for a synchronised setting.
    static func settingValueIsInvalid(key: String, value: JSONValue?) -> Bool {
        switch key {
        case "httpsUpgrade", "sendGpc", "stripTrackingParams", "stripCopiedLinks":
            if case .bool? = value { return false }
            return true
        case "protectionBaseline":
            if case .string(let level)? = value { return level != "standard" && level != "renforcee" }
            return true
        case "autoArchiveHours":
            if case .number(let hours)? = value { return !hours.isFinite || hours < 0 || hours > archiveHoursMax }
            return true
        case "searchUrlTemplate":
            guard case .string(let template)? = value else { return true }
            return !SearchEngine.isPreset(template)
        case "profileNames":
            guard case .object(let names)? = value, names.count <= 64 else { return true }
            return !names.allSatisfy { id, name in
                guard isProfileKey(id), case .string(let text) = name else { return false }
                return text.utf16.count <= profileNameMax
            }
        default:
            return true
        }
    }

    /// `/^[A-Za-z0-9_-]{1,64}$/`.
    private static func isProfileKey(_ key: String) -> Bool {
        (1...64).contains(key.utf8.count) && key.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }
    }

    public static func filter(kind: String, id: String, fields: [String: JSONValue]) -> Verdict {
        if SyncFieldClasses.neverKinds.contains(kind) { return .refused(.neverSynced) }
        if kind == "setting" {
            guard SyncFieldClasses.settingKeys.contains(id) else { return .refused(.notSynced) }
            if settingValueIsInvalid(key: id, value: fields["value"]) { return .refused(.invalidValue) }
            return .accepted(fields: ["value": fields["value"] ?? .null])
        }
        guard let known = SyncFieldClasses.kind(kind), let classes = SyncFieldClasses.classes[known] else { return .accepted(fields: fields) }
        // The key of a list is made of the profile (`favorites:<profile>`): an identifier of the Mac, or nothing.
        if known == .space || known == .favorite, let profile = fields["profileId"] {
            guard case .string(let text) = profile, BrowserState.isProfileId(text) else { return .refused(.invalidValue) }
        }
        if known == .tab {
            if case .bool(true)? = fields["private"] { return .refused(.private) }
            guard case .bool(true)? = fields["pinned"] else { return .refused(.notPinned) }
        }
        let kept = fields.filter { !classes.local.contains($0.key) }
        for name in urlFields[known] ?? [] {
            if let value = kept[name], !isWebAddress(value) { return .refused(.invalidURL) }
        }
        return .accepted(fields: kept)
    }

    // MARK: A snapshot

    /// The time a mark says (its first thirteen digits), 0 for the mark "zero".
    private static func milliseconds(of stamp: String) -> Int {
        stamp == SyncStamp.zero ? 0 : (Int(stamp.prefix(13)) ?? 0)
    }

    private static func marksTheFuture(_ stamp: String, now: Int) -> Bool { milliseconds(of: stamp) > now + futureRefusalMilliseconds }

    private static func isInTheFuture(_ entity: SyncEntity, now: Int) -> Bool {
        entity.stamps.values.contains { marksTheFuture($0, now: now) }
    }

    /// A snapshot with what passes: the refused entities are dropped (and listed so that the session counts and logs them), and the local fields of the others are
    /// taken off, with their marks. A tombstone, or a list with its mark of order, whose mark is more than seven days ahead is dropped and listed the same way (kind
    /// `tombstone` or `order`, §9.3: the merge keeps the greatest mark it sees and the book never lets its clock fall behind one it has seen, so a single such mark
    /// would delete what it names and push the clock out of the reach of every other device). What the others are made of is left to the merge, which treats an id
    /// it does not know as nothing.
    ///
    /// `base` is the base of the session (nil when there is none): an entity that is in it and is refused for its marks, its address or its value (`futureMark`,
    /// `invalidURL`, `invalidValue`) is given back as the base holds it, unchanged, and not dropped. The merge reads an entity that is in the base and not in a snapshot as
    /// deleted, and the other device would lose it: a clock a week ahead, an address that stopped being a web page, is "this cannot travel now", not "this was deleted".
    /// One refused for what it is (`notPinned`, `private`, a kind that is never synchronised) is dropped, and the other device deletes it: it left what is synchronised.
    /// The same rule as the Mac's `cleanSnapshot` (docs/synchronisation.md §22), for what comes in and for what is sent.
    public static func clean(_ snapshot: SyncSnapshot, now: Int, base: SyncSnapshot? = nil) -> Cleaned {
        var refused: [Refused] = []
        var entities: [String: [String: SyncEntity]] = [:]
        for (kind, byID) in snapshot.entities {
            for (id, entity) in byID {
                let verdict: Verdict = isInTheFuture(entity, now: now) ? .refused(.futureMark) : filter(kind: kind, id: id, fields: entity.fields)
                switch verdict {
                case .refused(let reason):
                    refused.append(Refused(kind: kind, id: id, reason: reason))
                    if standsInAsInTheBase.contains(reason), let before = base?.entities[kind]?[id] { entities[kind, default: [:]][id] = before }
                case .accepted(let fields):
                    var stamps = entity.stamps
                    if let known = SyncFieldClasses.kind(kind), let classes = SyncFieldClasses.classes[known] {
                        stamps = stamps.filter { !classes.local.contains($0.key) }
                    }
                    entities[kind, default: [:]][id] = SyncEntity(fields: fields, stamps: stamps)
                }
            }
        }
        var tombstones: [String: [String: String]] = [:]
        var standing: [(kind: String, id: String, stamp: String)] = []
        for (kind, byID) in snapshot.tombstones {
            for (id, stamp) in byID {
                if SyncFieldClasses.neverKinds.contains(kind) {
                    refused.append(Refused(kind: "tombstone", id: "\(kind)/\(id)", reason: .neverSynced))
                    continue
                }
                if marksTheFuture(stamp, now: now) {
                    refused.append(Refused(kind: "tombstone", id: "\(kind)/\(id)", reason: .futureMark))
                    continue
                }
                standing.append((kind, id, stamp))
            }
        }
        // At most `maxTombstonesPerSnapshot` of them, the newest (a tie goes to the smaller kind then id, so that both devices keep the same ones): the merge keeps the tombstones
        // of both sides, and a base that holds twice what a snapshot may is a base nobody can read.
        if standing.count > SyncLimits.maxTombstonesPerSnapshot {
            standing.sort { a, b in
                let byStamp = SyncStamp.compare(b.stamp, a.stamp)
                if byStamp != 0 { return byStamp < 0 }
                let byKind = SyncCanonical.compare(a.kind, b.kind)
                return byKind != 0 ? byKind < 0 : SyncCanonical.compare(a.id, b.id) < 0
            }
            standing = Array(standing.prefix(SyncLimits.maxTombstonesPerSnapshot))
            refused.append(Refused(kind: "tombstone", id: "*", reason: .tooManyTombstones))
        }
        for one in standing { tombstones[one.kind, default: [:]][one.id] = one.stamp }
        var order: [String: [String]] = [:]
        var orderStamps: [String: String] = [:]
        for (key, ids) in snapshot.order {
            let stamp = snapshot.orderStamps[key]
            if let stamp, marksTheFuture(stamp, now: now) {
                refused.append(Refused(kind: "order", id: key, reason: .futureMark))
                continue
            }
            order[key] = ids
            if let stamp { orderStamps[key] = stamp }
        }
        // A mark of order with no list (a list that went empty keeps none, §11.4) is checked and kept the same way.
        for (key, stamp) in snapshot.orderStamps where snapshot.order[key] == nil && !marksTheFuture(stamp, now: now) { orderStamps[key] = stamp }
        let cleaned = SyncSnapshot(entities: entities, tombstones: tombstones, order: order, orderStamps: orderStamps)
        refused.sort { a, b in
            let kind = SyncCanonical.compare(a.kind, b.kind)
            return kind != 0 ? kind < 0 : SyncCanonical.compare(a.id, b.id) < 0
        }
        return Cleaned(snapshot: cleaned, refused: refused)
    }
}
