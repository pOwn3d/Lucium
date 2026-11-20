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

    /// The appearance of the whole application the person chose (system, light or dark).
    var interfaceAppearance: InterfaceAppearance { state.interfaceAppearance }

    /// The scheme the screen is forced to for the space on screen: the application's own choice, else the one the space's theme asks for, else nil (the
    /// system's).
    var forcedColorScheme: ColorScheme? {
        switch state.forcedAppearance(forSpace: state.activeSpaceId) {
        case .light?: .light
        case .dark?: .dark
        default: nil
        }
    }

    /// Chooses the appearance of the application; kept like any other change.
    func chooseInterfaceAppearance(_ appearance: InterfaceAppearance) {
        var next = state
        guard next.chooseInterfaceAppearance(appearance) else { return }
        state = next
        scheduleSave()
    }

    /// What the settings list says of the protection level, for the row that opens the privacy page.
    var privacyLevelSummary: LocalizedStringKey {
        switch privacySettings.level {
        case .standard?: "privacy.level.standard"
        case .enhanced?: "privacy.level.enhanced"
        case .strict?: "privacy.level.strict"
        case nil: "settings.privacy.custom"
        }
    }

    // MARK: Tabs

    /// What the profile of the space on screen archives with, or that it follows the default profile's (`autoArchiveHours`, the Mac's key).
    var archiveChoice: ArchiveChoice { state.archiveChoice(forProfile: settingsProfileId) }

    /// The delay in force for the profile of the space on screen, whether it chose it or follows the default profile.
    var archiveHours: Double { state.autoArchiveHours(forSpace: activeSpace.id) }

    /// Chooses the archive delay of the profile of the space on screen. It is the delay the sweep reads when the application comes to the front.
    func chooseArchiveDelay(_ choice: ArchiveChoice) {
        var next = state
        guard next.chooseArchiveDelay(choice, forProfile: settingsProfileId) else { return }
        state = next
        scheduleSave()
    }

    /// How many tabs keep a live page: the limit in the state (the Mac's `sleepAwakeMax`, 0 = no limit), else the application's own.
    var awakeLimit: Int { state.awakeTabLimit ?? awakeCap }

    /// The cap the sleep rules use: no limit is a cap nothing reaches.
    var effectiveAwakeCap: Int { awakeLimit == 0 ? Int.max : awakeLimit }

    /// Chooses how many tabs stay awake; a lower number frees the surplus now.
    func chooseAwakeTabLimit(_ limit: Int) {
        var next = state
        guard next.chooseAwakeTabLimit(limit) else { return }
        state = next
        scheduleSave()
        Task { await sleepSurplus() }
    }
}
