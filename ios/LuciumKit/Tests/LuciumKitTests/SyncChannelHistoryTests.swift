import Foundation
import Testing
@testable import LuciumKit

/// The channel remembers which kinds of message came, not each message (second pass of the security review of the synchronisation): a Mac that sends lists of open tabs by the hundred
/// thousand, each a small frame, made every one of them search the whole list of the ones before it, which kept the phone busy until the session was cut at ten minutes.
@Suite("Synchronisation: the channel and what it remembers of a session")
struct SyncChannelHistoryTests {
    @Test func thirtyThousandSmallMessagesAreReadInSeconds() async throws {
        let ends = syncLoopback()
        let channel = SyncChannel(transport: ends.phone, phase: .session, log: { _ in })
        let mac = SyncFakeMac(ends.mac)
        try await mac.write("hello", ["device": ["id": "mac-1", "name": "Mac", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": [String](), "baseHash": NSNull(),
                                      "stateVersion": 1, "appVersion": "1", "now": 1])
        guard case .hello = try await channel.receive(timeout: .seconds(2)) else { Issue.record("no hello"); return }
        let count = 30_000
        for _ in 0..<count { try await mac.write("open-tabs", ["items": [Any]()]) }
        let clock = ContinuousClock()
        var read = 0
        let took = try await clock.measure {
            for _ in 0..<count {
                _ = try await channel.receive(timeout: .seconds(2))
                read += 1
            }
        }
        #expect(read == count)
        #expect(took < .seconds(10), "took \(took)")
    }

    @Test func theRulesOfOrderStillHoldWhenAKindCameManyTimes() async throws {
        #expect(SyncTransitions.allows("snapshot.end", after: ["hello", "snapshot.part"], receiver: .ios, phase: .session))
        #expect(!SyncTransitions.allows("snapshot.part", after: ["hello", "snapshot.part", "snapshot.end"], receiver: .ios, phase: .session))
        #expect(!SyncTransitions.allows("hello", after: ["hello"], receiver: .ios, phase: .session))
    }
}
