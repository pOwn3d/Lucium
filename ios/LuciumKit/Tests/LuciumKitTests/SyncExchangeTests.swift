import Foundation
import Testing
@testable import LuciumKit

// MARK: - The phone's side of a host

/// The application's model, in memory: a state, what is locked, and the one place a patch is written. A test that wants the person to act in the middle of a session
/// gives `beforeApply`, which runs just before the patch is written.
actor SyncTestHost: SyncExchangeHost {
    private(set) var state: BrowserState
    var locked: Set<String> = []
    var appLocked = false
    var neverModified = false
    var beforeApply: (@Sendable (inout BrowserState) -> Void)?
    private(set) var patches: [SyncPatch] = []
    private(set) var outcomes: [SyncApply.Outcome] = []
    private(set) var summaries: [SyncExchangeSummary] = []
    private(set) var lockedAtStart = 0
    let now = Double(SyncStateFixtures.now)

    init(state: BrowserState) { self.state = state }

    func currentState() -> BrowserState { state }
    func lockedSpaceIDs() -> Set<String> { locked }
    func isAppLocked() -> Bool { appLocked }
    func isNeverModified() -> Bool { neverModified }

    func apply(_ patch: SyncPatch) -> SyncApply.Outcome {
        beforeApply?(&state)
        patches.append(patch)
        let outcome = SyncApply.apply(patch, to: state, now: now)
        state = outcome.state
        outcomes.append(outcome)
        return outcome
    }

    func exchanged(_ summary: SyncExchangeSummary) { summaries.append(summary) }
    func restore(_ change: SyncChange) -> Bool {
        let outcome = SyncApply.restore(change, to: state, now: now)
        state = outcome.state
        return outcome.changed
    }

    func set(state: BrowserState) { self.state = state }
    func set(locked: Set<String>) { self.locked = locked }
    func set(appLocked: Bool) { self.appLocked = appLocked }
    func set(neverModified: Bool) { self.neverModified = neverModified }
    func set(beforeApply: (@Sendable (inout BrowserState) -> Void)?) { self.beforeApply = beforeApply }
}

// MARK: - The Mac's side of a session, written for the tests

/// What the Mac side of a session does, step by step, with the same Swift merge (`SyncMerge`): it reads the phone's messages with the real decoder, merges the same four
/// inputs and answers, so that the phone's half is proved against a peer that follows §8. What it is told to do wrong, it does wrong, once.
struct SyncTestMac: Sendable {
    var snapshot: SyncSnapshot
    var withheld: [String] = []
    /// The base the Mac holds for the phone, and the hash it says in its hello.
    var base: SyncSnapshot?
    var categories = ["structure"]
    var openTabs: [SyncOpenTab]?
    var warnAfterHello = false
    var wrongEndDigest = false
    var wrongResultDigest = false
    var errorAfterParts: SyncErrorCode?
    var unpairAfterParts = false
    var byeAfterParts = false
    var skipCommit = false
    var wrongCommitDigest = false
    var extraPartAfterEnd = false
    /// Says hello and then nothing at all.
    var silentAfterHello = false
    /// Sends its settings and its archive whatever the categories both ticked (a Mac that does not keep to what it said in its hello), and merges them as it sends them.
    var ignoresTheCategories = false

    struct Seen: @unchecked Sendable {
        var hello: [String: Any] = [:]
        var phone = SyncSnapshot()
        var phoneWithheld: [String] = []
        var phoneOpenTabs: [[String: Any]]?
        var phoneBaseHash: Any?
        var phoneResult: String?
        var phoneCommit: String?
        var errors: [(String, Bool)] = []
        var types: [String] = []
        var merged: SyncMergeResult?
    }

    private struct Message: @unchecked Sendable { let fields: [String: Any]? }

    /// The next message of the phone, or nil when nothing comes within `time` (or the connection ended).
    static func readWithin(_ mac: SyncFakeMac, _ time: Duration) async -> [String: Any]? {
        await withTaskGroup(of: Message.self) { group in
            group.addTask { Message(fields: try? await mac.read().fields) }
            group.addTask {
                try? await Task.sleep(for: time)
                return Message(fields: nil)
            }
            let first = await group.next() ?? Message(fields: nil)
            group.cancelAll()
            return first.fields
        }
    }

    static func jsonObject(_ value: JSONValue) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed])
    }

    static func value(_ object: [String: Any]) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func run(_ mac: SyncFakeMac, macId: String = "vector-mac-0000000001", now: Int = SyncStateFixtures.now) async throws -> Seen {
        var seen = Seen()
        let hash = base?.digest
        var hello: [String: Any] = ["device": ["id": macId, "name": "MacBook de test", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": categories,
                                    "baseHash": hash ?? NSNull(), "stateVersion": 1, "appVersion": "1.2.0", "now": now]
        hello["hosts"] = ["mac-de-test.local"]
        try await mac.write("hello", hello)
        let theirs = try await mac.read()
        seen.hello = theirs.fields
        seen.phoneBaseHash = theirs.fields["baseHash"]
        let phoneHash = theirs.fields["baseHash"] as? String
        if silentAfterHello {
            try await Task.sleep(for: .seconds(5))
            return seen
        }
        if warnAfterHello { try await mac.write("error", ["code": "clock-skew", "fatal": false, "detail": "the clocks differ"]) }

        // The Mac's own snapshot, in parts, as `session.ts` sends it: only the categories both ticked.
        let phoneCategories = Set(theirs.fields["categories"] as? [String] ?? [])
        let common = Set(categories).intersection(phoneCategories)
        var shown = snapshot
        if !common.contains("structure") { shown = shown.withoutStructure() }
        if !common.contains("settings") && !ignoresTheCategories { shown.entities["setting"] = nil }
        if !common.contains("archive") && !ignoresTheCategories { shown.entities["archived"] = nil }
        // What the Mac sends is what it would itself accept, with the phone's clock for the marks of the future (`hello.now`).
        let sent = SyncInbound.clean(shown, now: theirs.fields["now"] as? Int ?? now, base: (hash != nil && phoneHash == hash) ? base : nil).snapshot
        let parts = SyncSnapshotParts.parts(of: sent, withheld: withheld)
        for (index, part) in parts.enumerated() {
            try await mac.write("snapshot.part", try Self.jsonObject(.object(part)) as? [String: Any] ?? [:])
            if index == 0, let code = errorAfterParts {
                try await mac.write("error", ["code": code.rawValue, "fatal": true])
                // Whatever the phone says back is told (after the parts it was already sending): an error the Mac sent must not come back to it.
                while let said = await Self.readWithin(mac, .milliseconds(400)) {
                    if said["t"] as? String == "error" { seen.errors.append((said["code"] as? String ?? "?", said["fatal"] as? Bool ?? false)) }
                }
                return seen
            }
            if index == 0, unpairAfterParts { try await mac.write("unpair"); return seen }
            if index == 0, byeAfterParts { try await mac.write("bye"); return seen }
        }
        if let tabs = openTabs {
            let items = tabs.map { ["id": $0.id, "spaceId": $0.spaceId, "url": $0.url, "title": $0.title, "lastActiveAt": $0.lastActiveAt] as [String: Any] }
            try await mac.write("open-tabs", ["items": items])
        }
        let count = sent.entities.values.reduce(0) { $0 + $1.count }
        try await mac.write("snapshot.end", ["entityCount": count, "digest": wrongEndDigest ? String(repeating: "0", count: 64) : sent.digest])
        if extraPartAfterEnd { try await mac.write("snapshot.part", try Self.jsonObject(.object(parts[0])) as? [String: Any] ?? [:]) }

        // What the phone sent.
        var assembler = SyncSnapshotParts.Assembler()
        while true {
            let message = try await mac.read()
            let type = message.fields["t"] as? String ?? "?"
            seen.types.append(type)
            switch type {
            case "snapshot.part": try assembler.add(try Self.value(message.fields))
            case "open-tabs": seen.phoneOpenTabs = message.fields["items"] as? [[String: Any]]
            case "snapshot.end":
                let assembled = try assembler.finish(entityCount: message.fields["entityCount"] as? Int ?? -1, digest: message.fields["digest"] as? String ?? "")
                seen.phone = assembled.snapshot
                seen.phoneWithheld = assembled.withheld.sorted()
                let usable: SyncSnapshot? = (hash != nil && phoneHash == hash) ? base : nil
                let cleaned = SyncInbound.clean(assembled.snapshot, now: now, base: usable)
                let aside = Set(withheld).union(assembled.withheld).sorted()
                let merged = SyncMerge.merge(base: usable, local: sent, remote: cleaned.snapshot, withheld: aside)
                seen.merged = merged
                let digest = merged.snapshot.digest
                try await mac.write("result", ["digest": wrongResultDigest ? String(repeating: "f", count: 64) : digest])
                let result = try await mac.read()
                seen.types.append(result.fields["t"] as? String ?? "?")
                seen.phoneResult = result.fields["digest"] as? String
                if skipCommit { return seen }
                try await mac.write("commit", ["digest": wrongCommitDigest ? String(repeating: "e", count: 64) : digest])
                let commit = try await mac.read()
                seen.types.append(commit.fields["t"] as? String ?? "?")
                if commit.fields["t"] as? String == "error" {
                    // The phone found the two results different and said so instead of going on.
                    seen.errors.append((commit.fields["code"] as? String ?? "?", commit.fields["fatal"] as? Bool ?? false))
                    return seen
                }
                seen.phoneCommit = commit.fields["digest"] as? String
                let bye = try? await mac.read()
                if let bye { seen.types.append(bye.fields["t"] as? String ?? "?") }
                return seen
            case "error":
                seen.errors.append((message.fields["code"] as? String ?? "?", message.fields["fatal"] as? Bool ?? false))
                return seen
            default: break
            }
        }
    }
}

