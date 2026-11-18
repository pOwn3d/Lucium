import Foundation
import Testing
@testable import LuciumKit

/// A snapshot on the wire (§7.3, §8.3), the base of a Mac (§11.8) and the one way a session writes into the state (§8.5).
@Suite("Synchronisation: the parts of a snapshot")
struct SyncPartsTests {
    private func snapshot(entities count: Int, kind: String = "favorite", extra: String = "") -> SyncSnapshot {
        var snapshot = SyncSnapshot()
        for index in 0..<count {
            snapshot.entities[kind, default: [:]]["e\(index)"] = SyncEntity(fields: ["url": .string("https://e\(index).example/"), "title": .string("Entry \(index) \(extra)")], stamps: ["url": "1790000000000-0000-mac", "title": "1790000000001-0000-mac"])
        }
        return snapshot
    }

    private func assemble(_ parts: [[String: JSONValue]], of source: SyncSnapshot) throws -> SyncSnapshotParts.Assembled {
        var assembler = SyncSnapshotParts.Assembler()
        for part in parts { try assembler.add(.object(part)) }
        return try assembler.finish(entityCount: source.entities.values.reduce(0) { $0 + $1.count }, digest: source.digest)
    }

    @Test func aSnapshotIsCutInPartsOfAtMostFiveHundredEntitiesAndPutBackTogether() throws {
        var source = snapshot(entities: 1203)
        source.tombstones = ["tab": ["gone": "1790000000009-0000-mac"]]
        source.order = ["favorites:default": (0..<1203).map { "e\($0)" }]
        source.orderStamps = ["favorites:default": "1790000000010-0000-mac"]
        let parts = SyncSnapshotParts.parts(of: source, withheld: ["s9"])
        #expect(parts.count == 3)
        #expect(parts.allSatisfy { ($0["entities"]?.items.count ?? 0) <= SyncLimits.maxEntitiesPerPart })
        #expect(parts.enumerated().allSatisfy { $0.element["part"] == .number(Double($0.offset)) && $0.element["parts"] == .number(3) })
        #expect(parts[0]["withheld"] == .array([.string("s9")]), "the first part names the spaces set aside")
        #expect(parts[1]["withheld"] == nil)
        let assembled = try assemble(parts, of: source)
        #expect(assembled.snapshot == source)
        #expect(assembled.entityCount == 1203)
        #expect(assembled.withheld == ["s9"])
    }

    @Test func aPartThatWeighsTooMuchStartsTheNextOne() throws {
        let heavy = snapshot(entities: 40, extra: String(repeating: "x", count: 30_000))
        let parts = SyncSnapshotParts.parts(of: heavy, withheld: [])
        #expect(parts.count > 1)
        for part in parts {
            let bytes = SyncCanonical.text(.object(part))?.utf8.count ?? 0
            #expect(bytes < SyncLimits.maxFrameBytes, "a part fits a frame")
        }
        #expect(try assemble(parts, of: heavy).snapshot == heavy)
    }

    @Test func anEmptySnapshotIsOnePart() throws {
        let parts = SyncSnapshotParts.parts(of: .empty, withheld: [])
        #expect(parts.count == 1)
        #expect(parts[0]["entities"] == .array([]))
        #expect(parts[0]["tombstones"] == nil && parts[0]["order"] == nil)
        #expect(try assemble(parts, of: .empty).snapshot == .empty)
    }

    @Test func theSameSnapshotIsAlwaysCutTheSameWay() {
        let source = snapshot(entities: 700)
        #expect(SyncSnapshotParts.parts(of: source, withheld: []) == SyncSnapshotParts.parts(of: source, withheld: []))
    }

    @Test func theSameSnapshotIsCutTheSameWayWhateverTheOrderItWasBuiltIn() {
        var forward = SyncSnapshot(), backward = SyncSnapshot()
        let kinds = ["space", "folder", "tab", "favorite", "archived", "setting", "widget"]
        for kind in kinds { for index in 0..<30 { forward.entities[kind, default: [:]]["e\(index)"] = SyncEntity(fields: ["name": .string("\(kind)\(index)")], stamps: [:]) } }
        for kind in kinds.reversed() { for index in (0..<30).reversed() { backward.entities[kind, default: [:]]["e\(index)"] = SyncEntity(fields: ["name": .string("\(kind)\(index)")], stamps: [:]) } }
        for (kind, byID) in forward.entities { forward.tombstones[kind] = Dictionary(uniqueKeysWithValues: byID.keys.map { ($0, "0") }) }
        for kind in kinds.reversed() { backward.tombstones[kind] = forward.tombstones[kind] }
        for index in 0..<20 { forward.order["list\(index)"] = ["a"]; forward.orderStamps["list\(index)"] = "0" }
        for index in (0..<20).reversed() { backward.order["list\(index)"] = ["a"]; backward.orderStamps["list\(index)"] = "0" }
        #expect(forward == backward)
        #expect(SyncSnapshotParts.parts(of: forward, withheld: []) == SyncSnapshotParts.parts(of: backward, withheld: []), "a snapshot is always cut the same way")
    }

    @Test func aListWithNoMarkGetsTheMarkZeroOnTheWire() throws {
        var source = SyncSnapshot()
        source.order = ["spaces": []]
        let parts = SyncSnapshotParts.parts(of: source, withheld: [])
        #expect(parts[0]["orderStamps"] == .object(["spaces": .string("0")]))
    }

    // MARK: What is wrong with what comes in

