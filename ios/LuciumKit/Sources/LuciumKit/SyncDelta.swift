import Foundation

/// The Swift twin of `src/shared/sync-delta.ts` (docs/synchronisation.md §31): the difference between a snapshot and the base two devices share, which a device sends
/// instead of its whole snapshot, and what the other does to rebuild the snapshot from its own copy of the base. Played against the same vectors as the Mac
/// (`ios/Contracts/sync-delta-vectors.json`): change one side and the other fails.
///
/// A difference names nothing by its kind: an entity of a kind this version does not know is compared like any other, so that it is never "removed" by a device that
/// does not understand it (§11.6): the snapshot that is compared already carries such entities as the base holds them.
public struct SyncDelta: Equatable, Sendable {
    /// An entity or a tombstone that the difference takes out of the base.
    public struct Removal: Equatable, Sendable {
        public var kind: String
        public var id: String

        public init(kind: String, id: String) {
            self.kind = kind
            self.id = id
        }
    }

    /// What is new or changed, in the form of a snapshot: the entities and the tombstones whole, the lists whole with their mark.
    public var snapshot: SyncSnapshot
    public var removedEntities: [Removal]
    public var removedTombstones: [Removal]
    public var removedLists: [String]

    public init(snapshot: SyncSnapshot = SyncSnapshot(), removedEntities: [Removal] = [], removedTombstones: [Removal] = [], removedLists: [String] = []) {
        self.snapshot = snapshot
        self.removedEntities = removedEntities
        self.removedTombstones = removedTombstones
        self.removedLists = removedLists
    }

    private static func ordered(_ a: Removal, _ b: Removal) -> Bool {
        let kind = SyncCanonical.compare(a.kind, b.kind)
        return kind != 0 ? kind < 0 : SyncCanonical.compare(a.id, b.id) < 0
    }

    /// What `snapshot` has that `base` does not, and what `base` has that `snapshot` does not (§31.2). The removals are sorted by UTF-16 order.
    public static func diff(base: SyncSnapshot, snapshot: SyncSnapshot) -> SyncDelta {
        var delta = SyncDelta()
        for (kind, byID) in snapshot.entities {
            for (id, entity) in byID where base.entities[kind]?[id] != entity { delta.snapshot.entities[kind, default: [:]][id] = entity }
        }
        for (kind, byID) in base.entities {
            for id in byID.keys where snapshot.entities[kind]?[id] == nil { delta.removedEntities.append(Removal(kind: kind, id: id)) }
        }
        for (kind, byID) in snapshot.tombstones {
            for (id, stamp) in byID where base.tombstones[kind]?[id] != stamp { delta.snapshot.tombstones[kind, default: [:]][id] = stamp }
        }
        for (kind, byID) in base.tombstones {
            for id in byID.keys where snapshot.tombstones[kind]?[id] == nil { delta.removedTombstones.append(Removal(kind: kind, id: id)) }
        }
        // A list is its ids and its mark of order; a mark may stand without a list (the draws of the tests have them, a merge does not write them), and is compared on its own.
        for (key, ids) in snapshot.order {
            let stamp = snapshot.orderStamps[key]
            if let before = base.order[key], before == ids, base.orderStamps[key] == stamp { continue }
            delta.snapshot.order[key] = ids
            if let stamp { delta.snapshot.orderStamps[key] = stamp }
        }
        for (key, stamp) in snapshot.orderStamps where snapshot.order[key] == nil && (base.order[key] != nil || base.orderStamps[key] != stamp) {
            delta.snapshot.orderStamps[key] = stamp
        }
        for key in Set(base.order.keys).union(base.orderStamps.keys) where snapshot.order[key] == nil && (base.order[key] != nil || snapshot.orderStamps[key] == nil) {
            delta.removedLists.append(key)
        }
        delta.removedEntities.sort(by: ordered)
        delta.removedTombstones.sort(by: ordered)
        delta.removedLists.sort { SyncCanonical.compare($0, $1) < 0 }
        return delta
    }

    /// The snapshot a difference makes of a base (§31.3), or the reason it does not: a removal that names something the base does not hold, or a `(kind, id)` that is
    /// both written and removed. That the result is the snapshot the sender meant is the caller's to check (the count and the digest of `snapshot.end`).
    public static func apply(_ delta: SyncDelta, to base: SyncSnapshot) -> Result<SyncSnapshot, Problem> {
        var snapshot = base
        for removal in delta.removedEntities {
            guard snapshot.entities[removal.kind]?[removal.id] != nil else { return .failure(Problem("a removed entity that the base does not hold")) }
            guard delta.snapshot.entities[removal.kind]?[removal.id] == nil else { return .failure(Problem("an entity both written and removed")) }
            snapshot.entities[removal.kind]?[removal.id] = nil
            if snapshot.entities[removal.kind]?.isEmpty == true { snapshot.entities[removal.kind] = nil }
        }
        for removal in delta.removedTombstones {
            guard snapshot.tombstones[removal.kind]?[removal.id] != nil else { return .failure(Problem("a removed tombstone that the base does not hold")) }
            guard delta.snapshot.tombstones[removal.kind]?[removal.id] == nil else { return .failure(Problem("a tombstone both written and removed")) }
            snapshot.tombstones[removal.kind]?[removal.id] = nil
            if snapshot.tombstones[removal.kind]?.isEmpty == true { snapshot.tombstones[removal.kind] = nil }
        }
        for key in delta.removedLists {
            guard snapshot.order[key] != nil || snapshot.orderStamps[key] != nil else { return .failure(Problem("a removed list that the base does not hold")) }
            guard delta.snapshot.order[key] == nil else { return .failure(Problem("a list both written and removed")) }
            snapshot.order[key] = nil
            snapshot.orderStamps[key] = nil
        }
        for (kind, byID) in delta.snapshot.entities { for (id, entity) in byID { snapshot.entities[kind, default: [:]][id] = entity } }
        for (kind, byID) in delta.snapshot.tombstones { for (id, stamp) in byID { snapshot.tombstones[kind, default: [:]][id] = stamp } }
        for (key, ids) in delta.snapshot.order {
            snapshot.order[key] = ids
            if delta.snapshot.orderStamps[key] == nil { snapshot.orderStamps[key] = nil }
        }
        for (key, stamp) in delta.snapshot.orderStamps { snapshot.orderStamps[key] = stamp }
        return .success(snapshot)
    }

    /// Why a difference does not fit its base: for the log, never shown.
    public struct Problem: Error, Equatable, Sendable {
        public let message: String
        init(_ message: String) { self.message = message }
    }
}
