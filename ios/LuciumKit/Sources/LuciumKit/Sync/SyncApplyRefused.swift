import Foundation

/// What `SyncApply` refused to write must not become a deletion (docs/synchronisation.md §11.6, review n° 39 of the synchronisation).
///
/// An entity the other device sent and this version does not make (a folder with a blank name, a tab with no address) is in the merged snapshot, so it is in the base both
/// devices keep (§8.2); the state does not hold it, so a snapshot made of the state alone says « deleted here » at the next session, and the merge sends the other device a
/// deletion of what it has not deleted. The base is not changed to hide it: the two devices must keep the same base, or they cannot merge from it (the hashes in `hello` would
/// differ for ever). The phone remembers, next to its base, which entities it refused (`SyncStoredBase.refused`) and carries them from the base into the snapshot it freezes,
/// unchanged, as it does for a kind it does not know (review n° 40): there is nothing for the merge to settle, and the other device keeps its entity.
extension SyncApply {
    /// The kinds an entity of this label may be of: a tab that does not read once written is a `tab` or a `todayTab` (both live in the list of tabs).
    private static func kinds(ofLabel label: String) -> [String] { label == "tab" ? ["tab", SyncToday.kind] : [label] }

    /// Puts into `snapshot` the entities of `refused` that the base holds and the state (the snapshot) does not, for the kinds a session exchanges. Returns the ones it put.
    static func carry(_ refused: [Rejection], from base: SyncSnapshot, into snapshot: inout SyncSnapshot, categories: Set<SyncCategory>) -> [Rejection] {
        var carried: [Rejection] = []
        for one in refused where one.field == nil {
            for kind in kinds(ofLabel: one.kind) {
                guard let entity = base.entities[kind]?[one.id], snapshot.entities[kind]?[one.id] == nil, SyncStateView.isExchanged(kind: kind, categories: categories) else { continue }
                snapshot.entities[kind, default: [:]][one.id] = entity
                carried.append(Rejection(kind: kind, id: one.id))
            }
        }
        return carried
    }

    /// The entities to remember after a session: what this session refused and what it carried, as long as the merged snapshot still holds them (one that the other device
    /// deleted is gone from the merge, and there is nothing left to refuse), by kind then identifier.
    static func stillRefused(new: [Rejection], carried: [Rejection], merged: SyncSnapshot) -> [Rejection] {
        var seen = Set<Rejection>()
        var out: [Rejection] = []
        for one in carried + new where one.field == nil {
            for kind in kinds(ofLabel: one.kind) where merged.entities[kind]?[one.id] != nil {
                let entry = Rejection(kind: kind, id: one.id)
                if seen.insert(entry).inserted { out.append(entry) }
            }
        }
        return out.sorted { a, b in a.kind != b.kind ? SyncCanonical.compare(a.kind, b.kind) < 0 : SyncCanonical.compare(a.id, b.id) < 0 }
    }
}