    private func part(_ number: Int, of total: Int, _ entities: [JSONValue] = [], more: [String: JSONValue] = [:]) -> JSONValue {
        .object(["part": .number(Double(number)), "parts": .number(Double(total)), "entities": .array(entities)].merging(more) { _, new in new })
    }

    private func wire(_ kind: String, _ id: String) -> JSONValue {
        .object(["kind": .string(kind), "id": .string(id), "fields": .object(["name": .string(id)]), "stamps": .object(["name": .string("1790000000000-0000-mac")])])
    }

    @Test func partsOutOfOrderOrOfAnotherTotalAreRefused() {
        var assembler = SyncSnapshotParts.Assembler()
        #expect(throws: SyncFailure.self) { try assembler.add(part(1, of: 2)) }
        var next = SyncSnapshotParts.Assembler()
        #expect(throws: Never.self) { try next.add(part(0, of: 2)) }
        #expect(throws: SyncFailure.self) { try next.add(part(1, of: 3)) }
        var twice = SyncSnapshotParts.Assembler()
        #expect(throws: Never.self) { try twice.add(part(0, of: 2)) }
        #expect(throws: SyncFailure.self) { try twice.add(part(0, of: 2)) }
    }

    @Test func anEntityTwiceATombstoneTwiceAListTwiceAreBadMessages() throws {
        var entities = SyncSnapshotParts.Assembler()
        try entities.add(part(0, of: 2, [wire("space", "s1")]))
        #expect(throws: SyncFailure(.badMessage, "an entity is twice in a snapshot")) { try entities.add(part(1, of: 2, [wire("space", "s1")])) }
        let tomb: JSONValue = .array([.object(["kind": .string("tab"), "id": .string("t"), "stamp": .string("0")])])
        var tombstones = SyncSnapshotParts.Assembler()
        try tombstones.add(part(0, of: 2, more: ["tombstones": tomb]))
        #expect(throws: SyncFailure(.badMessage, "a tombstone is twice in a snapshot")) { try tombstones.add(part(1, of: 2, more: ["tombstones": tomb])) }
        let list: JSONValue = .object(["spaces": .array([.string("s1")])])
        var lists = SyncSnapshotParts.Assembler()
        try lists.add(part(0, of: 2, more: ["order": list]))
        #expect(throws: SyncFailure(.badMessage, "a list is twice in a snapshot")) { try lists.add(part(1, of: 2, more: ["order": list])) }
    }

    @Test func aPartThatIsNotOneIsABadMessage() {
        var assembler = SyncSnapshotParts.Assembler()
        for hostile: JSONValue in [.null, .array([]), .object([:]), .object(["part": .number(0), "parts": .number(1)]), .object(["part": .number(0.5), "parts": .number(1), "entities": .array([])]),
                                   .object(["part": .number(.infinity), "parts": .number(1), "entities": .array([])]), part(0, of: 1, [.string("x")]),
                                   part(0, of: 1, [.object(["kind": .string("a"), "id": .string("b"), "fields": .object([:]), "stamps": .object(["name": .number(1)])])]),
                                   part(0, of: 1, more: ["tombstones": .array([.number(1)])]), part(0, of: 1, more: ["order": .object(["spaces": .number(1)])]),
                                   part(0, of: 1, more: ["order": .object(["spaces": .array([.number(1)])])]), part(0, of: 1, more: ["orderStamps": .object(["spaces": .number(1)])]),
                                   part(0, of: 1, more: ["withheld": .array([.number(1)])])] {
            #expect(throws: SyncFailure.self) { try assembler.add(hostile) }
        }
    }

    @Test func moreEntitiesThanTheBoundAreTooLarge() throws {
        var assembler = SyncSnapshotParts.Assembler()
        let total = SyncLimits.maxEntities / SyncLimits.maxEntitiesPerPart + 2
        var failure: SyncFailure?
        for number in 0..<total {
            let entities = (0..<SyncLimits.maxEntitiesPerPart).map { wire("favorite", "e\(number)-\($0)") }
            do { try assembler.add(part(number, of: total, entities)) } catch let caught as SyncFailure { failure = caught; break }
        }
        #expect(failure?.code == .tooLarge)
    }

    @Test func theEndChecksThePartsTheCountAndTheDigest() throws {
        let source = snapshot(entities: 3)
        let parts = SyncSnapshotParts.parts(of: source, withheld: [])
        var complete = SyncSnapshotParts.Assembler()
        for part in parts { try complete.add(.object(part)) }
        #expect(throws: SyncFailure(.truncated, "the count of entities is not the one announced")) { try complete.finish(entityCount: 2, digest: source.digest) }
        #expect(throws: SyncFailure(.truncated, "the digest of the snapshot is not the one announced")) { try complete.finish(entityCount: 3, digest: String(repeating: "0", count: 64)) }
        #expect(throws: Never.self) { try complete.finish(entityCount: 3, digest: source.digest) }
        var none = SyncSnapshotParts.Assembler()
        #expect(throws: SyncFailure(.truncated, "the parts announced did not all come")) { try none.finish(entityCount: 0, digest: SyncSnapshot.empty.digest) }
        var half = SyncSnapshotParts.Assembler()
        try half.add(part(0, of: 2))
        #expect(throws: SyncFailure(.truncated, "the parts announced did not all come")) { try half.finish(entityCount: 0, digest: SyncSnapshot.empty.digest) }
    }

