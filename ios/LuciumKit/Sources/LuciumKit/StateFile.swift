import Foundation

/// Why a state file was put aside instead of read.
public enum SetAsideReason: String, Equatable, Sendable {
    /// Not readable: damaged, not JSON, too large, or with nothing to show.
    case corrupt
    /// Written by a newer format (`version` above `BrowserState.supportedVersion`). Not damaged, only not readable by this build.
    case future
}

public enum StateLoad: Equatable, Sendable {
    /// There was no file: a first launch.
    case fresh
    case loaded(BrowserState)
    /// The file could not be read and was moved to `backup` (never deleted). The caller starts again from a fresh state.
    case setAside(SetAsideReason, backup: URL, why: String)
    /// The file could not be read and could not be moved either: it stays where it is, and nothing is written over it until it can be moved.
    case held(SetAsideReason, why: String)
}

public enum StateFileError: Error, Equatable, Sendable {
    case notARegularFile(String)
    case tooLarge(bytes: Int, limit: Int)
    /// The file parsed, but holds no space: not a state this build can show.
    case noSpace
    /// A write was refused because the unreadable file in the way still cannot be put aside.
    case held(String)
}

/// The state file of the iOS application, in the format of the Mac's `state.json`. The rules are those of the Mac's `persist.ts` and `store.ts`:
/// - a write goes to a temporary file, reaches the disk, then replaces the file by a rename, so that a crash leaves the old file or the new
///   one, never half of one;
/// - a file that cannot be read is moved to `<name>.corrupt-<ms>`, a file of a newer format to `<name>.future-<ms>`: neither is deleted, and
///   only the three most recent of each sort are kept;
/// - when even the move fails, nothing is written over the file (it may be the only copy of what the person had).
public struct StateFile: Sendable {
    /// More than this is a damaged or hostile file, not a state (the Mac reads at most the same).
    public static let maxBytes = 64 * 1024 * 1024
    public static let sideFilesKept = 3
    /// The name of the state file in the application's folder.
    public static let fileName = "state.json"

    public let url: URL
    private let now: @Sendable () -> Date
    private var held: (reason: SetAsideReason, why: String)?

    public init(url: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url
        self.now = now
    }

    /// Reads the file. Whatever it cannot read it puts aside; it never throws and never deletes.
    public mutating func load() -> StateLoad {
        guard FileManager.default.fileExists(atPath: url.path) else { return .fresh }
        do {
            // A private tab found in a file is not a tab of this run (the Mac's rule): it is dropped as the file is read.
            guard let state = try BrowserState.decode(Self.stripByteOrderMark(try readBounded())).persistable().consistent() else { throw StateFileError.noSpace }
            return .loaded(state)
        } catch {
            let reason: SetAsideReason = (error as? BrowserState.StateError).map { _ in .future } ?? .corrupt
            do {
                let backup = try setAside(reason)
                print("[state] \(url.path) is unreadable (\(error)); moved to \(backup.path)")
                return .setAside(reason, backup: backup, why: String(describing: error))
            } catch let moveError {
                held = (reason, String(describing: error))
                print("[state] \(url.path) is unreadable (\(error)) and could not be moved aside (\(moveError)); nothing is written over it until it can be")
                return .held(reason, why: String(describing: error))
            }
        }
    }

    /// Writes the state. Throws `StateFileError.held` while an unreadable file is in the way and cannot be put aside.
    public mutating func save(_ state: BrowserState) throws {
        if let blocked = held {
            if FileManager.default.fileExists(atPath: url.path) {
                do { _ = try setAside(blocked.reason) } catch { throw StateFileError.held("\(blocked.why); still not movable: \(error)") }
            }
            held = nil
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        // The one place the state leaves memory: a private tab never goes through it (`BrowserState.persistable`).
        try writeAtomically(try encoder.encode(state.persistable()))
    }

    /// The files put aside next to this one, of one sort, the most recent first.
    public func sideFiles(_ reason: SetAsideReason) -> [URL] {
        let directory = url.deletingLastPathComponent()
        let prefix = "\(url.lastPathComponent).\(reason.rawValue)-"
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        } catch {
            print("[state] cannot list \(directory.path): \(error)")
            return []
        }
        return names.filter { $0.hasPrefix(prefix) }
            .sorted { $0.dropFirst(prefix.count).compare($1.dropFirst(prefix.count), options: .numeric) == .orderedDescending }
            .map { directory.appending(path: $0) }
    }

    // MARK: Files

    private func readBounded() throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else { throw StateFileError.notARegularFile(url.lastPathComponent) }
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        guard size <= Self.maxBytes else { throw StateFileError.tooLarge(bytes: size, limit: Self.maxBytes) }
        return try Data(contentsOf: url)
    }

    /// An editor that saved the file with a byte-order mark did not damage it.
    private static func stripByteOrderMark(_ data: Data) -> Data {
        data.starts(with: [0xEF, 0xBB, 0xBF]) ? data.dropFirst(3) : data
    }

    /// Moves the unreadable file to `<name>.<reason>-<ms>` (a name that is not taken yet), then prunes the older ones.
    private func setAside(_ reason: SetAsideReason) throws -> URL {
        let stamp = Int(now().timeIntervalSince1970 * 1000)
        let base = url.path + ".\(reason.rawValue)-\(stamp)"
        var target = URL(fileURLWithPath: base)
        var counter = 0
        while FileManager.default.fileExists(atPath: target.path) {
            counter += 1
            target = URL(fileURLWithPath: "\(base)-\(counter)")
        }
        try FileManager.default.moveItem(at: url, to: target)
        for old in sideFiles(reason).dropFirst(Self.sideFilesKept) {
            do { try FileManager.default.removeItem(at: old) } catch { print("[state] cannot remove the old side file \(old.path): \(error)") }
        }
        return target
    }

    private func writeAtomically(_ data: Data) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = URL(fileURLWithPath: url.path + ".tmp")
        guard manager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: temporary.path])
        }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            defer { try? handle.close() }
            try handle.write(contentsOf: data)
            try handle.synchronize()
            if manager.fileExists(atPath: url.path) {
                _ = try manager.replaceItemAt(url, withItemAt: temporary)
            } else {
                try manager.moveItem(at: temporary, to: url)
            }
        } catch {
            removeTemporary(temporary)
            throw error
        }
    }

    /// A complete copy of the state must not stay in a file nobody reads. A failure to remove it is logged with the file; the write's own error goes on.
    private func removeTemporary(_ file: URL) {
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        do { try FileManager.default.removeItem(at: file) } catch { print("[state] cannot remove \(file.path) after a failed write: \(error)") }
    }
}
