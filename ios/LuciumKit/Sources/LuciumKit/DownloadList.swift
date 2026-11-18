import Foundation

/// One line of the list of downloads.
public struct DownloadItem: Equatable, Identifiable, Sendable {
    public enum Phase: Equatable, Sendable { case running, finished, failed, cancelled }

    public let id: String
    /// The name of the file in the downloads folder; empty until the destination is chosen.
    public var fileName: String
    /// The host the file comes from (never the whole address: it may carry a token), or "" for a page saved as PDF.
    public var source: String
    /// The space whose page asked for the file: a space the lock covers shows none of its lines (what a file is called and where it comes from tells what
    /// was being read). "" when no space is known.
    public var spaceId: String
    public var phase: Phase
    public var receivedBytes: Int64
    /// The size announced by the server, or 0 when it did not say.
    public var totalBytes: Int64
    /// What went wrong, when `phase` is `.failed` (the system's own words: data, not a text of the interface).
    public var failure: String?
    /// Whether WebKit gave back what a resumption needs.
    public var canResume: Bool

    /// How far the download is, from 0 to 1; `nil` while the size is unknown.
    public var fraction: Double? {
        switch phase {
        case .finished: 1
        case .running, .failed, .cancelled: totalBytes > 0 ? min(1, max(0, Double(receivedBytes) / Double(totalBytes))) : nil
        }
    }
}

/// The downloads of this session, newest first. The Mac keeps the same list for the session only (the files stay on the disk).
///
/// A download that ended is final: WebKit may still report a failure after a cancellation, or a last progress after the end, and that must not
/// turn a finished line into a running one or a cancelled one into a failed one.
public struct DownloadList: Equatable, Sendable {
    public private(set) var items: [DownloadItem] = []

    public init() {}

    public func item(_ id: String) -> DownloadItem? { items.first { $0.id == id } }
    public var runningCount: Int { items.filter { $0.phase == .running }.count }
    public var runningItems: [DownloadItem] { items.filter { $0.phase == .running } }
    /// Whether the list holds a line that is not running (what "Clear" removes).
    public var hasEnded: Bool { items.contains { $0.phase != .running } }

    /// A download starts: it goes to the top.
    public mutating func begin(id: String, source: String, spaceId: String = "") {
        guard item(id) == nil else { return }
        items.insert(DownloadItem(id: id, fileName: "", source: source, spaceId: spaceId, phase: .running, receivedBytes: 0, totalBytes: 0, failure: nil,
                                  canResume: false), at: 0)
    }

    /// The lines the person may see: those of the spaces `isCovered` does not name. Everything that shows downloads reads this, never `items`.
    public func visible(hiding isCovered: (String) -> Bool) -> [DownloadItem] {
        items.filter { !isCovered($0.spaceId) }
    }

    /// The destination is chosen. Also used when a download is resumed under the same line.
    public mutating func named(id: String, fileName: String) { change(id) { $0.fileName = fileName } }

    public mutating func progress(id: String, received: Int64, total: Int64) {
        change(id, onlyWhileRunning: true) {
            $0.receivedBytes = max(0, received)
            $0.totalBytes = max(0, total)
        }
    }

    /// The download is done. `size` is the size of the file that was written, when it could be read: it is the truth, and it is the only size a small
    /// file has, WebKit publishing no progress at all for a download that ends at once.
    public mutating func finish(id: String, size: Int64? = nil) {
        change(id, onlyWhileRunning: true) {
            $0.phase = .finished
            $0.failure = nil
            if let size, size >= 0 {
                $0.receivedBytes = size
                $0.totalBytes = size
            } else if $0.totalBytes > 0 {
                $0.receivedBytes = $0.totalBytes
            }
        }
    }

    public mutating func fail(id: String, message: String, canResume: Bool) {
        change(id, onlyWhileRunning: true) {
            $0.phase = .failed
            $0.failure = message
            $0.canResume = canResume
        }
    }

    public mutating func cancel(id: String) {
        change(id, onlyWhileRunning: true) {
            $0.phase = .cancelled
            $0.canResume = false
        }
    }

    /// A failed line starts again (a resumption): it is running, with what it had received.
    public mutating func resumed(id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].phase == .failed else { return }
        items[index].phase = .running
        items[index].failure = nil
        items[index].canResume = false
    }

    public mutating func remove(id: String) { items.removeAll { $0.id == id } }

    /// Removes the lines that are not running. The files stay where they are.
    public mutating func clearEnded() { items.removeAll { $0.phase != .running } }

    private mutating func change(_ id: String, onlyWhileRunning: Bool = false, _ edit: (inout DownloadItem) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        if onlyWhileRunning, items[index].phase != .running { return }
        edit(&items[index])
    }
}
