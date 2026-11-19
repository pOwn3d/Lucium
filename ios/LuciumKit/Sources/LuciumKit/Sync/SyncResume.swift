import Foundation

/// « Reprendre un onglet du Mac » (docs/synchronisation.md §10.4): what the Mac announced at the last session, turned into rows the phone can show and
/// into the space a tap opens the page in. Pure logic: nothing here reads or writes the state, and the list itself lives in memory only.
public enum SyncResume {
    /// What the screen says, in the order the reasons are tested.
    public enum Availability: Equatable, Sendable {
        /// No Mac is paired, or the synchronisation is off.
        case notPaired
        /// "Open tabs" is not ticked on this phone: the sentence says where to tick it.
        case disabledHere
        /// Ticked here, but no session has gone through since (or the list was forgotten: the app was locked): it comes with the next session.
        case waiting
        /// Ticked here, a session went through and the Mac sent nothing: it has not ticked "Open tabs" on its side.
        case disabledOnMac
        /// A list came, with nothing in it that a phone can open.
        case empty
        case list
    }

    /// One line of the list.
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let url: String
        /// The title the Mac announced, or the host when it had none.
        public let title: String
        public let host: String
        /// The space the Mac had the tab in (an identifier of the Mac: the phone has the same one when the spaces are synchronised).
        public let spaceId: String
        public let lastActiveAt: Int

        public init(id: String, url: String, title: String, host: String, spaceId: String, lastActiveAt: Int) {
            self.id = id; self.url = url; self.title = title; self.host = host; self.spaceId = spaceId; self.lastActiveAt = lastActiveAt
        }
    }

    /// The rows of a list: web pages only (`http` and `https`, checked again here whatever the receiver kept), most recently read first, one per address and
    /// per identifier, and no more than the protocol allows. A page that has no host is not a page a person could be sent to.
    public static func rows(from tabs: [SyncOpenTab]) -> [Row] {
        var seen = Set<String>()
        var named = Set<String>()
        var rows: [Row] = []
        for tab in tabs.sorted(by: { ($0.lastActiveAt, $1.id) > ($1.lastActiveAt, $0.id) }) {
            // One line per address and per identifier: a list never holds two lines of one name (the screen names a line by it).
            guard isWebAddress(tab.url), !seen.contains(tab.url), !named.contains(tab.id) else { continue }
            let host = AddressResolver.host(of: tab.url)
            guard !host.isEmpty else { continue }
            seen.insert(tab.url)
            named.insert(tab.id)
            let title = tab.title.trimmingCharacters(in: .whitespacesAndNewlines)
            rows.append(Row(id: tab.id, url: tab.url, title: title.isEmpty ? host : title, host: host, spaceId: tab.spaceId, lastActiveAt: tab.lastActiveAt))
            if rows.count == SyncLimits.maxOpenTabs { break }
        }
        return rows
    }

    /// `http` and `https` with an authority, and nothing a script, a local file or a data address could be (the check of §10.4, made on the way out too).
    public static func isWebAddress(_ address: String) -> Bool {
        guard address.utf8.count <= SyncLimits.maxOpenTabURLBytes, let components = URLComponents(string: address),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return false }
        return true
    }

    /// Why the screen shows what it shows. `announcedAt` is nil until a list came; `listAnnounced` is whether the last session carried one at all (a Mac that
    /// did not tick the category sends none, which is not the same as sending an empty one).
    public static func availability(paired: Bool, categoryOnHere: Bool, announcedAt: Int?, listAnnounced: Bool, rowCount: Int, sessionHappened: Bool) -> Availability {
        if !paired { return .notPaired }
        if !categoryOnHere { return .disabledHere }
        if announcedAt == nil {
            return sessionHappened && !listAnnounced ? .disabledOnMac : .waiting
        }
        return rowCount == 0 ? .empty : .list
    }

    /// The space a tapped row opens in: the one the Mac had it in when this phone has it and it is not locked, else the space on screen when that one is
    /// not locked, else nowhere (a locked phone opens nothing). `spaceIds` are the spaces of the phone.
    public static func targetSpace(of row: Row, spaceIds: Set<String>, activeSpaceId: String, isLocked: (String) -> Bool) -> String? {
        if spaceIds.contains(row.spaceId), !isLocked(row.spaceId) { return row.spaceId }
        return isLocked(activeSpaceId) ? nil : activeSpaceId
    }

    /// How old a list is, in the unit the sentence says; the screen turns it into words in the language of the interface.
    public enum Age: Equatable, Sendable {
        case justNow
        case minutes(Int)
        case hours(Int)
        case days(Int)
    }

    /// `at` and `now` are in milliseconds. A clock that went back reads as "just now", never a negative time.
    public static func age(at: Int, now: Int) -> Age {
        let seconds = max(0, (now - at) / 1000)
        if seconds < 60 { return .justNow }
        if seconds < 3600 { return .minutes(seconds / 60) }
        if seconds < 86_400 { return .hours(seconds / 3600) }
        return .days(seconds / 86_400)
    }

    /// The rows a word typed in the command bar keeps: the title or the address matches, best match first, the order of the list for equal scores.
    public static func matching(_ rows: [Row], query: String, limit: Int? = nil) -> [Row] {
        let needle = Match.foldedQuery(query)
        let kept: [Row]
        if needle.isEmpty {
            kept = rows
        } else {
            let scored = rows.enumerated().compactMap { index, row -> (Int, Int, Row)? in
                let score = max(Match.scoreFolded(Match.fold(row.title), needle), Match.scoreFolded(Match.fold(row.host), needle))
                return score > 0 ? (score, index, row) : nil
            }
            // Best score first; equal scores keep the order of the list (the index breaks the tie).
            kept = scored.sorted { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1 < $1.1 }.map(\.2)
        }
        if let limit { return Array(kept.prefix(limit)) }
        return kept
    }
}
