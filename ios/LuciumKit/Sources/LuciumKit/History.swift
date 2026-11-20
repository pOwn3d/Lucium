import Foundation

/// A page the person visited, in the shape of the Mac's `HistoryEntry` (`url`, `title`, `visitCount`, `lastVisitAt` in milliseconds).
public struct HistoryEntry: Codable, Equatable, Identifiable, Sendable {
    public var url: String
    public var title: String
    public var visitCount: Int
    public var lastVisitAt: Double

    public var id: String { url }

    public init(url: String, title: String, visitCount: Int, lastVisitAt: Double) {
        self.url = url; self.title = title; self.visitCount = visitCount; self.lastVisitAt = lastVisitAt
    }
}

/// The history of this iPhone (docs/ios.md, "Historique"): the pages visited, per profile, kept in a file of its own next to the state and never in
/// the state itself. The state is what the synchronisation carries (`SyncFieldClasses.neverKinds` lists "history" as a kind that never leaves a
/// device), so a page visited here is not in the file a Mac reads. Pure value, proved by `swift test`; `HistoryFile` is the part that touches the disk.
public struct HistoryBook: Codable, Equatable, Sendable {
    /// How long a page is kept, in days: the choices the settings page offers.
    public static let retentionPresets: [Int] = [1, 7, 30, 90]
    public static let defaultRetentionDays = 30
    /// A profile's list stops here: a phone must not fill with the pages of a year of browsing.
    public static let maxEntriesPerProfile = 2000
    /// The version of the file; a file of a later one is not read (it would lose what this version does not know).
    public static let currentVersion = 1

    private static let dayMilliseconds = 86_400_000.0

    public var version = HistoryBook.currentVersion
    /// The delay after which a visit is forgotten. It belongs to the device, not to the state, so clearing the history leaves it.
    public var retentionDays = HistoryBook.defaultRetentionDays
    public var profiles: [String: [HistoryEntry]] = [:]

    public init() {}

    /// Only a web page is kept: `http` or `https`, with a host. A blank page, an `about:` page, a file or a script is not a visit.
    public static func isRecordable(_ address: String) -> Bool {
        guard let components = URLComponents(string: address), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return !(components.host ?? "").isEmpty
    }

    /// The address a visit is filed under: the page without its fragment (a jump inside a page is not another page).
    static func key(of address: String) -> String {
        guard var components = URLComponents(string: address), components.fragment != nil else { return address }
        components.fragment = nil
        return components.string ?? address
    }

    // MARK: Writing

    /// Notes a visit of `profileId` at `now`. A page already in the list counts one more and comes first again. Answers whether the book changed.
    @discardableResult
    public mutating func visit(url: String, title: String, profileId: String, at now: Double) -> Bool {
        guard Self.isRecordable(url) else { return false }
        let address = Self.key(of: url)
        var list = profiles[profileId] ?? []
        if let index = list.firstIndex(where: { $0.url == address }) {
            var entry = list.remove(at: index)
            entry.visitCount += 1
            entry.lastVisitAt = now
            if !title.isEmpty { entry.title = title }
            list.insert(entry, at: 0)
        } else {
            list.insert(HistoryEntry(url: address, title: title, visitCount: 1, lastVisitAt: now), at: 0)
        }
        if list.count > Self.maxEntriesPerProfile { list.removeLast(list.count - Self.maxEntriesPerProfile) }
        profiles[profileId] = list
        return true
    }

    /// A page that names itself after it loaded: the title is updated, with no new visit. Answers whether the book changed.
    @discardableResult
    public mutating func retitle(url: String, title: String, profileId: String) -> Bool {
        let address = Self.key(of: url)
        guard !title.isEmpty, var list = profiles[profileId], let index = list.firstIndex(where: { $0.url == address }), list[index].title != title else { return false }
        list[index].title = title
        profiles[profileId] = list
        return true
    }

    /// Forgets the visits older than the delay. Answers whether anything went.
    @discardableResult
    public mutating func prune(now: Double) -> Bool {
        let oldest = now - Double(retentionDays) * Self.dayMilliseconds
        var changed = false
        for (profile, list) in profiles {
            let kept = list.filter { $0.lastVisitAt >= oldest }
            if kept.count != list.count {
                changed = true
                profiles[profile] = kept.isEmpty ? nil : kept
            }
        }
        return changed
    }

