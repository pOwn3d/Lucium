import Foundation

/// The file of the conflicts a session settled (docs/synchronisation.md §11.7.3): `sync-conflicts.json`, next to the state file and never inside it. The lines and
/// their rules (30 days, 200 lines, a hostile file bounded and checked line by line) are `SyncConflicts`; this is the file itself. It holds titles and addresses, so
/// it stays on the device, is never sent, and goes with the Mac that is forgotten (§12).
public struct SyncJournalFile: Sendable {
    public static let fileName = "sync-conflicts.json"

    public struct Loaded: Equatable, Sendable {
        public var entries: [SettledConflict]
        /// Lines that were not well formed, left out.
        public var skipped: Int
        /// The file was written by a newer version: it is read as empty and must never be written over (§11.7.3).
        public var tooNew: Bool
    }

    public let url: URL

    public init(url: URL) { self.url = url }

    /// The journal as the file holds it. A missing file is an empty journal; a file that cannot be read is an empty one too, and the reason is logged: the screen has
    /// nothing to compare, the session goes on.
    public func load(now: Int) -> Loaded {
        guard FileManager.default.fileExists(atPath: url.path) else { return Loaded(entries: [], skipped: 0, tooNew: false) }
        do {
            // Bounded before it is read, as a state file is: `SyncConflicts.parse` bounds the text again.
            let data = try SyncFiles.readBounded(url, maxBytes: SyncConflicts.Limits.maxFileChars * 4)
            let parsed = SyncConflicts.parse(String(decoding: data, as: UTF8.self), now: now)
            if parsed.unreadable { print("[sync] \(url.lastPathComponent) cannot be read, the journal of the conflicts starts again") }
            if parsed.skipped > 0 { print("[sync] \(parsed.skipped) lines of \(url.lastPathComponent) were not well formed and were left out") }
            return Loaded(entries: parsed.entries, skipped: parsed.skipped, tooNew: parsed.tooNew)
        } catch {
            print("[sync] \(url.lastPathComponent) cannot be read, the journal of the conflicts starts again: \(error)")
            return Loaded(entries: [], skipped: 0, tooNew: false)
        }
    }

    public func save(_ entries: [SettledConflict]) throws {
        try SyncFiles.writeAtomically(Data(SyncConflicts.serialize(entries).utf8), to: url)
    }

    /// The Mac is forgotten: its conflicts go with it (§12).
    public func remove() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
