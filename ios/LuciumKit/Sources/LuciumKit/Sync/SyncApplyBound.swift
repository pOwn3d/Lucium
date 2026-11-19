import Foundation

extension SyncApply {
    /// What a state may weigh once a session has written into it: half of what the state file is read back at (`StateFile.maxBytes`, 64 MiB). A file over that bound is moved
    /// aside at the next launch and the application starts with nothing; a session carries 32 MiB at most, so a device that sends new entities in each session reaches it in
    /// three (the fields this version does not know are kept as they come, §11.6, so a name or an address is not the only thing that weighs).
    public static let maxStateBytes = StateFile.maxBytes / 2

    /// `apply`, then the size of the state it gives (as the state file writes it): over `maxStateBytes`, nothing is written (the state given back is the one that was given) and the
    /// outcome says `tooLarge`. A state that cannot be encoded cannot be saved either: it is refused too, and the reason is logged.
    public static func apply(_ patch: SyncPatch, to state: BrowserState, now: Double, maxStateBytes limit: Int, log: (String) -> Void = { print("[sync] \($0)") }) -> Outcome {
        let outcome = apply(patch, to: state, now: now)
        guard outcome.changed else { return outcome }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let size: Int
        do {
            size = try encoder.encode(outcome.state.persistable()).count
        } catch {
            log("the state a session would write cannot be encoded, it is not written: \(error)")
            return Outcome(state: state, rejected: outcome.rejected + ["the state would not encode"], rejections: outcome.rejections, changed: false, tooLarge: true)
        }
        guard size > limit else { return outcome }
        return Outcome(state: state, rejected: outcome.rejected + ["the state would weigh \(size) bytes, more than \(limit)"], rejections: outcome.rejections, changed: false, tooLarge: true)
    }
}