    @Test func aSnapshotThatDoesNotReadIsABadMessageEvenWhenItsDigestIsRight() throws {
        // A key that is not in normalization form C: two keys for the Mac, one for a Swift dictionary.
        var source = SyncSnapshot()
        source.entities = ["space": ["s1": SyncEntity(fields: ["e\u{301}": .bool(true)], stamps: [:])]]
        var assembler = SyncSnapshotParts.Assembler()
        for part in SyncSnapshotParts.parts(of: source, withheld: []) { try assembler.add(.object(part)) }
        #expect(throws: SyncFailure.self) { try assembler.finish(entityCount: 1, digest: source.digest) }
    }
}

@Suite("Synchronisation: the messages of a session, written")
struct SyncSessionMessagesTests {
    @Test func whatThePhoneWritesForAnExchangeIsReadBack() throws {
        let part: JSONValue = .object(["part": .number(0), "parts": .number(1), "entities": .array([]), "withheld": .array([.string("s9")])])
        let tabs: JSONValue = .object(["items": .array([.object(["id": .string("t"), "spaceId": .string("s"), "url": .string("https://a.example/"), "title": .string("A"), "lastActiveAt": .number(5)])])])
        let digest = String(repeating: "ab", count: 32)
        let sent: [SyncMessage] = [.snapshotPart(part), .openTabs(tabs), .snapshotEnd(entityCount: 7, digest: digest), .result(digest: digest), .commit(digest: digest)]
        for (index, message) in sent.enumerated() {
            let data = try SyncMessageCodec.encode(message, number: index + 1)
            guard case .success(let envelope) = SyncMessageCodec.decode(data) else { Issue.record("not read back: \(message.type)"); continue }
            #expect(envelope.number == index + 1)
            #expect(envelope.message.type == message.type)
            switch (envelope.message, message) {
            case (.snapshotPart(let read), .snapshotPart): #expect(read["part"] == .number(0) && read["withheld"] == .array([.string("s9")]))
            case (.openTabs(let read), .openTabs): #expect(read["items"]?.items.count == 1)
            default: #expect(envelope.message == message)
            }
        }
    }

    @Test func theEnvelopeIsTheCodecsAndNotTheBodys() throws {
        let body: JSONValue = .object(["part": .number(0), "parts": .number(1), "entities": .array([]), "n": .number(99), "t": .string("hello"), "v": .number(7)])
        let data = try SyncMessageCodec.encode(.snapshotPart(body), number: 4)
        guard case .success(let envelope) = SyncMessageCodec.decode(data) else { Issue.record("not read back"); return }
        #expect(envelope.number == 4)
        #expect(envelope.message.type == "snapshot.part")
    }

    @Test func aBodyThatIsNotAnObjectAndAMessageThePhoneNeverWritesAreRefused() {
        #expect(throws: SyncFailure.self) { try SyncMessageCodec.encode(.snapshotPart(.array([])), number: 1) }
        #expect(throws: SyncFailure.self) { try SyncMessageCodec.encode(.pairChallenge(nonce: Data(count: 16)), number: 1) }
        #expect(throws: SyncFailure.self) { try SyncMessageCodec.encode(.pairAccept(device: SyncDeviceInfo(id: "m", name: "Mac", platform: .mac), proof: Data(count: 32), hosts: []), number: 1) }
    }
}

@Suite("Synchronisation: the base of the Mac")
struct SyncBaseStoreTests {
    private func store() -> (SyncBaseStore, URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "bases-\(UUID().uuidString)")
        return (SyncBaseStore(directory: directory), directory)
    }

    private func sample() -> SyncSnapshot {
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": SyncEntity(fields: ["name": .string("Travail")], stamps: ["name": "1790000000000-0000-mac"])]]
        snapshot.order = ["spaces": ["s1"]]
        snapshot.orderStamps = ["spaces": "1790000000001-0000-mac"]
        return snapshot
    }

    @Test func aBaseIsKeptAndReadBackWithItsHash() throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(store.get(peerId: "mac-1", now: 5) == nil)
        let saved = try store.save(peerId: "mac-1", snapshot: sample(), now: 1_790_000_000_000)
        #expect(saved.hash == sample().digest)
        let read = try #require(store.get(peerId: "mac-1", now: 1_790_000_000_000))
        #expect(read == saved)
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.appending(path: "sync-base-mac-1.json").path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func aBaseOlderThanThirtyDaysIsNotUsed() throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        try store.save(peerId: "mac-1", snapshot: sample(), now: 1_000)
        let thirty = 30 * 24 * 60 * 60 * 1000
        #expect(store.get(peerId: "mac-1", now: 1_000 + thirty) != nil, "exactly thirty days: used")
        #expect(store.get(peerId: "mac-1", now: 1_000 + thirty + 1) == nil, "the tombstones that told the deletions are gone: the merge starts empty")
    }

    @Test func aFileThatIsNotABaseIsNotUsedAndSaysSo() throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "sync-base-mac-1.json")
        for hostile in ["not json", "[]", #"{"version":2,"savedAt":1,"snapshot":{}}"#, #"{"version":1,"savedAt":"x","snapshot":{}}"#, #"{"version":1,"savedAt":1,"snapshot":{"entities":{"space":{"s":{"fields":{"__proto__":1},"stamps":{}}}}}}"#] {
            try Data(hostile.utf8).write(to: url)
            #expect(store.get(peerId: "mac-1", now: 5) == nil, "\(hostile)")
        }
    }

    @Test func aDeviceIdentifierThatIsNotAFileNameIsRefused() throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        for id in ["../x", "a/b", "", String(repeating: "a", count: 65), "a b"] {
            #expect(throws: SyncFailure.self) { try store.save(peerId: id, snapshot: sample(), now: 1) }
            #expect(store.get(peerId: id, now: 1) == nil)
        }
    }

    @Test func forgettingTheMacRemovesItsBase() throws {
        let (store, directory) = store()
        defer { try? FileManager.default.removeItem(at: directory) }
        try store.save(peerId: "mac-1", snapshot: sample(), now: 1)
        try store.remove(peerId: "mac-1")
        #expect(store.get(peerId: "mac-1", now: 1) == nil)
        try store.remove(peerId: "mac-1")
    }
}

