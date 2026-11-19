import Foundation

/// A page the settings screen opens (docs/ios.md, "Les réglages"): one row of the list, one screen behind it.
public enum SettingsRow: String, CaseIterable, Identifiable, Hashable, Sendable {
    /// System, light or dark for the whole application (the Mac's `interfaceAppearance`).
    case appearance
    /// The search engine of the profile of the space on screen.
    case searchEngine
    /// How long an idle Today tab waits before it is archived, and how many tabs keep a live page.
    case tabs
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
    /// The version, and the links to the site and to the help.
    case about
    /// Not a page: "Rétablir les réglages", a button that asks before it puts the search engine and the privacy settings back.
    case reset

    public var id: String { rawValue }
}

/// A block of the settings list.
public enum SettingsSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case navigation, privacy, spaces, sync, about, reset

    public var id: String { rawValue }

    /// The rows of the section, in the order they are listed.
    public var rows: [SettingsRow] {
        switch self {
        case .navigation: [.searchEngine, .tabs, .appearance]
        case .privacy: [.privacy, .passwords, .lock]
        case .spaces: [.spaces]
        case .sync: [.sync]
        case .about: [.about, .licenses]
        case .reset: [.reset]
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

/// The two pages of the project's site the About page links to, in the language of the interface. The addresses are the Mac's (`DOWNLOAD_PAGES`'s site and
/// `PROBLEM_SITE_URLS` in `src/shared`): the site, and the community page where a question is asked without an account. They are here and nowhere else.
/// There is no donation link: the App Store review notes promise none (guideline 3.2.2).
public enum AboutLinks {
    public static func site(languageCode: String?) -> URL { URL(string: languageCode == "fr" ? "https://lucium.app/" : "https://lucium.app/en/")! }
    public static func help(languageCode: String?) -> URL { URL(string: languageCode == "fr" ? "https://lucium.app/communaute/" : "https://lucium.app/en/community/")! }
}
