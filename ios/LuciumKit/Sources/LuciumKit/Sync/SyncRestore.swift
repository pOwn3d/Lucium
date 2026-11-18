import Foundation

extension SyncApply {
    /// "Rétablir" on a line of « Conflit réglé » (§13.4): the version that lost is written back into the state, as an ordinary change that goes out at the next session
    /// like any other. It is the same write as a session's, with what the state holds now as what it is expected to hold: nothing the person did since is overwritten
    /// by surprise, and an entity or a list that is no longer there is left alone (the screen says nothing was put back).
    public static func restore(_ change: SyncChange, to state: BrowserState, now: Double) -> Outcome {
        func current(_ kind: SyncFieldClasses.Kind, _ id: String) -> [String: JSONValue]? {
            switch kind {
            case .space: state.spaces.first { SyncCanonical.identical($0.id, id) }.map { SyncStateView.entry(of: $0).fields }
            case .folder: state.folders.first { SyncCanonical.identical($0.id, id) }.map { SyncStateView.entry(ofJSON: $0.json, id: $0.id).fields }
            case .tab: state.tabs.first { SyncCanonical.identical($0.id, id) }.map { SyncStateView.entry(of: $0).fields }
            case .favorite: state.favorites.first { SyncCanonical.identical($0.id, id) }.map { SyncStateView.entry(of: $0).fields }
            case .archived: state.archive.first { SyncCanonical.identical($0.id, id) }.map { SyncStateView.entry(ofJSON: $0.json, id: $0.id).fields }
            }
        }
        var patch = SyncPatch()
        switch change {
        case .set(let kind, let id, let field, let value):
            if kind == "setting" {
                if field == "value" { patch.settings[id] = value }
            } else if let known = SyncFieldClasses.kind(kind), let fields = current(known, id) {
                patch.upserts.append(SyncPatch.Upsert(kind: known, id: id, create: false, fields: [field: value], remove: [], expect: fields[field].map { [field: $0] } ?? [:]))
            }
        case .unset(let kind, let id, let field):
            if let known = SyncFieldClasses.kind(kind), let fields = current(known, id) {
                patch.upserts.append(SyncPatch.Upsert(kind: known, id: id, create: false, fields: [:], remove: [field], expect: fields[field].map { [field: $0] } ?? [:]))
            }
        case .delete(let kind, let id):
            if let known = SyncFieldClasses.kind(kind), let fields = current(known, id) {
                patch.removals.append(SyncPatch.Removal(kind: known, id: id, expect: fields))
            }
        case .order(let list, let ids):
            patch.order[list] = ids
        }
        return apply(patch, to: state, now: now)
    }
}