// MARK: - The session

@Suite("Synchronisation: the exchange of the phone's state with the Mac's")
struct SyncExchangeTests {
    private let now = SyncStateFixtures.now
    private let macFingerprint = SyncContract.hex("d1e9cc4016253cbcc57d90fa77640b06d550223a14fd582c1c3bf31426e8519f")
    private let phone = SyncDeviceInfo(id: "vector-phone-000000002", name: "iPhone de test", platform: .ios)
    private var peer: SyncPairedMac {
        SyncPairedMac(id: "vector-mac-0000000001", name: "MacBook de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["mac-de-test.local"], pairedAt: 1_790_000_000_000)
    }

    private struct Rig {
        let directory: URL
        let host: SyncTestHost
        let marks: SyncMarkKeeper
        let bases: SyncBaseStore
        var body: SyncExchangeBody
        func cleanup() { try? FileManager.default.removeItem(at: directory) }
    }

    private func rig(state: BrowserState? = nil, clock: @escaping @Sendable () -> Int = { SyncStateFixtures.now }) throws -> Rig {
        let directory = FileManager.default.temporaryDirectory.appending(path: "exchange-\(UUID().uuidString)")
        let host = SyncTestHost(state: try state ?? SyncStateFixtures.sample())
        let marks = SyncMarkKeeper(device: phone.id, file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)))
        let bases = SyncBaseStore(directory: directory)
        return Rig(directory: directory, host: host, marks: marks, bases: bases, body: SyncExchangeBody(host: host, marks: marks, bases: bases, now: clock, idleTimeout: .seconds(2)))
    }

    private func macEntity(_ fields: [String: JSONValue], at ms: Int = SyncStateFixtures.now - 50_000, counter: Int = 0) -> SyncEntity {
        SyncEntity(fields: fields, stamps: Dictionary(uniqueKeysWithValues: fields.keys.map { ($0, String(format: "%013ld-%04lx-vector-mac-0000000001", ms, counter)) }))
    }

    /// A Mac with one space of its own, a folder in it, a pinned tab and the order of those lists.
    private func macSnapshot() -> SyncSnapshot {
        var snapshot = SyncSnapshot()
        snapshot.entities = [
            "space": ["m1": macEntity(["name": .string("Du Mac"), "emoji": .string("🍎"), "profileId": .string("default"), "theme": SpaceTheme.make(hue: 130)])],
            "folder": ["mf": macEntity(["spaceId": .string("m1"), "name": .string("Dossier du Mac"), "collapsed": .bool(false)])],
            "tab": ["mt": macEntity(["spaceId": .string("m1"), "pinned": .bool(true), "anchorUrl": .string("https://mac.example/"), "url": .string("https://mac.example/page"), "title": .string("Mac")])],
        ]
        snapshot.order = ["spaces": ["m1"], "folders:m1:-": ["mf"], "tabs:m1:-": ["mt"]]
        snapshot.orderStamps = ["spaces": macStamp(1), "folders:m1:-": macStamp(1), "tabs:m1:-": macStamp(1)]
        return snapshot
    }

    private func macStamp(_ counter: Int) -> String { String(format: "%013ld-%04lx-vector-mac-0000000001", now - 50_000, counter) }

    @discardableResult
    private func session(_ rig: Rig, mac script: SyncTestMac, categories: [SyncCategory] = [.structure], baseHash override: String?? = nil, phoneNow: Int? = nil, expect: SyncFailure? = nil) async throws -> (SyncSessionReport?, SyncTestMac.Seen) {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let macTask = Task { try await script.run(fake, now: now) }
        defer { macTask.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        let baseHash: String?
        if let override { baseHash = override } else { baseHash = await rig.body.baseHash(forMac: peer.id) }
        var report: SyncSessionReport?
        if let expect {
            await #expect(throws: expect) {
                _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: categories, appVersion: "0.1.0", supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16),
                                                    baseHash: baseHash, now: { phoneNow ?? self.now }, body: rig.body, handshakeTimeout: .seconds(2))
            }
        } else {
            report = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: categories, appVersion: "0.1.0", supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16),
                                                     baseHash: baseHash, now: { phoneNow ?? self.now }, body: rig.body, handshakeTimeout: .seconds(2))
        }
        let seen = (try? await macTask.value) ?? SyncTestMac.Seen()
        return (report, seen)
    }

    // MARK: The first exchange

    @Test func theFirstExchangeIsTheUnionOfTheTwoStatesAndBothMergeTheSameThing() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(report?.outcome == .committed(at: now))
        // The Mac received what the phone has: its two spaces, the folders and the pinned tabs, no Today tab, no private tab.
        #expect(seen.phone.entities["space"]?.keys.sorted() == ["s1", "s2"])
        #expect(seen.phone.entities["folder"]?.keys.sorted() == ["f1", "f2"])
        #expect(seen.phone.entities["tab"]?.keys.sorted() == ["t1", "t2"])
        #expect(seen.phone.entities["favorite"]?.keys.sorted() == ["fav1"])
        #expect(seen.phone.entities["archived"] == nil && seen.phone.entities["setting"] == nil, "only the categories both ticked")
        // The phone now holds the Mac's space too, its folder, its pinned tab, in the order the merge gave.
        let state = await rig.host.state
        #expect(state.spaces.map(\.id).sorted() == ["m1", "s1", "s2"])
        #expect(state.folders.map(\.id).contains("mf"))
        #expect(state.tabs.contains { $0.id == "mt" && $0.pinned && $0.anchorUrl == "https://mac.example/" })
        #expect(seen.phoneResult == seen.merged?.snapshot.digest && seen.phoneCommit == seen.merged?.snapshot.digest, "both said the same digest")
        #expect(seen.types.suffix(3) == ["result", "commit", "bye"])
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.applied && !summary.adoptedTheMacState && summary.conflicts.isEmpty && summary.refusedSent.isEmpty && summary.refusedReceived.isEmpty)
        // The base is the merged snapshot, without seeds, and its hash is what the next hello says.
        let base = try #require(rig.bases.get(peerId: peer.id, now: now))
        #expect(base.hash == SyncStateView.base(of: seen.merged!.snapshot).digest)
        #expect(await rig.body.baseHash(forMac: peer.id) == base.hash)
    }

    @Test func aSecondExchangeWithNothingNewWritesNothing() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        let merged = SyncStateView.base(of: try #require(first.1.merged).snapshot)
        let stateAfter = await rig.host.state
        // The Mac holds the same base and the same state: the two hashes of the hellos are equal and the merge starts from it.
        var mac = SyncTestMac(snapshot: try #require(first.1.merged).snapshot, base: merged)
        mac.snapshot = macSnapshotAfter(merged: first.1.merged!.snapshot)
        let second = try await session(rig, mac: mac)
        #expect(second.0?.outcome == .committed(at: now))
        #expect(second.1.phoneBaseHash as? String == merged.digest, "the phone says it holds the base the Mac holds")
        let summary = try #require(await rig.host.summaries.last)
        #expect(!summary.applied && summary.conflicts.isEmpty)
        #expect(await rig.host.state == stateAfter)
        #expect(await rig.host.patches.count == 1, "no patch the second time")
    }

    /// The Mac's snapshot once it has adopted a merge: the same entities, seeds included.
    private func macSnapshotAfter(merged: SyncSnapshot) -> SyncSnapshot { SyncStateView.base(of: merged) }

    /// Two devices that do not hold the same base merge from none (§8.2): the Mac's mark of a field is later than the phone's change, so a merge from the base (the
    /// phone changed, the Mac did not) and a merge from none (both "changed": the later mark wins) give different results. The session only goes through when both
    /// started from none.
    private func disagreeingBases(phoneSaysNone: Bool) async throws -> (SyncSessionReport?, SyncTestMac.Seen, Rig) {
        let rig = try rig()
        let first = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        let merged = try #require(first.1.merged).snapshot
        var state = await rig.host.state
        let index = try #require(state.spaces.firstIndex { $0.id == "m1" })
        state.spaces[index].name = "Sur le téléphone"
        await rig.host.set(state: state)
        var macNow = SyncStateView.base(of: merged)
        macNow.entities["space"]?["m1"]?.stamps["name"] = String(format: "%013ld-0000-vector-mac-0000000001", now + 600_000)
        // The base the Mac holds: the phone's own, or another one.
        var other = SyncSnapshot()
        other.entities = ["space": ["z": SyncEntity(fields: ["name": .string("Autre")], stamps: ["name": "0"])]]
        let held = phoneSaysNone ? SyncStateView.base(of: merged) : other
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macNow, base: held), baseHash: phoneSaysNone ? .some(nil) : nil)
        return (report, seen, rig)
    }

    @Test func aMacThatHoldsAnotherBaseMakesBothMergeFromNone() async throws {
        let (report, seen, rig) = try await disagreeingBases(phoneSaysNone: false)
        defer { rig.cleanup() }
        #expect(report?.outcome == .committed(at: now), "both merged from none: the digests are equal")
        #expect(seen.phoneResult == seen.merged?.snapshot.digest)
        #expect(await rig.host.state.spaces.first { $0.id == "m1" }?.name == "Du Mac", "from none the later mark wins")
    }

    @Test func aPhoneThatSaysItHoldsNoBaseMakesBothMergeFromNone() async throws {
        let (report, seen, rig) = try await disagreeingBases(phoneSaysNone: true)
        defer { rig.cleanup() }
        #expect(report?.outcome == .committed(at: now))
        #expect(seen.phoneBaseHash is NSNull)
        #expect(await rig.host.state.spaces.first { $0.id == "m1" }?.name == "Du Mac")
    }

    // MARK: A phone that was never modified

    @Test func aPhoneNeverModifiedSendsNoStructureAndAdoptsTheStateOfTheMac() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        await rig.host.set(neverModified: true)
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(report?.outcome == .committed(at: now))
        #expect(seen.phoneBaseHash is NSNull, "it has no base to speak of: the Mac must merge from an empty one too")
        #expect(seen.phone.entities.isEmpty && seen.phone.order.isEmpty, "the Mac receives the state of a device that has nothing")
        let state = await rig.host.state
        #expect(state.spaces.map(\.id) == ["m1"], "its own spaces are replaced by the Mac's")
        #expect(state.folders.map(\.id) == ["mf"])
        #expect(state.tabs.map(\.id) == ["mt"], "the Today tab and the private tab went with their space")
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.adoptedTheMacState && summary.conflicts.isEmpty)
    }

    @Test func aPhoneNeverModifiedStillSendsItsSettingsAndArchiveTheOrdinaryWay() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        await rig.host.set(neverModified: true)
        let (_, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), categories: ["structure", "settings", "archive"]), categories: [.structure, .settings, .archive])
        #expect(seen.phone.entities["space"] == nil && seen.phone.entities["tab"] == nil)
        #expect(seen.phone.entities["setting"]?.keys.sorted() == ["httpsUpgrade", "profileNames", "sendGpc"], "the person's settings are not 'structure': they are not replaced by the Mac's silence")
        #expect(seen.phone.entities["archived"]?.keys.sorted() == ["a1"])
    }

    @Test func aPhoneNeverModifiedThatDoesNotExchangeTheStructureKeepsIt() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        await rig.host.set(neverModified: true)
        let before = await rig.host.state
        _ = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), categories: ["settings"]), categories: [.structure, .settings])
        #expect(await rig.host.state.spaces == before.spaces, "the Mac did not tick the structure: nothing of it was exchanged, nothing was adopted")
        #expect(try #require(await rig.host.summaries.first).adoptedTheMacState == false, "and the person is not told the Mac's state was adopted")
    }

    @Test func aPhoneNeverModifiedSaysItHoldsNoBaseEvenWhenOneIsStored() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        _ = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(await rig.body.baseHash(forMac: peer.id) != nil, "a base is kept after a session")
        await rig.host.set(neverModified: true)
        #expect(await rig.body.baseHash(forMac: peer.id) == nil, "a phone that adopts the Mac's state merges from none, and says so")
    }

    @Test func aSettingThatChangedOnTheMacReachesThePhoneWithNothingElseInThePatch() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        var mac = SyncTestMac(snapshot: macSnapshot(), categories: ["settings"])
        mac.snapshot.entities = ["setting": ["autoArchiveHours": macEntity(["value": .number(6)])]]
        mac.snapshot.order = [:]
        mac.snapshot.orderStamps = [:]
        _ = try await session(rig, mac: mac, categories: [.settings])
        guard case .object(let settings)? = await rig.host.state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(settings["autoArchiveHours"] == .number(6), "a patch that holds only a setting is written")
        #expect(await rig.host.state.spaces.map(\.id).sorted() == ["s1", "s2"])
    }

    @Test func theSettingsAndTheArchiveOfAMacThatDoesNotKeepToTheCategoriesAreNotTaken() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        var mac = SyncTestMac(snapshot: macSnapshot(), categories: ["structure"])
        mac.ignoresTheCategories = true
        mac.snapshot.entities["setting"] = ["httpsUpgrade": macEntity(["value": .bool(false)]), "sendGpc": macEntity(["value": .bool(true)])]
        mac.snapshot.entities["archived"] = ["planted": macEntity(["spaceId": .string("m1"), "url": .string("https://planted.example/"), "title": .string("planted"), "archivedAt": .number(1)])]
        let before = await rig.host.state
        // Only the structure is common. The Mac merges what it sent, the settings included; the phone merges what is common, and the two do not reach the same snapshot.
        _ = try? await session(rig, mac: mac, categories: [.structure])
        let after = await rig.host.state
        #expect(after.rest["settings"] == before.rest["settings"], "the privacy settings of the phone are not the Mac's to change when the category is not ticked")
        #expect(after.archive == before.archive)
        #expect(after.spaces == before.spaces, "and nothing is written at all when the two devices do not agree")
    }

    @Test func whatIsLeftOutOfACategoryThatIsNotCommonIsTheKindsAndTheListsOfIt() {
        var received = macSnapshot()
        received.entities["setting"] = ["httpsUpgrade": macEntity(["value": .bool(false)])]
        received.entities["archived"] = ["a9": macEntity(["spaceId": .string("m1"), "url": .string("https://x.example/")])]
        received.entities["unknown-kind"] = ["u1": macEntity(["x": .number(1)])]
        received.tombstones = ["tab": ["gone": macStamp(2)], "archived": ["old": macStamp(2)]]
        let kept = SyncInbound.onlyExchanged(received, categories: [.settings])
        #expect(kept.snapshot.entities.keys.sorted() == ["setting", "unknown-kind"], "the structure and the archive are not common; a kind this version does not know crosses")
        #expect(kept.snapshot.tombstones.isEmpty)
        #expect(kept.snapshot.order.isEmpty && kept.snapshot.orderStamps.isEmpty, "the lists and the deletions of the structure go with it")
        #expect(kept.refused.contains { $0.kind == "space" && $0.id == "m1" && $0.reason == .notSynced })
        #expect(SyncInbound.onlyExchanged(received, categories: [.structure, .settings, .archive]).snapshot == received, "everything that is common stays")
    }

    @Test func anEntityThatCannotTravelBecauseOfItsMarkIsNotTakenForADeletion() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        let merged = try #require(first.1.merged).snapshot
        // The phone renames the Mac's space with a clock that is eight days ahead of the Mac's: the Mac would refuse that mark, and the entity would look deleted.
        var state = await rig.host.state
        let index = try #require(state.spaces.firstIndex { $0.id == "m1" })
        state.spaces[index].name = "Horloge d'avance"
        await rig.host.set(state: state)
        rig.marks.observe(state, now: now + 8 * 24 * 60 * 60 * 1000)
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: SyncStateView.base(of: merged), base: SyncStateView.base(of: merged)))
        #expect(report?.outcome == .committed(at: now), "the two merges agree: the base stood in for the entity that could not travel")
        #expect(seen.phone.entities["space"]?["m1"]?.fields["name"] == .string("Du Mac"), "what the Mac received of it is the base's version, unchanged")
        let kept = await rig.host.state
        #expect(kept.spaces.contains { $0.id == "m1" } && kept.folders.contains { $0.id == "mf" }, "nobody lost the space, nor what is in it")
        let summary = try #require(await rig.host.summaries.last)
        #expect(summary.refusedSent.contains(.init(kind: "space", id: "m1", reason: .futureMark)))
    }

    @Test func anEntityTheMacSendsWithAMarkThatIsAWeekAheadOfThePhonesClockIsReplacedByTheBaseOnBothSides() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        let merged = SyncStateView.base(of: try #require(first.1.merged).snapshot)
        // The phone's clock is eight days behind the Mac's: every mark of the Mac is a week ahead of it. Both devices refuse them and put the base in their place, so that
        // neither takes the other's entities for deleted (the real Mac does the same with the phone's `hello.now`).
        let behind = now - 8 * 24 * 60 * 60 * 1000
        let rig2 = try self.rig(clock: { behind })
        defer { rig2.cleanup() }
        try? FileManager.default.removeItem(at: rig2.directory)
        try FileManager.default.copyItem(at: rig.directory, to: rig2.directory)
        await rig2.host.set(state: await rig.host.state)
        let (report, _) = try await session(rig2, mac: SyncTestMac(snapshot: merged, base: merged), phoneNow: behind)
        #expect(report?.outcome == .committed(at: behind), "the two merges agree")
        let state = await rig2.host.state
        #expect(state.spaces.contains { $0.id == "m1" } && state.folders.contains { $0.id == "mf" }, "nothing of the Mac's was taken for deleted")
        #expect(try #require(await rig2.host.summaries.last).refusedReceived.contains(.init(kind: "space", id: "m1", reason: .futureMark)))
    }

    @Test func aSessionIsCutAtTheLongestTimeItMayLast() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "exchange-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let host = SyncTestHost(state: try SyncStateFixtures.sample())
        let body = SyncExchangeBody(host: host, marks: SyncMarkKeeper(device: phone.id, file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName))), bases: SyncBaseStore(directory: directory), now: { self.now },
                                    idleTimeout: .seconds(30), sessionMaximum: .milliseconds(300))
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        var mac = SyncTestMac(snapshot: macSnapshot())
        mac.silentAfterHello = true
        let script = mac
        let task = Task { try await script.run(fake) }
        defer { task.cancel() }
        let started = ContinuousClock.now
        var failure: SyncFailure?
        do {
            _ = try await SyncSessionClient.run(connection: SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint), peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0",
                                                supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16), baseHash: nil, now: { self.now }, body: body, handshakeTimeout: .seconds(2))
        } catch let caught as SyncFailure {
            failure = caught
        }
        #expect(failure?.code == .timeout, "the session ends on `timeout`")
        #expect(ContinuousClock.now - started < .seconds(5), "cut by the bound of the session, not by the silence of the peer")
    }

    // MARK: When the two do not agree

    @Test func twoDifferentResultsAreADivergenceAndNothingIsWritten() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let before = await rig.host.state
        let (_, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), wrongResultDigest: true), expect: SyncFailure(.divergence, "the two devices do not reach the same merged snapshot: nothing is written"))
        #expect(await rig.host.state == before)
        #expect(await rig.host.patches.isEmpty && rig.bases.get(peerId: peer.id, now: now) == nil, "no base is kept for a session that did not go through")
        #expect(await rig.host.summaries.isEmpty)
        #expect(seen.errors.first?.0 == "divergence", "the Mac is told why")
    }

    @Test func aDigestOfTheEndThatIsNotTheOneOfTheSnapshotIsTruncated() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let before = await rig.host.state
        try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), wrongEndDigest: true), expect: SyncFailure(.truncated, "the digest of the snapshot is not the one announced"))
        #expect(await rig.host.state == before)
        #expect(rig.bases.get(peerId: peer.id, now: now) == nil)
    }

    @Test func aSessionThatCannotKeepItsMarksFailsAndLetsTheBookFollowTheStateAgain() async throws {
        let rig = try rig()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: rig.directory.path)
            rig.cleanup()
        }
        rig.marks.observe(await rig.host.state, now: now)
        // The folder cannot be written into: the marks of the merge cannot be kept, and the session must not say it is done.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: rig.directory.path)
        try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()), expect: SyncFailure(.internal, "the base could not be written"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: rig.directory.path)
        #expect(await rig.host.summaries.isEmpty, "the person is not told 'up to date'")
        var state = await rig.host.state
        state.spaces[0].name = "Après l'échec"
        rig.marks.observe(state, now: now + 50_000)
        let mark = rig.marks.currentBook.stamps(of: "space", id: state.spaces[0].id)["name"]
        #expect(mark?.hasPrefix("1790000050000-") == true && mark?.hasSuffix("-vector-phone-000000002") == true, "the book is not held for ever by a session that failed")
    }

    @Test func aCommitThatIsNotTheDigestAgreedIsABadMessageAfterTheStateWasWritten() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), wrongCommitDigest: true), expect: SyncFailure(.badMessage, "the commit of the Mac is not the one expected"))
        #expect(await rig.host.summaries.isEmpty, "the person is not told 'up to date'")
    }

    @Test func aMacThatSaysAFatalErrorEndsTheSessionWithItsCodeAndGetsNothingBack() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let before = await rig.host.state
        let (_, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), errorAfterParts: .locked), expect: SyncFailure(.locked, "the Mac ended the session"))
        #expect(await rig.host.state == before)
        #expect(seen.errors.isEmpty, "an error the Mac sent is not sent back to it")
    }

    @Test func aMacThatForgotThePhoneEndsItWithNotPaired() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), unpairAfterParts: true), expect: SyncFailure(.notPaired, "the Mac forgot this phone"))
    }

    @Test func aByeBeforeTheExchangeIsOverIsNotAnEndingTheStateIsLeftAlone() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let before = await rig.host.state
        try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), byeAfterParts: true), expect: SyncFailure(.badMessage, "the Mac ended the session before the exchange was over"))
        #expect(await rig.host.state == before)
    }

    @Test func aWarningOfTheClocksDoesNotEndTheSession() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let (report, _) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot(), warnAfterHello: true))
        #expect(report?.outcome == .committed(at: now))
    }

    @Test func aPartAfterTheEndIsABadMessageFromTheChannel() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let before = await rig.host.state
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let mac = SyncTestMac(snapshot: macSnapshot(), extraPartAfterEnd: true)
        let task = Task { try await mac.run(fake) }
        defer { task.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        await #expect(throws: SyncFailure.self) {
            _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0", supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16),
                                                baseHash: nil, now: { self.now }, body: rig.body, handshakeTimeout: .seconds(2))
        }
        #expect(await rig.host.state == before)
    }

    // MARK: What is set aside

    @Test func aLockedSpaceIsNotSentAndItsStateIsNotTouched() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        await rig.host.set(locked: ["s2"])
        var mac = SyncTestMac(snapshot: macSnapshot())
        // The Mac has its own change to the locked space: it must not be written while the space is closed here.
        mac.snapshot.entities["space"]?["s2"] = macEntity(["name": .string("Renommé sur le Mac"), "emoji": .string("🏠"), "profileId": .string("default")])
        let (_, seen) = try await session(rig, mac: mac)
        #expect(seen.phone.entities["space"]?.keys.contains("s2") == false, "nothing of a locked space goes")
        #expect(seen.phoneWithheld == ["s2"], "only its identifier travels, so that the Mac does not take it for deleted")
        let state = await rig.host.state
        #expect(state.spaces.first { $0.id == "s2" }?.name == "Maison")
        #expect(state.spaces.map(\.id).sorted() == ["m1", "s1", "s2"])
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.spacesSetAside == 1)
    }

    @Test func aSpaceTheMacSetAsideIsNotWrittenEither() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        var mac = SyncTestMac(snapshot: macSnapshot(), withheld: ["m1"])
        mac.snapshot.entities["space"]?["m2"] = macEntity(["name": .string("Autre"), "emoji": .string("🌍"), "profileId": .string("default")])
        mac.snapshot.order["spaces"] = ["m1", "m2"]
        _ = try await session(rig, mac: mac)
        let ids = await rig.host.state.spaces.map(\.id).sorted()
        #expect(ids == ["m2", "s1", "s2"], "m1 is closed on the Mac: it does not arrive; m2 does")
    }

    @Test func theApplicationBeingLockedNothingIsExchanged() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        await rig.host.set(appLocked: true)
        let before = await rig.host.state
        try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()), expect: SyncFailure(.locked, "the application is locked"))
        #expect(await rig.host.state == before)
    }

    @Test func theApplicationLockingBeforeTheWriteStopsTheWrite() async throws {
        // A host that locks at the moment the merge is done: nothing is written, no base kept.
        final class LockingHost: SyncExchangeHost, @unchecked Sendable {
            let inner: SyncTestHost
            private let lock = NSLock()
            private var calls = 0
            init(_ inner: SyncTestHost) { self.inner = inner }
            func currentState() async -> BrowserState { await inner.currentState() }
            func lockedSpaceIDs() async -> Set<String> { await inner.lockedSpaceIDs() }
            func isAppLocked() async -> Bool {
                let call = lock.withLock { calls += 1; return calls }
                return call >= 2  // the first look is at the start of the session, the second just before the write
            }
            func isNeverModified() async -> Bool { await inner.isNeverModified() }
            func apply(_ patch: SyncPatch) async -> SyncApply.Outcome { await inner.apply(patch) }
            func exchanged(_ summary: SyncExchangeSummary) async { await inner.exchanged(summary) }
            func restore(_ change: SyncChange) async -> Bool { await inner.restore(change) }
        }
        let directory = FileManager.default.temporaryDirectory.appending(path: "exchange-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let inner = SyncTestHost(state: try SyncStateFixtures.sample())
        let locking = LockingHost(inner)
        let marks = SyncMarkKeeper(device: phone.id, file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)))
        let bases = SyncBaseStore(directory: directory)
        let body = SyncExchangeBody(host: locking, marks: marks, bases: bases, now: { self.now }, idleTimeout: .seconds(2))
        let before = await inner.state
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let mac = SyncTestMac(snapshot: macSnapshot())
        let task = Task { try await mac.run(fake) }
        defer { task.cancel() }
        await #expect(throws: SyncFailure(.locked, "the application locked before anything was written")) {
            _ = try await SyncSessionClient.run(connection: SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint), peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0",
                                                supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16), baseHash: nil, now: { self.now }, body: body, handshakeTimeout: .seconds(2))
        }
        #expect(await inner.state == before)
        #expect(bases.get(peerId: peer.id, now: now) == nil)
    }

    // MARK: The person acts during the session

    @Test func whatThePersonChangedDuringTheSessionKeepsTheirChange() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        // The first session gives both sides the same state and a base.
        let first = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        let merged = try #require(first.1.merged).snapshot
        // The Mac renames the Mac's space; the person renames it too, on the phone, in the middle of the next session.
        var mac = SyncTestMac(snapshot: merged, base: SyncStateView.base(of: merged))
        mac.snapshot.entities["space"]?["m1"]?.fields["name"] = .string("Du Mac, renommé")
        mac.snapshot.entities["space"]?["m1"]?.stamps["name"] = String(format: "%013ld-0000-vector-mac-0000000001", now + 1000)
        await rig.host.set(beforeApply: { state in
            if let index = state.spaces.firstIndex(where: { $0.id == "m1" }) { state.spaces[index].name = "Renommé par la personne" }
        })
        let second = try await session(rig, mac: mac)
        #expect(second.0?.outcome == .committed(at: now))
        #expect(await rig.host.state.spaces.first { $0.id == "m1" }?.name == "Renommé par la personne", "their change is kept, and the next session sends it")
    }

    @Test func twoChangesToTheSameFieldAreOneConflictTheNewerWinsAndTheJournalGetsTheLine() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        let merged = try #require(first.1.merged).snapshot
        // The person renames the Mac's space on the phone; the Mac renames it too, later.
        var state = await rig.host.state
        let index = try #require(state.spaces.firstIndex { $0.id == "m1" })
        state.spaces[index].name = "Sur le téléphone"
        await rig.host.set(state: state)
        var mac = SyncTestMac(snapshot: merged, base: SyncStateView.base(of: merged))
        mac.snapshot.entities["space"]?["m1"]?.fields["name"] = .string("Sur le Mac")
        mac.snapshot.entities["space"]?["m1"]?.stamps["name"] = String(format: "%013ld-0000-vector-mac-0000000001", now + 60_000)
        // The phone's own clock is later than the Mac's mark: it marks the gesture with the time the book sees it.
        let (report, seen) = try await session(rig, mac: mac)
        #expect(report?.outcome == .committed(at: now))
        let summary = try #require(await rig.host.summaries.last)
        let conflict = try #require(summary.conflicts.first)
        #expect(conflict.kind == "space" && conflict.entityID == "m1" && conflict.field == "name" && conflict.peer == .mac)
        #expect(conflict.reason == .newer)
        #expect(conflict.winner == .remote && conflict.restore != nil, "the Mac's mark is the later one, and what the phone had can be put back")
        #expect(await rig.host.state.spaces.first { $0.id == "m1" }?.name == "Sur le Mac")
        #expect(seen.merged?.conflicts.count == 1)
    }

    // MARK: The marks

    @Test func whatTheMergeWroteIsNotSentBackAsAChangeOfThePhone() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        _ = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        // Looking at the state again (the model does it each time it writes the state) marks nothing the Mac wrote.
        let book = rig.marks.currentBook
        rig.marks.observe(await rig.host.state, now: now + 10_000)
        #expect(rig.marks.currentBook.stamps(of: "space", id: "m1") == book.stamps(of: "space", id: "m1"))
        let stamps = rig.marks.currentBook.stamps(of: "space", id: "m1")
        #expect(!stamps.isEmpty && stamps.values.allSatisfy { $0.hasSuffix("vector-mac-0000000001") }, "the book holds the Mac's own marks for what the Mac wrote")
    }

    @Test func theBookDoesNotLookAtTheStateWhileASessionWritesIntoIt() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        var seenDuringTheWrite: SyncMarkBook?
        // A host that looks at the state through the book in the middle of the write, as the model's own flush does.
        final class Watching: SyncExchangeHost, @unchecked Sendable {
            let inner: SyncTestHost
            let marks: SyncMarkKeeper
            private let lock = NSLock()
            private var stored: SyncMarkBook?
            var book: SyncMarkBook? { lock.withLock { stored } }
            init(_ inner: SyncTestHost, _ marks: SyncMarkKeeper) { self.inner = inner; self.marks = marks }
            func currentState() async -> BrowserState { await inner.currentState() }
            func lockedSpaceIDs() async -> Set<String> { await inner.lockedSpaceIDs() }
            func isAppLocked() async -> Bool { await inner.isAppLocked() }
            func isNeverModified() async -> Bool { await inner.isNeverModified() }
            func apply(_ patch: SyncPatch) async -> SyncApply.Outcome {
                let outcome = await inner.apply(patch)
                marks.observe(outcome.state, now: SyncStateFixtures.now + 9_000)
                lock.withLock { stored = marks.currentBook }
                return outcome
            }
            func exchanged(_ summary: SyncExchangeSummary) async { await inner.exchanged(summary) }
            func restore(_ change: SyncChange) async -> Bool { await inner.restore(change) }
        }
        let watching = Watching(rig.host, rig.marks)
        let body = SyncExchangeBody(host: watching, marks: rig.marks, bases: rig.bases, now: { self.now }, idleTimeout: .seconds(2))
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let mac = SyncTestMac(snapshot: macSnapshot())
        let task = Task { try await mac.run(fake) }
        defer { task.cancel() }
        _ = try await SyncSessionClient.run(connection: SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint), peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0",
                                            supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16), baseHash: nil, now: { self.now }, body: body, handshakeTimeout: .seconds(2))
        seenDuringTheWrite = watching.book
        #expect(seenDuringTheWrite?.stamps(of: "space", id: "m1").isEmpty == true, "nothing was marked while the session wrote")
        #expect(rig.marks.currentBook.stamps(of: "space", id: "m1").values.allSatisfy { $0.hasSuffix("vector-mac-0000000001") }, "and what the merge decided is the Mac's")
    }

    // MARK: What is not sent, what is not taken

    @Test func anEntityThePhoneWouldNotSendStaysAndIsCounted() async throws {
        var state = try SyncStateFixtures.sample()
        var script = TabItem(id: "script", spaceId: "s1", url: "https://ok.example/", title: "Script", pinned: true)
        script.anchorUrl = "javascript:alert(1)"
        state.tabs.append(script)
        let rig = try rig(state: state)
        defer { rig.cleanup() }
        let (_, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(seen.phone.entities["tab"]?.keys.contains("script") == false)
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.refusedSent == [SyncInbound.Refused(kind: "tab", id: "script", reason: .invalidURL)])
        #expect(await rig.host.state.tabs.contains { $0.id == "script" }, "it stays where it is, untouched")
    }

    @Test func anEntityThatCannotBeReadByTheMacIsLeftOutSoThatItDoesNotEndEverySession() async throws {
        var state = try SyncStateFixtures.sample()
        // A field name that is not in normalization form C: the Mac's reader would refuse the whole snapshot.
        state.spaces[1].rest["e\u{301}clair"] = .bool(true)
        let rig = try rig(state: state)
        defer { rig.cleanup() }
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(report?.outcome == .committed(at: now))
        #expect(seen.phone.entities["space"]?.keys.contains("s2") == false)
        #expect(seen.phone.entities["space"]?.keys.contains("s1") == true)
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.refusedSent.map(\.id) == ["s2"])
    }

    @Test func aNameThatAJavaScriptObjectAnswersToIsLeftOutSoThatTheMacDoesNotRefuseTheWholeSnapshot() async throws {
        var state = try SyncStateFixtures.sample()
        state.favorites.append(Favorite(id: "constructor", url: "https://odd.example/", title: "Odd", profileId: "default"))
        state.folders.append(Folder(id: "__proto__", spaceId: "s1", name: "Proto"))
        let rig = try rig(state: state)
        defer { rig.cleanup() }
        await rig.host.set(locked: ["toString"])
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(report?.outcome == .committed(at: now))
        #expect(seen.phone.entities["favorite"]?.keys.contains("constructor") == false && seen.phone.entities["folder"]?.keys.contains("__proto__") == false)
        #expect(seen.phone.order.values.allSatisfy { !$0.contains("constructor") && !$0.contains("__proto__") }, "and not in a list")
        #expect(seen.phoneWithheld.isEmpty || !seen.phoneWithheld.contains("toString"))
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.refusedSent.map(\.id).sorted() == ["__proto__", "constructor"])
        #expect(await rig.host.state.favorites.contains { $0.id == "constructor" }, "it stays on the phone, untouched")
    }

    @Test func everyNameAJavaScriptObjectAnswersToIsLeftOutOfWhatThePhoneSendsWhereverItStands() {
        #expect(SyncSnapshot.namesOfAnObject.count == 13 && SyncSnapshot.namesOfAnObject.contains("prototype") && SyncSnapshot.namesOfAnObject.contains("valueOf"))
        for name in SyncSnapshot.namesOfAnObject.sorted() {
            let entity = SyncEntity(fields: ["name": .string("x")], stamps: ["name": "0"])
            var snapshot = SyncSnapshot()
            snapshot.entities = ["space": [name: entity, "ok": entity], name: ["id": entity]]
            snapshot.tombstones = ["tab": [name: "0", "gone": "0"], name: ["id": "0"]]
            snapshot.order = ["spaces": [name, "ok"], name: ["ok"], "tabs:s:-": ["ok"]]
            snapshot.orderStamps = ["spaces": "0", name: "0", "tabs:s:-": "0"]
            let vetted = SyncExchangeBody.vet(snapshot, log: { _ in })
            #expect(vetted.snapshot.entities == ["space": ["ok": entity]], "\(name): in an id or a kind of an entity")
            #expect(vetted.snapshot.tombstones == ["tab": ["gone": "0"]], "\(name): in a tombstone")
            #expect(vetted.snapshot.order == ["tabs:s:-": ["ok"]] && vetted.snapshot.orderStamps == ["tabs:s:-": "0"], "\(name): as a list or in a list")
            #expect(Set(vetted.refused.map(\.id)) == [name, "id"], "\(name): the entities are counted")
        }
    }

    @Test func anOddNameAndAnEntityThatDoesNotReadAreBothCountedWhenTheSnapshotIsCutEntityByEntity() {
        let entity = SyncEntity(fields: ["name": .string("x")], stamps: ["name": "0"])
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["constructor": entity, "ok": entity, "bad": SyncEntity(fields: ["e\u{301}": .bool(true)], stamps: [:])]]
        let vetted = SyncExchangeBody.vet(snapshot, log: { _ in })
        #expect(vetted.snapshot.entities == ["space": ["ok": entity]])
        #expect(vetted.refused.map(\.id) == ["bad", "constructor"], "both were left out, and both are counted")
    }

    @Test func aLockedSpaceWithAnOddNameIsNotNamedAmongThoseSetAside() async throws {
        var state = try SyncStateFixtures.sample()
        state.spaces.append(Space(id: "valueOf", name: "Odd", emoji: "🎲", profileId: "default"))
        let rig = try rig(state: state)
        defer { rig.cleanup() }
        await rig.host.set(locked: ["valueOf", "s2"])
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()))
        #expect(report?.outcome == .committed(at: now))
        #expect(seen.phoneWithheld == ["s2"], "a name the Mac would refuse is not in the list, and the session still goes through")
    }

    @Test func anEntityOfCodeThatAMacSendsIsRefusedAndTheSessionDoesNotGoThrough() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let before = await rig.host.state
        var mac = SyncTestMac(snapshot: macSnapshot())
        // A real Mac never sends one; a hostile one that does is refused here, and its own result then differs from this one: nothing is written.
        mac.snapshot.entities["boost"] = ["b1": macEntity(["css": .string("body{display:none}")])]
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let macRun = mac
        let task = Task { try await SyncTestMacHostile(base: macRun).run(fake) }
        defer { task.cancel() }
        await #expect(throws: SyncFailure.self) {
            _ = try await SyncSessionClient.run(connection: SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint), peer: peer, device: phone, categories: [.structure], appVersion: "0.1.0",
                                                supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16), baseHash: nil, now: { self.now }, body: rig.body, handshakeTimeout: .seconds(2))
        }
        #expect(await rig.host.state == before)
        #expect(rig.bases.get(peerId: peer.id, now: now) == nil)
    }

    // MARK: The open tabs

    @Test func theOpenTabsOfTheMacAreHeldAndThoseOfThePhoneAreSentWhenTheCategoryIsCommon() async throws {
        var state = try SyncStateFixtures.sample()
        var web = TabItem(id: "w1", spaceId: "s1", url: "https://reading.example/article", title: "À lire")
        web.lastActiveAt = 5
        state.tabs.append(web)
        let rig = try rig(state: state)
        defer { rig.cleanup() }
        var mac = SyncTestMac(snapshot: macSnapshot(), categories: ["structure", "openTabs"])
        mac.openTabs = [SyncOpenTab(id: "mt-open", spaceId: "m1", url: "https://mac-reading.example/", title: "Sur le Mac", lastActiveAt: 7)]
        let (_, seen) = try await session(rig, mac: mac, categories: [.structure, .openTabs])
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.openTabs == mac.openTabs)
        let sent = try #require(seen.phoneOpenTabs)
        #expect(sent.compactMap { $0["id"] as? String }.sorted() == ["t1", "t2", "today", "w1"], "every open web page, pinned or not; never the private one")
        #expect(!(await rig.host.state.tabs.contains { $0.id == "mt-open" }), "an announced tab is never written into the state")
    }

    @Test func aListOfOpenTabsThePhoneDidNotAskForIsIgnoredAndOnlyWebPagesAreKept() async throws {
        let withoutIt = try rig()
        defer { withoutIt.cleanup() }
        var mac = SyncTestMac(snapshot: macSnapshot(), categories: ["structure", "openTabs"])
        mac.openTabs = [SyncOpenTab(id: "x", spaceId: "m1", url: "https://reading.example/", title: "Lu", lastActiveAt: 7), SyncOpenTab(id: "y", spaceId: "m1", url: "file:///etc/passwd", title: "Fichier", lastActiveAt: 8)]
        // The phone did not tick « Open tabs »: a list that comes anyway is not kept.
        _ = try await session(withoutIt, mac: mac, categories: [.structure])
        #expect(try #require(await withoutIt.host.summaries.first).openTabs == nil)
        // It did: only the web pages of the list are kept.
        let withIt = try rig()
        defer { withIt.cleanup() }
        _ = try await session(withIt, mac: mac, categories: [.structure, .openTabs])
        #expect(try #require(await withIt.host.summaries.first).openTabs?.map(\.id) == ["x"], "an address that is not a web page is left out")
    }

    @Test func anOpenTabWithAnIdentifierLongerThanTheMacKeepsIsLeftOut() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        var mac = SyncTestMac(snapshot: macSnapshot(), categories: ["structure", "openTabs"])
        mac.openTabs = [SyncOpenTab(id: "ok", spaceId: "m1", url: "https://reading.example/", title: "Lu", lastActiveAt: 7), SyncOpenTab(id: String(repeating: "i", count: 129), spaceId: "m1", url: "https://long-id.example/", title: "Long", lastActiveAt: 8),
                        SyncOpenTab(id: "long-space", spaceId: String(repeating: "s", count: 129), url: "https://long-space.example/", title: "Long", lastActiveAt: 9), SyncOpenTab(id: String(repeating: "i", count: 128), spaceId: "m1", url: "https://edge.example/", title: "Edge", lastActiveAt: 10)]
        _ = try await session(rig, mac: mac, categories: [.structure, .openTabs])
        #expect(try #require(await rig.host.summaries.first).openTabs?.map(\.url) == ["https://reading.example/", "https://edge.example/"], "128 characters is kept, 129 is not")
    }

    @Test func theOpenTabsAreNotSentWhenTheMacDidNotTickTheCategory() async throws {
        let rig = try rig()
        defer { rig.cleanup() }
        let (_, seen) = try await session(rig, mac: SyncTestMac(snapshot: macSnapshot()), categories: [.structure, .openTabs])
        #expect(seen.phoneOpenTabs == nil)
        #expect(try #require(await rig.host.summaries.first).openTabs == nil)
    }

    // MARK: The first real trial (19 November 2026, card 494)

    /// The phone of the first real trial: the three spaces of a first launch, each with a profile of its own, a day old.
    private func phoneOfTheTrial() -> BrowserState {
        func space(_ id: String, _ name: String, _ emoji: String, hue: Double) -> Space { Space(id: id, name: name, emoji: emoji, profileId: id, rest: ["theme": SpaceTheme.make(hue: hue)]) }
        return BrowserState(revision: 2, spaces: [space("work", "Travail", "💼", hue: 250), space("home", "Maison", "🏠", hue: 30), space("projects", "Projets", "🧩", hue: 175)],
                            activeSpaceId: "work", activeTabBySpace: ["work": nil, "home": nil, "projects": nil])
    }

    /// The Mac of the trial, new: its three default spaces, and « Perso », which the person made there.
    private func macOfTheTrial() -> SyncSnapshot {
        func space(_ id: String, _ name: String, _ emoji: String, _ profile: String, hue: Double) -> SyncEntity {
            macEntity(["name": .string(name), "emoji": .string(emoji), "profileId": .string(profile), "theme": SpaceTheme.make(hue: hue)])
        }
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["home": space("home", "Maison", "🏠", "home", hue: 30), "work": space("work", "Travail", "💼", "work", hue: 250), "projects": space("projects", "Projets", "🧩", "projects", hue: 175),
                                       "a5217766-0743-4472-b55f-c623fecfe910": space("a5217766-0743-4472-b55f-c623fecfe910", "Perso", "🏠", "default", hue: 250)]]
        snapshot.order = ["spaces": ["home", "work", "projects", "a5217766-0743-4472-b55f-c623fecfe910"]]
        snapshot.orderStamps = ["spaces": macStamp(12)]
        return snapshot
    }

    @Test func aSpaceMadeOnANewMacReachesAPhoneThatHadTheDefaultSpacesBefore() async throws {
        let rig = try rig(state: phoneOfTheTrial())
        defer { rig.cleanup() }
        // The phone saw its own state a day before the Mac was even installed (the marks are older than the Mac's).
        rig.marks.observe(await rig.host.state, now: now - 43_000_000)
        let (report, seen) = try await session(rig, mac: SyncTestMac(snapshot: macOfTheTrial()))
        #expect(report?.outcome == .committed(at: now))
        #expect(seen.phoneResult == seen.merged?.snapshot.digest && seen.phoneCommit == seen.merged?.snapshot.digest)
        let state = await rig.host.state
        #expect(Set(state.spaces.map(\.id)) == ["home", "work", "projects", "a5217766-0743-4472-b55f-c623fecfe910"], "the phone shows the four spaces of the Mac")
        #expect(state.spaces.first { $0.id == "a5217766-0743-4472-b55f-c623fecfe910" }?.name == "Perso")
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.applied && summary.rejectedByApply.isEmpty && summary.refusedReceived.isEmpty && summary.refusedSent.isEmpty)
        #expect(summary.categories == [.structure] && summary.taken >= 1, "the summary says what crossed and how much the phone took")
    }

    /// What the person of the first trial could not see: the phone ticked more than the Mac did, so only the structure crossed, and nothing on the page said so.
    @Test func theSummaryNamesTheCategoriesThatCrossedAndTheOnesThePhoneTickedAlone() async throws {
        let rig = try rig(state: phoneOfTheTrial())
        defer { rig.cleanup() }
        rig.marks.observe(await rig.host.state, now: now - 43_000_000)
        let ticked: [SyncCategory] = [.structure, .settings, .archive]
        _ = try await session(rig, mac: SyncTestMac(snapshot: macOfTheTrial()), categories: ticked)
        let summary = try #require(await rig.host.summaries.first)
        #expect(summary.categories == [.structure], "the Mac ticked the structure only")
        #expect(SyncLastExchange.lines(of: summary, ticked: ticked) == [.exchanged([.structure]), .notExchanged([.settings, .archive]), .received(summary.taken)])
    }

    @Test func theCountOfWhatThePhoneTookAddsTheSettingsAndTheRemovalsToTheEntitiesMade() async throws {
        let rig = try rig(state: phoneOfTheTrial())
        defer { rig.cleanup() }
        rig.marks.observe(await rig.host.state, now: now - 43_000_000)
        var snapshot = macOfTheTrial()
        snapshot.entities["setting"] = ["httpsUpgrade": macEntity(["value": .bool(true)])]
        var mac = SyncTestMac(snapshot: snapshot, categories: ["structure", "settings"])
        _ = try await session(rig, mac: mac, categories: [.structure, .settings])
        let first = try #require(await rig.host.patches.first)
        #expect(first.settings.count == 1)
        #expect(try #require(await rig.host.summaries.first).taken == first.upserts.count + first.removals.count + 1, "the setting counts with the entities")
        // Then the Mac removes « Perso »: the removal counts too.
        let merged = SyncStateView.base(of: try #require(await rig.bases.get(peerId: peer.id, now: now)).snapshot)
        var after = merged
        after.entities["space"]?["a5217766-0743-4472-b55f-c623fecfe910"] = nil
        after.order["spaces"] = after.order["spaces"]?.filter { $0 != "a5217766-0743-4472-b55f-c623fecfe910" }
        after.orderStamps["spaces"] = macStamp(40)
        after.tombstones["space"] = ["a5217766-0743-4472-b55f-c623fecfe910": macStamp(41)]
        mac = SyncTestMac(snapshot: after, base: merged, categories: ["structure", "settings"])
        _ = try await session(rig, mac: mac, categories: [.structure, .settings])
        let second = try #require(await rig.host.patches.last)
        #expect(second.removals.count == 1)
        #expect(try #require(await rig.host.summaries.last).taken == second.upserts.count + 1 + second.settings.count)
    }

    @Test func aSecondSessionWithNothingNewSaysSoInsteadOfLeavingTheLineEmpty() async throws {
        let rig = try rig(state: phoneOfTheTrial())
        defer { rig.cleanup() }
        rig.marks.observe(await rig.host.state, now: now - 43_000_000)
        let first = try await session(rig, mac: SyncTestMac(snapshot: macOfTheTrial()))
        let merged = try #require(first.1.merged).snapshot
        _ = try await session(rig, mac: SyncTestMac(snapshot: SyncStateView.base(of: merged), base: SyncStateView.base(of: merged)))
        let summary = try #require(await rig.host.summaries.last)
        #expect(summary.taken == 0 && !summary.applied)
        #expect(SyncLastExchange.lines(of: summary, ticked: [.structure]) == [.exchanged([.structure]), .nothingNew])
    }
}