@Suite("Synchronisation: the patch, written into the state")
struct SyncApplyTests {
    private let now = Double(SyncStateFixtures.now)

    private func upsert(_ kind: SyncFieldClasses.Kind, _ id: String, create: Bool = false, fields: [String: JSONValue] = [:], remove: [String] = [], expect: [String: JSONValue] = [:]) -> SyncPatch.Upsert {
        SyncPatch.Upsert(kind: kind, id: id, create: create, fields: fields, remove: remove, expect: expect)
    }

    private func patch(_ upserts: [SyncPatch.Upsert] = [], removals: [SyncPatch.Removal] = [], order: [String: [String]] = [:], settings: [String: JSONValue] = [:]) -> SyncPatch {
        var patch = SyncPatch()
        patch.upserts = upserts
        patch.removals = removals
        patch.order = order
        patch.settings = settings
        return patch
    }

    private func apply(_ patch: SyncPatch, to state: BrowserState) -> SyncApply.Outcome { SyncApply.apply(patch, to: state, now: now) }

    @Test func aPatchThatChangesNothingGivesBackTheStateItWasGiven() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(SyncPatch(), to: state)
        #expect(outcome.state == state)
        #expect(!outcome.changed)
        #expect(outcome.removedTabIDs.isEmpty && outcome.removedSpaceIDs.isEmpty && outcome.createdSpaceIDs.isEmpty)
    }

    @Test func aFieldIsSetOnlyWhileTheStateStillHoldsWhatItHeldAtTheFreeze() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s1", fields: ["name": .string("Boulot")], expect: ["name": .string("Travail")])])
        #expect(apply(change, to: state).state.spaces.first?.name == "Boulot")
        // The person renamed it in the meantime: their change stays, and the next session sends it.
        var renamed = state
        renamed.spaces[0].name = "Pro"
        let kept = apply(change, to: renamed)
        #expect(kept.state.spaces.first?.name == "Pro")
        #expect(!kept.changed)
    }

    @Test func aFieldThatIsAbsentAtTheFreezeIsTouchedOnlyWhileItStillIs() throws {
        var state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s1", fields: ["hideHeader": .bool(true)], expect: [:])])
        #expect(apply(change, to: state).state.spaces[0].rest["hideHeader"] == .bool(true))
        state.spaces[0].rest["hideHeader"] = .bool(false)
        #expect(apply(change, to: state).state.spaces[0].rest["hideHeader"] == .bool(false), "the person set it meanwhile")
    }

    @Test func aFieldIsTakenAwayOnlyWhileItIsStillWhatItWas() throws {
        var state = try SyncStateFixtures.sample()
        state.spaces[0].rest["hideHeader"] = .bool(true)
        let change = patch([upsert(.space, "s1", remove: ["hideHeader"], expect: ["hideHeader": .bool(true)])])
        #expect(apply(change, to: state).state.spaces[0].rest["hideHeader"] == nil)
        state.spaces[0].rest["hideHeader"] = .bool(false)
        #expect(apply(change, to: state).state.spaces[0].rest["hideHeader"] == .bool(false))
    }

    @Test func aFieldAnEntityCannotBeWithoutIsNeverTakenAway() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s1", remove: ["name", "emoji", "profileId", "id"], expect: ["name": .string("Travail"), "emoji": .string("💼"), "profileId": .string("work")])])
        let outcome = apply(change, to: state)
        #expect(outcome.state.spaces[0] == state.spaces[0])
    }

    @Test func theIdentifierIsNeverWrittenAndTheFieldsTheStateDoesNotTypeCross() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s1", fields: ["id": .string("hijack"), "futureField": .array([.number(1)])], expect: [:])])
        let outcome = apply(change, to: state)
        #expect(outcome.state.spaces[0].id == "s1")
        #expect(outcome.state.spaces[0].rest["futureField"] == .array([.number(1)]))
        #expect(outcome.state.spaces[0].rest["theme"] == state.spaces[0].rest["theme"], "what the patch does not name is kept")
    }

    @Test func aValueThisVersionDoesNotKeepIsNotWrittenAndIsSaid() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s1", fields: ["name": .number(5), "emoji": .string("not an emoji"), "hideHeader": .string("yes")], expect: ["name": .string("Travail"), "emoji": .string("💼")])])
        let outcome = apply(change, to: state)
        #expect(outcome.state.spaces[0] == state.spaces[0])
        #expect(outcome.rejected.count == 3)
    }

    @Test func aNameIsReboundedLikeAFileWouldBe() throws {
        let state = try SyncStateFixtures.sample()
        let long = String(repeating: "é", count: 300)
        let change = patch([upsert(.space, "s1", fields: ["name": .string(" Un\nnom\u{7} " + long)], expect: ["name": .string("Travail")])])
        let name = apply(change, to: state).state.spaces[0].name
        #expect(name.utf16.count <= Library.nameMax)
        #expect(name.hasPrefix("Un nom"), "control characters become a space, the ends are trimmed")
    }

    @Test func anEntityThatArrivesIsMadeWithItsFieldsAndAPinnedTabKeepsItsFolder() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.folder, "f9", create: true, fields: ["spaceId": .string("s2"), "name": .string("Nouveau"), "collapsed": .bool(true)]),
                            upsert(.tab, "t9", create: true, fields: ["spaceId": .string("s2"), "pinned": .bool(true), "anchorUrl": .string("https://new.example/"), "folderId": .string("f9")]),
                            upsert(.favorite, "fav9", create: true, fields: ["url": .string("https://fav9.example/"), "title": .string("Fav 9"), "profileId": .string("default")]),
                            upsert(.archived, "a9", create: true, fields: ["spaceId": .string("s2"), "url": .string("https://old9.example/"), "title": .string("Old 9"), "archivedAt": .number(5)]),
                            upsert(.space, "s9", create: true, fields: ["name": .string("Neuf"), "emoji": .string("🚀"), "profileId": .string("work"), "theme": SpaceTheme.make(hue: 130)])])
        let outcome = apply(change, to: state)
        #expect(outcome.createdSpaceIDs == ["s9"])
        #expect(outcome.state.spaces.map(\.id) == ["s1", "s2", "s9"])
        #expect(outcome.state.folders.map(\.id).contains("f9"))
        let tab = try #require(outcome.state.tabs.first { $0.id == "t9" })
        #expect(tab.pinned && tab.folderId == "f9" && tab.anchorUrl == "https://new.example/")
        #expect(tab.url == "https://new.example/" && tab.title == "new.example", "a pinned tab that arrives without its seed opens at the page it returns to")
        #expect(outcome.state.favorites.map(\.id) == ["fav1", "fav9"])
        #expect(outcome.state.archive.map(\.id).sorted() == ["a1", "a9"])
        #expect(outcome.state.activeTabBySpace["s9"] == .some(nil), "a new space shows no tab, as the Mac's normalize gives it")
        #expect(outcome.rejected.isEmpty)
    }

    @Test func anEntityThatLacksANameOrAnAddressIsNotMade() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s9", create: true, fields: ["emoji": .string("🚀")]), upsert(.folder, "f9", create: true, fields: ["spaceId": .string("s1")]),
                            upsert(.tab, "t9", create: true, fields: ["spaceId": .string("s1"), "pinned": .bool(true)]), upsert(.favorite, "fav9", create: true, fields: ["title": .string("x")]),
                            upsert(.archived, "a9", create: true, fields: ["spaceId": .string("s1"), "url": .string("javascript:1")])])
        let outcome = apply(change, to: state)
        #expect(outcome.state == state)
        #expect(outcome.rejected.count >= 5)
    }

    @Test func anEntityIsNotMadeUnlessThePatchSaysItIsNew() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch([upsert(.space, "ghost", create: false, fields: ["name": .string("Fantôme"), "emoji": .string("👻")]),
                                   upsert(.folder, "ghost-f", create: false, fields: ["spaceId": .string("s1"), "name": .string("Fantôme")])]), to: state)
        #expect(outcome.state == state, "a change to something that is not here is not a creation")
    }

    @Test func theIdentifierOfAnEntityIsNeverTakenFromItsFields() throws {
        let state = try SyncStateFixtures.sample()
        let made = apply(patch([upsert(.folder, "f9", create: true, fields: ["id": .string("hijack"), "spaceId": .string("s1"), "name": .string("Neuf")])]), to: state)
        #expect(made.state.folders.map(\.id).contains("f9") && !made.state.folders.map(\.id).contains("hijack"))
        // Even when the patch says the identifier was what the state holds: it is the key of the entity, not a field.
        let changed = apply(patch([upsert(.space, "s1", fields: ["id": .string("hijack")], expect: ["id": .string("s1")])]), to: state)
        #expect(changed.state.spaces.map(\.id) == ["s1", "s2"])
    }

    @Test func aFavouriteOrAnArchivedTabThatArrivesWithNoTitleIsNamedByItsSite() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch([upsert(.favorite, "fav9", create: true, fields: ["url": .string("https://sans-titre.example/page"), "profileId": .string("default")]),
                                   upsert(.archived, "a9", create: true, fields: ["spaceId": .string("s1"), "url": .string("https://archive.example/old")])]), to: state)
        #expect(outcome.state.favorites.first { $0.id == "fav9" }?.title == "sans-titre.example")
        #expect(outcome.state.archive.first { $0.id == "a9" }?.title == "archive.example")
    }

    @Test func anEntityThatExistsAlreadyIsNotMadeAgain() throws {
        let state = try SyncStateFixtures.sample()
        let change = patch([upsert(.space, "s1", create: true, fields: ["name": .string("Autre"), "emoji": .string("🚀")], expect: [:])])
        let outcome = apply(change, to: state)
        #expect(outcome.state.spaces[0].name == "Travail", "the name is there now, and the patch expected it absent")
        #expect(outcome.state.spaces.count == 2)
    }

    @Test func anEntityIsRemovedOnlyWhileItIsStillWhatItWasAtTheFreeze() throws {
        let state = try SyncStateFixtures.sample()
        let removal = SyncPatch.Removal(kind: .folder, id: "f2", expect: ["spaceId": .string("s1"), "name": .string("Sous"), "parentId": .string("f1")])
        #expect(apply(patch(removals: [removal]), to: state).state.folders.map(\.id) == ["f1"])
        var renamed = state
        renamed.folders[1].name = "Renommé"
        #expect(apply(patch(removals: [removal]), to: renamed).state.folders.map(\.id) == ["f1", "f2"], "the person changed it meanwhile")
    }

    @Test func aStateIsNeverLeftWithNoSpace() throws {
        let state = try SyncStateFixtures.sample()
        let removals = state.spaces.map { SyncPatch.Removal(kind: .space, id: $0.id, expect: ["name": .string($0.name)]) }
        let outcome = apply(patch(removals: removals), to: state)
        #expect(outcome.state.spaces.map(\.id) == ["s2"])
        #expect(outcome.state.activeSpaceId == "s2", "the pointers are put right")
        #expect(outcome.removedSpaceIDs == ["s1"])
    }

    @Test func whatPointsAtASpaceThatWentGoesWithIt() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .space, id: "s1", expect: ["name": .string("Travail")])]), to: state)
        #expect(outcome.state.spaces.map(\.id) == ["s2"])
        #expect(outcome.state.tabs.isEmpty, "the pinned tabs and the Today tab of the space")
        #expect(Set(outcome.removedTabIDs) == ["t1", "t2", "today", "secret"])
        #expect(outcome.state.folders.isEmpty)
        #expect(outcome.state.archive.isEmpty)
        #expect(outcome.state.activeTabBySpace["s1"] == nil)
    }

    @Test func aFolderOrAParentThatIsNotThereIsCutAndTheTabGoesBackToTheRoot() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .folder, id: "f1", expect: ["spaceId": .string("s1"), "name": .string("Réunions")])]), to: state)
        #expect(outcome.state.folders.map(\.id) == ["f2"])
        #expect(outcome.state.folders[0].parentId == nil, "its parent went: it is at the root")
        #expect(outcome.state.tabs.first { $0.id == "t1" }?.folderId == nil)
        #expect(outcome.state.tabs.first { $0.id == "t1" } != nil, "a tab is not lost with its folder")
    }

    @Test func aTabCannotBeFiledInAFolderOfAnotherSpace() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch([upsert(.tab, "t2", fields: ["folderId": .string("f1")], expect: [:]), upsert(.folder, "f1", fields: ["parentId": .string("f2")], expect: [:])]), to: state)
        // f1 inside f2 which is inside f1: a loop is cut, never kept.
        let folders = Dictionary(uniqueKeysWithValues: outcome.state.folders.map { ($0.id, $0.parentId) })
        #expect(!(folders["f1"] == "f2" && folders["f2"] == "f1"))
    }

    @Test func aFolderOrATabOrAnArchivedTabIsNeverFiledInAFolderOfAnotherSpace() throws {
        var state = try SyncStateFixtures.sample()
        state.folders.append(Folder(id: "other", spaceId: "s2", name: "Ailleurs"))
        state.archive.append(ArchivedTab(id: "a2", spaceId: "s1", url: "https://old2.example/", title: "Old 2", archivedAt: 5, pinned: true, folderId: "f1"))
        let into = patch([upsert(.folder, "f2", fields: ["parentId": .string("other")], expect: ["parentId": .string("f1")]),
                          upsert(.tab, "t2", fields: ["folderId": .string("other")], expect: [:]),
                          upsert(.archived, "a2", fields: ["folderId": .string("other")], expect: ["folderId": .string("f1")])])
        let outcome = apply(into, to: state)
        #expect(outcome.state.folders.first { $0.id == "f2" }?.parentId == nil, "a folder in a folder of another space is at the root")
        #expect(outcome.state.tabs.first { $0.id == "t2" }?.folderId == nil)
        #expect(outcome.state.archive.first { $0.id == "a2" }?.folderId == nil)
        // The same space is fine: nothing is cut that points at a folder of its own space.
        let inside = apply(patch([upsert(.tab, "t2", fields: ["folderId": .string("f2")], expect: [:]), upsert(.archived, "a2", fields: ["folderId": .string("f2")], expect: ["folderId": .string("f1")])]), to: state)
        #expect(inside.state.tabs.first { $0.id == "t2" }?.folderId == "f2" && inside.state.archive.first { $0.id == "a2" }?.folderId == "f2")
    }

    @Test func anArchivedTabWhoseFolderIsGoneIsAtTheRoot() throws {
        var state = try SyncStateFixtures.sample()
        state.archive.append(ArchivedTab(id: "a2", spaceId: "s1", url: "https://old2.example/", title: "Old 2", archivedAt: 5, pinned: true, folderId: "f1"))
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .folder, id: "f1", expect: ["spaceId": .string("s1"), "name": .string("Réunions")])]), to: state)
        #expect(outcome.state.archive.first { $0.id == "a2" }?.folderId == nil)
    }

    @Test func theLoopOfFoldersIsCutAtTheFolderThatClosesIt() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch([upsert(.folder, "f1", fields: ["parentId": .string("f2")], expect: [:])]), to: state)
        #expect(outcome.state.folders.map(\.id) == ["f1", "f2"])
        #expect(outcome.state.folders.contains { $0.parentId == nil }, "one of the two is at the root")
        // A folder in itself is a loop too.
        let own = apply(patch([upsert(.folder, "f2", fields: ["parentId": .string("f2")], expect: ["parentId": .string("f1")])]), to: state)
        #expect(own.state.folders[1].parentId == nil)
    }

    // MARK: The order

    private func reorderable() throws -> BrowserState {
        var state = try SyncStateFixtures.sample()
        var t3 = TabItem(id: "t3", spaceId: "s1", url: "https://c.example/", title: "C", pinned: true)
        t3.anchorUrl = "https://c.example/"
        let today2 = TabItem(id: "today2", spaceId: "s1", url: "https://today2.example/", title: "Today 2")
        // The order of the array: t1 (folder f1), t2, today, secret (private), t3, today2.
        state.tabs.append(contentsOf: [t3, today2])
        return state
    }

    @Test func aListIsReorderedInThePlacesItsMembersHeldSoThatWhatIsNotSynchronisedDoesNotMove() throws {
        let state = try reorderable()
        let outcome = apply(patch(order: ["tabs:s1:-": ["t3", "t2"]]), to: state)
        #expect(outcome.state.tabs.map(\.id) == ["t1", "t3", "today", "secret", "t2", "today2"], "t2 and t3 swapped places; the Today tabs and the private tab stayed where they were")
    }

    @Test func aFolderListOnlyMovesTheFoldersOfItsOwnLevel() throws {
        var state = try SyncStateFixtures.sample()
        // The array holds a child, then two folders of the root: the list of the root orders the two, and the child stays where it is.
        state.folders = [Folder(id: "child", spaceId: "s1", name: "Enfant", parentId: "f1"), Folder(id: "f1", spaceId: "s1", name: "Réunions"), Folder(id: "f3", spaceId: "s1", name: "Trois")]
        let outcome = apply(patch(order: ["folders:s1:-": ["f3", "f1"]]), to: state)
        #expect(outcome.state.folders.map(\.id) == ["child", "f3", "f1"])
        let other = apply(patch(order: ["folders:s2:-": ["f3", "f1"]]), to: state)
        #expect(other.state.folders == state.folders, "the folders of another space are not this list's")
    }

    @Test func aProfileThatIsNotAnIdentifierBecomesTheDefaultProfile() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch([upsert(.space, "s1", fields: ["profileId": .string("not an id!")], expect: ["profileId": .string("work")]),
                                   upsert(.favorite, "fav9", create: true, fields: ["url": .string("https://fav9.example/"), "title": .string("F"), "profileId": .string("../x")])]), to: state)
        #expect(outcome.state.spaces[0].profileId == "default", "a profile names a folder on the disk: anything that is not a plain identifier is the default one")
        #expect(outcome.state.favorites.first { $0.id == "fav9" }?.profileId == "default")
    }

    @Test func aStateThatNeverHadTheLibraryListsDoesNotGainThemByBeingPatched() throws {
        var state = try SyncStateFixtures.sample()
        state.rest["folders"] = nil
        state.rest["favorites"] = nil
        state.rest["archive"] = nil
        let outcome = apply(patch([upsert(.space, "s1", fields: ["name": .string("Boulot")], expect: ["name": .string("Travail")])]), to: state)
        #expect(outcome.state.spaces[0].name == "Boulot")
        #expect(outcome.state.rest["folders"] == nil && outcome.state.rest["favorites"] == nil && outcome.state.rest["archive"] == nil)
    }

    @Test func aNameThatIsOnlySpacesIsNotAName() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch([upsert(.space, "s1", fields: ["name": .string("  \n  ")], expect: ["name": .string("Travail")])]), to: state)
        #expect(outcome.state.spaces[0].name == "Travail")
        #expect(outcome.rejected.count == 1)
    }

    @Test func aMemberTheOrderDoesNotNameGoesAfterTheOnesItNames() throws {
        let state = try reorderable()
        let outcome = apply(patch(order: ["tabs:s1:-": ["t3"]]), to: state)
        #expect(outcome.state.tabs.map(\.id) == ["t1", "t3", "today", "secret", "t2", "today2"])
    }

    @Test func theSpacesTheFoldersAndTheFavouritesAreReorderedByTheirOwnKeys() throws {
        var state = try reorderable()
        state.favorites = [Favorite(id: "fa", url: "https://fa.example/", title: "A", profileId: "default"), Favorite(id: "fb", url: "https://fb.example/", title: "B", profileId: "work"),
                           Favorite(id: "fc", url: "https://fc.example/", title: "C", profileId: "default")]
        let outcome = apply(patch(order: ["spaces": ["s2", "s1"], "folders:s1:-": ["f1"], "favorites:default": ["fc", "fa"]]), to: state)
        #expect(outcome.state.spaces.map(\.id) == ["s2", "s1"])
        #expect(outcome.state.favorites.map(\.id) == ["fc", "fb", "fa"])
    }

    @Test func aKeyThatNamesNothingThisVersionOrdersIsIgnored() throws {
        let state = try reorderable()
        let outcome = apply(patch(order: ["widgets:x:y": ["a"], "": [], "tabs": ["t1"], "favorites:a:b": ["x"]]), to: state)
        #expect(outcome.state == state)
    }

    @Test func aProfileListsAPageOnceAmongItsFavourites() throws {
        var state = try SyncStateFixtures.sample()
        state.favorites = [Favorite(id: "one", url: "https://same.example/", title: "Same", profileId: "default")]
        let outcome = apply(patch([upsert(.favorite, "two", create: true, fields: ["url": .string("https://same.example/"), "title": .string("Same too"), "profileId": .string("default")]),
                                   upsert(.favorite, "other", create: true, fields: ["url": .string("https://same.example/"), "title": .string("Same, another profile"), "profileId": .string("work")])]), to: state)
        #expect(outcome.state.favorites.map(\.id) == ["one", "other"], "the first one is kept, and another profile keeps its own")
    }

    // MARK: The settings

    @Test func theSettingsOfTheClosedListAreWrittenAndNothingElse() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch(settings: ["sendGpc": .bool(true), "lockEnabled": .bool(false), "updateFeedUrl": .string("https://evil.example/"), "proxy": .bool(true)]), to: state)
        guard case .object(let settings)? = outcome.state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(settings["sendGpc"] == .bool(true))
        #expect(settings["lockEnabled"] == .bool(true), "a lock is never written by a synchronisation")
        #expect(settings["updateFeedUrl"] == nil && settings["proxy"] == nil)
        #expect(outcome.rejected.isEmpty, "a key outside the list is ignored, not a value that was refused")
        #expect(settings["httpsUpgrade"] == .bool(true), "the other settings are as they were")
    }

    @Test func aSettingThatIsNotOneThisVersionWouldWriteIsNotWritten() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch(settings: ["sendGpc": .string("yes"), "autoArchiveHours": .number(-4), "searchUrlTemplate": .string("javascript:alert(%s)")]), to: state)
        #expect(outcome.state == state)
        #expect(outcome.rejected.count == 3)
    }

    @Test func aStateWithNoSettingsGetsTheFiveOfANewProfileBeforeTheOneThePatchWrites() throws {
        var state = try SyncStateFixtures.sample()
        state.rest["settings"] = nil
        let outcome = apply(patch(settings: ["autoArchiveHours": .number(6)]), to: state)
        // Without them, a partial `settings` reads as an earlier profile's (HTTPS first and nothing else): the privacy of the phone would drop without a word.
        #expect(outcome.state.privacy == PrivacySettings.newProfile)
        guard case .object(let settings)? = outcome.state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(settings["autoArchiveHours"] == .number(6) && settings["protectionBaseline"] == .string("renforcee"))
    }

    @Test func theProfileNamesAreOneValue() throws {
        let state = try SyncStateFixtures.sample()
        let outcome = apply(patch(settings: ["profileNames": .object(["default": .string("Perso")])]), to: state)
        #expect(outcome.state.profileNames == ["default": "Perso"], "the whole dictionary is replaced, not merged key by key")
    }

    // MARK: What is kept

    @Test func whatTheStateHoldsThatThisVersionDoesNotTypeComesOutUnchanged() throws {
        var state = try SyncStateFixtures.sample()
        state.rest["boosts"] = .array([.object(["host": .string("example.com")])])
        state.rest["futureTopLevel"] = .object(["a": .number(1)])
        state.favorites[0].rest["futureFavouriteField"] = .string("kept")
        let outcome = apply(patch([upsert(.space, "s1", fields: ["name": .string("Boulot")], expect: ["name": .string("Travail")])]), to: state)
        #expect(outcome.state.rest["boosts"] == state.rest["boosts"])
        #expect(outcome.state.rest["futureTopLevel"] == state.rest["futureTopLevel"])
        #expect(outcome.state.favorites[0].rest["futureFavouriteField"] == .string("kept"))
        #expect(outcome.state.tabs == state.tabs, "an entity the patch did not touch is the one it was, field for field")
    }

    @Test func aTabThatWasUnpinnedHereKeepsItsOtherFieldsWhenOnlyAFieldIsPatched() throws {
        var state = try SyncStateFixtures.sample()
        state.tabs[1].lastActiveAt = 42
        state.tabs[1].rest["faviconUrl"] = .string("https://b.example/i.png")
        let outcome = apply(patch([upsert(.tab, "t2", fields: ["customTitle": .string("Doc B")], expect: [:])]), to: state)
        let tab = try #require(outcome.state.tabs.first { $0.id == "t2" })
        #expect(tab.rest["customTitle"] == .string("Doc B"))
        #expect(tab.lastActiveAt == 42 && tab.rest["faviconUrl"] == .string("https://b.example/i.png"), "the local fields are not the patch's")
    }
}

