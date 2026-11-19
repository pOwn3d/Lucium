import Foundation
import Testing
@testable import LuciumKit

/// A connector that answers from a script: what each host does, and which hosts were tried, in order.
private final class ScriptedConnector: SyncConnecting, @unchecked Sendable {
    private let lock = NSLock()
    private var tried: [String] = []
    private let behaviour: [String: Behaviour]
    var attempts: [String] { lock.withLock { tried } }

    enum Behaviour { case connects, silent, fails(SyncConnectError) }

    /// A host that is not in the script does not answer.
    init(_ behaviour: [String: Behaviour]) { self.behaviour = behaviour }

    func connect(host: String, port: UInt16, pin: SyncPin, timeout: Duration) async throws -> SyncConnection {
        lock.withLock { tried.append(host) }
        switch behaviour[host] ?? .silent {
        case .fails(let error): throw error
        case .silent: throw SyncConnectError.timedOut
        case .connects: break
        }
        return SyncConnection(transport: syncLoopback().phone, presentedFingerprint: Data(repeating: 1, count: 32))
    }
}

@Suite("Synchronisation: finding the Mac")
struct SyncReachTests {
    private func reach(_ hosts: [String], _ behaviour: [String: ScriptedConnector.Behaviour]) async -> (SyncReach, [String]) {
        let connector = ScriptedConnector(behaviour)
        let result = await SyncReacher.connect(hosts: hosts, port: 49213, pin: .learn, using: connector, timeout: .milliseconds(10))
        return (result, connector.attempts)
    }

    @Test func theLocalNameIsTriedFirstThenTheAddressesInTheOrderGiven() {
        #expect(SyncCandidates.ordered(["192.168.1.20", "10.0.0.7", "mac.local", "fd12::1"]) == ["mac.local", "192.168.1.20", "10.0.0.7", "fd12::1"])
    }

    @Test func noAddressThatIsNotLocalIsEverTriedAndThereAreAtMostFour() {
        #expect(SyncCandidates.ordered(["8.8.8.8", "example.com", "192.168.1.20", "127.0.0.1"]) == ["192.168.1.20"])
        #expect(SyncCandidates.ordered(["a.local", "b.local", "10.0.0.1", "10.0.0.2", "10.0.0.3"]) == ["a.local", "b.local", "10.0.0.1", "10.0.0.2"])
        #expect(SyncCandidates.ordered(["10.0.0.1", "10.0.0.1"]) == ["10.0.0.1"])
    }

    @Test func theFirstAddressThatAnswersIsTheOneUsedAndTheOthersAreNotTried() async {
        let (result, tried) = await reach(["mac.local", "10.0.0.7", "10.0.0.8"], ["mac.local": .silent, "10.0.0.7": .connects])
        guard case .connected = result else {
            Issue.record("not connected")
            return
        }
        #expect(tried == ["mac.local", "10.0.0.7"], "one after the other, and it stops at the first")
    }

    @Test func aMacThatRefusesIsWaitingNotMissing() async {
        let (result, _) = await reach(["mac.local", "10.0.0.7"], ["mac.local": .fails(.refused), "10.0.0.7": .silent])
        guard case .failed(let why) = result else {
            Issue.record("connected to a Mac that refuses")
            return
        }
        #expect(why == .refused)
    }

    @Test func nobodyAnsweringIsUnreachable() async {
        let (result, tried) = await reach(["mac.local", "10.0.0.7"], ["mac.local": .silent, "10.0.0.7": .fails(.failed("no route"))])
        guard case .failed(let why) = result else {
            Issue.record("connected to nobody")
            return
        }
        #expect(why == .unreachable)
        #expect(tried == ["mac.local", "10.0.0.7"])
    }

    @Test func aCertificateThatIsNotThePinnedOneIsReportedWhenNothingElseConnects() async {
        let (result, _) = await reach(["10.0.0.7", "10.0.0.8"], ["10.0.0.7": .fails(.fingerprintMismatch), "10.0.0.8": .fails(.refused)])
        guard case .failed(let why) = result else {
            Issue.record("connected")
            return
        }
        #expect(why == .fingerprintMismatch, "somebody else is at the Mac's old address: that says more than a refusal")
    }

    @Test func aLaterAddressStillWinsAfterAStrangerAnsweredAtAnEarlierOne() async {
        let (result, tried) = await reach(["10.0.0.7", "10.0.0.8"], ["10.0.0.7": .fails(.fingerprintMismatch), "10.0.0.8": .connects])
        guard case .connected = result else {
            Issue.record("not connected")
            return
        }
        #expect(tried == ["10.0.0.7", "10.0.0.8"])
    }

