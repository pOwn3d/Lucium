import Foundation

/// The Swift twin of `src/shared/sync-merge.ts`: the three-way merge of docs/synchronisation.md §11. Both devices call it with the same four inputs (each
/// one's own snapshot being "local" to itself) and must get the same snapshot back: the digest of that snapshot is what they compare before either writes
/// anything (§8.5). It is a pure function of its inputs (no clock, no disk, no random number, no locale: strings are compared by UTF-16 code unit through
/// `SyncCanonical`, never with Swift's `<` or `==`) and it changes nothing it was given (value types).
///
/// Checked by the same vectors as the Mac: `ios/Contracts/sync-merge-vectors.json` and the corpus of random states `sync-merge-draws.json`
/// (`SyncMergeVectorTests`). Change one side and the other fails.

/// Which side won, from the point of view of the device that merges (the other device sees the same conflict with the sides exchanged).
public enum SyncConflictSide: String, Sendable {
    case local, remote

    public var other: SyncConflictSide { self == .local ? .remote : .local }
}

/// Why. `newer`: the marks differ in their time or their counter; `deviceID`: the same time and counter, the greater device id wins; `value`: the same mark
/// on both sides (a field never stamped), the greater canonical text wins; `modificationOverDeletion`: an entity deleted on one side and changed on the
/// other; `order`: two different reorders of one list.
public enum SyncConflictReason: String, Sendable {
    case newer
    case deviceID = "device-id"
    case value
    case modificationOverDeletion = "modification-over-deletion"
    case order
}

public struct SyncConflict: Equatable, Sendable {
    public var kind: String
    public var id: String
    /// The field, or nil for a whole entity (a deletion that lost) and for a list (kind `order`, id the list key).
    public var field: String?
    public var winner: SyncConflictSide
    public var reason: SyncConflictReason

    public init(kind: String, id: String, field: String?, winner: SyncConflictSide, reason: SyncConflictReason) {
        self.kind = kind
        self.id = id
        self.field = field
        self.winner = winner
        self.reason = reason
    }

    /// The same conflict seen from the other device.
    public var seenFromTheOtherDevice: SyncConflict {
        SyncConflict(kind: kind, id: id, field: field, winner: winner.other, reason: reason)
    }

    /// The order the conflicts are listed in: by kind, then id, then field (a whole entity first), each compared by UTF-16 code unit.
    public static func precedes(_ a: SyncConflict, _ b: SyncConflict) -> Bool {
        let kind = SyncCanonical.compare(a.kind, b.kind)
        if kind != 0 { return kind < 0 }
        let id = SyncCanonical.compare(a.id, b.id)
        if id != 0 { return id < 0 }
        switch (a.field, b.field) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case let (x?, y?): return SyncCanonical.compare(x, y) < 0
        }
    }
}

public struct SyncMergeResult: Equatable, Sendable {
    public var snapshot: SyncSnapshot
    /// Sorted by kind, id, field (`SyncConflict.precedes`).
    public var conflicts: [SyncConflict]
}

