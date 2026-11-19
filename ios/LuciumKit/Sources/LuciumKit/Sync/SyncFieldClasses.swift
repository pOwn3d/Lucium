import Foundation

/// What is synchronised, field by field (docs/synchronisation.md §10.2, §10.3, §10.5): the Swift twin of `src/main/sync/field-classes.ts`, checked by the same
/// vectors (`fieldClasses`, `settingsAllowed`, `neverKinds` of `ios/Contracts/sync-message-vectors.json`). Every field of the five kinds is in ONE of three
/// classes:
///   - synced: merged field by field (§11);
///   - seed: copied when the entity is created on the other device, then local (the page a pinned tab is on is noise);
///   - local: never sent (a file that only exists on the device, a runtime flag, the clock of the last use…).
/// A field a LATER version added is in no class and crosses as opaque (§11.6): that is the rule for entities, never for settings.
public enum SyncFieldClasses {
    /// The six kinds of entity this version knows how to write into its state. `setting` is a seventh kind of the snapshot, with its own closed list. `todayTab` is the open
    /// tabs of "Today" (§27): a projection of the tabs of the state that are not pinned, admitted by `SyncToday.admit`, and not a list of the state of its own.
    public enum Kind: String, CaseIterable, Sendable {
        case space, folder, tab, favorite, archived, todayTab
    }

    public struct Classes: Equatable, Sendable {
        public let synced: [String]
        public let seed: [String]
        public let local: [String]
    }

    public static let classes: [Kind: Classes] = [
        .space: Classes(synced: ["id", "name", "emoji", "theme", "profileId", "hideHeader", "iconKind", "iconLetter", "iconColor", "iconRound"], seed: [], local: ["image", "background", "webPanels"]),
        .folder: Classes(synced: ["id", "spaceId", "name", "parentId", "atBottom", "atTodayStart", "noWake", "icon"], seed: ["collapsed"], local: ["live"]),
        .tab: Classes(synced: ["id", "spaceId", "pinned", "anchorUrl", "customTitle", "icon", "folderId", "keepAwake"], seed: ["url", "title"],
                      local: ["image", "faviconUrl", "deadKept", "autoReload", "container", "windowKey", "openerId", "parentId", "treeCollapsed", "favoriteId", "createdAt", "lastActiveAt", "private"]),
        .favorite: Classes(synced: ["id", "url", "title", "profileId"], seed: [], local: ["faviconUrl"]),
        .archived: Classes(synced: ["id", "spaceId", "url", "title", "archivedAt", "source", "pinned", "anchorUrl", "folderId"], seed: [], local: ["history", "container"]),
        .todayTab: SyncToday.fieldClasses,
    ]

    /// The closed list of settings (§10.3): nothing is "every setting but these".
    public static let settingKeys = ["httpsUpgrade", "sendGpc", "stripTrackingParams", "stripCopiedLinks", "protectionBaseline", "autoArchiveHours", "searchUrlTemplate", "profileNames"]

    /// The kinds that are code or secrets: never sent, never taken, whatever a device says (§10.5).
    public static let neverKinds = ["boost", "userScript", "extension", "password", "vault", "lock", "history", "cookie", "session"]

    /// The most archived tabs of one space that are sent: the latest (§10.1).
    public static let archivePerSpaceSent = 500

    public static func kind(_ name: String) -> Kind? { Kind(rawValue: name) }

    /// Whether the book of marks follows a field of an entity of this kind: what `adopt` is told. A field of a kind this version does not know is followed as it comes.
    public static func follows(kind: String, field: String) -> Bool {
        if kind == "setting" { return field == "value" }
        guard let known = Kind(rawValue: kind), let classes = classes[known] else { return true }
        return field != "id" && !classes.local.contains(field) && !classes.seed.contains(field)
    }
}