    @Test func aLocalNetworkThatIsRefusedStopsTheSearch() async {
        let (result, tried) = await reach(["mac.local", "10.0.0.7"], ["mac.local": .fails(.localNetworkDenied), "10.0.0.7": .connects])
        guard case .failed(let why) = result else {
            Issue.record("connected without the local network")
            return
        }
        #expect(why == .localNetworkDenied)
        #expect(tried == ["mac.local"], "the other addresses are on the same network and would be refused the same way")
    }

    @Test func aMacWithNoUsableAddressIsUnreachableWithoutAnyConnection() async {
        let (result, tried) = await reach(["8.8.8.8"], [:])
        guard case .failed(let why) = result else {
            Issue.record("connected")
            return
        }
        #expect(why == .unreachable)
        #expect(tried.isEmpty)
    }
}

@Suite("Synchronisation: settings, state and when a session starts")
struct SyncSettingsTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "lucium-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private let mac = SyncPairedMac(id: "vector-mac-0000000001", name: "MacBook de test", fingerprintHex: String(repeating: "ab", count: 32), port: 49213, hosts: ["mac.local", "192.168.1.20"], pairedAt: 1)

    @Test func itIsOffByDefaultAndOnlyTheStructureIsTicked() {
        let settings = SyncSettings()
        #expect(!settings.enabled)
        #expect(settings.categories == [.structure])
        #expect(settings.mac == nil)
        #expect(settings.deviceId == nil)
        #expect(SyncCategory.defaults == [.structure])
    }

    @Test func theFileComesBackAsItWasWrittenAndIsKeptPrivate() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = SyncSettingsFile(url: dir.appending(path: SyncSettingsFile.fileName))
        #expect(file.load() == .none)
        let settings = SyncSettings(enabled: true, categories: [.structure, .archive], deviceId: "AbCdEfGhIjKlMnOpQrStUv", mac: mac)
        try file.save(settings)
        #expect(file.load() == .loaded(settings))
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        try file.remove()
        #expect(file.load() == .none)
    }

    @Test func hexIsReadOnlyAsLowerCaseAsciiDigitsAndNeverStopsTheApplication() {
        #expect(SyncEncoding.data(hex: "00ff7a") == Data([0x00, 0xff, 0x7a]))
        #expect(SyncEncoding.data(hex: "") == Data())
        // `é` is two bytes and one character: an even count of bytes that used to run past the end of the string.
        for text in ["é", "aé", "éa", "😀", "+f", "-0", "+f+f", "FF", "0g", "abc", " a", "a\u{0}"] {
            #expect(SyncEncoding.data(hex: text) == nil, "\(text.debugDescription)")
        }
    }

    @Test func aFileThatCannotBeTrustedIsReportedAndNotGuessed() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: SyncSettingsFile.fileName)
        let file = SyncSettingsFile(url: url)
        let good = #"{"version":1,"enabled":true,"categories":["structure"],"deviceId":"AbCdEfGhIjKlMnOpQrStUv"}"#
        let hostile = [
            "not json", "{}", #"{"version":2,"enabled":true,"categories":[]}"#, #"{"version":0,"enabled":true,"categories":[]}"#,
            #"{"version":1,"enabled":true,"categories":[],"deviceId":"a b"}"#,
            #"{"version":1,"enabled":true,"categories":[],"mac":{"id":"m","name":"x","fingerprintHex":"zz","port":1,"hosts":[],"pairedAt":1}}"#,
            #"{"version":1,"enabled":true,"categories":[],"mac":{"id":"m","name":"x","fingerprintHex":"é","port":1,"hosts":[],"pairedAt":1}}"#,
            #"{"version":1,"enabled":true,"categories":[],"mac":{"id":"m","name":"x","fingerprintHex":"\#(String(repeating: "+f", count: 32))","port":1,"hosts":[],"pairedAt":1}}"#,
            #"{"version":1,"enabled":true,"categories":[],"mac":{"id":"m","name":"x","fingerprintHex":"\#(String(repeating: "ab", count: 32))","port":0,"hosts":[],"pairedAt":1}}"#,
            #"{"version":1,"enabled":true,"categories":[],"mac":{"id":"m","name":"x","fingerprintHex":"\#(String(repeating: "ab", count: 32))","port":1,"hosts":["8.8.8.8"],"pairedAt":1}}"#,
            #"{"version":1,"enabled":true,"categories":[],"mac":{"id":"m","name":"x","fingerprintHex":"\#(String(repeating: "AB", count: 32))","port":1,"hosts":[],"pairedAt":1}}"#,
        ]
        try Data(good.utf8).write(to: url)
        guard case .loaded(let read) = file.load() else {
            Issue.record("a good file was not read")
            return
        }
        #expect(read.enabled)
        for text in hostile {
            try Data(text.utf8).write(to: url)
            guard case .unreadable = file.load() else { Issue.record("read, but it must not be: \(text.prefix(70))"); continue }
        }
        try Data(repeating: 0x20, count: SyncSettingsFile.maxBytes + 1).write(to: url)
        #expect(file.load() == .unreadable("too large"))
    }

    @Test func aCategoryOfANewerVersionIsLeftOutAndNotAnError() throws {
        let json = #"{"version":1,"enabled":true,"categories":["structure","library","structure","archive"]}"#
        let settings = try JSONDecoder().decode(SyncSettings.self, from: Data(json.utf8))
        #expect(settings.categories == [.structure, .archive])
    }

    @Test func theRetiredCategoryOpenTabsOfADevelopmentFileIsIgnoredAndNotWrittenBack() throws {
        let json = #"{"version":1,"enabled":true,"categories":["structure","openTabs","archive"]}"#
        let settings = try JSONDecoder().decode(SyncSettings.self, from: Data(json.utf8))
        #expect(settings.categories == [.structure, .archive])
        let written = String(decoding: try JSONEncoder().encode(settings), as: UTF8.self)
        #expect(!written.contains("openTabs"))
        #expect(SyncCategory.allCases.map(\.rawValue) == ["structure", "settings", "archive", "todayTabs"])
        #expect(SyncCategory.common(mine: [.structure], theirs: ["structure", "openTabs"]) == [.structure], "a Mac that still announces it shares nothing more")
    }

    @Test func aRestoreThatBroughtTheFileButNotTheKeyForgetsTheMac() {
        var settings = SyncSettings(enabled: true, deviceId: "AbCdEfGhIjKlMnOpQrStUv", mac: mac)
        let keptWithKey = settings.reconcile(identityPresent: true)
        #expect(!keptWithKey)
        #expect(settings.mac != nil)
        let forgotten = settings.reconcile(identityPresent: false)
        #expect(forgotten)
        #expect(settings.mac == nil)
        let again = settings.reconcile(identityPresent: false)
        #expect(!again, "nothing left to forget")
    }

    @Test func aSessionStartsOnlyWhenEveryConditionHolds() {
        func decide(_ trigger: SyncScheduler.Trigger = .launch, enabled: Bool = true, hasMac: Bool = true, locked: Bool = false, running: Bool = false, since: Duration? = nil) -> SyncScheduler.Decision {
            SyncScheduler.decide(trigger, enabled: enabled, hasMac: hasMac, appLocked: locked, running: running, sinceLastStart: since)
        }
        #expect(decide() == .start(after: .zero))
        #expect(decide(enabled: false) == .skip(.off), "nothing runs while the switch is off, whoever asks")
        #expect(decide(.manual, enabled: false) == .skip(.off))
        #expect(decide(hasMac: false) == .skip(.noMac))
        #expect(decide(locked: true) == .skip(.appLocked), "no session while the application is locked")
        #expect(decide(.manual, locked: true) == .skip(.appLocked))
        #expect(decide(running: true) == .skip(.alreadyRunning))
        #expect(decide(.manual, running: true) == .skip(.alreadyRunning))
    }

    @Test func theDelaysAndTheFifteenSecondRuleAreThoseOfTheSpecification() {
        func decide(_ trigger: SyncScheduler.Trigger, since: Duration?) -> SyncScheduler.Decision {
            SyncScheduler.decide(trigger, enabled: true, hasMac: true, appLocked: false, running: false, sinceLastStart: since)
        }
        #expect(decide(.foreground, since: nil) == .start(after: .seconds(5)))
        #expect(decide(.localChange, since: nil) == .start(after: .seconds(30)))
        #expect(decide(.foreground, since: .seconds(14)) == .skip(.tooSoon))
        #expect(decide(.foreground, since: .seconds(15)) == .start(after: .seconds(5)))
        #expect(decide(.manual, since: .seconds(1)) == .start(after: .zero), "the person's own request is not held back")
    }

    @Test func theIntervalTriggerStartsAtOnceButKeepsTheFifteenSecondFloorAndEveryOtherCondition() {
        func decide(_ trigger: SyncScheduler.Trigger = .interval, enabled: Bool = true, hasMac: Bool = true, locked: Bool = false, running: Bool = false, since: Duration? = nil) -> SyncScheduler.Decision {
            SyncScheduler.decide(trigger, enabled: enabled, hasMac: hasMac, appLocked: locked, running: running, sinceLastStart: since)
        }
        #expect(decide(since: nil) == .start(after: .zero))
        #expect(decide(since: .seconds(30)) == .start(after: .zero))
        #expect(decide(since: .seconds(14)) == .skip(.tooSoon), "never more than one session in 15 seconds, the interval included")
        #expect(decide(enabled: false) == .skip(.off))
        #expect(decide(hasMac: false) == .skip(.noMac))
        #expect(decide(locked: true) == .skip(.appLocked))
        #expect(decide(running: true) == .skip(.alreadyRunning))
    }

    @Test func theIntervalsOnOfferAreThirtySecondsOneMinuteFiveMinutesAndFifteenMinutesAndTheDefaultIsOneMinute() {
        #expect(SyncInterval.allCases.map(\.rawValue) == [30, 60, 300, 900])
        #expect(SyncInterval.default == .minute1 && SyncInterval.default.duration == .seconds(60))
        #expect(SyncSettings().interval == .minute1)
        #expect(SyncInterval.allCases.allSatisfy { $0.duration >= SyncLimits.minimumAutomaticInterval }, "no interval is shorter than the floor between two sessions")
    }

    @Test func theIntervalIsKeptInTheFileAndAnUnknownOrMissingOneIsOneMinute() throws {
        var settings = SyncSettings(enabled: true)
        settings.interval = .minutes5
        let data = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(SyncSettings.self, from: data).interval == .minutes5)
        // A file written before the interval existed.
        let old = #"{"version":1,"enabled":true,"categories":["structure"]}"#
        #expect(try JSONDecoder().decode(SyncSettings.self, from: Data(old.utf8)).interval == .minute1)
        // A value a version does not offer (7 seconds, a text).
        for odd in ["7", "0", "-30", "\"30\"", "null"] {
            let json = #"{"version":1,"enabled":true,"categories":["structure"],"interval":"# + odd + "}"
            let read = try? JSONDecoder().decode(SyncSettings.self, from: Data(json.utf8))
            #expect(read?.interval == .minute1, "\(odd): the file stays readable, with the default")
        }
    }

    @Test func theNextAutomaticSessionIsDueAtTheChosenIntervalAndSlowsDownAfterThreeFailuresInARow() {
        for interval in SyncInterval.allCases {
            for failures in 0...2 { #expect(SyncAutoSchedule.delay(interval: interval, consecutiveFailures: failures) == interval.duration, "\(interval) after \(failures)") }
        }
        let thirty = SyncInterval.seconds30
        #expect([3, 4, 5, 6, 7].map { SyncAutoSchedule.delay(interval: thirty, consecutiveFailures: $0) } == [.seconds(60), .seconds(120), .seconds(240), .seconds(480), .seconds(900)], "doubled at each failure, 15 minutes at most")
        #expect(SyncAutoSchedule.delay(interval: .minute1, consecutiveFailures: 3) == .seconds(120))
        #expect(SyncAutoSchedule.delay(interval: .minutes5, consecutiveFailures: 3) == .seconds(600))
        #expect(SyncAutoSchedule.delay(interval: .minutes5, consecutiveFailures: 4) == .seconds(900))
        #expect(SyncAutoSchedule.delay(interval: .minutes15, consecutiveFailures: 9) == .seconds(900), "never past 15 minutes, and never below the interval")
        for failures in [0, 3, 50, 10_000] { #expect(SyncAutoSchedule.delay(interval: .minutes15, consecutiveFailures: failures) == .seconds(900)) }
        #expect(SyncAutoSchedule.delay(interval: thirty, consecutiveFailures: 10_000) == .seconds(900), "a huge count does not overflow")
    }

    @Test func onlyTheStatesThatHaveAMacToTalkToCanStartASession() {
        let startable: [SyncStatus] = [.idle, .waiting, .unreachable, .macAnswered(at: 1), .upToDate(at: 1), .localNetworkDenied, .clockSkew, .failed(.timeout)]
        for status in startable { #expect(status.canStartSession, "\(status)") }
        for status in [SyncStatus.off, .noDevice, .running, .identityLost] { #expect(!status.canStartSession, "\(status)") }
    }
}
