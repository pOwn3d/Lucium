import Foundation

/// A snapshot on the wire (docs/synchronisation.md §7.3, §8.3): cut in `snapshot.part`s that each fit a frame, and put back together from the parts that come in,
/// with every number the other device gave checked. The Swift twin of `partsOf` and `receiveSnapshot` of `src/main/sync/session.ts`.
public enum SyncSnapshotParts {
    /// The bytes a part may weigh before the next one starts: well under a frame (§7.5).
    static let partBytes = 600_000

    // MARK: Sending

    /// What a snapshot sent as a difference says besides its entities, tombstones and lists (§31.2): the base it is with, and what it takes out of that base.
    public struct Difference: Equatable, Sendable {
        public var base: String
        public var removedEntities: [SyncDelta.Removal]
        public var removedTombstones: [SyncDelta.Removal]
        public var removedLists: [String]
    }

    /// The difference between the snapshot of this device and the base the two share, cut in parts ready to be sent (§31.2).
    public static func parts(differingFrom base: SyncSnapshot, hash: String, of snapshot: SyncSnapshot, withheld: [String]) -> [[String: JSONValue]] {
        let delta = SyncDelta.diff(base: base, snapshot: snapshot)
        return parts(of: delta.snapshot, withheld: withheld, difference: Difference(base: hash, removedEntities: delta.removedEntities, removedTombstones: delta.removedTombstones, removedLists: delta.removedLists))
    }

    /// The snapshot cut in parts, each the body of a `snapshot.part` (the envelope is added when it is written): the entities first, then the tombstones, then the
    /// lists; the first part names the spaces set aside. Entities and lists are taken in the order of their identifiers, so that the same snapshot is always cut the
    /// same way.
    public static func parts(of snapshot: SyncSnapshot, withheld: [String], difference: Difference? = nil) -> [[String: JSONValue]] {
        struct Part {
            var entities: [JSONValue] = []
            var tombstones: [JSONValue] = []
            var order: [String: JSONValue] = [:]
            var orderStamps: [String: JSONValue] = [:]
            var removedEntities: [JSONValue] = []
            var removedTombstones: [JSONValue] = []
            var removedLists: [JSONValue] = []
            var weight = 0
        }
        var parts: [Part] = []
        var current = Part()
        func room(_ weight: Int, entities: Int = 0) {
            if current.weight > 0, current.weight + weight > partBytes || current.entities.count + entities > SyncLimits.maxEntitiesPerPart {
                parts.append(current)
                current = Part()
            }
            current.weight += weight
        }
        func size(_ value: JSONValue) -> Int { SyncCanonical.text(value)?.utf8.count ?? 0 }
        let byText: (String, String) -> Bool = { SyncCanonical.compare($0, $1) < 0 }
        for kind in snapshot.entities.keys.sorted(by: byText) {
            let byID = snapshot.entities[kind] ?? [:]
            for id in byID.keys.sorted(by: byText) {
                guard let entity = byID[id] else { continue }
                let wire = JSONValue.object(["kind": .string(kind), "id": .string(id), "fields": .object(entity.fields), "stamps": .object(entity.stamps.mapValues { .string($0) })])
                room(size(wire), entities: 1)
                current.entities.append(wire)
            }
        }
        for kind in snapshot.tombstones.keys.sorted(by: byText) {
            let byID = snapshot.tombstones[kind] ?? [:]
            for id in byID.keys.sorted(by: byText) {
                let wire = JSONValue.object(["kind": .string(kind), "id": .string(id), "stamp": .string(byID[id] ?? SyncStamp.zero)])
                room(size(wire))
                current.tombstones.append(wire)
            }
        }
        for key in snapshot.order.keys.sorted(by: byText) {
            let ids = JSONValue.array((snapshot.order[key] ?? []).map { .string($0) })
            room(size(ids) + key.utf8.count + 80)
            current.order[key] = ids
            current.orderStamps[key] = .string(snapshot.orderStamps[key] ?? SyncStamp.zero)
        }
        if let difference {
            func removal(_ one: SyncDelta.Removal) -> JSONValue { .object(["kind": .string(one.kind), "id": .string(one.id)]) }
            for one in difference.removedEntities {
                let wire = removal(one)
                room(size(wire))
                current.removedEntities.append(wire)
            }
            for one in difference.removedTombstones {
                let wire = removal(one)
                room(size(wire))
                current.removedTombstones.append(wire)
            }
            for key in difference.removedLists {
                room(key.utf8.count + 4)
                current.removedLists.append(.string(key))
            }
        }
        parts.append(current)
        return parts.enumerated().map { index, part in
            var body: [String: JSONValue] = ["part": .number(Double(index)), "parts": .number(Double(parts.count)), "entities": .array(part.entities)]
            if !part.tombstones.isEmpty { body["tombstones"] = .array(part.tombstones) }
            if !part.order.isEmpty {
                body["order"] = .object(part.order)
                body["orderStamps"] = .object(part.orderStamps)
            }
            if !part.removedEntities.isEmpty { body["removedEntities"] = .array(part.removedEntities) }
            if !part.removedTombstones.isEmpty { body["removedTombstones"] = .array(part.removedTombstones) }
            if !part.removedLists.isEmpty { body["removedLists"] = .array(part.removedLists) }
            if index == 0 {
                body["withheld"] = .array(withheld.map { .string($0) })
                if let difference { body["base"] = .string(difference.base) }
            }
            return body
        }
    }