/// A Mac that sends what it is given without cleaning it: the way a hostile one would.
struct SyncTestMacHostile: Sendable {
    let base: SyncTestMac

    func run(_ mac: SyncFakeMac) async throws {
        let snapshot = base.snapshot
        try await mac.write("hello", ["device": ["id": "vector-mac-0000000001", "name": "MacBook de test", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": ["structure"],
                                      "baseHash": NSNull(), "stateVersion": 1, "appVersion": "1.2.0", "now": SyncStateFixtures.now, "hosts": ["mac-de-test.local"]])
        _ = try await mac.read()
        for part in SyncSnapshotParts.parts(of: snapshot, withheld: []) { try await mac.write("snapshot.part", try SyncTestMac.jsonObject(.object(part)) as? [String: Any] ?? [:]) }
        try await mac.write("snapshot.end", ["entityCount": snapshot.entities.values.reduce(0) { $0 + $1.count }, "digest": snapshot.digest])
        var assembler = SyncSnapshotParts.Assembler()
        while true {
            let message = try await mac.read()
            switch message.fields["t"] as? String {
            case "snapshot.part": try assembler.add(try SyncTestMac.value(message.fields))
            case "snapshot.end":
                let received = try assembler.finish(entityCount: message.fields["entityCount"] as? Int ?? -1, digest: message.fields["digest"] as? String ?? "")
                // The hostile Mac merges what it sent (the boost included) with what it got.
                let merged = SyncMerge.merge(base: nil, local: snapshot, remote: received.snapshot, withheld: [])
                try await mac.write("result", ["digest": merged.snapshot.digest])
                _ = try? await mac.read()
                return
            default: break
            }
        }
    }
}
