import Foundation

/// The persisted state, in the shape of the Mac's `state.json` (`src/shared/model.ts`, `SidebarState`).
///
/// Only the fields the iOS application reads today are typed. Everything else (themes, boosts, settings, a field a newer Mac
/// adds) is kept in `rest` and written back as it was: an older iPhone never drops what a newer Mac wrote. This is the
/// precondition of any synchronization (docs/ios.md, "Modèle d'état").
public struct BrowserState: Codable, Equatable, Sendable {
    /// The format version this build reads. A file with a higher one is refused, never rewritten (the Mac's `.future-<time>` rule).
    public static let supportedVersion = 1

    public var version: Int
    public var revision: Int?
    public var spaces: [Space]
    public var tabs: [TabItem]
    public var activeSpaceId: String
    public var activeTabBySpace: [String: String?]
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["version", "revision", "spaces", "tabs", "activeSpaceId", "activeTabBySpace"]

    public enum StateError: Error, Equatable {
        case newerVersion(Int)
    }

    public init(version: Int = BrowserState.supportedVersion, revision: Int? = nil, spaces: [Space] = [], tabs: [TabItem] = [],
                activeSpaceId: String = "", activeTabBySpace: [String: String?] = [:], rest: [String: JSONValue] = [:]) {
        self.version = version; self.revision = revision; self.spaces = spaces; self.tabs = tabs
        self.activeSpaceId = activeSpaceId; self.activeTabBySpace = activeTabBySpace; self.rest = rest
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyKey.self)
        version = try container.decode(Int.self, forKey: AnyKey("version"))
        if version > Self.supportedVersion { throw StateError.newerVersion(version) }
        revision = try container.decodeIfPresent(Int.self, forKey: AnyKey("revision"))
        spaces = try container.decode([Space].self, forKey: AnyKey("spaces"))
        tabs = try container.decode([TabItem].self, forKey: AnyKey("tabs"))
        activeSpaceId = try container.decode(String.self, forKey: AnyKey("activeSpaceId"))
        activeTabBySpace = try container.decode([String: String?].self, forKey: AnyKey("activeTabBySpace"))
        rest = try Self.rest(of: container)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyKey.self)
        for (key, value) in rest { try container.encode(value, forKey: AnyKey(key)) }
        try container.encode(version, forKey: AnyKey("version"))
        try container.encodeIfPresent(revision, forKey: AnyKey("revision"))
        try container.encode(spaces, forKey: AnyKey("spaces"))
        try container.encode(tabs, forKey: AnyKey("tabs"))
        try container.encode(activeSpaceId, forKey: AnyKey("activeSpaceId"))
        try container.encode(activeTabBySpace, forKey: AnyKey("activeTabBySpace"))
    }

    private static func rest(of container: KeyedDecodingContainer<AnyKey>) throws -> [String: JSONValue] {
        var rest: [String: JSONValue] = [:]
        for key in container.allKeys where !known.contains(key.stringValue) {
            rest[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
        }
        return rest
    }

    /// Reads a state file. Throws `StateError.newerVersion` for a file written by a newer format.
    public static func decode(_ data: Data) throws -> BrowserState {
        try JSONDecoder().decode(BrowserState.self, from: data)
    }
}

/// A space: a colour, an emoji and a profile. Spaces sharing a `profileId` share their cookies and storage.
public struct Space: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var emoji: String
    public var profileId: String
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "name", "emoji", "profileId"]

    public init(id: String, name: String, emoji: String, profileId: String, rest: [String: JSONValue] = [:]) {
        self.id = id; self.name = name; self.emoji = emoji; self.profileId = profileId; self.rest = rest
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyKey.self)
        id = try container.decode(String.self, forKey: AnyKey("id"))
        name = try container.decode(String.self, forKey: AnyKey("name"))
        emoji = try container.decode(String.self, forKey: AnyKey("emoji"))
        profileId = try container.decode(String.self, forKey: AnyKey("profileId"))
        rest = [:]
        for key in container.allKeys where !Self.known.contains(key.stringValue) {
            rest[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyKey.self)
        for (key, value) in rest { try container.encode(value, forKey: AnyKey(key)) }
        try container.encode(id, forKey: AnyKey("id"))
        try container.encode(name, forKey: AnyKey("name"))
        try container.encode(emoji, forKey: AnyKey("emoji"))
        try container.encode(profileId, forKey: AnyKey("profileId"))
    }
}

/// A tab of a space (`TabItem` on the Mac).
public struct TabItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var spaceId: String
    public var url: String
    public var title: String
    public var pinned: Bool
    public var rest: [String: JSONValue]

    private static let known: Set<String> = ["id", "spaceId", "url", "title", "pinned"]

    public init(id: String, spaceId: String, url: String, title: String, pinned: Bool = false, rest: [String: JSONValue] = [:]) {
        self.id = id; self.spaceId = spaceId; self.url = url; self.title = title; self.pinned = pinned; self.rest = rest
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyKey.self)
        id = try container.decode(String.self, forKey: AnyKey("id"))
        spaceId = try container.decode(String.self, forKey: AnyKey("spaceId"))
        url = try container.decode(String.self, forKey: AnyKey("url"))
        title = try container.decode(String.self, forKey: AnyKey("title"))
        pinned = try container.decode(Bool.self, forKey: AnyKey("pinned"))
        rest = [:]
        for key in container.allKeys where !Self.known.contains(key.stringValue) {
            rest[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyKey.self)
        for (key, value) in rest { try container.encode(value, forKey: AnyKey(key)) }
        try container.encode(id, forKey: AnyKey("id"))
        try container.encode(spaceId, forKey: AnyKey("spaceId"))
        try container.encode(url, forKey: AnyKey("url"))
        try container.encode(title, forKey: AnyKey("title"))
        try container.encode(pinned, forKey: AnyKey("pinned"))
    }
}
