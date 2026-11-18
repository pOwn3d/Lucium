import Foundation

/// A block of the command bar's list.
public enum CommandBarSection: Equatable, Sendable, Identifiable {
    /// What the keyboard's Go key does with the text: open the address, or search with the engine of the profile.
    case enter(ResolvedInput)
    case tabs, commands, favorites
    /// The tabs the Mac announced (« Sur le Mac »), under the tabs of this phone.
    case mac

    public var id: String {
        switch self {
        case .enter: "enter"
        case .tabs: "tabs"
        case .commands: "commands"
        case .favorites: "favorites"
        case .mac: "mac"
        }
    }
}

/// The order of the command bar's list. The line the Go key runs comes first, as on the Mac (`rankCandidates` puts the address typed, or the
/// search, ahead of the tabs and the rest, and Enter takes the first line): somebody who types "youtube" sees at once that Go searches, and
/// somebody who types "youtube.com" that it opens the address, whatever tabs and favourites answer under it. Put last, the line fell below the
/// tabs, the commands and the favourites, out of sight behind the keyboard, and a tab named like the text looked like what Go would open.
public enum CommandBarLayout {
    /// The blocks that have something to show, top to bottom. `enter` is nil when the bar lists no line for the Go key (nothing typed, or a
    /// filter chosen).
    public static func sections(enter: ResolvedInput?, hasTabs: Bool, hasCommands: Bool, hasFavorites: Bool, hasMac: Bool = false) -> [CommandBarSection] {
        var sections: [CommandBarSection] = []
        if let enter { sections.append(.enter(enter)) }
        if hasTabs { sections.append(.tabs) }
        if hasMac { sections.append(.mac) }
        if hasCommands { sections.append(.commands) }
        if hasFavorites { sections.append(.favorites) }
        return sections
    }
}
