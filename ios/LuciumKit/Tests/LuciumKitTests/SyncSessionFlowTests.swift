import Foundation
import Testing
@testable import LuciumKit

/// The phone's side of a session (docs/synchronisation.md §8.2) against a Mac written in the test. The part after `hello` is a body that the tests stand in for.
@Suite("Synchronisation session: the phone's half, up to hello")
struct SyncSessionFlowTests {
    private let macFingerprint = SyncContract.hex("d1e9cc4016253cbcc57d90fa77640b06d550223a14fd582c1c3bf31426e8519f")
    private let phone = SyncDeviceInfo(id: "vector-phone-000000002", name: "iPhone de test", platform: .ios)
    private var peer: SyncPairedMac {
        SyncPairedMac(id: "vector-mac-0000000001", name: "MacBook de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["mac-de-test.local"], pairedAt: 1_790_000_000_000)
    }
    private let nonce = Data(repeating: 9, count: 16)

    /// The `hello` a Mac sends, with what a test wants to change.
    private func macHello(id: String = "vector-mac-0000000001", platform: String = "mac", categories: [String] = ["structure", "settings"], stateVersion: Int = 1, now: Int = 1_790_000_000_000,
                          hosts: [String]? = ["mac-de-test.local", "192.168.1.20"], baseHash: Any = NSNull()) -> [String: Any] {
        var fields: [String: Any] = ["device": ["id": id, "name": "MacBook de test", "platform": platform], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": categories,
                                     "baseHash": baseHash, "stateVersion": stateVersion, "appVersion": "1.2.0", "now": now]
        if let hosts { fields["hosts"] = hosts }
        return fields
    }

    private struct Recorder: SyncSessionBody {
        let seen: Seen
        final class Seen: @unchecked Sendable { var context: SyncSessionContext?; var count = 0 }
        func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
            seen.context = context
            seen.count += 1
            return .committed(at: 42)
        }
    }

    private struct Failing: SyncSessionBody {
        func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome { throw SyncFailure(.divergence, "test") }
    }

