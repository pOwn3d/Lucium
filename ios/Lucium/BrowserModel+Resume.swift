import LuciumKit
import SwiftUI

/// « Reprendre un onglet du Mac » (docs/synchronisation.md §10.4): the pages the Mac announced at its last session. The list is read from the synchronisation, in
/// memory only; a tap opens the address as an ordinary new tab. Nothing about the list is ever written to the state.
extension BrowserModel {
    /// The rows of the list, as the sheet and the command bar show them. Nothing while the application is locked.
    var resumeRows: [SyncResume.Row] {
        guard lock?.appLocked != true else { return [] }
        return sync?.resumeRows ?? []
    }

    /// Why there are no rows, or `.list`. A phone with no synchronisation at all says it is not paired.
    var resumeAvailability: SyncResume.Availability {
        guard lock?.appLocked != true else { return .waiting }
        return sync?.resumeAvailability ?? .notPaired
    }

    /// The space a row opens in (see `SyncResume.targetSpace`).
    func resumeSpace(of row: SyncResume.Row) -> String? {
        SyncResume.targetSpace(of: row, spaceIds: Set(state.spaces.map(\.id)), activeSpaceId: state.activeSpaceId, isLocked: isCovered)
    }

    /// The space whose name a row may show: its own when this phone has it and it is not locked (a locked space says nothing of itself).
    func resumeSpaceShown(of row: SyncResume.Row) -> Space? {
        guard !isCovered(row.spaceId) else { return nil }
        return state.spaces.first { $0.id == row.spaceId }
    }

    /// Opens the address of a row in a new tab of the space it goes to, and shows it. An address that is not a web page, or no space to put it in (everything
    /// is locked), opens nothing.
    func resume(_ row: SyncResume.Row) {
        commandBarShown = false
        settingsShown = false
        tabsSheetShown = false
        guard SyncResume.isWebAddress(row.url), let space = resumeSpace(of: row) else { return }
        drawerEvent(.pageShown)
        leaveActiveTab()
        if space != state.activeSpaceId { state.selectSpace(space) }
        guard state.openTab(id: UUID().uuidString.lowercased(), in: space, url: row.url, title: row.title, now: clock()) != nil else {
            ensureActiveTab()
            arrive()
            return
        }
        arrive()
    }

    /// What the source « Sur le Mac » of the command bar lists for a text: the rows that match, a few of them among the other answers, all of them under its filter.
    func commandMacTabs(matching text: String, filtered: Bool) -> [SyncResume.Row] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if filtered { return SyncResume.matching(resumeRows, query: query) }
        return query.isEmpty ? [] : SyncResume.matching(resumeRows, query: query, limit: 5)
    }

    /// Whether the bar offers the source: a Mac is paired (when the category is off, the source says how to turn it on instead of staying out of sight).
    var offersMacSource: Bool { resumeAvailability != .notPaired }
}
