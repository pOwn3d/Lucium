import Foundation

/// Reads the shared vectors of the synchronisation (`ios/Contracts/sync-*.json`) for the tests that play them against the real code. The Mac's TypeScript
/// plays the same files in `src/shared/ios-sync-contract.test.ts`.
enum SyncContract {
    enum Failure: Error { case notAnObject(String), missing(String) }

    static func load(_ name: String) throws -> [String: Any] {
        // …/ios/LuciumKit/Tests/LuciumKitTests/<this file> → …/ios/Contracts/<name>
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Contracts/\(name)")
        guard let dictionary = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw Failure.notAnObject(name) }
        return dictionary
    }

    static func array(_ root: [String: Any], _ key: String) throws -> [[String: Any]] {
        guard let items = root[key] as? [[String: Any]] else { throw Failure.missing(key) }
        return items
    }

    static func hex(_ text: String) -> Data { SyncTestHex.data(text) }
}

enum SyncTestHex {
    static func data(_ text: String) -> Data {
        var bytes = Data()
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            bytes.append(UInt8(text[index..<next], radix: 16) ?? 0)
            index = next
        }
        return bytes
    }
}
