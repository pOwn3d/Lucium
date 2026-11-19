import Foundation

/// A page the settings screen opens (docs/ios.md, "Les réglages"): one row of the list, one screen behind it.
public enum SettingsRow: String, CaseIterable, Identifiable, Hashable, Sendable {
    /// The search engine of the profile of the space on screen.
    case searchEngine
    /// The protection level and the three rewrites of the privacy rules, and what is said of the blocker.
    case privacy
    /// What Lucium says of passwords and passkeys: it keeps none, and what iOS does in a page is the system's (docs/ios.md, "AutoFill et passkeys").
    case passwords
    /// What is locked: the application, and each space.
    case lock
    /// The spaces, grouped by profile.
    case spaces
    /// The synchronisation with the Mac (phase 2: the place is kept, no row is shown until it exists).
    case sync
    /// The licence of the application and the credits of the filter lists it carries.
    case licenses

    public var id: String { rawValue }
}

/// A block of the settings list.
public enum SettingsSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case navigation, privacy, spaces, sync, about

    public var id: String { rawValue }

    /// The rows of the section, in the order they are listed.
    public var rows: [SettingsRow] {
        switch self {
        case .navigation: [.searchEngine]
        case .privacy: [.privacy, .passwords, .lock]
        case .spaces: [.spaces]
        case .sync: [.sync]
        case .about: [.licenses]
        }
    }
}

/// What a section of the list holds for this run of the application.
public struct SettingsGroup: Equatable, Identifiable, Sendable {
    public let section: SettingsSection
    public let rows: [SettingsRow]
    public var id: String { section.id }
}

/// Which sections and rows the settings screen lists, and in what order. Pure, so that `swift test` proves it: the screen draws what this says.
public enum SettingsLayout {
    /// The groups of the list, in order, without an empty one. A row that this copy cannot offer is left out, and so is its section when nothing is left:
    /// - the lock, on a copy that has no lock controller (`lockAvailable`);
    /// - the synchronisation, until the phase 2 gives it a page (`syncAvailable`, off): the place is there, between the spaces and the licences, so that
    ///   the page is added without moving anything else.
    public static func groups(lockAvailable: Bool, syncAvailable: Bool = false) -> [SettingsGroup] {
        SettingsSection.allCases.compactMap { section in
            let rows = section.rows.filter { row in
                switch row {
                case .lock: lockAvailable
                case .sync: syncAvailable
                default: true
                }
            }
            return rows.isEmpty ? nil : SettingsGroup(section: section, rows: rows)
        }
    }
}