    // MARK: Receiving

    /// What was put together from the parts that came in.
    public struct Assembled: Equatable, Sendable {
        public var snapshot: SyncSnapshot
        public var entityCount: Int
        /// The ids of the spaces the other device set aside (§18).
        public var withheld: Set<String>
    }

    /// Reads `snapshot.part`s up to `snapshot.end`, checking every number the other device gave.
    public struct Assembler: Sendable {
        private var snapshot = SyncSnapshot()
        private var withheld = Set<String>()
        private var parts: Int?
        private var next = 0
        private var entityCount = 0
        /// The base a first part said this snapshot is a difference with (§31.2), and what the parts take out of it.
        private var difference: String?
        private var removed = SyncDelta()
        /// Whether a difference is agreed (§31.1): without it, a part that says `base` is a bad message.
        private let differencesAgreed: Bool

        public init(differencesAgreed: Bool = false) { self.differencesAgreed = differencesAgreed }

        /// Adds one part (the whole JSON of the message). A part out of its place, an entity twice, a bound exceeded are `bad-message` or `too-large`.
        public mutating func add(_ message: JSONValue) throws {
            guard case .object(let fields) = message, case .number(let part)? = fields["part"], case .number(let total)? = fields["parts"], case .array(let entities)? = fields["entities"],
                  let partIndex = Int(exactly: part), let partCount = Int(exactly: total) else {
                throw SyncFailure(.badMessage, "a part of a snapshot with no part, parts or entities")
            }
            if parts == nil { parts = partCount }
            guard partCount == parts, partIndex == next else { throw SyncFailure(.badMessage, "the parts do not follow one another") }
            if case .string(let base)? = fields["base"] {
                guard differencesAgreed else { throw SyncFailure(.badMessage, "a difference where none was agreed") }
                guard partIndex == 0 else { throw SyncFailure(.badMessage, "the base of a difference is said in the first part only") }
                difference = base
            }
            if difference == nil, fields["removedEntities"] != nil || fields["removedTombstones"] != nil || fields["removedLists"] != nil { throw SyncFailure(.badMessage, "a removal in a whole snapshot") }
            next += 1
            for item in entities {
                guard case .object(let wire) = item, case .string(let kind)? = wire["kind"], case .string(let id)? = wire["id"], case .object(let entityFields)? = wire["fields"], case .object(let rawStamps)? = wire["stamps"] else {
                    throw SyncFailure(.badMessage, "an entity that is not one")
                }
                if snapshot.entities[kind]?[id] != nil { throw SyncFailure(.badMessage, "an entity is twice in a snapshot") }
                var stamps: [String: String] = [:]
                for (name, stamp) in rawStamps {
                    guard case .string(let text) = stamp else { throw SyncFailure(.badMessage, "a mark that is not a text") }
                    stamps[name] = text
                }
                snapshot.entities[kind, default: [:]][id] = SyncEntity(fields: entityFields, stamps: stamps)
                entityCount += 1
                if entityCount > SyncLimits.maxEntities { throw SyncFailure(.tooLarge, "a snapshot of more entities than the bound") }
            }
            if case .array(let tombstones)? = fields["tombstones"] {
                for item in tombstones {
                    guard case .object(let wire) = item, case .string(let kind)? = wire["kind"], case .string(let id)? = wire["id"], case .string(let stamp)? = wire["stamp"] else {
                        throw SyncFailure(.badMessage, "a tombstone that is not one")
                    }
                    if snapshot.tombstones[kind]?[id] != nil { throw SyncFailure(.badMessage, "a tombstone is twice in a snapshot") }
                    snapshot.tombstones[kind, default: [:]][id] = stamp
                }
            }
            if case .object(let lists)? = fields["order"] {
                for (key, raw) in lists {
                    if snapshot.order[key] != nil { throw SyncFailure(.badMessage, "a list is twice in a snapshot") }
                    guard case .array(let ids) = raw else { throw SyncFailure(.badMessage, "a list that is not a list") }
                    snapshot.order[key] = try ids.map {
                        guard case .string(let text) = $0 else { throw SyncFailure(.badMessage, "an identifier that is not a text") }
                        return text
                    }
                }
            }
            if case .object(let stamps)? = fields["orderStamps"] {
                for (key, raw) in stamps {
                    guard case .string(let text) = raw else { throw SyncFailure(.badMessage, "a mark that is not a text") }
                    snapshot.orderStamps[key] = text
                }
            }
            for (name, keep) in [("removedEntities", \SyncDelta.removedEntities), ("removedTombstones", \SyncDelta.removedTombstones)] {
                guard case .array(let items)? = fields[name] else { continue }
                for item in items {
                    guard case .object(let wire) = item, case .string(let kind)? = wire["kind"], case .string(let id)? = wire["id"] else { throw SyncFailure(.badMessage, "a removal that is not one") }
                    removed[keyPath: keep].append(SyncDelta.Removal(kind: kind, id: id))
                }
            }
            if case .array(let keys)? = fields["removedLists"] {
                for raw in keys {
                    guard case .string(let key) = raw else { throw SyncFailure(.badMessage, "a list key that is not a text") }
                    removed.removedLists.append(key)
                }
            }
            if case .array(let ids)? = fields["withheld"] {
                for raw in ids {
                    guard case .string(let id) = raw else { throw SyncFailure(.badMessage, "an identifier that is not a text") }
                    withheld.insert(id)
                }
            }
        }

