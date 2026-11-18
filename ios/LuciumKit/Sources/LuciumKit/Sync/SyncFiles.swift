import Foundation

/// How the small files of the synchronisation (the marks, the base of each Mac, the journal of the conflicts) are read and written. Same rules as the other files of
/// the application (`StateFile`, `SyncOriginFile`): a file is hostile until read (a regular file, bounded), and a write goes to a temporary file, reaches the disk,
/// then replaces the file by a rename, with the rights of its owner only: a crash leaves the old file or the new one, never half of one.
enum SyncFiles {
    struct NotARegularFile: Error, Equatable { let name: String }
    struct TooLarge: Error, Equatable { let name: String; let bytes: Int; let limit: Int }

    static func readBounded(_ url: URL, maxBytes: Int) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else { throw NotARegularFile(name: url.lastPathComponent) }
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        guard size <= maxBytes else { throw TooLarge(name: url.lastPathComponent, bytes: size, limit: maxBytes) }
        return try Data(contentsOf: url)
    }

    static func writeAtomically(_ data: Data, to url: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = URL(fileURLWithPath: url.path + ".tmp")
        guard manager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: temporary.path])
        }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            defer { try? handle.close() }
            try handle.write(contentsOf: data)
            try handle.synchronize()
            if manager.fileExists(atPath: url.path) {
                _ = try manager.replaceItemAt(url, withItemAt: temporary)
            } else {
                try manager.moveItem(at: temporary, to: url)
            }
        } catch {
            if manager.fileExists(atPath: temporary.path) {
                do { try manager.removeItem(at: temporary) } catch { print("[sync] cannot remove \(temporary.path) after a failed write: \(error)") }
            }
            throw error
        }
    }
}
