import CryptoKit
import Foundation

/// What a sleeping tab keeps besides its line in the state: the picture of its page and the state of its web view (the history and the scroll
/// position, as `WKWebView.interactionState` gives them). Both are the iPhone's own: the Mac's state file does not know them, so they live in a
/// folder next to it, one file per tab and per sort.
///
/// File names are a digest of the tab's id, never the id itself: a state that came from another device names tabs as it likes, and a name
/// with `/` or `..` must not leave the folder.
public struct TabSideStore: Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case interaction = "state"
        case thumbnail = "jpg"
    }

    /// A page's state or picture beyond this is not kept (a runaway page must not fill the phone).
    public static let maxBytes = 16 * 1024 * 1024
    /// The folder's name next to the state file.
    public static let directoryName = "tabs"

    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    public enum StoreError: Error, Equatable, Sendable {
        case tooLarge(bytes: Int, limit: Int)
    }

    public func url(of kind: Kind, for tabId: String) -> URL {
        directory.appending(path: Self.stem(of: tabId) + "." + kind.rawValue)
    }

    public func write(_ data: Data, kind: Kind, for tabId: String) throws {
        guard data.count <= Self.maxBytes else { throw StoreError.tooLarge(bytes: data.count, limit: Self.maxBytes) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url(of: kind, for: tabId), options: .atomic)
    }

    /// What was kept, or `nil` when nothing was (a tab that never slept, or one whose file was removed).
    public func read(_ kind: Kind, for tabId: String) -> Data? {
        let file = url(of: kind, for: tabId)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        do {
            return try Data(contentsOf: file)
        } catch {
            print("[tabs] cannot read \(file.lastPathComponent): \(error)")
            return nil
        }
    }

    /// Removes what a tab kept, of every sort.
    public func remove(for tabId: String) {
        for kind in Kind.allCases { remove(kind, for: tabId) }
    }

    /// Removes one sort. Nothing to remove is not an error; a file that cannot be removed is logged with its name.
    public func remove(_ kind: Kind, for tabId: String) {
        let file = url(of: kind, for: tabId)
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        do { try FileManager.default.removeItem(at: file) } catch { print("[tabs] cannot remove \(file.lastPathComponent): \(error)") }
    }

    /// Deletes what belongs to tabs that are no longer in the state (a tab closed on the Mac). Answers how many files went.
    @discardableResult
    public func prune(keeping tabIds: some Sequence<String>) -> Int {
        let kept = Set(tabIds.map(Self.stem(of:)))
        guard FileManager.default.fileExists(atPath: directory.path) else { return 0 }
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        } catch {
            print("[tabs] cannot list \(directory.path): \(error)")
            return 0
        }
        var removed = 0
        for name in names {
            let url = URL(fileURLWithPath: name)
            guard Kind.allCases.contains(where: { $0.rawValue == url.pathExtension }), !kept.contains(url.deletingPathExtension().lastPathComponent) else { continue }
            do {
                try FileManager.default.removeItem(at: directory.appending(path: name))
                removed += 1
            } catch {
                print("[tabs] cannot remove \(name): \(error)")
            }
        }
        return removed
    }

    private static func stem(of tabId: String) -> String {
        SHA256.hash(data: Data(tabId.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