    private func run(mac script: @escaping @Sendable (SyncFakeMac) async throws -> Void, presented: Data? = nil, categories: [SyncCategory] = [.structure, .archive],
                     supported: Int = 1, now: Int = 1_790_000_000_000, body: any SyncSessionBody = SyncNoSessionBody(),
                     sessionMaximum: Duration = SyncLimits.sessionMaximum) async throws -> (SyncSessionReport, SyncLoopbackEnd) {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let task = Task { try await script(fake) }
        defer { task.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: presented ?? macFingerprint)
        let report = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: categories, appVersion: "0.1.0", supportedStateVersion: supported, nonce: nonce,
                                                     baseHash: nil, now: { now }, body: body, handshakeTimeout: .seconds(2), sessionMaximum: sessionMaximum)
        _ = try? await task.value
        return (report, ends.phone)
    }

    private func goodMac(hello: @autoclosure @escaping @Sendable () -> [String: Any]) -> @Sendable (SyncFakeMac) async throws -> Void {
        { mac in
            try await mac.write("hello", hello())
            let theirs = try await mac.read()
            #expect(theirs.fields["t"] as? String == "hello", "the phone speaks first or at once with its hello")
            #expect(theirs.n == 1)
            let next = try await mac.read()
            #expect(next.fields["t"] as? String == "bye", "with no body the session ends with bye")
        }
    }

    // MARK: How long a session may last (docs/synchronisation.md §6.1, §7.5, review n° 19)

    /// A body that reads message after message, each within the time of a silence: the pace of a peer that never stays quiet for long and never gets to the end (two hundred
    /// messages at 60 ms are twelve seconds, far past the maximum the test gives).
    private struct ReadsForLong: SyncSessionBody {
        func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
            for _ in 0..<200 { _ = try await channel.receive(timeout: .seconds(5)) }
            return .committed(at: 1)
        }
    }

    @Test func aSessionThatDripsPastTheTimeASessionMayTakeIsCutAtThatTimeAndTheConnectionIsClosed() async throws {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let drip = Task {
            try await fake.write("hello", macHello())
            _ = try await fake.read()
            for _ in 0..<400 {
                try await Task.sleep(for: .milliseconds(60))
                try await fake.write("open-tabs", ["items": []])
            }
        }
        defer { drip.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        do {
            _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0", supportedStateVersion: 1, nonce: nonce,
                                                baseHash: nil, now: { 1_790_000_000_000 }, body: ReadsForLong(), handshakeTimeout: .seconds(2), sessionMaximum: .milliseconds(350))
            Issue.record("a session that outlasted its time went through")
        } catch let failure as SyncFailure {
            #expect(failure.code == .timeout)
        }
        #expect(ends.phone.closed)
    }

    @Test func aSessionThatFinishesInTimeIsNotTouchedByTheLimit() async throws {
        let (report, transport) = try await run(mac: goodMac(hello: macHello()), sessionMaximum: .seconds(30))
        #expect(report.outcome == .notExchanged)
        #expect(transport.closed)
    }

    @Test func aSessionWithNoBodyGoesToHelloAndSaysNothingWasExchanged() async throws {
        let (report, transport) = try await run(mac: goodMac(hello: macHello()))
        #expect(report.outcome == .notExchanged)
        #expect(report.categories == [.structure], "only what both ticked")
        #expect(report.hosts == ["mac-de-test.local", "192.168.1.20"])
        #expect(report.macAppVersion == "1.2.0")
        #expect(!report.clockSkew)
        #expect(transport.closed)
    }

    @Test func theBodyIsGivenTheContextAndItsOutcomeIsTheReports() async throws {
        let seen = Recorder.Seen()
        let (report, _) = try await run(mac: goodMac(hello: macHello(categories: ["structure", "archive", "future-thing"])), body: Recorder(seen: seen))
        #expect(report.outcome == .committed(at: 42))
        #expect(seen.count == 1)
        #expect(seen.context?.categories == [.structure, .archive], "a category this version does not know is ignored")
        #expect(seen.context?.mac.id == "vector-mac-0000000001")
        #expect(seen.context?.local.categories == ["structure", "archive"])
        #expect(seen.context?.local.device.platform == .ios)
    }

    @Test func aBodyThatFailsClosesTheConnectionAndTheFailureIsTheBodys() async throws {
        do {
            _ = try await run(mac: { mac in try await mac.write("hello", macHello()); _ = try? await mac.read() }, body: Failing())
            Issue.record("a failing body was reported as a success")
        } catch let failure as SyncFailure {
            #expect(failure.code == .divergence)
        }
    }

    @Test func theMacsAddressesAreFilteredAndOnlyTheLocalOnesComeBack() async throws {
        let (report, _) = try await run(mac: goodMac(hello: macHello(hosts: ["8.8.8.8", "192.168.1.20", "mac-de-test.local", "example.com"])))
        #expect(report.hosts == ["mac-de-test.local", "192.168.1.20"], "no public address, no DNS name, the .local name first")
        let (duplicates, _) = try await run(mac: goodMac(hello: macHello(hosts: ["192.168.1.20", "192.168.1.20", "mac-de-test.local", "mac-de-test.local"])))
        #expect(duplicates.hosts == ["mac-de-test.local", "192.168.1.20"], "each address once")
    }

    @Test func aHelloWithNoAddressesLeavesTheStoredOnesAlone() async throws {
        let (report, _) = try await run(mac: goodMac(hello: macHello(hosts: nil)))
        #expect(report.hosts == nil)
    }

    @Test func aDriftOfMoreThanFiveMinutesIsAWarningAndTheSessionGoesOn() async throws {
        let (late, _) = try await run(mac: goodMac(hello: macHello(now: 1_790_000_300_001)))
        #expect(late.clockSkew)
        let (edge, _) = try await run(mac: goodMac(hello: macHello(now: 1_790_000_300_000)))
        #expect(!edge.clockSkew, "five minutes exactly is not more than five minutes")
        let (early, _) = try await run(mac: goodMac(hello: macHello(now: 1_789_999_699_999)))
        #expect(early.clockSkew, "in either direction")
    }

    @Test func aStateOfANewerFormatIsRefusedAndTheMacIsToldWhy() async throws {
        let told = ErrorBox()
        do {
            _ = try await run(mac: { mac in
                try await mac.write("hello", macHello(stateVersion: 2))
                _ = try await mac.read()
                told.message = try await mac.read().fields
            })
            Issue.record("a newer state was accepted")
        } catch let failure as SyncFailure {
            #expect(failure.code == .stateTooNew)
        }
        try await Task.sleep(for: .milliseconds(100))
        #expect(told.message?["code"] as? String == "state-too-new")
        #expect(told.message?["fatal"] as? Bool == true)
    }

    @Test func aMacThatSaysItIsAnotherDeviceThanTheOneRegisteredIsRefused() async throws {
        let liars: [@Sendable () -> [String: Any]] = [{ macHello(id: "someone-else-000000000") }, { macHello(platform: "ios") }]
        for hello in liars {
            do {
                _ = try await run(mac: { mac in try await mac.write("hello", hello()); _ = try? await mac.read(); _ = try? await mac.read() })
                Issue.record("a device that is not the registered Mac was accepted")
            } catch let failure as SyncFailure {
                #expect(failure.code == .fingerprintMismatch)
            }
        }
    }

    @Test func aCertificateThatIsNotTheRegisteredOneIsRefusedBeforeAnyByteIsSent() async throws {
        let ends = syncLoopback()
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: Data(repeating: 0x22, count: 32))
        do {
            _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0", supportedStateVersion: 1, nonce: nonce, baseHash: nil,
                                                now: { 0 }, body: SyncNoSessionBody())
            Issue.record("a certificate that is not the registered one was accepted")
        } catch let failure as SyncFailure {
            #expect(failure.code == .fingerprintMismatch)
        }
        #expect(ends.phone.sent == 0)
        #expect(ends.phone.closed)
    }

    @Test func theMacsErrorIsReportedWithItsOwnCode() async throws {
        for code in [SyncErrorCode.notPaired, .locked, .busy, .rateLimited] {
            do {
                _ = try await run(mac: { mac in _ = try? await mac.read(); try await mac.write("error", ["code": code.rawValue, "fatal": true]) })
                Issue.record("\(code) was not reported")
            } catch let failure as SyncFailure {
                #expect(failure.code == code)
            }
        }
    }

    @Test func whatIsOutOfOrderOrBrokenInASessionIsRefused() async throws {
        let attempts: [(String, @Sendable (SyncFakeMac) async throws -> Void, SyncErrorCode)] = [
            ("a snapshot before the hello", { mac in try await mac.write("snapshot.end", ["entityCount": 0, "digest": String(repeating: "a", count: 64)]) }, .badMessage),
            ("a hello numbered 3", { mac in try await mac.write("hello", macHello(), number: 3) }, .badSequence),
            ("a pair.challenge in a session", { mac in try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(Data(repeating: 1, count: 16))]) }, .badMessage),
            ("a frame of 2 MiB", { mac in try await mac.writeRaw(Data([0, 0x20, 0, 0])) }, .tooLarge),
        ]
        for (name, script, code) in attempts {
            do {
                _ = try await run(mac: script)
                Issue.record("\(name) was accepted")
            } catch let failure as SyncFailure {
                #expect(failure.code == code, "\(name)")
            }
        }
    }

    /// A body that reads one more message, as a real one will.
    private struct ReadsOne: SyncSessionBody {
        func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
            _ = try await channel.receive(timeout: .seconds(2))
            return .notExchanged
        }
    }

    @Test func theChannelKeepsApplyingTheRulesToWhatTheBodyReads() async throws {
        let attempts: [(String, @Sendable (SyncFakeMac) async throws -> Void, SyncErrorCode)] = [
            ("a second hello", { mac in try await mac.write("hello", macHello()); try await mac.write("hello", macHello()) }, .badMessage),
            ("a commit before any result", { mac in try await mac.write("hello", macHello()); try await mac.write("commit", ["digest": String(repeating: "a", count: 64)]) }, .badMessage),
            ("a number that repeats", { mac in try await mac.write("hello", macHello()); try await mac.write("unpair", number: 1) }, .badSequence),
        ]
        for (name, script, code) in attempts {
            do {
                _ = try await run(mac: script, body: ReadsOne())
                Issue.record("\(name) was accepted")
            } catch let failure as SyncFailure {
                #expect(failure.code == code, "\(name)")
            }
        }
        // And what is allowed is read: an unpair after the hello.
        let (report, _) = try await run(mac: { mac in try await mac.write("hello", macHello()); try await mac.write("unpair"); _ = try? await mac.read() }, body: ReadsOne())
        #expect(report.outcome == .notExchanged)
    }

    @Test func aMacThatStaysSilentIsATimeout() async throws {
        do {
            _ = try await run(mac: { _ in try await Task.sleep(for: .seconds(5)) }, now: 0)
            Issue.record("a silent Mac was waited for")
        } catch let failure as SyncFailure {
            #expect(failure.code == .timeout)
        }
    }

    /// A line of the log, kept for the test to read.
    private final class LogBox: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String] = []
        func add(_ line: String) { lock.withLock { lines.append(line) } }
        var all: [String] { lock.withLock { lines } }
    }

    /// A connection that takes what it is given until it is told to fail.
    private final class Breaking: SyncTransport, @unchecked Sendable {
        let inner: SyncLoopbackEnd
        init(_ inner: SyncLoopbackEnd) { self.inner = inner }
        private let lock = NSLock()
        private var writes = 0
        var failAfter = 1
        func send(_ bytes: Data) async throws {
            let n = lock.withLock { writes += 1; return writes }
            if n > failAfter { throw SyncConnectError.failed("broken pipe") }
            try await inner.send(bytes)
        }
        func receive() async throws -> Data { try await inner.receive() }
        func close() { inner.close() }
    }

    @Test func aByeThatCannotBeSentIsLoggedWithItsReasonAndTheSessionStillEndsWell() async throws {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let task = Task { try await fake.write("hello", macHello()); _ = try? await fake.read() }
        defer { task.cancel() }
        let log = LogBox()
        let connection = SyncConnection(transport: Breaking(ends.phone), presentedFingerprint: macFingerprint)
        let report = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0", supportedStateVersion: 1, nonce: nonce,
                                                     baseHash: nil, now: { 1_790_000_000_000 }, body: SyncNoSessionBody(), handshakeTimeout: .seconds(2), log: { log.add($0) })
        #expect(report.outcome == .notExchanged, "the person has nothing to do about a bye that did not go")
        #expect(log.all.count == 1)
        #expect(log.all.first?.contains("could not send bye (the session is done)") == true)
        #expect(log.all.first?.contains("broken pipe") == true)
    }

    /// A body that waits for a message that never comes: the session is cancelled while it waits.
    private struct WaitsForever: SyncSessionBody {
        func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
            _ = try await channel.receive(timeout: .seconds(60))
            return .notExchanged
        }
    }

    @Test func cancellingASessionClosesTheConnectionAtOnceInsteadOfWaitingForTheSilenceTimeout() async throws {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let macTask = Task { try await fake.write("hello", macHello()); try await Task.sleep(for: .seconds(30)) }
        defer { macTask.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        let session = Task {
            try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0", supportedStateVersion: 1, nonce: nonce,
                                            baseHash: nil, now: { 1_790_000_000_000 }, body: WaitsForever(), handshakeTimeout: .seconds(2))
        }
        try await Task.sleep(for: .milliseconds(300))
        let started = ContinuousClock.now
        session.cancel()
        do {
            _ = try await session.value
            Issue.record("a cancelled session reported a success")
        } catch {
            // Whatever it is, it ends now: the connection was closed by the cancellation.
        }
        #expect(ContinuousClock.now - started < .seconds(5), "the 60 s wait of the body did not hold the cancellation")
        #expect(ends.phone.closed)
    }

    private final class ErrorBox: @unchecked Sendable { var message: [String: Any]? }
}
