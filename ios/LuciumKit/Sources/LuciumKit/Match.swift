import Foundation

/// The Swift twin of the Mac's way of comparing what is typed with a name (`src/shared/fold.ts`, `command-bar-match.ts`): the text folded (accents
/// taken off, typographic apostrophes made straight, lower case) and the score of a match. Checked by the same vectors as the Mac
/// (`ios/Contracts/match-vectors.json`): change one side and the other fails.
public enum Match {
    /// "L’Été" becomes "l'ete": decomposed, the combining marks U+0300–U+036F taken off, the apostrophes ’ ‘ made straight, the non-breaking
    /// spaces made ordinary, lower case (`foldAccentsAndQuotes`).
    public static func fold(_ text: String) -> String {
        var folded = String.UnicodeScalarView()
        for scalar in text.decomposedStringWithCanonicalMapping.unicodeScalars {
            switch scalar.value {
            case 0x0300...0x036F: continue
            case 0x2019, 0x2018: folded.append("'")
            case 0x00A0, 0x202F: folded.append(" ")
            default: folded.append(scalar)
            }
        }
        return String(folded).lowercased()
    }

    /// The query as `score` compares it: folded and trimmed. Empty when it holds nothing to look for.
    public static func foldedQuery(_ query: String) -> String {
        fold(query).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 100 prefix match, 70 word start, 50 substring, 20 letters in order, 0 no match. Case and accents are ignored. An empty query matches nothing.
    public static func score(_ text: String, query: String) -> Int {
        let needle = foldedQuery(query)
        return needle.isEmpty ? 0 : scoreFolded(fold(text), needle)
    }

    /// `score` for a text and a query that are already folded (the query not empty): a list searched at every keystroke folds its texts once.
    public static func scoreFolded(_ haystack: String, _ needle: String) -> Int {
        if haystack.hasPrefix(needle) { return 100 }
        if let found = haystack.range(of: needle, options: .literal) {
            if found.lowerBound > haystack.startIndex {
                let before = haystack[haystack.index(before: found.lowerBound)]
                if before.isWhitespace || "/._'-".contains(before) { return 70 }
            }
            return 50
        }
        var from = haystack.startIndex
        for character in needle {
            guard let at = haystack[from...].firstIndex(of: character) else { return 0 }
            from = haystack.index(after: at)
        }
        return 20
    }
}

/// What the command bar offers for what is typed: the tabs that answer, the favourites that answer (`command-bar.ts`, kept to what the iPhone has).
public enum CommandSearch {
    /// The tabs listed at most (`MAX_TABS`).
    public static let maxTabs = 6

    /// The open tabs that answer `query`, best first (the name, the title or the address, whichever scores most), the most recently used first
    /// among equals. Every space is searched unless `space` names one. With nothing typed: the most recently used. The page of a favourite and a
    /// blank tab are not offered: the tile of the first stands for it, the second has nothing to find. `limit` nil lists every answer.
    public static func tabs(in state: BrowserState, matching query: String, space: String? = nil, limit: Int? = maxTabs) -> [TabItem] {
        let candidates = state.tabs.filter { $0.isListed && !$0.isBlank && (space == nil || $0.spaceId == space) }
        let recency: (TabItem, TabItem) -> Bool = { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
        let needle = Match.foldedQuery(query)
        let ranked: [TabItem]
        if needle.isEmpty {
            ranked = candidates.sorted(by: recency)
        } else {
            let scored = candidates.compactMap { tab -> (tab: TabItem, score: Int)? in
                let best = max(Match.scoreFolded(Match.fold(tab.title), needle), Match.scoreFolded(Match.fold(tab.url), needle))
                return best > 0 ? (tab, best) : nil
            }
            ranked = scored.sorted { $0.score != $1.score ? $0.score > $1.score : recency($0.tab, $1.tab) }.map(\.tab)
        }
        return limit.map { Array(ranked.prefix($0)) } ?? ranked
    }

    /// The favourites of a space's profile that answer `query` (title or address), best first; all of them, in their order, with nothing typed.
    public static func favorites(in state: BrowserState, space spaceId: String, matching query: String, limit: Int = 8) -> [Favorite] {
        let mine = state.favorites(inSpace: spaceId)
        let needle = Match.foldedQuery(query)
        guard !needle.isEmpty else { return Array(mine.prefix(limit)) }
        let scored = mine.compactMap { favorite -> (favorite: Favorite, score: Int)? in
            let best = max(Match.scoreFolded(Match.fold(favorite.title), needle), Match.scoreFolded(Match.fold(favorite.url), needle))
            return best > 0 ? (favorite, best) : nil
        }
        return Array(scored.sorted { $0.score > $1.score }.prefix(limit).map(\.favorite))
    }
}

/// How long ago archived tabs were archived (`archiveBuckets` of the Mac): the archive screen groups its rows by these.
public enum ArchiveBucket: String, CaseIterable, Sendable {
    case today, yesterday, week, month, older
}

public struct ArchiveGroup: Equatable, Identifiable, Sendable {
    public var bucket: ArchiveBucket
    public var entries: [ArchivedTab]
    public var id: String { bucket.rawValue }
}

extension Library {
    private static let dayMilliseconds = 86_400_000.0

    /// The archive grouped by age, newest first, empty groups dropped. `startOfToday` is midnight of the day `now` is in, in milliseconds (the
    /// caller knows the calendar and the time zone); the limits are whole days of 24 hours back from it, as on the Mac.
    public static func archiveGroups(_ entries: [ArchivedTab], startOfToday: Double) -> [ArchiveGroup] {
        func bucket(_ at: Double) -> ArchiveBucket {
            if at >= startOfToday { return .today }
            if at >= startOfToday - dayMilliseconds { return .yesterday }
            if at >= startOfToday - 7 * dayMilliseconds { return .week }
            if at >= startOfToday - 30 * dayMilliseconds { return .month }
            return .older
        }
        var grouped: [ArchiveBucket: [ArchivedTab]] = [:]
        for entry in entries.sorted(by: { $0.archivedAt > $1.archivedAt }) { grouped[bucket(entry.archivedAt), default: []].append(entry) }
        return ArchiveBucket.allCases.compactMap { bucket in grouped[bucket].map { ArchiveGroup(bucket: bucket, entries: $0) } }
    }

    /// Midnight of the day of `now` (milliseconds), in a calendar.
    public static func startOfDay(_ now: Double, calendar: Calendar = .current) -> Double {
        (calendar.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000).rounded()
    }
}

/// The colour and the letter of the tile of a site that has no picture: one of a few, always the same for the same host (`String.hashValue` changes at every
/// launch, so the host is hashed here).
public enum TileStyle {
    public static let colorCount = 8

    public static func colorIndex(forHost host: String) -> Int {
        var hash: UInt32 = 5381
        for scalar in host.lowercased().unicodeScalars { hash = hash &* 33 &+ scalar.value }
        return Int(hash % UInt32(colorCount))
    }

    /// The letter on the tile: the first letter or digit of the host, upper case; nil for an address that has no host (the start page).
    public static func letter(forHost host: String) -> String? {
        host.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() }
    }
}
