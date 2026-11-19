import LuciumKit
import SwiftUI

/// What the person kept: bookmarks, and the pages put aside to read later (docs/ios.md, §5.4). The rules and the stored shape are in `LuciumKit`
/// (`Keepsakes.swift`, held by vectors shared with the Mac); here a tap keeps or opens a page, the sheet is shown, and the person is told what happened.
/// The two lists are shared by every space and stay on this device (the synchronisation does not carry them yet).
extension BrowserModel {
    /// What a tap on "Add to bookmarks" or "Read later" did, shown once as a line above the bottom bar.
    enum KeepNotice: Equatable, Identifiable {
        case bookmarkSaved, bookmarkAlready, bookmarkFull, bookmarkRemoved
        case readLaterSaved, readLaterAlready, readLaterFull
        case unsupported

        var id: Self { self }
        /// Whether the line offers to open the lists (not for a page that cannot be kept at all).
        var offersList: Bool { self != .unsupported }
        var list: KeptList {
            switch self {
            case .readLaterSaved, .readLaterAlready, .readLaterFull: .readLater
            default: .bookmarks
            }
        }
        /// The sentence, shown on the line and spoken to VoiceOver (one source for both).
        var message: String.LocalizationValue {
            switch self {
            case .bookmarkSaved: "kept.notice.bookmark-saved"
            case .bookmarkAlready: "kept.notice.bookmark-already"
            case .bookmarkFull: "kept.notice.bookmark-full"
            case .bookmarkRemoved: "kept.notice.bookmark-removed"
            case .readLaterSaved: "kept.notice.later-saved"
            case .readLaterAlready: "kept.notice.later-already"
            case .readLaterFull: "kept.notice.later-full"
            case .unsupported: "kept.notice.unsupported"
            }
        }
    }

    // MARK: Reading

    var bookmarks: [Bookmark] { state.bookmarks }
    var readLaterPages: [ReadLaterItem] { state.readLater }

    /// The tab whose page can be kept: a tab that shows a web page, not a private one (a private page leaves no trace) and not a covered one.
    var keepableTab: TabItem? {
        guard let tab = activeTab, !tab.isPrivate, !tab.isBlank, Keepsakes.isWebAddress(tab.url, max: Keepsakes.bookmarkUrlMax) else { return nil }
        return tab
    }

    /// Whether the page on screen is a bookmark already (the menu then offers to remove it).
    var activePageIsBookmarked: Bool {
        guard let tab = keepableTab else { return false }
        return state.bookmarkOutcome(of: tab.url) == .already
    }

    // MARK: Keeping

    /// Bookmarks the page on screen, or removes the bookmark when it already is one.
    func toggleBookmark() {
        guard let tab = keepableTab else { show(.unsupported); return }
        if state.bookmarkOutcome(of: tab.url) == .already {
            let key = Keepsakes.key(of: tab.url)
            guard let mark = state.bookmarks.first(where: { Keepsakes.key(of: $0.url) == key }) else { return }
            keepChange { $0.removeBookmark(id: mark.id) }
            show(.bookmarkRemoved)
            return
        }
        var outcome = KeepOutcome.unsupported
        keepChange { outcome = $0.addBookmark(id: UUID().uuidString.lowercased(), url: tab.url, title: tab.title, now: clock()) }
        show(outcome == .saved ? .bookmarkSaved : outcome == .already ? .bookmarkAlready : outcome == .full ? .bookmarkFull : .unsupported)
    }

    /// Puts the page on screen in "Read later" and closes its tab, as the Mac does (a pinned tab stays: it is not closed by keeping its page). A full
    /// list refuses the page and the tab stays open, so nothing is lost.
    func readLater() {
        guard let tab = keepableTab, Keepsakes.isWebAddress(tab.url, max: Keepsakes.readLaterUrlMax) else { show(.unsupported); return }
        var outcome = KeepOutcome.unsupported
        keepChange { outcome = $0.addReadLater(id: UUID().uuidString.lowercased(), url: tab.url, title: tab.title, now: clock()) }
        switch outcome {
        case .saved, .already:
            if !tab.pinned { close(tab) }
            show(outcome == .saved ? .readLaterSaved : .readLaterAlready)
        case .full: show(.readLaterFull)
        case .unsupported: show(.unsupported)
        }
    }

    func removeBookmark(_ bookmark: Bookmark) { keepChange { $0.removeBookmark(id: bookmark.id) } }
    func removeReadLater(_ page: ReadLaterItem) { keepChange { $0.removeReadLater(id: page.id) } }
    func clearReadLater() { keepChange { $0.clearReadLater() } }

    // MARK: Opening

    /// Opens a kept page in a new tab of the active space (it stays in its list), and closes the sheet. A blank tab on screen is not left behind.
    func openKept(address: String) {
        guard !activeSpaceCovered, Keepsakes.isWebAddress(address, max: Keepsakes.bookmarkUrlMax) else { return }
        keptShown = false
        tabsSheetShown = false
        commandBarShown = false
        drawerEvent(.pageShown)
        let blank = activeTab.flatMap { $0.isBlank ? $0 : nil }
        leaveActiveTab()
        guard state.openTab(id: UUID().uuidString.lowercased(), in: state.activeSpaceId, url: address, now: clock()) != nil else { return }
        arrive()
        if let blank { close(blank) }
    }

    /// Opens the lists, on the one asked for.
    func showKept(_ list: KeptList) {
        keptList = list
        tabsSheetShown = false
        keptShown = true
    }

    // MARK: Plumbing

    private func show(_ notice: KeepNotice) {
        keepNotice = notice
        // VoiceOver is told once, in the person's language: the line is also on screen, but nothing moves focus to it.
        AccessibilityNotification.Announcement(String(localized: notice.message)).post()
    }

    private func keepChange(_ edit: (inout BrowserState) -> Void) {
        var next = state
        edit(&next)
        state = next
        scheduleSave()
    }
}

/// Which of the two lists the sheet shows.
enum KeptList: Hashable { case bookmarks, readLater }
