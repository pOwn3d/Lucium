import Foundation

/// The shared Today tabs of docs/synchronisation.md §27, as pure functions: the Swift twin of `src/shared/sync-today.ts`, played against the same vectors
/// (`ios/Contracts/sync-today-vectors.json`). What makes a tab of "Today" enter the shared set (admission, §27.3, §27.4), what the door lets through of a `todayTab`
/// entity that comes in (§27.4, §27.7), and what a patch that removes one kind and creates the other for the same id means (§27.2). A rule that differed from the
/// Mac's would make the two merges start from other inputs, and the session would end in `divergence` (§8.5).
public enum SyncToday {
    /// The kind of the entity (§27.2), distinct from `tab` (the pinned tabs): the two categories are ticked apart.
    public static let kind = "todayTab"
    /// The most Today tabs one device admits at a time [Q12, A]: one that does not fit stays local, and is admitted when a place is free (§27.4).
    public static let cap = 200
    /// The most `todayTab` entities the door keeps in one snapshot (§27.4): an honest device never reaches it.
    public static let gate = 500
    /// The longest address of a shared tab, in bytes: a longer one is left out, never cut (a cut address is another page).
    public static let urlMaxBytes = 4096
    /// The longest title, in bytes: a longer one is cut on a boundary of characters.
    public static let titleMaxBytes = 300
    /// How long a tab must have been open to enter: a window of authentication or a redirection is not shared (§27.3, condition 4).
    public static let minAgeMilliseconds = 20_000
    /// The step `activeAt` is rounded down to: ten minutes (§27.2).
    public static let activeAtStepMilliseconds = 600_000

    /// The classes of the fields of a `todayTab` (§27.2, §10.2). `activeAt` is a projection of `lastActiveAt`; `notApplicable` are the fields of the model that only a
    /// pinned tab has.
    public static let fieldClasses = SyncFieldClasses.Classes(
        synced: ["id", "spaceId", "customTitle", "icon", "activeAt"],
        seed: ["url", "title"],
        local: ["image", "faviconUrl", "deadKept", "autoReload", "container", "windowKey", "openerId", "parentId", "treeCollapsed", "favoriteId", "createdAt", "lastActiveAt", "private", "keepAwake"])
    public static let notApplicable = ["pinned", "anchorUrl", "folderId"]

    // MARK: The activity

    /// `activeAt`: the moment of the last use, rounded down to ten minutes (§27.2). A value that is not finite and positive is 0.
    public static func roundActiveAt(_ lastActiveAt: Double) -> Int {
        guard lastActiveAt.isFinite, lastActiveAt > 0 else { return 0 }
        return Int((lastActiveAt / Double(activeAtStepMilliseconds)).rounded(.down)) * activeAtStepMilliseconds
    }

    /// What a device writes as `lastActiveAt` when it receives an `activeAt`: the greater of the two (§27.5, [Q10]).
    public static func lastActive(local: Double, received: Double) -> Double { max(local, received) }

    // MARK: The address

    /// An http or https address with a host, of at most `urlMaxBytes` bytes: the only pages a shared tab may be on (§27.3, condition 3; §27.7).
    public static func isShareableAddress(_ value: JSONValue?) -> Bool {
        guard case .string(let text)? = value, SyncInbound.isWebAddress(value) else { return false }
        return text.utf8.count <= urlMaxBytes
    }

    // MARK: The admission (§27.3, §27.4)

    public struct Candidate: Equatable, Sendable {
        public var id: String
        public var url: String
        /// How long the tab has been open, in ms.
        public var ageMilliseconds: Int
        /// The raw `lastActiveAt`: it ranks the tabs that compete for a place.
        public var lastActiveAt: Double
        public var isPrivate = false
        /// A tab of a private window (the window, not the tab, is private).
        public var inPrivateWindow = false
        public var isFavoritePage = false
        /// A tab of a container: its address does not leave the device.
        public var inContainer = false
        public var spaceLocked = false
        /// Already in the shared set: the admission is sticky.
        public var admitted = false

        public init(id: String, url: String, ageMilliseconds: Int, lastActiveAt: Double) {
            self.id = id
            self.url = url
            self.ageMilliseconds = ageMilliseconds
            self.lastActiveAt = lastActiveAt
        }
    }

