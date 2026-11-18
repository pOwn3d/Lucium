import Foundation

/// What a session changes in the state (docs/synchronisation.md §8.5): the difference between the snapshot this device froze and the one the merge gave, as the
/// patch that is written into the state. The Swift twin of `src/main/sync/patch.ts` (`buildPatch`) and of `sync/apply` (`src/shared/sidebar-sync.ts`). It carries, for
/// each field it changes, what the field held when the snapshot was frozen: a field the person changed in the meantime keeps their change, and the next session
/// sends it. Played against the same vectors as the Mac's (`ios/Contracts/sync-patch-vectors.json`).
public struct SyncPatch: Equatable, Sendable {
    public struct Upsert: Equatable, Sendable {
        public var kind: SyncFieldClasses.Kind
        public var id: String
        /// The entity is new here: it is made, with its seed fields.
        public var create: Bool
        /// The fields to set.
        public var fields: [String: JSONValue]
        /// The fields to take away.
        public var remove: [String]
        /// What each field named above held when the session froze its snapshot (absent: it was absent): the field is touched only while it still does.
        public var expect: [String: JSONValue]

        public init(kind: SyncFieldClasses.Kind, id: String, create: Bool, fields: [String: JSONValue], remove: [String], expect: [String: JSONValue]) {
            self.kind = kind
            self.id = id
            self.create = create
            self.fields = fields
            self.remove = remove
            self.expect = expect
        }
    }

    public struct Removal: Equatable, Sendable {
        public var kind: SyncFieldClasses.Kind
        public var id: String
        /// The synchronised fields the entity had when frozen: it is removed only while it still has exactly these.
        public var expect: [String: JSONValue]

        public init(kind: SyncFieldClasses.Kind, id: String, expect: [String: JSONValue]) {
            self.kind = kind
            self.id = id
            self.expect = expect
        }
    }

    public var upserts: [Upsert] = []
    public var removals: [Removal] = []
    /// List key → the ids in their new order.
    public var order: [String: [String]] = [:]
    /// The settings to write, by key.
    public var settings: [String: JSONValue] = [:]

    public init() {}

    public var isEmpty: Bool { upserts.isEmpty && removals.isEmpty && order.isEmpty && settings.isEmpty }

    // MARK: Building

    /// Whether an entity belongs to a space that is set aside: the space itself, or what holds its `spaceId`.
    private static func isSetAside(kind: String, id: String, entity: SyncEntity, withheld: Set<String>) -> Bool {
        if kind == "space" { return withheld.contains(id) }
        if case .string(let space)? = entity.fields["spaceId"] { return withheld.contains(space) }
        return false
    }

    /// The list keys that name a space set aside.
    private static func isListOfSpaceAside(_ key: String, withheld: Set<String>) -> Bool {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        return (parts[0] == "folders" || parts[0] == "tabs") && parts.count > 1 && withheld.contains(parts[1])
    }

    /// What belongs to a space set aside (a locked one) is left out of the patch whatever the merge says: the merge took those spaces out of its three inputs, so it
    /// gives none of them back, and "not in the merged snapshot" would otherwise read as "deleted".
    public static func build(frozen: SyncSnapshot, merged: SyncSnapshot, withheld: Set<String>) -> SyncPatch {
        var patch = SyncPatch()
        let byText: (String, String) -> Bool = { SyncCanonical.compare($0, $1) < 0 }
        for kind in SyncFieldClasses.Kind.allCases {
            let before = frozen.entities[kind.rawValue] ?? [:]
            let after = merged.entities[kind.rawValue] ?? [:]
            for id in after.keys.sorted(by: byText) {
                guard let entity = after[id], !isSetAside(kind: kind.rawValue, id: id, entity: entity, withheld: withheld) else { continue }
                let old = before[id]
                var change = Upsert(kind: kind, id: id, create: old == nil, fields: [:], remove: [], expect: [:])
                var names = Set(entity.fields.keys)
                names.formUnion(old?.fields.keys.map { $0 } ?? [])
                for name in names.sorted(by: byText) {
                    let had = old?.fields[name]
                    let has = entity.fields[name]
                    if old != nil, SyncCanonical.same(had, has) { continue }
                    if let had { change.expect[name] = had }
                    if let has { change.fields[name] = has } else { change.remove.append(name) }
                }
                if old == nil || !change.fields.isEmpty || !change.remove.isEmpty { patch.upserts.append(change) }
            }
            for id in before.keys.sorted(by: byText) {
                guard let entity = before[id], after[id] == nil, !isSetAside(kind: kind.rawValue, id: id, entity: entity, withheld: withheld) else { continue }
                patch.removals.append(Removal(kind: kind, id: id, expect: entity.fields))
            }
        }
        for (key, ids) in merged.order {
            if isListOfSpaceAside(key, withheld: withheld) { continue }
            if let old = frozen.order[key], old.count == ids.count, zip(old, ids).allSatisfy({ SyncCanonical.identical($0, $1) }) { continue }
            patch.order[key] = ids
        }
        for (key, entity) in merged.entities["setting"] ?? [:] {
            guard let value = entity.fields["value"] else { continue }
            if !SyncCanonical.same(frozen.entities["setting"]?[key]?.fields["value"], value) { patch.settings[key] = value }
        }
        return patch
    }

    /// The patch as JSON, in the form the shared vectors give it (`ios/Contracts/sync-patch-vectors.json`).
    public var json: JSONValue {
        .object([
            "upserts": .array(upserts.map { change in
                .object(["kind": .string(change.kind.rawValue), "id": .string(change.id), "create": .bool(change.create), "fields": .object(change.fields),
                         "remove": .array(change.remove.map { .string($0) }), "expect": .object(change.expect)])
            }),
            "removals": .array(removals.map { .object(["kind": .string($0.kind.rawValue), "id": .string($0.id), "expect": .object($0.expect)]) }),
            "order": .object(order.mapValues { .array($0.map { .string($0) }) }),
            "settings": .object(settings),
        ])
    }
}
