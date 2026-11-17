import Foundation

/// What the person chose to lock (the Mac's `lockApp` and `lockedSpaces`, `src/shared/lock.ts`). These choices belong to this phone: they are kept in
/// a file of their own and never in `state.json`, so that a state file brought from the Mac (or, later, a synchronization) can neither switch a lock
/// off nor on. The Mac's `exportableState` makes the same rule for its own file.
public struct LockSettings: Codable, Equatable, Sendable {
    public static let version = 1
    /// The Mac's `LOCKED_SPACES_MAX`.
    public static let maxSpaces = 200
    /// The longest id the Mac's state keeps (`ID_MAX`).
    static let maxIdLength = 256

    /// The application is locked when it is left and at launch.
    public var lockApp: Bool
    /// The spaces that ask for the owner each time Lucium has been left.
    public var lockedSpaces: [String]

    public init(lockApp: Bool = false, lockedSpaces: [String] = []) {
        self.lockApp = lockApp
        self.lockedSpaces = lockedSpaces
    }

    /// Something is to be locked.
    public var isActive: Bool { lockApp || !lockedSpaces.isEmpty }

    /// The same settings with each space once, at most `maxSpaces` of them, and, when `spaceIds` is given, only spaces that exist.
    public func cleaned(spaceIds: Set<String>? = nil) -> LockSettings {
        var seen = Set<String>()
        var spaces: [String] = []
        for id in lockedSpaces where !id.isEmpty && id.count <= Self.maxIdLength && (spaceIds?.contains(id) ?? true) {
            guard spaces.count < Self.maxSpaces else { break }
            if seen.insert(id).inserted { spaces.append(id) }
        }
        return LockSettings(lockApp: lockApp, lockedSpaces: spaces)
    }

    public enum ReadError: Error, Equatable {
        /// Written by a newer format: not read, so not trusted (and not rewritten before the person changes it).
        case newerVersion(Int)
    }

    private enum Keys: String, CodingKey { case version, lockApp, lockedSpaces }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version >= 1, version <= Self.version else { throw ReadError.newerVersion(version) }
        lockApp = try container.decode(Bool.self, forKey: .lockApp)
        lockedSpaces = try container.decode([String].self, forKey: .lockedSpaces)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(Self.version, forKey: .version)
        try container.encode(lockApp, forKey: .lockApp)
        try container.encode(lockedSpaces, forKey: .lockedSpaces)
    }
}

/// What is locked at this moment: the settings, and which of them the owner has opened since Lucium was last left. Pure rules; the controller
/// (`LockController`) asks the owner and calls these.
public struct LockSession: Equatable, Sendable {
    public private(set) var settings: LockSettings
    /// The whole application is covered.
    public private(set) var appLocked: Bool
    /// The guarded spaces the owner has opened since the last `lockAll()`.
    public private(set) var unlockedSpaces: Set<String> = []

    /// A launch: the application starts locked when it is set to, and every guarded space starts locked.
    public init(settings: LockSettings) {
        self.settings = settings
        appLocked = settings.lockApp
    }

    public func isSpaceLocked(_ id: String) -> Bool { settings.lockedSpaces.contains(id) && !unlockedSpaces.contains(id) }

    /// What must not be shown nor kept awake: everything while the application is locked, else the guarded spaces not opened since.
    public func covers(space id: String) -> Bool { appLocked || isSpaceLocked(id) }

    /// The guarded spaces that are locked now.
    public var lockedSpaces: [String] { settings.lockedSpaces.filter { !unlockedSpaces.contains($0) } }

    /// Lucium was left: everything that is set to be locked is locked again.
    public mutating func lockAll() {
        appLocked = settings.lockApp
        unlockedSpaces = []
    }

    public mutating func unlockApp() { appLocked = false }

    /// Opens one space only. The application's own lock is not touched: a space opened under a locked application stays hidden by it.
    public mutating func unlock(space id: String) {
        if settings.lockedSpaces.contains(id) { unlockedSpaces.insert(id) }
    }

    /// New choices of the person. A space that has just been guarded is locked at once (only a guarded space can be in `unlockedSpaces`, so a
    /// new one never is); one that is no longer guarded forgets it was opened, so that guarding it again locks it. Turning the application's
    /// lock on does not lock the screen the person is using; it locks when Lucium is left.
    public mutating func apply(_ new: LockSettings) {
        settings = new
        if !new.lockApp { appLocked = false }
        unlockedSpaces.formIntersection(new.lockedSpaces)
    }

    /// The screen must be hidden from the system's picture of the application (the app switcher) and from a look over the shoulder: whenever
    /// the scene is not active and something is set to be locked. Locking itself happens when Lucium goes to the background.
    public func coversScreen(sceneActive: Bool) -> Bool { settings.isActive && !sceneActive }
}

/// The file of the lock's settings, in the application's folder. A missing file is a lock that was never set; a file that cannot be read is
/// reported as such, and the controller locks the application (a lock that fails open is no lock).
public struct LockSettingsFile: Sendable {
    public static let fileName = "lock.json"
    /// A few identifiers: more than this is not a lock's file.
    static let maxBytes = 1_048_576

    public enum Load: Equatable, Sendable {
        case none
        case loaded(LockSettings)
        case unreadable(String)
    }

    public let url: URL

    public init(url: URL) { self.url = url }

    public func load() -> Load {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return .none }
        do {
            let attributes = try manager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else { return .unreadable("not a regular file") }
            guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= Self.maxBytes else { return .unreadable("too large") }
            return .loaded(try JSONDecoder().decode(LockSettings.self, from: Data(contentsOf: url)))
        } catch {
            print("[lock] \(url.path) cannot be read: \(error)")
            return .unreadable(String(describing: error))
        }
    }

    /// Writes the settings; the old file stays whole until the new one is complete and on the disk.
    public func save(_ settings: LockSettings) throws {
        let manager = FileManager.default
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(settings)
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
                do { try manager.removeItem(at: temporary) } catch { print("[lock] cannot remove \(temporary.path) after a failed write: \(error)") }
            }
            throw error
        }
    }
}
