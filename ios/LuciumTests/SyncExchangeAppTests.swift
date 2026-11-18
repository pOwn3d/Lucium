import LuciumKit
import UIKit
import XCTest
@testable import Lucium

/// The exchange of the data in the application (docs/synchronisation.md §8.5, §9.2, §11.7.3, §12): the model writes a session's patch and takes the marks as it writes
/// the state, the controller runs the body and keeps the journal of the conflicts, and « À jour » is said after a real exchange. The merge and the body themselves are
/// proved in LuciumKit; the Mac here is a script that merges with the same Swift code.
@MainActor
final class SyncExchangeAppTests: BrowserCoreTestCase {
    private var store: TestIdentityStore!
    private let macFingerprint = Data((0..<32).map { UInt8(255 - $0) })
    private let now = 1_790_000_000_000

    override func setUp() async throws {
        try await super.setUp()
        store = TestIdentityStore()
    }

    override func tearDown() async throws {
        store.cleanUp()
        try await super.tearDown()
    }

    private var syncFile: SyncSettingsFile { SyncSettingsFile(url: directory.appending(path: SyncSettingsFile.fileName)) }

    /// A phone that is paired with the scripted Mac, with the synchronisation on, and a model that has been modified (so that it adds to the Mac's state, not adopts it).
    private func pairedModel(connector: ScriptedConnector, enabled: Bool = true, modified: Bool = true) async throws -> (BrowserModel, SyncController) {
        _ = try store.loadOrCreate()
        let mac = SyncPairedMac(id: "mac-test-0000000001", name: "Mac de test", fingerprintHex: SyncEncoding.hex(macFingerprint), port: 49213, hosts: ["mac-de-test.local"], pairedAt: 1_789_000_000_000)
        try syncFile.save(SyncSettings(enabled: enabled, categories: [.structure], deviceId: "phone-test-000000001", mac: mac))
        let model = await makeModel()
        if modified {
            // The launch wrote the origin of a first run (never modified): a phone that was used before has no such file, so the keeper is made again over none.
            let origin = directory.appending(path: SyncOriginFile.fileName)
            try FileManager.default.removeItem(at: origin)
            model.syncOrigin = SyncOriginKeeper(file: SyncOriginFile(url: origin), stateWasFound: true, state: model.state)
        }
        let controller = SyncController(file: syncFile, identityStore: store, makeConnector: { _ in connector }, exchangeHost: SyncModelHost(model: model), deviceName: "iPhone de test",
                                        appVersion: "0.1.0", now: { 1_790_000_000_000 }, isAppLocked: { false })
        model.sync = controller
        return (model, controller)
    }