public enum SyncMerge {
    /// `fusion(base, local, distant, withheld)` of §11.1. `base` is nil when there is none (a first session, a base that does not match the other device's, a
    /// last session more than 30 days ago: §11.8): the merge then takes every entity of one side only for an addition. `withheld` is the union of the ids of
    /// the spaces each device set aside (§18).
    public static func merge(base baseIn: SyncSnapshot?, local localIn: SyncSnapshot, remote remoteIn: SyncSnapshot, withheld: [String] = []) -> SyncMergeResult {
        let aside = Set(withheld.map(Key.init))
        let base = baseIn.map { withoutSpaces($0, aside) }
        let local = withoutSpaces(localIn, aside)
        let remote = withoutSpaces(remoteIn, aside)
        var conflicts: [SyncConflict] = []
        var result = SyncSnapshot()
        let enteredLocal = Lazy { enteredTargets(local, base) }
        let enteredRemote = Lazy { enteredTargets(remote, base) }

        // §11.2 and §11.5: each entity, then each deletion.
        var kinds = Set<String>()
        for snapshot in [base, local, remote].compactMap({ $0 }) {
            kinds.formUnion(snapshot.entities.keys)
            kinds.formUnion(snapshot.tombstones.keys)
        }
        for kind in kinds {
            var ids = Set<String>()
            for snapshot in [base, local, remote].compactMap({ $0 }) {
                ids.formUnion(snapshot.entities[kind]?.keys.map { $0 } ?? [])
                ids.formUnion(snapshot.tombstones[kind]?.keys.map { $0 } ?? [])
            }
            for id in ids {
                let b = base?.entities[kind]?[id]
                let l = local.entities[kind]?[id]
                let r = remote.entities[kind]?[id]
                let tombLocal = local.tombstones[kind]?[id]
                let tombRemote = remote.tombstones[kind]?[id]
                if let l, let r {
                    result.entities[kind, default: [:]][id] = mergeEntity(kind: kind, id: id, base: b, local: l, remote: r, conflicts: &conflicts)
                    continue
                }
                if l == nil, r == nil {
                    // Gone from both sides: stays gone, and the greater of the two marks is kept.
                    if b != nil || tombLocal != nil || tombRemote != nil {
                        result.tombstones[kind, default: [:]][id] = SyncStamp.max(tombLocal ?? SyncStamp.zero, tombRemote ?? SyncStamp.zero)
                    }
                    continue
                }
                let keptSide: SyncConflictSide = l != nil ? .local : .remote
                let kept = (l ?? r)!
                let otherTombstone = l != nil ? tombRemote : tombLocal
                if b == nil, otherTombstone == nil {
                    result.entities[kind, default: [:]][id] = kept // an addition
                    continue
                }
                // The other side deleted it. With a base, "modified" is a change of a field, or something put into it since the base (§11.2); with none, it
                // is a mark later than the tombstone (§11.5).
                let modified: Bool
                if let b {
                    let entered = (keptSide == .local ? enteredLocal.value : enteredRemote.value).contains(Target(kind: kind, id: id))
                    modified = !sameFields(kept.fields, b.fields) || entered
                } else {
                    modified = SyncStamp.compare(SyncStamp.max(of: Array(kept.stamps.values)), otherTombstone ?? SyncStamp.zero) > 0
                }
                if modified {
                    result.entities[kind, default: [:]][id] = kept
                    conflicts.append(SyncConflict(kind: kind, id: id, field: nil, winner: keptSide, reason: .modificationOverDeletion))
                } else {
                    result.tombstones[kind, default: [:]][id] = otherTombstone ?? SyncStamp.zero
                }
            }
        }

        // §11.7.1: what belongs to a space that is not there is removed, and leaves a tombstone marked with its own latest change (a later change elsewhere
        // brings it back, and it is removed again: that is what makes the merge idempotent).
        let spaceIDs = Set((result.entities["space"] ?? [:]).keys.map(Key.init))
        for kind in ["folder", "tab", "archived", "todayTab"] {
            guard let byID = result.entities[kind] else { continue }
            for (id, entity) in byID {
                if let space = reference(entity.fields, "spaceId"), spaceIDs.contains(Key(space)) { continue }
                result.entities[kind]?[id] = nil
                result.tombstones[kind, default: [:]][id] = SyncStamp.max(of: Array(entity.stamps.values))
            }
        }
        // A folder or a parent that is not there: the entity goes back to the root, its mark kept (unless it says nothing).
        let folderIDs = Set((result.entities["folder"] ?? [:]).keys.map(Key.init))
        for (kind, field) in [("tab", "folderId"), ("archived", "folderId"), ("folder", "parentId")] {
            guard let byID = result.entities[kind] else { continue }
            for (id, var entity) in byID {
                guard let target = reference(entity.fields, field), !folderIDs.contains(Key(target)) else { continue }
                entity.fields[field] = nil
                if entity.stamps[field] == SyncStamp.zero { entity.stamps[field] = nil }
                result.entities[kind]?[id] = entity
            }
        }
        // §11.7.2: folders that loop. A folder has one parent, so the cycles are apart: each is cut at the folder whose id is the smallest, in one pass.
        if var folders = result.entities["folder"] {
            breakCycles(&folders)
            result.entities["folder"] = folders
        }
        for (kind, byID) in result.entities where byID.isEmpty { result.entities[kind] = nil }

        mergeOrder(base: base, local: local, remote: remote, result: &result, conflicts: &conflicts)
        conflicts.sort(by: SyncConflict.precedes)
        return SyncMergeResult(snapshot: result, conflicts: conflicts)
    }

    // MARK: - Strings that are one key for the merge

