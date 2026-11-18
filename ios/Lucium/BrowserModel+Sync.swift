import LuciumKit
import SwiftUI

/// What the synchronisation does to the model (docs/synchronisation.md §8.5): the one place a session writes into the state, and the way the session reads it. The
/// rules of the write are `SyncApply` (proved in LuciumKit); this is what the application adds: the web views, pictures and page states of what went, the lock,
/// the tab that is on screen, and the write of the file.
extension BrowserModel {
    /// Writes the patch of a session into the state. A field the person changed since the session froze its snapshot keeps their change; a tab or a space that goes
    /// takes its web view, its picture and its page state with it (a profile stays, with its cookies, as when a space is deleted by hand).
    @discardableResult
    func applySyncPatch(_ patch: SyncPatch) -> SyncApply.Outcome {
        let outcome = SyncApply.apply(patch, to: state, now: clock())
        write(outcome, because: "a session")
        return outcome
    }

    /// « Rétablir »: the version that lost is written back, as an ordinary change that goes out at the next session.
    @discardableResult
    func restoreSyncChange(_ change: SyncChange) -> Bool {
        let outcome = SyncApply.restore(change, to: state, now: clock())
        write(outcome, because: "a restore")
        return outcome.changed
    }

    private func write(_ outcome: SyncApply.Outcome, because reason: String) {
        if !outcome.rejected.isEmpty { print("[sync] \(reason) asked for \(outcome.rejected.count) values this version does not keep: \(outcome.rejected.prefix(5))") }
        guard outcome.changed else { return }
        isApplyingSync = true
        defer { isApplyingSync = false }
        let shown = activeTab?.id
        // The tab on screen, when it goes, takes no picture with it: it would be written for a tab that no longer exists.
        for id in outcome.removedTabIDs {
            if let view = webViews[id] { free(view, tabId: id) }
            sideStore?.remove(for: id)
            thumbnailCache[id] = nil
        }
        if !outcome.removedTabIDs.isEmpty { thumbnailRevision += 1 }
        state = outcome.state
        lock?.reconcile(spaceIds: Set(state.spaces.map(\.id)))  // a space that went leaves the guarded ones
        ensureActiveTab()
        if activeTab?.id != shown { arrive() }
        // Kept now, not 500 ms from now: the session says `commit` when this is written.
        flush()
        syncOrigin?.observe(state)
    }
}

/// The model, seen by a session (`SyncExchangeHost`): its state, what is locked, and the one place the state is written. It holds the model weakly: a session never keeps
/// the model alive, and one that outlives it finds the application locked and ends.
final class SyncModelHost: SyncExchangeHost, @unchecked Sendable {
    private weak var model: BrowserModel?

    init(model: BrowserModel) { self.model = model }

    func currentState() async -> BrowserState { await MainActor.run { model?.state ?? BrowserState() } }

    func lockedSpaceIDs() async -> Set<String> {
        await MainActor.run {
            guard let model else { return [] }
            return Set(model.state.spaces.map(\.id).filter { model.lock?.covers(space: $0) == true })
        }
    }

    /// No model: nothing to exchange with. The session ends with `locked`, which the page reads as "waiting".
    func isAppLocked() async -> Bool { await MainActor.run { model?.lock?.appLocked ?? (model == nil) } }

    func isNeverModified() async -> Bool { await MainActor.run { model?.syncOrigin?.origin.untouched ?? false } }

    func apply(_ patch: SyncPatch) async -> SyncApply.Outcome {
        await MainActor.run {
            guard let model else { return SyncApply.Outcome(state: BrowserState(), changed: false) }
            return model.applySyncPatch(patch)
        }
    }

    func exchanged(_ summary: SyncExchangeSummary) async {
        await MainActor.run { model?.sync?.exchangeDone(summary) }
    }

    func restore(_ change: SyncChange) async -> Bool { await MainActor.run { model?.restoreSyncChange(change) ?? false } }
}
