import Foundation

/// What "Rétablir les réglages" puts back and what the "modified" mark of the settings list watches (docs/ios.md, "À propos et Rétablir"). Only the two
/// settings pages that hold plain choices are covered: the search engine of the profile on screen, and the privacy settings. The lock, the spaces and
/// the synchronisation hold the person's own data or an agreement (a pairing, a spaces list): putting them back is never one tap away.
public enum SettingsDefaults {
    /// The engine a profile searches with when nothing was chosen: DuckDuckGo, which the Mac also starts with.
    static let defaultEngine = AddressResolver.defaultSearchTemplate

    /// The rows of the list whose page is no longer at its original value, for the profile on screen.
    public static func changedRows(in state: BrowserState, profileId: String) -> Set<SettingsRow> {
        var rows: Set<SettingsRow> = []
        if state.searchChoice(forProfile: profileId) != originalSearchChoice(forProfile: profileId) { rows.insert(.searchEngine) }
        if state.privacy != .newProfile { rows.insert(.privacy) }
        return rows
    }

    /// Puts both settings back. Answers whether the state changed, so that a list with nothing changed writes nothing. Only the keys of these settings
    /// move: the rest of `settings` (profile names, download folders, the Mac's own keys) goes back out as it came in.
    @discardableResult
    public static func reset(_ state: inout BrowserState, profileId: String) -> Bool {
        let before = state
        state.chooseSearchEngine(originalSearchChoice(forProfile: profileId), forProfile: profileId)
        
        if state.privacy != .newProfile { state.privacy = .newProfile }
        return state != before
    }

    private static func originalSearchChoice(forProfile profileId: String) -> SearchChoice {
        profileId == BrowserState.defaultProfileId ? .engine(defaultEngine) : .inherited
    }
}
