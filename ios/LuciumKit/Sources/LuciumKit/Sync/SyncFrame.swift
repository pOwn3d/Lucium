import Foundation

/// The bounds of the exchange (docs/synchronisation.md §7.5), as numbers. The vectors of `sync-message-vectors.json` (`limits`) hold the same ones.
public enum SyncLimits {
    public static let maxFrameBytes = 1_048_576
    public static let maxSnapshotBytes = 33_554_432
    public static let maxEntities = 100_000
    /// The most tombstones a side sends or takes in a snapshot, the newest (docs/synchronisation.md §11.5, review n° 14): the merge keeps those of both sides, so two sides at the
    /// bound of a snapshot would make a base nobody can read.
    public static let maxTombstonesPerSnapshot = 50_000
    public static let maxEntitiesPerPart = 500
    public static let maxParts = 4096
    public static let maxJSONDepth = 32
    /// How many values (every object, list, text, number, boolean and null) one frame and one whole connection may hold: the bounds in bytes do not bound the work
    /// (a frame of `[[],[],…]` holds a third of a million values to the mebibyte). The Mac applies the same figures (`MAX_FRAME_VALUES`, `MAX_SESSION_VALUES`).
    public static let maxFrameValues = 150_000
    public static let maxSessionValues = 2_000_000
    public static let maxStringBytes = 65_536
    public static let maxDeviceNameCharacters = 80
    public static let maxDeviceIdCharacters = 64
    public static let maxCategories = 8
    public static let maxHosts = 4
    public static let handshakeTimeout: Duration = .seconds(10)
    public static let idleTimeout: Duration = .seconds(60)
    public static let sessionMaximum: Duration = .seconds(600)
    /// How long the phone waits for the person to answer on the Mac (§4.1, step 7: 60 seconds, no answer is a refusal), plus a margin for the network.
    public static let pairingConfirmationWait: Duration = .seconds(75)
    public static let candidateTimeout: Duration = .seconds(3)
    public static let minimumAutomaticInterval: Duration = .seconds(15)
    public static let clockSkewWarningMilliseconds = 300_000
}

/// One message on the wire: four bytes of length (unsigned, big-endian), then that many bytes of JSON (§7.1).
public enum SyncFrame {
    /// The frame of a message. A content of no byte or of more than a frame cannot be written.
    public static func encode(_ content: Data) throws -> Data {
        guard !content.isEmpty else { throw SyncFailure(.badFrame, "an empty message") }
        guard content.count <= SyncLimits.maxFrameBytes else { throw SyncFailure(.tooLarge, "a message of \(content.count) bytes") }
        var frame = Data(capacity: 4 + content.count)
        let length = UInt32(content.count)
        frame.append(contentsOf: [UInt8(length >> 24), UInt8((length >> 16) & 0xff), UInt8((length >> 8) & 0xff), UInt8(length & 0xff)])
        frame.append(content)
        return frame
    }

    /// Whether a length announced in a header is one a frame may have. A length that is not is refused from the four bytes alone: the content that
    /// follows is never read, never waited for and never kept.
    public static func check(announced length: UInt32) -> SyncFailure? {
        if length == 0 { return SyncFailure(.badFrame, "a frame of length 0") }
        if length > UInt32(SyncLimits.maxFrameBytes) { return SyncFailure(.tooLarge, "a frame announced at \(length) bytes") }
        return nil
    }
}

/// Cuts a stream of bytes into frames. What comes from the network is put in with `append`, and `next()` gives a whole frame's content when there is one.
/// It throws the moment a header announces a length the rules refuse, before one byte of the content is waited for.
public struct SyncFrameDecoder: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func append(_ bytes: Data) { buffer.append(bytes) }

    /// What is held and not yet a frame: a connection that has sent more than a frame and a header without a frame in it is closed by the caller.
    public var pending: Int { buffer.count }

    public mutating func next() throws -> Data? {
        guard buffer.count >= 4 else { return nil }
        let base = buffer.startIndex
        let length = (UInt32(buffer[base]) << 24) | (UInt32(buffer[base + 1]) << 16) | (UInt32(buffer[base + 2]) << 8) | UInt32(buffer[base + 3])
        if let failure = SyncFrame.check(announced: length) { throw failure }
        let total = 4 + Int(length)
        guard buffer.count >= total else { return nil }
        let content = Data(buffer[(base + 4)..<(base + total)])
        buffer = Data(buffer[(base + total)...])
        return content
    }
}
