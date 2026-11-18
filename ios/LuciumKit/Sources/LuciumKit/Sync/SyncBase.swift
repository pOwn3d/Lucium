import Foundation

/// The base of the Mac this phone is paired with (docs/synchronisation.md §11.8, §3.3): the merged snapshot of the last session that went through, the "base" of the
/// next three-way merge. The Swift twin of `src/main/sync/bases.ts`. One file per device (`sync-base-<id>.json`), next to the state file and never inside it. A file is
/// hostile input: bounded, and read through `SyncSnapshot.read`. A base older than thirty days is not used: the tombstones that told the deletions have been purged
/// (§11.5), and the merge starts from an empty base.
public struct SyncStoredBase: Equatable, Sendable {
    public let snapshot: SyncSnapshot
    /// When it was saved, in milliseconds since 1970.
    public let savedAt: Int
    /// The SHA-256 of the canonical form of the snapshot: what `hello.baseHash` carries.
    public let hash: String
}

public struct SyncBaseStore: Sendable {
    public static let version = 1
    static let maxBytes = SyncLimits.maxSnapshotBytes
    static let retentionMilliseconds = 30 * 24 * 60 * 60 * 1000

    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    /// The file of a device, or nil when the identifier is not one that can be a file name.
    func url(for peerId: String) -> URL? {
        SyncDeviceInfo.isValidId(peerId) ? directory.appending(path: "sync-base-\(peerId).json") : nil
    }

    /// The base of a device, or nil when there is none, when it is older than thirty days, or when the file cannot be used (the reason is logged: the merge then
    /// starts from an empty one).
    public func get(peerId: String, now: Int) -> SyncStoredBase? {
        guard let url = url(for: peerId), FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let data = try SyncFiles.readBounded(url, maxBytes: Self.maxBytes)
            guard case .object(let root) = try JSONDecoder().decode(JSONValue.self, from: data), case .number(let version)? = root["version"], version == Double(Self.version),
                  case .number(let savedAt)? = root["savedAt"], savedAt.isFinite, let saved = Int(exactly: savedAt), let raw = root["snapshot"] else {
                throw SyncFailure(.internal, "not a base of this version")
            }
            switch SyncSnapshot.read(raw) {
            case .failure(let problem): throw SyncFailure(.internal, problem.message)
            case .success(let snapshot):
                if now - saved > Self.retentionMilliseconds { return nil }
                return SyncStoredBase(snapshot: snapshot, savedAt: saved, hash: snapshot.digest)
            }
        } catch {
            print("[sync] the base of the Mac cannot be used, the next merge starts from an empty one: \(error)")
            return nil
        }
    }

    /// Written whole and moved into place (a crash leaves the old base); throws when it cannot be written, so that the session says `internal` instead of `commit`.
    @discardableResult
    public func save(peerId: String, snapshot: SyncSnapshot, now: Int) throws -> SyncStoredBase {
        guard let url = url(for: peerId) else { throw SyncFailure(.internal, "a device identifier is not a file name") }
        let body = JSONValue.object(["version": .number(Double(Self.version)), "savedAt": .number(Double(now)), "snapshot": snapshot.json])
        try SyncFiles.writeAtomically(try JSONEncoder().encode(body), to: url)
        return SyncStoredBase(snapshot: snapshot, savedAt: now, hash: snapshot.digest)
    }

    /// The Mac is forgotten: its base goes with it (§12).
    public func remove(peerId: String) throws {
        guard let url = url(for: peerId), FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
