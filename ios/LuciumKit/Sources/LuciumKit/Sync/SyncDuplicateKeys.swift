import Foundation

/// Whether an object of a JSON text names a key twice, however each is written (`"n"` and `"n"` are one key; docs/synchronisation.md §7.1, review n° 20 of the
/// synchronisation). The first wins in a Swift reader and the last in JavaScript's `JSON.parse`: one message would be two, and the digests that say whether the two
/// devices agree would not catch it, because each hashes what it read. The Mac refuses such a text (`hasDuplicateKey` of `messages.ts`); the phone must too, before it
/// reads a message (`SyncMessageCodec.decode`: card 452, which owns that file). `duplicateKeys` of `sync-message-vectors.json` is played against both.
///
/// A scan of the bytes that tracks strings and brackets, with one set of keys for each object that is open and no recursion (a frame of a million brackets must not
/// exhaust the stack). The text is read as JSON that has already parsed; a key that cannot be decoded is taken for a duplicate, which refuses it.
public enum SyncDuplicateKeys {
    private final class Keys { var seen = Set<String>() }
    private enum Frame { case object(Keys), array }

    public static func has(in content: Data) -> Bool {
        let bytes = [UInt8](content)
        var open: [Frame] = []
        var expectKey = false
        var at = 0
        while at < bytes.count {
            switch bytes[at] {
            case 0x22:
                var end = at + 1
                var escaped = false
                while end < bytes.count {
                    if bytes[end] == 0x5c {
                        escaped = true
                        end += 2
                        continue
                    }
                    if bytes[end] == 0x22 { break }
                    end += 1
                }
                guard end < bytes.count else { return true }
                if case .object(let keys)? = open.last, expectKey {
                    guard let key = decode(Array(bytes[at...end]), escaped: escaped), keys.seen.insert(key).inserted else { return true }
                    expectKey = false
                }
                at = end
            case 0x7b:
                open.append(.object(Keys()))
                expectKey = true
            case 0x5b:
                open.append(.array)
                expectKey = false
            case 0x7d, 0x5d:
                _ = open.popLast()
                expectKey = false
            case 0x2c:
                if case .object? = open.last { expectKey = true } else { expectKey = false }
            default:
                break
            }
            at += 1
        }
        return false
    }

    /// The key a quoted piece of JSON names: its bytes as they are, or the text the escapes make.
    private static func decode(_ quoted: [UInt8], escaped: Bool) -> String? {
        if !escaped { return String(bytes: quoted.dropFirst().dropLast(), encoding: .utf8) }
        guard let value = try? JSONSerialization.jsonObject(with: Data([0x5b] + quoted + [0x5d])) as? [String], value.count == 1 else { return nil }
        return value[0]
    }
}
