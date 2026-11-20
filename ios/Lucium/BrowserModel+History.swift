import LuciumKit
import SwiftUI
import WebKit

/// The history of this phone (docs/ios.md, "Historique"; decision of the project lead, 19 November 2026): the pages visited, kept on the phone only,
/// cleared in one gesture, for a delay the person chooses, never for a private tab and never synchronised. The rules are `HistoryBook` and
/// `BrowserState.recordsHistory` (`LuciumKit`, proved there); this is the part that watches the pages and keeps the file.
extension BrowserModel {
    /// The profile the history on screen is about: the one of the space on screen.
    var historyProfileId: String { settingsProfileId }

    /// Whether the profile of the space on screen keeps the pages it visits (the Mac's `historyOff`, read with its rule).
    var recordsHistory: Bool { state.recordsHistory(forProfile: historyProfileId) }

    /// Whether the command bar offers the "History" chip: nothing is offered while the space is covered, and a profile that keeps nothing and has nothing
    /// kept has nothing to open (the chip would lead nowhere).
    var historyAvailable: Bool {
        !activeSpaceCovered && (recordsHistory || historyCount > 0)
    }

    /// How many pages the profile on screen has kept.
    var historyCount: Int { history.count(profileId: historyProfileId, now: clock()) }

    /// The pages of the profile on screen that answer `query`; none while the space is covered (a locked space shows nothing of its profile).
    func historyEntries(matching query: String, limit: Int) -> [HistoryEntry] {
        activeSpaceCovered ? [] : history.entries(profileId: historyProfileId, matching: query, limit: limit, now: clock())
    }

    // MARK: Watching the pages

    /// A page of a tab changed: a loaded page is a visit (once per address and tab), a title that arrives later renames it. A private tab never writes.
    func noteVisit(_ view: WKWebView, tabId: String) {
        guard let tab = state.tabs.first(where: { $0.id == tabId }), !tab.isPrivate,
              let space = state.spaces.first(where: { $0.id == tab.spaceId }),
              state.recordsHistory(forProfile: space.profileId),
              let address = view.url?.absoluteString, HistoryBook.isRecordable(address) else { return }
        let title = view.title ?? ""
        var changed = false
        if historyLastVisit[tabId] == address {
            changed = history.retitle(url: address, title: title, profileId: space.profileId)
        } else if !view.isLoading {
            historyLastVisit[tabId] = address
            changed = history.visit(url: address, title: title, profileId: space.profileId, at: clock())
        }
        if changed { scheduleHistorySave() }
    }

    // MARK: Choices

    /// Chooses whether the profile on screen keeps its history. Pages already kept stay until they are cleared or expire.
    func chooseRecordsHistory(_ records: Bool) {
        var next = state
        guard next.chooseRecordsHistory(records, forProfile: historyProfileId) else { return }
        state = next
        scheduleSave()
    }

    /// Chooses how long visits are kept; the ones older than the new delay go now.
    func chooseHistoryRetention(days: Int) {
        guard history.chooseRetention(days: days) else { return }
        history.prune(now: clock())
        scheduleHistorySave()
    }

    /// Forgets one page of the profile on screen.
    func forgetHistoryEntry(_ entry: HistoryEntry) {
        guard history.forget(url: entry.url, profileId: historyProfileId) else { return }
        scheduleHistorySave()
    }

    /// Clears the history of the profile on screen, in one gesture, and writes the file at once (what is cleared must not come back with a crash).
    func clearHistory() {
        guard history.clear(profileId: historyProfileId) else { return }
        historyLastVisit = [:]
        flushHistory()
    }

    // MARK: The file

    func loadHistory() {
        guard let historyFile else { return }
        switch historyFile.load(now: clock()) {
        case .fresh: break
        case .loaded(let book):
            history = book
            if history.prune(now: clock()) { scheduleHistorySave() }
        case .setAside(let aside): report(.history, "the history could not be read and was put aside as \(aside.lastPathComponent)")
        }
    }

    func scheduleHistorySave() {
        guard historyFile != nil else { return }
        historySaveTask?.cancel()
        historySaveTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }  // cancelled: a newer change schedules its own write
            self?.flushHistory()
        }
    }

    func flushHistory() {
        historySaveTask?.cancel()
        historySaveTask = nil
        guard let historyFile else { return }
        do {
            try historyFile.save(history)
            storageProblems[.history] = nil
        } catch {
            report(.history, "the history was not written: \(error)")
        }
    }
}
