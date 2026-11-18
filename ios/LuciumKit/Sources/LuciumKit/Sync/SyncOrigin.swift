import CryptoKit
import Foundation

/// Whether this phone has ever been changed by its person (docs/synchronisation.md §11.8, decision [Q3]). At the first exchange there is no common base: the two
/// states are merged as a union, except that a phone **never modified since its first launch** adopts the Mac's state instead of adding its own (an empty space
/// that nobody made would otherwise be given to the Mac next to its own).
///
/// "Never modified" is a latch, not a comparison with today: it starts true only at the very first launch (no state file existed), and it becomes false the first
/// time the structure the person arranges (spaces, folders, pinned tabs, favourites) is no longer the one of that first launch. Deleting everything again does not
/// bring it back. A phone whose state was read from a file, which is every phone that had Lucium before the synchronisation existed, starts false: the union
/// loses nothing, and adopting the Mac's state could.
public struct SyncOrigin: Codable, Equatable, Sendable {
    public static let version = 1

    /// The SHA-256 of the structure of the first launch; nil when there was none to compare (a phone that started false).
    public var firstStructure: String?
    public var untouched: Bool

    public init(firstStructure: String?, untouched: Bool) {
        self.firstStructure = firstStructure
        self.untouched = untouched
    }

    /// The origin to keep when the application starts and no file of the origin exists yet.
    public static func atFirstRun(stateWasFound: Bool, state: BrowserState) -> SyncOrigin {
        stateWasFound ? SyncOrigin(firstStructure: nil, untouched: false) : SyncOrigin(firstStructure: Self.structureHash(of: state), untouched: true)
    }

    /// The origin after the state has changed: once the structure differs from the first one, the phone is no longer untouched. It only ever goes from true to false.
    public func observing(_ state: BrowserState) -> SyncOrigin {
        // `untouched` only ever goes from true to false: nothing here, or anywhere, makes a touched origin untouched (the first line only saves the hash).
        guard untouched else { return self }
        guard let first = firstStructure else { return SyncOrigin(firstStructure: nil, untouched: false) }
        return Self.structureHash(of: state) == first ? self : SyncOrigin(firstStructure: first, untouched: false)
    }

    /// What a person arranges and a synchronisation would carry: the spaces with their names, emoji, themes and profiles, the folders, the pinned tabs (which
    /// tab, in which space, not which page it is on) and the favourites. Not the tabs of "Today", not the archive (the application fills it by itself), not which
    /// space is on screen, not the settings.
    static func structureHash(of state: BrowserState) -> String {
        /// A list that is absent, null or empty is one and the same: a library operation may write an empty list where there was none, which is no change.
        func list(_ value: JSONValue?) -> JSONValue {
            if case .array(let items)? = value, !items.isEmpty { return .array(items) }
            return .array([])
        }
        struct Description: Encodable {
            var spaces: [Space]
            var folders: JSONValue
            var pinned: [[String]]
            var favorites: JSONValue
        }
        let description = Description(spaces: state.spaces, folders: list(state.rest["folders"]), pinned: state.tabs.filter(\.pinned).map { [$0.id, $0.spaceId] },
                                      favorites: list(state.rest["favorites"]))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        do {
            return SHA256.hash(data: try encoder.encode(description)).map { String(format: "%02x", $0) }.joined()
        } catch {
            // A value that cannot be written would make every state look the same: fail the other way, so that the phone is judged touched.
            print("[sync] the structure could not be described, the phone is judged modified: \(error)")
            return UUID().uuidString
        }
    }
}

/// The file of the origin, next to the state file and never inside it. Same rules as the other small files of the application (`LockSettingsFile`).
public struct SyncOriginFile: Sendable {
    public static let fileName = "sync-origin.json"
    static let maxBytes = 4096

    public enum Load: Equatable, Sendable {
        case none
        case loaded(SyncOrigin)
        /// Cannot be read: the phone is judged touched (the safe side), and the file is written again at the next change.
        case unreadable(String)
    }

    public let url: URL

    public init(url: URL) { self.url = url }

    public func load() -> Load {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return .none }
        do {
            let attributes = try manager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular, ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= Self.maxBytes else { return .unreadable("not a small regular file") }
            let origin = try JSONDecoder().decode(SyncOrigin.self, from: Data(contentsOf: url))
            return .loaded(origin)
        } catch {
            print("[sync] \(url.lastPathComponent) cannot be read: \(error)")
            return .unreadable(String(describing: error))
        }
    }

    public func save(_ origin: SyncOrigin) throws {
        let manager = FileManager.default
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(origin)
        try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = URL(fileURLWithPath: url.path + ".tmp")
        guard manager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: temporary.path])
        }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
            if manager.fileExists(atPath: url.path) {
                _ = try manager.replaceItemAt(url, withItemAt: temporary)
            } else {
                try manager.moveItem(at: temporary, to: url)
            }
        } catch {
            if manager.fileExists(atPath: temporary.path) {
                do { try manager.removeItem(at: temporary) } catch { print("[sync] cannot remove \(temporary.path) after a failed write: \(error)") }
            }
            throw error
        }
    }
}