    nonisolated private static func json(_ value: JSONValue) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed]) }

    nonisolated private static func macStamp(_ counter: Int = 0) -> String { String(format: "%013ld-%04lx-mac-test-0000000001", 1_790_000_000_000 - 50_000, counter) }

    /// What the Mac holds: one space of its own with a folder in it.
    nonisolated private static func macSnapshot() -> SyncSnapshot {
        func entity(_ fields: [String: JSONValue]) -> SyncEntity { SyncEntity(fields: fields, stamps: Dictionary(uniqueKeysWithValues: fields.keys.map { ($0, Self.macStamp()) })) }
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["m1": entity(["name": .string("Du Mac"), "emoji": .string("🍎"), "profileId": .string("default"), "theme": SpaceTheme.make(hue: 130)])],
                             "folder": ["mf": entity(["spaceId": .string("m1"), "name": .string("Dossier du Mac"), "collapsed": .bool(false)])]]
        snapshot.order = ["spaces": ["m1"], "folders:m1:-": ["mf"]]
        snapshot.orderStamps = ["spaces": Self.macStamp(1), "folders:m1:-": Self.macStamp(1)]
        return snapshot
    }

    /// The Mac side of one session: hello, its snapshot, the phone's, the merge, the two digests, the two commits.
    private func macScript(snapshot: SyncSnapshot, base: SyncSnapshot? = nil, onPhoneBaseHash: (@Sendable (String?) -> Void)? = nil, onMerged: (@Sendable (SyncMergeResult) -> Void)? = nil) -> ScriptedConnector.Answer {
        .connect(fingerprint: macFingerprint, mac: { mac in
            try await mac.write("hello", ["device": ["id": "mac-test-0000000001", "name": "Mac de test", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": ["structure"],
                                          "baseHash": base?.digest ?? NSNull(), "stateVersion": 1, "appVersion": "1.2.0", "now": 1_790_000_000_000, "hosts": ["mac-de-test.local"]])
            let theirHello = try await mac.read()
            onPhoneBaseHash?(theirHello["baseHash"] as? String)
            let parts = SyncSnapshotParts.parts(of: snapshot, withheld: [])
            for part in parts { try await mac.write("snapshot.part", try Self.json(.object(part)) as? [String: Any] ?? [:]) }
            try await mac.write("snapshot.end", ["entityCount": snapshot.entities.values.reduce(0) { $0 + $1.count }, "digest": snapshot.digest])
            var assembler = SyncSnapshotParts.Assembler()
            while true {
                let message = try await mac.read()
                switch message["t"] as? String {
                case "snapshot.part": try assembler.add(try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: message)))
                case "snapshot.end":
                    let received = try assembler.finish(entityCount: message["entityCount"] as? Int ?? -1, digest: message["digest"] as? String ?? "")
                    let usable = (base != nil && theirHello["baseHash"] as? String == base?.digest) ? base : nil
                    let merged = SyncMerge.merge(base: usable, local: snapshot, remote: SyncInbound.clean(received.snapshot, now: 1_790_000_000_000).snapshot, withheld: Array(received.withheld))
                    onMerged?(merged)
                    try await mac.write("result", ["digest": merged.snapshot.digest])
                    _ = try await mac.read()
                    try await mac.write("commit", ["digest": merged.snapshot.digest])
                    _ = try await mac.read()
                    return
                default: break
                }
            }
        })
    }

    // MARK: « À jour »

    func testARealExchangeMergesTheTwoStatesAndThePageSaysUpToDate() async throws {
        let connector = ScriptedConnector(macScript(snapshot: Self.macSnapshot()))
        let (model, controller) = try await pairedModel(connector: connector, enabled: true)
        let before = model.state.spaces.map(\.id)
        controller.launched()
        try await eventually("the page says up to date", { if case .upToDate = controller.status { true } else { false } })
        XCTAssertEqual(Set(model.state.spaces.map(\.id)), Set(before + ["m1"]), "the Mac's space came, the phone's own stayed")
        XCTAssertTrue(model.state.folders.contains { $0.id == "mf" && $0.spaceId == "m1" })
        // Written now, not 500 ms from now: the Mac was told `commit` when it was.
        var file = StateFile(url: directory.appending(path: StateFile.fileName))
        guard case .loaded(let onDisk) = file.load() else { return XCTFail("the state was not written") }
        XCTAssertTrue(onDisk.spaces.contains { $0.id == "m1" })
        XCTAssertNotNil(SyncBaseStore(directory: directory).get(peerId: "mac-test-0000000001", now: now), "the base of this Mac is kept")
        let book = SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)).load(device: "phone-test-000000001")
        guard case .loaded(let marks) = book else { return XCTFail("the marks were not kept") }
        XCTAssertTrue(marks.stamps(of: "space", id: "m1").values.allSatisfy { $0.hasSuffix("-mac-test-0000000001") }, "what the Mac wrote is not marked as the phone's own change")
        XCTAssertTrue(controller.lastConflicts.isEmpty)
    }

    final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [String?] = []
        var hashes: [String?] { lock.withLock { stored } }
        func add(_ hash: String?) { lock.withLock { stored.append(hash) } }
    }

    func testASecondSessionSaysWhichBaseTheFirstOneLeft() async throws {
        let said = Recorder()
        let connector = ScriptedConnector(macScript(snapshot: Self.macSnapshot(), onPhoneBaseHash: { said.add($0) }))
        let (model, controller) = try await pairedModel(connector: connector)
        controller.launched()
        try await eventually("the first session is up to date", { if case .upToDate = controller.status { true } else { false } })
        let base = try XCTUnwrap(SyncBaseStore(directory: directory).get(peerId: "mac-test-0000000001", now: now))
        connector.set(macScript(snapshot: SyncStateView.base(of: Self.macSnapshot()), base: base.snapshot, onPhoneBaseHash: { said.add($0) }))
        controller.requestSession(.manual)
        // The clock of the test does not move: the second session is seen by the hello it sent and by the page being up to date again.
        try await eventually("a second session", { said.hashes.count == 2 && { if case .upToDate = controller.status { true } else { false } }() })
        XCTAssertEqual(said.hashes.count, 2)
        XCTAssertNil(said.hashes[0] ?? nil, "no base before the first session")
        XCTAssertEqual(said.hashes[1], base.hash, "the hash of the base the first session kept is what the next hello says (§8.2)")
        _ = model
    }

    func testThePageSaysWhatLeavesTheDeviceOnlyWhenTheSynchronisationIsOnWithAMac() async throws {
        let (_, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        XCTAssertTrue(controller.isSynchronizing)
        XCTAssertTrue(controller.setEnabled(false))
        XCTAssertFalse(controller.isSynchronizing, "off: nothing leaves, the plain sentence")
        let again = SyncController(file: SyncSettingsFile(url: directory.appending(path: "other-sync.json")), identityStore: store, makeConnector: { _ in ScriptedConnector(.fail(.timedOut)) })
        XCTAssertTrue(again.setEnabled(true))
        XCTAssertFalse(again.isSynchronizing, "on with no Mac paired: nothing can leave yet")
    }

    func testAPhoneNeverModifiedAdoptsTheStateOfTheMac() async throws {
        let connector = ScriptedConnector(macScript(snapshot: Self.macSnapshot()))
        let (model, controller) = try await pairedModel(connector: connector, modified: false)
        XCTAssertTrue(try XCTUnwrap(model.syncOrigin).origin.untouched, "a first launch")
        controller.launched()
        try await eventually("up to date", { if case .upToDate = controller.status { true } else { false } })
        XCTAssertEqual(model.state.spaces.map(\.id), ["m1"], "its own spaces were replaced by the Mac's")
        XCTAssertFalse(try XCTUnwrap(model.syncOrigin).origin.untouched, "and the phone is a modified one from then on")
        XCTAssertNotNil(model.activeTab, "a space always shows a tab")
        XCTAssertEqual(model.state.activeSpaceId, "m1")
    }

    func testASessionThatFindsTheTwoResultsDifferentWritesNothingAndSaysSo() async throws {
        let divergentSnapshot = Self.macSnapshot()
        let connector = ScriptedConnector(.connect(fingerprint: macFingerprint, mac: { mac in
            try await mac.write("hello", ["device": ["id": "mac-test-0000000001", "name": "Mac de test", "platform": "mac"], "nonce": SyncEncoding.base64url(Data(repeating: 3, count: 16)), "categories": ["structure"],
                                          "baseHash": NSNull(), "stateVersion": 1, "appVersion": "1.2.0", "now": 1_790_000_000_000, "hosts": ["mac-de-test.local"]])
            _ = try await mac.read()
            let snapshot = divergentSnapshot
            for part in SyncSnapshotParts.parts(of: snapshot, withheld: []) { try await mac.write("snapshot.part", try Self.json(.object(part)) as? [String: Any] ?? [:]) }
            try await mac.write("snapshot.end", ["entityCount": 2, "digest": snapshot.digest])
            while (try await mac.read())["t"] as? String != "snapshot.end" {}
            try await mac.write("result", ["digest": String(repeating: "a", count: 64)])
            _ = try? await mac.read()
        }))
        let (model, controller) = try await pairedModel(connector: connector)
        let before = model.state
        controller.launched()
        try await eventually("the page says the two do not agree", { controller.status == .failed(.divergence) })
        XCTAssertEqual(model.state, before)
        XCTAssertNil(SyncBaseStore(directory: directory).get(peerId: "mac-test-0000000001", now: now))
    }

    // MARK: The model writes a patch

    private func patch(_ build: (inout SyncPatch) -> Void) -> SyncPatch {
        var patch = SyncPatch()
        build(&patch)
        return patch
    }

    func testAPatchThatRemovesTheSpaceOnScreenTakesItsTabsAndTheScreenFollows() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let gone = model.state.activeSpaceId
        let goneTabs = model.state.tabs(in: gone).map(\.id)
        for id in goneTabs {
            try model.sideStore?.write(Data("page state".utf8), kind: .interaction, for: id)
            try model.sideStore?.write(Data("picture".utf8), kind: .thumbnail, for: id)
            model.thumbnailCache[id] = UIImage()
        }
        XCTAssertNotNil(model.webViews[try XCTUnwrap(goneTabs.first)], "its page is awake")
        let name = try XCTUnwrap(model.state.spaces.first { $0.id == gone }?.name)
        let outcome = model.applySyncPatch(patch { $0.removals = [SyncPatch.Removal(kind: .space, id: gone, expect: ["name": .string(name)])] })
        XCTAssertEqual(outcome.removedSpaceIDs, [gone])
        XCTAssertFalse(model.state.spaces.contains { $0.id == gone })
        XCTAssertTrue(goneTabs.allSatisfy { model.webViews[$0] == nil }, "no web view is left for a tab that no longer exists")
        XCTAssertNotEqual(model.state.activeSpaceId, gone)
        XCTAssertNotNil(model.activeTab, "the space that shows now shows a tab")
        XCTAssertNotNil(model.webViews[try XCTUnwrap(model.activeTab).id], "and its page is awake")
        XCTAssertTrue(goneTabs.allSatisfy { id in !model.state.tabs.contains { $0.id == id } })
        XCTAssertTrue(goneTabs.allSatisfy { model.sideStore?.read(.interaction, for: $0) == nil && model.sideStore?.read(.thumbnail, for: $0) == nil }, "their page states and pictures went too")
        XCTAssertTrue(goneTabs.allSatisfy { model.thumbnailCache[$0] == nil })
        var file = StateFile(url: directory.appending(path: StateFile.fileName))
        guard case .loaded(let onDisk) = file.load() else { return XCTFail("not written") }
        XCTAssertEqual(onDisk.spaces.map(\.id), model.state.spaces.map(\.id), "kept at once")
    }

    func testAPatchKeepsWhatThePersonChangedSinceTheFreeze() async throws {
        let model = await makeModel()
        let space = try XCTUnwrap(model.state.spaces.first)
        _ = model.updateSpace(space.id, name: "Renommé ici", emoji: space.emoji, hue: nil)
        let outcome = model.applySyncPatch(patch { $0.upserts = [SyncPatch.Upsert(kind: .space, id: space.id, create: false, fields: ["name": .string("Renommé là-bas")], remove: [], expect: ["name": .string(space.name)])] })
        XCTAssertEqual(model.state.spaces.first?.name, "Renommé ici")
        XCTAssertFalse(outcome.changed)
    }

    func testWhatAPatchWritesIsNotMarkedAsAChangeOfThePhoneButWhatThePersonDoesAfterIs() async throws {
        let (model, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        controller.stateWritten(model.state)  // the book starts from the state as it is
        let marksFile = SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName))
        let fields: [String: JSONValue] = ["name": .string("Du Mac"), "emoji": .string("🍎"), "profileId": .string("default")]
        model.applySyncPatch(patch { $0.upserts = [SyncPatch.Upsert(kind: .space, id: "m1", create: true, fields: fields, remove: [], expect: [:])] })
        XCTAssertTrue(model.state.spaces.contains { $0.id == "m1" })
        guard case .loaded(let during) = marksFile.load(device: "phone-test-000000001") else { return XCTFail("no book") }
        XCTAssertTrue(during.stamps(of: "space", id: "m1").isEmpty, "the book did not look at the state while the session wrote")
        model.flush()  // the next write of the state: the person's own gestures are marked now
        guard case .loaded(let after) = marksFile.load(device: "phone-test-000000001") else { return XCTFail("no book") }
        XCTAssertFalse(after.stamps(of: "space", id: "m1").isEmpty, "what nobody adopted is taken as the phone's at the next write")
    }

    func testTheMarksAreTakenAsTheStateIsWrittenAndOnlyWhileTheSwitchIsOn() async throws {
        let (model, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)), enabled: false)
        let marksURL = directory.appending(path: SyncMarksFile.fileName)
        model.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: marksURL.path), "off: no book, nothing runs")
        XCTAssertTrue(controller.setEnabled(true))
        try await eventually("the state as it is is marked when the switch is turned on", { FileManager.default.fileExists(atPath: marksURL.path) })
        let space = try XCTUnwrap(model.state.spaces.first)
        _ = model.updateSpace(space.id, name: "Autre nom", emoji: space.emoji, hue: nil)
        model.flush()
        guard case .loaded(let book) = SyncMarksFile(url: marksURL).load(device: "phone-test-000000001") else { return XCTFail("no book") }
        XCTAssertNotNil(book.stamps(of: "space", id: space.id)["name"], "the gesture is marked when the state is written")
        controller.setEnabled(false)
        let written = try Data(contentsOf: marksURL)
        _ = model.updateSpace(space.id, name: "Encore un autre", emoji: space.emoji, hue: nil)
        model.flush()
        XCTAssertEqual(try Data(contentsOf: marksURL), written, "off again: the book is not touched")
    }

    // MARK: The journal of the conflicts

    private func conflict(_ id: String = "s1") -> SettledConflict {
        SettledConflict(id: SyncConflicts.entryID(kind: "space", id: id, field: "name"), settledAt: now, peer: .mac, kind: "space", entityID: id, field: "name", reason: .newer, winner: .remote, label: "Travail",
                        kept: .text("Du Mac"), lost: .text("Ancien"), keptAt: now - 5000, lostAt: now - 9000, restore: .set(kind: "space", id: id, field: "name", value: .string("Ancien")))
    }

    private func summary(_ conflicts: [SettledConflict]) -> SyncExchangeSummary {
        SyncExchangeSummary(at: now, conflicts: conflicts, refusedSent: [], refusedReceived: [], rejectedByApply: [], applied: true, adoptedTheMacState: false, spacesSetAside: 0, openTabs: nil)
    }

    func testTheConflictsOfASessionGoToTheJournalAndSurviveARestart() async throws {
        let (model, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        XCTAssertTrue(controller.lastConflicts.isEmpty)
        let space = try XCTUnwrap(model.state.spaces.first)
        controller.exchangeDone(summary([conflict(space.id)]))
        XCTAssertEqual(controller.lastConflicts.map(\.entityID), [space.id])
        let journal = directory.appending(path: SyncJournalFile.fileName)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        let attributes = try FileManager.default.attributesOfItem(atPath: journal.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let again = SyncController(file: syncFile, identityStore: store, makeConnector: { _ in ScriptedConnector(.fail(.timedOut)) }, exchangeHost: SyncModelHost(model: model), now: { 1_790_000_000_000 })
        XCTAssertEqual(again.lastConflicts.map(\.entityID), [space.id], "read back from the file")
    }

    func testPuttingBackAVersionIsAnOrdinaryChangeAndTheLineGoes() async throws {
        let (model, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        let space = try XCTUnwrap(model.state.spaces.first)
        controller.exchangeDone(summary([conflict(space.id)]))
        let line = try XCTUnwrap(controller.lastConflicts.first)
        controller.restore(try XCTUnwrap(line.restore), lineID: line.id)
        try await eventually("the version that lost is back", { model.state.spaces.first?.name == "Ancien" && controller.lastConflicts.isEmpty })
        XCTAssertTrue(SyncJournalFile(url: directory.appending(path: SyncJournalFile.fileName)).load(now: now).entries.isEmpty, "the line is out of the file too")
    }

    func testAJournalOfANewerVersionIsNeverWrittenOver() async throws {
        let (model, _) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        let url = directory.appending(path: SyncJournalFile.fileName)
        let newer = #"{"v":2,"entries":[]}"#
        try Data(newer.utf8).write(to: url)
        let controller = SyncController(file: syncFile, identityStore: store, makeConnector: { _ in ScriptedConnector(.fail(.timedOut)) }, exchangeHost: SyncModelHost(model: model), now: { 1_790_000_000_000 })
        controller.exchangeDone(summary([conflict()]))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), newer)
        XCTAssertEqual(controller.lastConflicts.count, 1, "kept in memory for this run")
    }

    func testForgettingTheMacRemovesWhatWasKeptForIt() async throws {
        let (model, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        controller.stateWritten(model.state)
        controller.exchangeDone(summary([conflict(try XCTUnwrap(model.state.spaces.first).id)]))
        try SyncBaseStore(directory: directory).save(peerId: "mac-test-0000000001", snapshot: SyncSnapshot(), now: now)
        let files = [SyncJournalFile.fileName, SyncMarksFile.fileName, "sync-base-mac-test-0000000001.json"].map { directory.appending(path: $0) }
        XCTAssertTrue(files.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
        controller.forgetMac()
        XCTAssertTrue(files.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) }, "the base, the marks and the journal go with the Mac (§12)")
        XCTAssertTrue(controller.lastConflicts.isEmpty && controller.macOpenTabs.isEmpty)
    }

    func testTheOpenTabsOfTheMacAreKeptInMemoryOnly() async throws {
        let (_, controller) = try await pairedModel(connector: ScriptedConnector(.fail(.timedOut)))
        var withTabs = summary([])
        withTabs.openTabs = [SyncOpenTab(id: "t", spaceId: "s", url: "https://reading.example/", title: "Lu", lastActiveAt: 5)]
        controller.exchangeDone(withTabs)
        XCTAssertEqual(controller.macOpenTabs.map(\.url), ["https://reading.example/"])
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            let text = (try? String(contentsOf: directory.appending(path: name), encoding: .utf8)) ?? ""
            XCTAssertFalse(text.contains("reading.example"), "\(name) holds an address of the Mac's open tabs")
        }
        controller.exchangeDone(summary([]))
        XCTAssertTrue(controller.macOpenTabs.isEmpty, "a session where the category is not common leaves none")
    }
}
