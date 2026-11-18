import Foundation
import Testing
@testable import LuciumKit

/// The bounds that count values and not bytes (docs/synchronisation.md §7.5): 150 000 values in a frame, 2 000 000 in a connection, as the Mac reads them.
@Suite("Synchronisation: the values of a message")
struct SyncValueBoundTests {
    /// A frame that holds `empties` empty lists: the object, `v`, `t`, `n`, the list `x`, then the lists.
    private func frame(empties: Int) -> Data {
        Data(("{\"v\":1,\"t\":\"bye\",\"n\":1,\"x\":[" + Array(repeating: "[]", count: empties).joined(separator: ",") + "]}").utf8)
    }

    @Test func aFrameThatHoldsMoreThanTheBoundIsTooLargeWhateverItsSizeInBytesAndOneAtTheBoundIsRead() {
        let bound = SyncLimits.maxFrameValues
        #expect(bound == 150_000 && SyncLimits.maxSessionValues == 2_000_000)
        guard case .success(let envelope) = SyncMessageCodec.decode(frame(empties: bound - 5)) else { Issue.record("a frame at the bound was refused"); return }
        #expect(envelope.message == .bye)
        guard case .failure(let failure) = SyncMessageCodec.decode(frame(empties: bound - 4)) else { Issue.record("a frame over the bound was read"); return }
        #expect(failure.code == .tooLarge)
    }

    @Test func eachValueCountsOnceAndTheKeysOfAnObjectDoNot() {
        #expect(SyncMessageCodec.valueCount(.object(["v": .number(1), "t": .string("bye"), "n": .number(1)]), stopAbove: 100) == 4)
        #expect(SyncMessageCodec.valueCount(.array([.null, .bool(true), .array([]), .object([:])]), stopAbove: 100) == 5)
        #expect(SyncMessageCodec.valueCount(.string("x"), stopAbove: 100) == 1)
        #expect(SyncMessageCodec.valueCount(.array(Array(repeating: .null, count: 1000)), stopAbove: 10) == 11, "the count stops as soon as it is over what is asked: nothing past it is looked at")
    }

    @Test func aConnectionSpendsItsValuesAndARefusalSpendsNone() {
        var left = 10
        let bye = Data(#"{"v":1,"t":"bye","n":1}"#.utf8)
        guard case .success = SyncMessageCodec.decode(bye, valuesLeft: &left) else { Issue.record("not read"); return }
        #expect(left == 6, "a bye is four values")
        guard case .success = SyncMessageCodec.decode(bye, valuesLeft: &left) else { Issue.record("not read"); return }
        #expect(left == 2)
        guard case .failure(let failure) = SyncMessageCodec.decode(bye, valuesLeft: &left) else { Issue.record("a message over what is left was read"); return }
        #expect(failure.code == .tooLarge && left == 2)
        var unlimited = Int.max
        if case .failure = SyncMessageCodec.decode(bye, valuesLeft: &unlimited) { Issue.record("the unlimited form refused a bye") }
    }

    @Test func aChannelRefusesTheMessageThatTakesItOverTheValuesOfAConnection() async throws {
        let ends = syncLoopback()
        let channel = SyncChannel(transport: ends.phone, phase: .session, log: { _ in })
        let mac = SyncFakeMac(ends.mac)
        let padding = Array(repeating: [] as [Int], count: SyncLimits.maxFrameValues - 20)
        try await mac.write("hello", ["device": ["id": "mac-1", "name": "Mac", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": [String](), "baseHash": NSNull(),
                                      "stateVersion": 1, "appVersion": "1", "now": 1])
        guard case .hello = try await channel.receive(timeout: .seconds(2)) else { Issue.record("no hello"); return }
        // Warnings are allowed at any time; each carries a field the reader ignores and counts.
        var read = 0
        var failure: SyncFailure?
        for _ in 0..<20 {
            try await mac.write("error", ["code": "clock-skew", "fatal": false, "pad": padding])
            do {
                _ = try await channel.receive(timeout: .seconds(2))
                read += 1
            } catch let caught as SyncFailure {
                failure = caught
                break
            }
        }
        #expect(failure?.code == .tooLarge, "a connection holds two million values at most")
        #expect(read >= 12 && read <= 14, "about fourteen frames of a hundred and fifty thousand values")
    }
}