        /// What the end of a snapshot made: the snapshot, or the reason a difference did not rebuild (§31.4: not an error of the session, the whole snapshot is asked for).
        public enum Outcome: Equatable, Sendable {
            case assembled(Assembled)
            case didNotRebuild(String)
        }

        /// The end: every part came, the count of entities is the one announced, and the digest of what was put together is the one announced (`truncated`
        /// otherwise). The form of the snapshot (`SyncSnapshot.read`) is checked here too: what does not read is `bad-message`. A difference (§31.3) is rebuilt on
        /// `base` first, and held to the count and the digest of the whole snapshot: one that does not rebuild is `didNotRebuild`, not an error.
        public func end(entityCount announced: Int, digest announcedDigest: String, rebuildOn base: (snapshot: SyncSnapshot, hash: String)? = nil) throws -> Outcome {
            guard let parts, next == parts else { throw SyncFailure(.truncated, "the parts announced did not all come") }
            var whole = snapshot
            var count = entityCount
            if let difference {
                guard let base, difference == base.hash else { return .didNotRebuild("the base of the difference is not the one this device holds") }
                var delta = removed
                delta.snapshot = snapshot
                switch SyncDelta.apply(delta, to: base.snapshot) {
                case .failure(let problem): return .didNotRebuild(problem.message)
                case .success(let rebuilt): whole = rebuilt
                }
                count = whole.entities.values.reduce(0) { $0 + $1.count }
                guard count <= SyncLimits.maxEntities else { throw SyncFailure(.tooLarge, "a snapshot of more entities than the bound") }
                guard announced == count else { return .didNotRebuild("the count of entities of the rebuilt snapshot is not the one announced") }
                guard announcedDigest == whole.digest else { return .didNotRebuild("the digest of the rebuilt snapshot is not the one announced") }
            } else {
                guard announced == entityCount else { throw SyncFailure(.truncated, "the count of entities is not the one announced") }
                guard announcedDigest == snapshot.digest else { throw SyncFailure(.truncated, "the digest of the snapshot is not the one announced") }
            }
            switch SyncSnapshot.read(whole.json) {
            case .success(let read): return .assembled(Assembled(snapshot: read, entityCount: count, withheld: withheld))
            case .failure(let problem): throw SyncFailure(.badMessage, "the snapshot is not well formed: \(problem.message)")
            }
        }

        /// The end of a snapshot that is whole (no difference is agreed): `end` with nothing to rebuild on.
        public func finish(entityCount announced: Int, digest announcedDigest: String) throws -> Assembled {
            switch try end(entityCount: announced, digest: announcedDigest) {
            case .assembled(let assembled): return assembled
            case .didNotRebuild(let reason): throw SyncFailure(.truncated, reason)
            }
        }
    }
}