    /// A name used as a key, compared scalar for scalar. The door a snapshot comes in by (`SyncSnapshot.read`) refuses names that are not in
    /// normalization form C, so that two names that differ only by their normalization never reach the merge; this wrapper is for what is built here.
    private struct Key: Hashable {
        let text: String
        init(_ text: String) { self.text = text }
        static func == (a: Key, b: Key) -> Bool { SyncCanonical.identical(a.text, b.text) }
        func hash(into hasher: inout Hasher) { for byte in text.utf8 { hasher.combine(byte) } }
    }

    /// What an entity can be moved into: a space or a folder, by kind and id.
    private struct Target: Hashable {
        let kind: String
        let id: String
        init(kind: String, id: String) {
            self.kind = kind
            self.id = id
        }
        static func == (a: Target, b: Target) -> Bool { SyncCanonical.identical(a.kind, b.kind) && SyncCanonical.identical(a.id, b.id) }
        func hash(into hasher: inout Hasher) {
            for byte in kind.utf8 { hasher.combine(byte) }
            hasher.combine(UInt8(0))
            for byte in id.utf8 { hasher.combine(byte) }
        }
    }

    private final class Lazy<T> {
        private var made: T?
        private let make: () -> T
        init(_ make: @escaping () -> T) { self.make = make }
        var value: T {
            if let made { return made }
            let value = make()
            made = value
            return value
        }
    }

    private static func reference(_ fields: [String: JSONValue], _ name: String) -> String? {
        if case .string(let value)? = fields[name] { return value }
        return nil
    }

    private static func sameFields(_ a: [String: JSONValue], _ b: [String: JSONValue]) -> Bool {
        SyncCanonical.same(.object(a), .object(b))
    }

    // MARK: - Space set aside

    /// The kind of the entities a list holds, by its key, so that a space set aside takes its own lists out and no other.
    private static func listKind(_ key: String) -> String? {
        if SyncCanonical.identical(key, "spaces") { return "space" }
        if key.hasPrefix("folders:") { return "folder" }
        if key.hasPrefix("tabs:") { return "tab" }
        return nil
    }

    /// The key of the list an entity is in, or nil for a kind that has no order (`archived`, `setting`, a kind this version does not know).
    private static func listKey(kind: String, fields: [String: JSONValue]) -> String? {
        switch kind {
        case "space": return "spaces"
        case "folder": return "folders:\(reference(fields, "spaceId") ?? "-"):\(reference(fields, "parentId") ?? "-")"
        case "tab": return "tabs:\(reference(fields, "spaceId") ?? "-"):\(reference(fields, "folderId") ?? "-")"
        case "todayTab": return "today:\(reference(fields, "spaceId") ?? "-")"
        case "favorite": return "favorites:\(reference(fields, "profileId") ?? "-")"
        default: return nil
        }
    }

    /// §10.4 and §18: what belongs to a space set aside (the space, its folders, its tabs, its archive) is taken out of the three snapshots before anything
    /// is compared, on both devices, so that nothing is added, changed or deleted for it and the result holds none of it. Tombstones stay: they protect a
    /// deletion from being undone by an old copy when the space comes back.
    private static func withoutSpaces(_ snapshot: SyncSnapshot, _ spaces: Set<Key>) -> SyncSnapshot {
        if spaces.isEmpty { return snapshot }
        var dropped: [String: Set<Key>] = [:]
        var entities: [String: [String: SyncEntity]] = [:]
        for (kind, byID) in snapshot.entities {
            var kept: [String: SyncEntity] = [:]
            for (id, entity) in byID {
                let space = reference(entity.fields, "spaceId")
                let belongs = (kind == "space" && spaces.contains(Key(id))) || ((kind == "folder" || kind == "tab" || kind == "archived" || kind == "todayTab") && space != nil && spaces.contains(Key(space!)))
                if belongs { dropped[kind, default: []].insert(Key(id)) } else { kept[id] = entity }
            }
            entities[kind] = kept
        }
        var order: [String: [String]] = [:]
        for (key, ids) in snapshot.order {
            if let kind = listKind(key), let out = dropped[kind] { order[key] = ids.filter { !out.contains(Key($0)) } } else { order[key] = ids }
        }
        var copy = snapshot
        copy.entities = entities
        copy.order = order
        return copy
    }

    // MARK: - Entering a container

