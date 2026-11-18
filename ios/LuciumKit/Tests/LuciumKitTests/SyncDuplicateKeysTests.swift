import Foundation
import Testing
@testable import LuciumKit

/// A key written twice in one object (docs/synchronisation.md §7.1, review n° 20): the first wins in a Swift reader and the last in JavaScript, so the two devices
/// would read two messages. The vectors are the Mac's too (`hasDuplicateKey`).
@Suite("Sync: a key written twice")
struct SyncDuplicateKeysTests {
    private func has(_ text: String) -> Bool { SyncDuplicateKeys.has(in: Data(text.utf8)) }

    @Test func theVectorsAreRead() throws {
        let vectors = try SyncContract.array(try SyncContract.load("sync-message-vectors.json"), "duplicateKeys")
        #expect(vectors.count >= 3)
        for vector in vectors {
            #expect(has(vector["raw"] as? String ?? "") == (vector["duplicate"] as? Bool), "\(vector["name"] ?? "?")")
        }
    }

    @Test func aKeyWrittenTwiceIsFoundAtAnyDepthAndHoweverItIsWritten() {
        #expect(has(#"{"a":1,"a":2}"#))
        #expect(has(#"{"x":{"a":1,"b":{"c":1,"c":2}}}"#))
        #expect(has(#"{"x":[{"k":1,"k":1}]}"#))
        #expect(has(#"{"n":1,"n":2}"#), "an escape is the same key")
        #expect(has(#"{"é":1,"é":2}"#))
    }

    @Test func theSameKeyInTwoObjectsOrADifferentOneIsNotADuplicate() {
        #expect(!has(#"{"a":1,"A":2}"#))
        #expect(!has(#"{"x":{"a":1},"y":{"a":2}}"#))
        #expect(!has(#"[{"a":1},{"a":2}]"#))
        // A text that looks like a key is not one.
        #expect(!has(#"{"a":"\"a\":1,\"a\":2"}"#))
        #expect(!has(#"{"a":["a","a"],"b":"a"}"#))
        #expect(!has("{}"))
        #expect(!has("[]"))
    }

    @Test func aMillionBracketsDoNotExhaustTheStack() {
        let deep = String(repeating: "[", count: 1_000_000) + String(repeating: "]", count: 1_000_000)
        #expect(!has(deep))
    }
}