@Suite("Synchronisation: reading the small files")
struct SyncFilesTests {
    @Test func aFileIsReadOnlyWhenItIsARegularFileUnderTheBound() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "files-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let small = directory.appending(path: "small.json")
        try Data("0123456789".utf8).write(to: small)
        #expect(try SyncFiles.readBounded(small, maxBytes: 10) == Data("0123456789".utf8), "exactly the bound: read")
        #expect(throws: SyncFiles.TooLarge(name: "small.json", bytes: 10, limit: 9)) { try SyncFiles.readBounded(small, maxBytes: 9) }
        #expect(throws: SyncFiles.NotARegularFile(name: directory.lastPathComponent)) { try SyncFiles.readBounded(directory, maxBytes: 1_000) }
        // A link to a file is not the file: what the link points at is not read.
        let link = directory.appending(path: "link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: small)
        #expect(throws: SyncFiles.NotARegularFile.self) { try SyncFiles.readBounded(link, maxBytes: 1_000) }
    }

    @Test func aWriteGoesToATemporaryFileAndReplacesTheOldOneWholeWithTheRightsOfItsOwner() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "files-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "x.json")
        try SyncFiles.writeAtomically(Data("one".utf8), to: url)
        try SyncFiles.writeAtomically(Data("two".utf8), to: url)
        #expect(try String(contentsOf: url, encoding: .utf8) == "two")
        #expect(!FileManager.default.fileExists(atPath: url.path + ".tmp"), "no temporary file is left")
        #expect(try (FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func aWriteThatFailsLeavesNoTemporaryFileAndTheErrorGoesOn() throws {
        let blocker = FileManager.default.temporaryDirectory.appending(path: "files-block-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: blocker) }
        try Data("x".utf8).write(to: blocker)
        #expect(throws: (any Error).self) { try SyncFiles.writeAtomically(Data("y".utf8), to: blocker.appending(path: "x.json")) }
    }
}
