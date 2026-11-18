import Foundation

/// What the person can choose to send (docs/synchronisation.md §10.1). A category goes only if both devices have it ticked.
public enum SyncCategory: String, CaseIterable, Codable, Hashable, Sendable {
    /// Spaces, folders, favourites and pinned tabs.
    case structure
    /// The eight common settings of §10.3.
    case settings
    /// The archived tabs.
    case archive
    /// A read-only announcement of the open tabs, for "Resume a tab of the Mac" (§10.4).
    case openTabs

    /// Decision of the project lead (18 November 2026, [Q2]): only the structure is ticked until the person ticks more. The others are what looks most like a
    /// browsing history, or what changes all the time.
    public static let defaults: [SyncCategory] = [.structure]
}

/// The Mac this phone is paired with: what is kept of the pairing (§3.3). Not a secret: the fingerprint is public (it is the hash of a certificate), and the
/// private key is in the keychain, not here.
public struct SyncPairedMac: Codable, Equatable, Sendable {
    public static let maxHosts = 4

    public var id: String
    public var name: String
    /// The SHA-256 of the Mac's certificate, lower-case hexadecimal, 64 characters: the one every connection is pinned to.
    public var fingerprintHex: String
    public var port: Int
    /// The last addresses and `.local` name the Mac gave, in the order to try them (`SyncCandidates`).
    public var hosts: [String]
    /// Milliseconds since 1970.
    public var pairedAt: Int
    /// The last time the Mac answered a session, in milliseconds since 1970.
    public var lastContactAt: Int?

    public init(id: String, name: String, fingerprintHex: String, port: Int, hosts: [String], pairedAt: Int, lastContactAt: Int? = nil) {
        self.id = id
        self.name = name
        self.fingerprintHex = fingerprintHex
        self.port = port
        self.hosts = hosts
        self.pairedAt = pairedAt
        self.lastContactAt = lastContactAt
    }

    public var fingerprint: Data? { SyncEncoding.data(hex: fingerprintHex).flatMap { $0.count == SyncPairingCode.fingerprintBytes ? $0 : nil } }

    /// A record that can be trusted to connect with: every field has the shape the protocol gives it. A file is read as hostile (§3.3).
    var isWellFormed: Bool {
        SyncDeviceInfo.isValidId(id) && !name.isEmpty && name.unicodeScalars.count <= SyncLimits.maxDeviceNameCharacters && fingerprint != nil && fingerprintHex == fingerprintHex.lowercased()
            && (1...65535).contains(port) && hosts.count <= Self.maxHosts && hosts.allSatisfy { SyncAddress.isLocal($0) }
    }
}

/// The phone's synchronisation settings. They live in a file of their own (`sync.json`), never in `state.json`: a state brought from the Mac, or a
/// synchronisation, can neither switch this on nor name a Mac to talk to (the same rule as the lock's `lock.json`).
public struct SyncSettings: Codable, Equatable, Sendable {
    public static let version = 1

    /// Off until the person turns it on. Nothing runs, nothing is asked of the system, while it is off.
    public var enabled: Bool
    public var categories: [SyncCategory]
    /// This phone's identifier in the protocol: 16 random bytes in base64url, made at the first activation (§3.2). Never derived from anything on the phone.
    public var deviceId: String?
    public var mac: SyncPairedMac?

    public init(enabled: Bool = false, categories: [SyncCategory] = SyncCategory.defaults, deviceId: String? = nil, mac: SyncPairedMac? = nil) {
        self.enabled = enabled
        self.categories = categories
        self.deviceId = deviceId
        self.mac = mac
    }

    public enum ReadError: Error, Equatable {
        /// Written by a newer format: not read, so not trusted.
        case newerVersion(Int)
        /// A record that does not have the shape of a pairing: not used.
        case badRecord
    }

    private enum Keys: String, CodingKey { case version, enabled, categories, deviceId, mac }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version >= 1, version <= Self.version else { throw ReadError.newerVersion(version) }
        enabled = try container.decode(Bool.self, forKey: .enabled)
        // A category this version does not know is left out, not an error: a newer version may have added one.
        let names = try container.decode([String].self, forKey: .categories)
        categories = Self.unique(names.compactMap(SyncCategory.init(rawValue:)))
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
        if let id = deviceId, !SyncDeviceInfo.isValidId(id) { throw ReadError.badRecord }
        mac = try container.decodeIfPresent(SyncPairedMac.self, forKey: .mac)
        if let mac, !mac.isWellFormed { throw ReadError.badRecord }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(Self.version, forKey: .version)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(categories.map(\.rawValue), forKey: .categories)
        try container.encodeIfPresent(deviceId, forKey: .deviceId)
        try container.encodeIfPresent(mac, forKey: .mac)
    }

    private static func unique(_ list: [SyncCategory]) -> [SyncCategory] {
        var seen = Set<SyncCategory>()
        return list.filter { seen.insert($0).inserted }
    }

    /// What §3.3 says of a restore: a settings file that names a Mac while the key is gone (a backup restored on another phone, a reinstall) has nothing to
    /// pair with. The Mac is forgotten, and the person is told to pair again. Returns true when it changed something.
    public mutating func reconcile(identityPresent: Bool) -> Bool {
        guard !identityPresent, mac != nil else { return false }
        mac = nil
        return true
    }
}

/// The file of the settings, in the application's folder. A missing file is a synchronisation never set up; a file that cannot be read is reported, and the
/// synchronisation stays off (a setting that cannot be read must not be guessed).
public struct SyncSettingsFile: Sendable {
    public static let fileName = "sync.json"
    static let maxBytes = 65_536

    public enum Load: Equatable, Sendable {
        case none
        case loaded(SyncSettings)
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
            return .loaded(try JSONDecoder().decode(SyncSettings.self, from: Data(contentsOf: url)))
        } catch {
            print("[sync] \(url.lastPathComponent) cannot be read: \(error)")
            return .unreadable(String(describing: error))
        }
    }

    /// Writes the settings; the old file stays whole until the new one is complete and on the disk.
    public func save(_ settings: SyncSettings) throws {
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
                do { try manager.removeItem(at: temporary) } catch { print("[sync] cannot remove \(temporary.path) after a failed write: \(error)") }
            }
            throw error
        }
    }

    /// Removes the file (the person forgot the Mac and turned the synchronisation off, or the phone is reset).
    public func remove() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
