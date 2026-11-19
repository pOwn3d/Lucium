import LuciumKit
import SwiftUI

/// What the settings screen reads and changes on the model (docs/ios.md, "Les réglages"). The rules are in `LuciumKit` (`SettingsLayout`,
/// `chooseSearchEngine`), proved there; this is the part that keeps the state and tells the screen.
extension BrowserModel {
    /// Opens the settings, on a page when one is named (the list when not).
    func openSettings(on row: SettingsRow? = nil) {
        settingsStart = row
        settingsShown = true
    }

    /// The profile the settings of the navigation are about: the one of the space on screen.
    var settingsProfileId: String { activeSpace.profileId }

    /// The engine the profile of the space on screen searches with, or that it follows the default profile's.
    var searchChoice: SearchChoice { state.searchChoice(forProfile: settingsProfileId) }

    /// The engine the profile searches with, whether it chose it or follows the default profile.
    var searchTemplate: String { state.searchTemplate(forProfile: settingsProfileId) }

    /// Chooses the search engine of the profile of the space on screen. The state is the Mac's: the choice is written where the Mac reads it, and
    /// kept like any other change. The next search of the command bar and the start page's field use it at once (they read the state).
    func chooseSearchEngine(_ choice: SearchChoice) {
        var next = state
        guard next.chooseSearchEngine(choice, forProfile: settingsProfileId) else { return }
        state = next
        scheduleSave()
    }

    /// The rows of the settings list whose page is no longer at its original value, for the profile on screen: they carry the "Changed" mark.
    var changedSettingsRows: Set<SettingsRow> { SettingsDefaults.changedRows(in: state, profileId: settingsProfileId) }

    /// "Rétablir les réglages": the search engine of the profile on screen and the privacy settings go back to their original values. Nothing else moves
    /// (`SettingsDefaults`); a list with nothing changed writes nothing.
    func resetSettings() {
        var next = state
        guard SettingsDefaults.reset(&next, profileId: settingsProfileId) else { return }
        state = next
        scheduleSave()
    }

    /// What the settings list says of the protection level, for the row that opens the privacy page.
    var privacyLevelSummary: LocalizedStringKey {
        switch privacySettings.level {
        case .standard?: "privacy.level.standard"
        case .enhanced?: "privacy.level.enhanced"
        case nil: "settings.privacy.custom"
        }
    }
}