    public enum AdmissionRefusal: String, Sendable {
        case `private`
        case privateWindow = "private-window"
        case favorite, container
        case spaceLocked = "space-locked"
        case notWebAddress = "not-web-address"
        case urlTooLong = "url-too-long"
        case tooYoung = "too-young"
        case full
    }

    public struct Admission: Equatable, Sendable {
        /// The ids of the shared set, sorted by UTF-16 code unit.
        public var admitted: [String]
        /// The ids left out, sorted, with why.
        public var refused: [(id: String, reason: AdmissionRefusal)]

        public static func == (a: Admission, b: Admission) -> Bool {
            a.admitted == b.admitted && a.refused.count == b.refused.count && zip(a.refused, b.refused).allSatisfy { $0.id == $1.id && $0.reason == $1.reason }
        }
    }

    /// Condition 1 is looked at every time; the sticky admission skips only 2 to 5.
    private static func refusalOfKind(_ c: Candidate) -> AdmissionRefusal? {
        if c.isPrivate { return .private }
        if c.inPrivateWindow { return .privateWindow }
        if c.isFavoritePage { return .favorite }
        if c.inContainer { return .container }
        return nil
    }

    /// Conditions 2 to 4 of a tab that is not yet admitted (condition 5, the place, is for `admit`, which sees them all).
    private static func refusalOfEntry(_ c: Candidate) -> AdmissionRefusal? {
        if c.spaceLocked { return .spaceLocked }
        if !SyncInbound.isWebAddress(.string(c.url)) { return .notWebAddress }
        if !isShareableAddress(.string(c.url)) { return .urlTooLong }
        if c.ageMilliseconds < minAgeMilliseconds { return .tooYoung }
        return nil
    }

    /// The shared set at the end of the freeze of a session (§27.3). A tab already admitted stays whatever page it is on and whatever the cap: neither a navigation,
    /// nor a full set, nor a lock set later takes it out of the snapshot, since the merge reads "absent from one side, in the base" as a closing (§11.2). A new tab
    /// enters when it holds conditions 1 to 4, and while there is a place: `cap` less the tabs already admitted, the most recently used first, then the id (§27.4).
    public static func admit(_ candidates: [Candidate], cap: Int = SyncToday.cap) -> Admission {
        var admitted: [String] = []
        var refused: [(id: String, reason: AdmissionRefusal)] = []
        var waiting: [Candidate] = []
        for c in candidates {
            if let reason = refusalOfKind(c) { refused.append((c.id, reason)) }
            else if c.admitted { admitted.append(c.id) }
            else if let reason = refusalOfEntry(c) { refused.append((c.id, reason)) }
            else { waiting.append(c) }
        }
        var room = max(0, cap - admitted.count)
        waiting.sort { a, b in a.lastActiveAt != b.lastActiveAt ? a.lastActiveAt > b.lastActiveAt : SyncCanonical.compare(a.id, b.id) < 0 }
        for c in waiting {
            if room > 0 {
                admitted.append(c.id)
                room -= 1
            } else {
                refused.append((c.id, .full))
            }
        }
        admitted.sort { SyncCanonical.compare($0, $1) < 0 }
        refused.sort { SyncCanonical.compare($0.id, $1.id) < 0 }
        return Admission(admitted: admitted, refused: refused)
    }

    // MARK: The door (§27.4, §27.7)

    public enum Refusal: String, Sendable {
        case invalidURL = "invalid-url"
        case invalidValue = "invalid-value"
        case tooManyTodayTabs = "too-many-today-tabs"
    }

    public struct Gate: Equatable, Sendable {
        /// What passes, by id: the local fields are taken off (with their marks), the title is cut, and an entity refused for what cannot travel now is the one the base holds.
        public var entities: [String: SyncEntity]
        /// Sorted by id.
        public var refused: [(id: String, reason: Refusal)]

        public static func == (a: Gate, b: Gate) -> Bool {
            a.entities == b.entities && a.refused.count == b.refused.count && zip(a.refused, b.refused).allSatisfy { $0.id == $1.id && $0.reason == $1.reason }
        }
    }