    /// The targets an entity was moved into, or created in, on one side since the base (§11.2: that counts as a modification of the target). Without a base
    /// there is no "since the base": only the marks of the entity count (§11.5), so nothing has entered.
    private static func enteredTargets(_ side: SyncSnapshot, _ base: SyncSnapshot?) -> Set<Target> {
        guard let base else { return [] }
        var entered = Set<Target>()
        func scan(_ targetKind: String, _ dependents: [(String, String)]) {
            for (childKind, field) in dependents {
                for (childID, child) in side.entities[childKind] ?? [:] {
                    guard let target = reference(child.fields, field) else { continue }
                    let before = base.entities[childKind]?[childID]
                    let was = before.flatMap { reference($0.fields, field) }
                    if before == nil || was == nil || !SyncCanonical.identical(was!, target) { entered.insert(Target(kind: targetKind, id: target)) }
                }
            }
        }
        scan("space", [("folder", "spaceId"), ("tab", "spaceId"), ("archived", "spaceId"), ("todayTab", "spaceId")])
        scan("folder", [("folder", "parentId"), ("tab", "folderId"), ("archived", "folderId")])
        return entered
    }

    // MARK: - An entity

    /// §11.3: one entity present on both sides, field by field.
    private static func mergeEntity(kind: String, id: String, base: SyncEntity?, local: SyncEntity, remote: SyncEntity, conflicts: inout [SyncConflict]) -> SyncEntity {
        var names = Set<String>()
        names.formUnion(base?.fields.keys.map { $0 } ?? [])
        names.formUnion(local.fields.keys)
        names.formUnion(remote.fields.keys)
        names.formUnion(local.stamps.keys)
        names.formUnion(remote.stamps.keys)
        var fields: [String: JSONValue] = [:]
        var stamps: [String: String] = [:]
        for name in names {
            let b = base?.fields[name]
            let l = local.fields[name]
            let r = remote.fields[name]
            let sl = local.stamps[name] ?? SyncStamp.zero
            let sr = remote.stamps[name] ?? SyncStamp.zero
            let changedLocal = !SyncCanonical.same(l, b)
            let changedRemote = !SyncCanonical.same(r, b)
            let value: JSONValue?
            let stamp: String
            if !changedLocal, !changedRemote {
                value = b
                stamp = SyncStamp.max(sl, sr)
            } else if changedLocal, !changedRemote {
                value = l
                stamp = sl
            } else if !changedLocal, changedRemote {
                value = r
                stamp = sr
            } else if SyncCanonical.same(l, r) {
                value = l
                stamp = SyncStamp.max(sl, sr)
            } else {
                // Both changed it, differently: the greater mark wins (the greater device id at the same time and counter); equal marks (a field never
                // stamped on either side): the greater canonical text, which is arbitrary but is the same on both devices.
                let remoteWins = SyncCanonical.identical(sl, sr) ? SyncCanonical.compare(canonicalText(r), canonicalText(l)) > 0 : SyncCanonical.compare(sr, sl) > 0
                value = remoteWins ? r : l
                stamp = remoteWins ? sr : sl
                conflicts.append(SyncConflict(kind: kind, id: id, field: name, winner: remoteWins ? .remote : .local, reason: reason(sl, sr)))
            }
            if let value { fields[name] = value }
            // The mark of a field that is absent and was never stamped says nothing, and two devices would not write it alike (§8.3): it is not kept.
            if value != nil || stamp != SyncStamp.zero { stamps[name] = stamp }
        }
        return SyncEntity(fields: fields, stamps: stamps)
    }

    private static func canonicalText(_ value: JSONValue?) -> String {
        guard let value else { return "" }
        return SyncCanonical.text(value) ?? ""
    }

    /// What a mark says about the difference between two: the time or the counter (`newer`), only the device id (`device-id`), nothing (`value`).
    private static func reason(_ a: String, _ b: String) -> SyncConflictReason {
        if SyncCanonical.identical(a, b) { return .value }
        func time(_ mark: String) -> String { mark.split(separator: "-", maxSplits: 2, omittingEmptySubsequences: false).prefix(2).joined(separator: "-") }
        return SyncCanonical.identical(time(a), time(b)) ? .deviceID : .newer
    }

    // MARK: - Folders that loop

