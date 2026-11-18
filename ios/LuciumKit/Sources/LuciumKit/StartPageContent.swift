import Foundation

/// What the start page of a blank tab shows under its search field (docs/ios.md, "La page de démarrage"): the favourites of the profile of the
/// space, or a sentence that says how to add one, or nothing of the profile at all. Pure, so that what the page lists is proved on the Mac with
/// `swift test`; the view only draws the answer.
public enum StartPageContent: Equatable, Sendable {
    /// The favourites of the profile of the space, in the order of the state (the Mac's order), never empty.
    case favorites([Favorite])
    /// The profile has no favourite: the page says how to add one.
    case noFavorites
    /// A private tab has no profile: the favourites of the space are not offered there, because opening one would leave the private tab for a page
    /// that has the cookies of the profile. The page says what a private tab is instead.
    case privateTab
    /// The space is locked: the page shows nothing of it (the lock hides every list, `BrowserModel+Library.swift`).
    case hidden

    /// How many tiles a row holds (the decision of the project lead, 18 November 2026; the sheet of tabs and the sidebar draw four as well).
    public static let columns = 4

    /// What the page of a blank tab of `spaceId` shows. `covered` is whether the lock hides that space; `isPrivate` whether the tab is a private one.
    public static func make(in state: BrowserState, space spaceId: String, covered: Bool, isPrivate: Bool) -> StartPageContent {
        if covered { return .hidden }
        if isPrivate { return .privateTab }
        let favorites = state.favorites(inSpace: spaceId)
        return favorites.isEmpty ? .noFavorites : .favorites(favorites)
    }

    /// The sentence at the foot of the page, about what stays on the device (decision of the project lead, 18 November 2026). It says what is true: nothing leaves the
    /// device, unless the synchronisation is on with a Mac, in which case the one thing that leaves is the exchange with that Mac, on the local network.
    public enum PrivacyNote: Equatable, Sendable {
        /// "Nothing leaves this device."
        case staysOnTheDevice
        /// "Nothing leaves this device, except to your Mac, on your network."
        case staysExceptToTheMac
    }

    /// - Parameter synchronizing: the synchronisation is switched on and a Mac is paired: what the page promises is then not the whole truth any more. Switched on with
    ///   no Mac, nothing can leave, and the plain sentence stays.
    public static func privacyNote(synchronizing: Bool) -> PrivacyNote {
        synchronizing ? .staysExceptToTheMac : .staysOnTheDevice
    }
}