    /// A mark of a field of the class "local" has no business in a snapshot (§10.2).
    private static func withoutLocal(_ entity: SyncEntity) -> SyncEntity {
        SyncEntity(fields: entity.fields.filter { !fieldClasses.local.contains($0.key) }, stamps: entity.stamps.filter { !fieldClasses.local.contains($0.key) })
    }

    /// Why one `todayTab` entity cannot be taken as it is: an address that is not a web page (or is too long), an `activeAt` that is not a number. A title is cut, not refused.
    private static func problem(of entity: SyncEntity) -> Refusal? {
        if let url = entity.fields["url"], !isShareableAddress(url) { return .invalidURL }
        if let title = entity.fields["title"] {
            guard case .string = title else { return .invalidValue }
        }
        if let activeAt = entity.fields["activeAt"] {
            guard case .number(let value) = activeAt, value.isFinite, value >= 0 else { return .invalidValue }
        }
        return nil
    }

    private static func activeAt(of entity: SyncEntity) -> Double {
        if case .number(let value)? = entity.fields["activeAt"] { return value }
        return 0
    }

    /// The `todayTab` entities of a snapshot that comes in, or that this device is about to send (both devices must start from the same inputs). An entity refused for its
    /// address or a value, and the ones beyond the `limit` best ranked (`activeAt`, newest first, then the id), are dropped and listed; one that is in `base` is given back as the
    /// base holds it, so that the gap is not read as a deletion by the other device (the rule of §22). Never fatal. The generic checks of the door (a mark in the future, a
    /// kind that is never synchronised) are those of `SyncInbound.clean`, which calls this for the kind.
    public static func gate(_ entities: [String: SyncEntity], base: [String: SyncEntity]? = nil, limit: Int = SyncToday.gate) -> Gate {
        var passed: [String: SyncEntity] = [:]
        var refused: [(id: String, reason: Refusal)] = []
        func standIn(_ id: String) { if let before = base?[id] { passed[id] = before } }
        var ranked: [String] = []
        for (id, entity) in entities {
            if let reason = problem(of: entity) {
                refused.append((id, reason))
                standIn(id)
                continue
            }
            var clean = withoutLocal(entity)
            if case .string(let title)? = clean.fields["title"] { clean.fields["title"] = .string(SyncStateView.cut(title, bytes: titleMaxBytes)) }
            passed[id] = clean
            ranked.append(id)
        }
        if ranked.count > limit {
            ranked.sort { a, b in
                let (x, y) = (activeAt(of: passed[a]!), activeAt(of: passed[b]!))
                return x != y ? x > y : SyncCanonical.compare(a, b) < 0
            }
            for id in ranked.dropFirst(limit) {
                refused.append((id, .tooManyTodayTabs))
                passed[id] = nil
                standIn(id)
            }
        }
        refused.sort { SyncCanonical.compare($0.id, $1.id) < 0 }
        return Gate(entities: passed, refused: refused)
    }

    // MARK: Pinning and unpinning (§27.2)

    public struct Move: Equatable, Sendable {
        public var id: String
        /// `todayTab` → `tab` is a pinning; `tab` → `todayTab` is a detaching.
        public var from: String
        public var to: String
    }

    /// Which of the patch's creations and removals are one tab changing list: a removal of `todayTab/<id>` with a creation of `tab/<id>` in the same patch (or the other way
    /// round). A removal alone is a closing, a creation alone an opening. Sorted by id.
    public static func moves(removed: [(kind: String, id: String)], created: [(kind: String, id: String)]) -> [Move] {
        let removedToday = Set(removed.filter { $0.kind == kind }.map(\.id))
        let removedPinned = Set(removed.filter { $0.kind == "tab" }.map(\.id))
        var moves: [Move] = []
        for c in created {
            if c.kind == "tab", removedToday.contains(c.id) { moves.append(Move(id: c.id, from: kind, to: "tab")) }
            else if c.kind == kind, removedPinned.contains(c.id) { moves.append(Move(id: c.id, from: "tab", to: kind)) }
        }
        return moves.sorted { SyncCanonical.compare($0.id, $1.id) < 0 }
    }
}