    /// §11.7.2: the `parentId` of the folder with the smallest id of each cycle is cleared (its mark kept, unless it says nothing).
    private static func breakCycles(_ folders: inout [String: SyncEntity]) {
        enum State { case walking, done }
        var state: [Key: State] = [:]
        for start in folders.keys {
            if state[Key(start)] != nil { continue }
            var path: [String] = []
            var at: String? = start
            while let current = at, folders[current] != nil, state[Key(current)] == nil {
                state[Key(current)] = .walking
                path.append(current)
                at = reference(folders[current]!.fields, "parentId")
            }
            if let current = at, state[Key(current)] == .walking, let from = path.firstIndex(where: { SyncCanonical.identical($0, current) }) {
                let cycle = path[from...]
                let smallest = cycle.reduce(cycle.first!) { SyncCanonical.compare($0, $1) <= 0 ? $0 : $1 }
                folders[smallest]?.fields["parentId"] = nil
                if folders[smallest]?.stamps["parentId"] == SyncStamp.zero { folders[smallest]?.stamps["parentId"] = nil }
            }
            for id in path { state[Key(id)] = .done }
        }
    }

    // MARK: - Order

    /// §11.4: the order of each list is a register of its own, not a field of each entity.
    private static func mergeOrder(base: SyncSnapshot?, local: SyncSnapshot, remote: SyncSnapshot, result: inout SyncSnapshot, conflicts: inout [SyncConflict]) {
        var members: [String: [String: SyncEntity]] = [:]
        for (kind, byID) in result.entities {
            for (id, entity) in byID {
                if let key = listKey(kind: kind, fields: entity.fields) { members[key, default: [:]][id] = entity }
            }
        }
        var keys = Set<String>()
        keys.formUnion(base?.order.keys.map { $0 } ?? [])
        keys.formUnion(local.order.keys)
        keys.formUnion(remote.order.keys)
        keys.formUnion(members.keys)
        for key in keys {
            let present = members[key] ?? [:]
            let ob = base?.order[key] ?? []
            let ol = local.order[key] ?? []
            let or = remote.order[key] ?? []
            let sl = local.orderStamps[key] ?? SyncStamp.zero
            let sr = remote.orderStamps[key] ?? SyncStamp.zero
            // A side "reordered" when, among the ids its list shares with the base's, the relative order is not the base's.
            func reordered(_ side: [String]) -> Bool {
                let inBase = Set(ob.map(Key.init))
                let inSide = Set(side.map(Key.init))
                let a = side.filter { inBase.contains(Key($0)) }
                let b = ob.filter { inSide.contains(Key($0)) }
                return a.count != b.count || zip(a, b).contains { !SyncCanonical.identical($0, $1) }
            }
            let reorderedLocal = reordered(ol)
            let reorderedRemote = reordered(or)
            var chosen = ob
            if reorderedLocal, reorderedRemote, ol.count == or.count, zip(ol, or).allSatisfy({ SyncCanonical.identical($0, $1) }) {
                chosen = ol // the same reorder on both sides is not a conflict
            } else if reorderedLocal, reorderedRemote {
                // Two different reorders: the list with the greater mark wins (at equal marks, the greater canonical text); what the other side added goes to the end.
                let remoteWins = SyncCanonical.identical(sl, sr) ? SyncCanonical.compare(listText(or), listText(ol)) > 0 : SyncCanonical.compare(sr, sl) > 0
                chosen = remoteWins ? or : ol
                conflicts.append(SyncConflict(kind: "order", id: key, field: nil, winner: remoteWins ? .remote : .local, reason: .order))
            } else if reorderedLocal {
                chosen = ol
            } else if reorderedRemote {
                chosen = or
            }
            var kept: [String] = []
            var inKept = Set<Key>()
            for id in chosen where present[id] != nil && !inKept.contains(Key(id)) {
                kept.append(id)
                inKept.insert(Key(id))
            }
            // What is not in the chosen list (added, or arrived from the other side) goes to the end, the oldest birth first, then by id.
            func birth(_ id: String) -> String { SyncStamp.min(of: Array(present[id]?.stamps.values ?? [:].values)) }
            let added = present.keys.filter { !inKept.contains(Key($0)) }.sorted { a, b in
                let byBirth = SyncCanonical.compare(birth(a), birth(b))
                return byBirth != 0 ? byBirth < 0 : SyncCanonical.compare(a, b) < 0
            }
            let final = kept + added
            // A list with no member is not written, and neither is its mark (see sync-merge.ts).
            if final.isEmpty { continue }
            result.order[key] = final
            let stamp = SyncStamp.max(sl, sr)
            if stamp != SyncStamp.zero { result.orderStamps[key] = stamp }
        }
    }

    private static func listText(_ ids: [String]) -> String {
        SyncCanonical.text(.array(ids.map { .string($0) })) ?? ""
    }
}