    /// Chooses how long visits are kept (one of the presets). Answers whether it changed; the visits older than the new delay go on the next `prune`.
    @discardableResult
    public mutating func chooseRetention(days: Int) -> Bool {
        guard Self.retentionPresets.contains(days), days != retentionDays else { return false }
        retentionDays = days
        return true
    }

    /// Forgets one page of a profile. Answers whether it was there.
    @discardableResult
    public mutating func forget(url: String, profileId: String) -> Bool {
        guard var list = profiles[profileId], let index = list.firstIndex(where: { $0.url == url }) else { return false }
        list.remove(at: index)
        profiles[profileId] = list.isEmpty ? nil : list
        return true
    }

    /// Forgets everything a profile visited. Answers whether there was anything. The delay is left as it is.
    @discardableResult
    public mutating func clear(profileId: String) -> Bool {
        profiles.removeValue(forKey: profileId) != nil
    }

    /// Forgets the history of every profile.
    @discardableResult
    public mutating func clearAll() -> Bool {
        let had = !profiles.isEmpty
        profiles = [:]
        return had
    }

    // MARK: Reading

    /// How many pages a profile has, among those still within the delay.
    public func count(profileId: String, now: Double) -> Int { live(profileId, now: now).count }

    /// The pages of a profile that answer `query` (title or address, the best first, the most recent first among equals); the most recent ones with
    /// nothing typed. Only visits within the delay are offered, whether or not they were pruned yet.
    public func entries(profileId: String, matching query: String, limit: Int, now: Double) -> [HistoryEntry] {
        let candidates = live(profileId, now: now)
        let needle = Match.foldedQuery(query)
        guard !needle.isEmpty else { return Array(candidates.sorted { $0.lastVisitAt > $1.lastVisitAt }.prefix(limit)) }
        let scored = candidates.compactMap { entry -> (entry: HistoryEntry, score: Int)? in
            let best = max(Match.scoreFolded(Match.fold(entry.title), needle), Match.scoreFolded(Match.fold(entry.url), needle))
            return best > 0 ? (entry, best) : nil
        }
        let ranked = scored.sorted { $0.score != $1.score ? $0.score > $1.score : $0.entry.lastVisitAt > $1.entry.lastVisitAt }
        return Array(ranked.prefix(limit).map(\.entry))
    }

    private func live(_ profileId: String, now: Double) -> [HistoryEntry] {
        let oldest = now - Double(retentionDays) * Self.dayMilliseconds
        return (profiles[profileId] ?? []).filter { $0.lastVisitAt >= oldest }
    }
}

/// The file of the history: `history.json` next to the state. It is excluded from the device's backups, so that the history stays on this phone.
public struct HistoryFile: Sendable {
    public static let fileName = "history.json"

    public let url: URL

    public init(url: URL) { self.url = url }

    public enum Loaded: Equatable, Sendable {
        /// No file yet: nothing was ever kept.
        case fresh
        case loaded(HistoryBook)
        /// The file could not be read; it was put aside under this name (never deleted) and the history starts empty.
        case setAside(URL)
    }

    /// Reads the file. One that does not read, or that a later version wrote, is renamed `history.json.unreadable-<ms>` and reported, not overwritten.
    public func load(now: Double) -> Loaded {
        guard FileManager.default.fileExists(atPath: url.path) else { return .fresh }
        do {
            let book = try JSONDecoder().decode(HistoryBook.self, from: Data(contentsOf: url))
            guard book.version <= HistoryBook.currentVersion else { throw CocoaError(.fileReadCorruptFile) }
            return .loaded(book)
        } catch {
            let aside = url.deletingLastPathComponent().appending(path: "\(Self.fileName).unreadable-\(Int(now))")
            do {
                try FileManager.default.moveItem(at: url, to: aside)
                print("[history] the file cannot be read (\(error)), put aside as \(aside.lastPathComponent)")
                return .setAside(aside)
            } catch {
                print("[history] the file cannot be read and cannot be put aside: \(error)")
                return .fresh
            }
        }
    }

    /// Writes the book atomically and keeps the file out of the backups.
    public func save(_ book: HistoryBook) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(book)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try target.setResourceValues(values)
    }
}
