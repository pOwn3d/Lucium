import Foundation
import Testing
@testable import LuciumKit

/// What an entity that comes in may carry (docs/synchronisation.md §8.5, §10), played against the vectors the Mac's `inbound-filter.test.ts` plays too
/// (`inbound`, `fieldClasses`, `settingsAllowed`, `neverKinds` of `ios/Contracts/sync-message-vectors.json`), then what the vectors do not say.
@Suite("Synchronisation: the gate for what comes in")
struct SyncInboundTests {
    private let vectors = (try? Contract.load("sync-message-vectors.json")) ?? .null

    private func fields(_ value: JSONValue?) -> [String: JSONValue] {
        if case .object(let members)? = value { return members }
        return [:]
    }

    @Test func theVectorsOfTheSpecificationAreTheMacsVerdicts() throws {
        let cases = try #require(vectors["inbound"]).items
        #expect(cases.count >= 20)
        for item in cases {
            let name = item["name"]?.text ?? "?"
            let expect = try #require(item["expect"])
            // A vector written as text because a JSON file cannot hold a lone surrogate as a value: this reader refuses the text before any entity is made (a stricter `bad-message`).
            if let raw = item["entityRaw"]?.text {
                #expect(SyncMessageCodec.hasLoneSurrogate(Data(raw.utf8)), "\(name): a text this reader cannot hold")
                #expect(expect["accepted"]?.flag == false, "\(name)")
                continue
            }
            let entity = try #require(item["entity"])
            let verdict = SyncInbound.filter(kind: try #require(entity["kind"]?.text), id: try #require(entity["id"]?.text), fields: fields(entity["fields"]))
            if expect["accepted"]?.flag == true {
                guard case .accepted(let kept) = verdict else { Issue.record("\(name): refused, \(verdict)"); continue }
                if let wanted = expect["fields"] { #expect(JSONValue.object(kept) == wanted, "\(name)") }
            } else {
                let text = try #require(expect["reason"]?.text)
                let reason = try #require(SyncInbound.Refusal(rawValue: text))
                #expect(verdict == .refused(reason), "\(name)")
            }
        }
    }

    @Test func everyRefusalOfTheVectorsIsTriedAtLeastOnce() throws {
        var reasons = Set<String>()
        for item in try #require(vectors["inbound"]).items where item["expect"]?["accepted"]?.flag == false { reasons.insert(item["expect"]?["reason"]?.text ?? "") }
        for reason in ["never-synced", "not-synced", "invalid-value", "not-pinned", "private", "invalid-url"] { #expect(reasons.contains(reason), "\(reason)") }
    }

    @Test func theClassesOfTheFieldsAreTheOnesOfTheVectors() throws {
        let table = try #require(vectors["fieldClasses"])
        for kind in SyncFieldClasses.Kind.allCases {
            let classes = try #require(SyncFieldClasses.classes[kind])
            let wanted = try #require(table[kind.rawValue])
            #expect(classes.synced == (wanted["synced"]?.items.compactMap(\.text) ?? []), "\(kind) synced")
            #expect(classes.seed == (wanted["seed"]?.items.compactMap(\.text) ?? []), "\(kind) seed")
            #expect(classes.local == (wanted["local"]?.items.compactMap(\.text) ?? []), "\(kind) local")
            // One class and only one: a field in two classes would be sent and kept at once.
            let all = classes.synced + classes.seed + classes.local
            #expect(Set(all).count == all.count, "\(kind): a field is in two classes")
        }
        guard case .object(let members) = table else { Issue.record("fieldClasses is not an object"); return }
        #expect(Set(members.keys) == Set(SyncFieldClasses.Kind.allCases.map(\.rawValue)), "a kind of the vectors that this version does not list, or the other way round")
    }

    @Test func theClosedListOfSettingsAndTheKindsThatAreNeverSentAreTheOnesOfTheVectors() throws {
        #expect(SyncFieldClasses.settingKeys == (try #require(vectors["settingsAllowed"]).items.compactMap(\.text)))
        #expect(SyncFieldClasses.neverKinds == (try #require(vectors["neverKinds"]).items.compactMap(\.text)))
        // A lock, a network setting or an update setting is in no list: every key the Mac never sends is refused whatever its value.
        for key in try #require(vectors["settingsNever"]).items.compactMap(\.text) {
            #expect(!SyncFieldClasses.settingKeys.contains(key), "\(key)")
            #expect(SyncInbound.filter(kind: "setting", id: key, fields: ["value": .bool(true)]) == .refused(.notSynced), "\(key)")
        }
    }

    // MARK: What the vectors do not say

    @Test func aSettingOutsideTheClosedListIsRefusedWhateverItsValue() {
        for key in ["lockEnabled", "lockApp", "proxyEnabled", "proxy", "dohCustomUrl", "updateFeedUrl", "customFilterLists", "extensionPaths", "passwordManager", "boostsEnabled", "userScripts", "__proto__", ""] {
            #expect(SyncInbound.filter(kind: "setting", id: key, fields: ["value": .bool(true)]) == .refused(.notSynced), "\(key)")
        }
    }

    /// A setting and a value this version would not write. Typed on its own, and in small pieces: a long literal of mixed values in the arguments of a test is more than
    /// the compiler of every toolchain type-checks in reasonable time.
    private static let invalidSettings: [Setting] = {
        let manyProfiles: [String: JSONValue] = Dictionary(uniqueKeysWithValues: (0..<65).map { index in (String("p\(index)"), JSONValue.string("x")) })
        let longTemplate: String = "https://example.com/?q=%s" + String(repeating: "x", count: 2100)
        let longName: String = String(repeating: "x", count: 41)
        var all: [Setting] = []
        all.append(Setting(key: "httpsUpgrade", value: .string("true")))
        all.append(Setting(key: "sendGpc", value: .number(1)))
        all.append(Setting(key: "protectionBaseline", value: .string("extreme")))
        all.append(Setting(key: "autoArchiveHours", value: .number(-1)))
        all.append(Setting(key: "autoArchiveHours", value: .number(Double.infinity)))
        all.append(Setting(key: "autoArchiveHours", value: .number(Double(24 * 366 + 1))))
        all.append(Setting(key: "autoArchiveHours", value: .string("12")))
        all.append(Setting(key: "searchUrlTemplate", value: .string("https://example.com/search")))
        all.append(Setting(key: "searchUrlTemplate", value: .string("javascript:alert(%s)")))
        all.append(Setting(key: "searchUrlTemplate", value: .string(longTemplate)))
        all.append(Setting(key: "profileNames", value: .string("x")))
        all.append(Setting(key: "profileNames", value: .object(["work": .number(3)])))
        all.append(Setting(key: "profileNames", value: .object(["bad id!": .string("x")])))
        all.append(Setting(key: "profileNames", value: .object(["work": .string(longName)])))
        all.append(Setting(key: "profileNames", value: .object(manyProfiles)))
        return all
    }()

    private static let validSettings: [Setting] = {
        var all: [Setting] = []
        all.append(Setting(key: "httpsUpgrade", value: .bool(false)))
        all.append(Setting(key: "protectionBaseline", value: .string("renforcee")))
        all.append(Setting(key: "autoArchiveHours", value: .number(0)))
        all.append(Setting(key: "autoArchiveHours", value: .number(Double(24 * 366))))
        all.append(Setting(key: "searchUrlTemplate", value: .string("https://duckduckgo.com/?q=%s")))
        all.append(Setting(key: "profileNames", value: .object(["work": .string("Travail"), "perso": .string("Perso")])))
        return all
    }()

    struct Setting: Sendable, CustomTestStringConvertible {
        let key: String
        let value: JSONValue
        var testDescription: String { "\(key) = \(value)" }
    }

    @Test(arguments: SyncInboundTests.invalidSettings)
    func aValueThisVersionWouldNotWriteIsRefused(setting: Setting) {
        #expect(SyncInbound.filter(kind: "setting", id: setting.key, fields: ["value": setting.value]) == .refused(.invalidValue), "\(setting.key)")
    }

    @Test(arguments: SyncInboundTests.validSettings)
    func aValueThisVersionWouldWriteIsKept(setting: Setting) {
        #expect(SyncInbound.filter(kind: "setting", id: setting.key, fields: ["value": setting.value]) == .accepted(fields: ["value": setting.value]), "\(setting.key)")
    }

    @Test func aSettingKeepsItsValueAndNothingElse() {
        #expect(SyncInbound.filter(kind: "setting", id: "sendGpc", fields: ["value": .bool(true), "extra": .string("x")]) == .accepted(fields: ["value": .bool(true)]))
    }

    @Test func onlyAnHttpOrHttpsAddressIsAPage() {
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "about:blank", "chrome://settings", "ftp://x", "https://", "https:// bad", "//example.com", "", "https://:80/", "https://@/", "https://?x", "https://#x"] {
            #expect(!SyncInbound.isWebAddress(.string(bad)), "\(bad)")
            #expect(SyncInbound.filter(kind: "favorite", id: "f", fields: ["url": .string(bad)]) == .refused(.invalidURL), "\(bad)")
            #expect(SyncInbound.filter(kind: "tab", id: "t", fields: ["pinned": .bool(true), "anchorUrl": .string(bad)]) == .refused(.invalidURL), "\(bad)")
            #expect(SyncInbound.filter(kind: "archived", id: "a", fields: ["url": .string(bad)]) == .refused(.invalidURL), "\(bad)")
        }
        #expect(!SyncInbound.isWebAddress(.number(5)))
        #expect(!SyncInbound.isWebAddress(.null))
        #expect(!SyncInbound.isWebAddress(nil))
        #expect(SyncInbound.filter(kind: "tab", id: "t", fields: ["pinned": .bool(true), "url": .string("javascript:1")]) == .refused(.invalidURL))
        for good in ["http://example.com", "HTTPS://Example.com/a?b=c#d", "https://example.com:8443/path", "https://user@example.com/", "https://[::1]/", "https:///example.com/"] {
            #expect(SyncInbound.isWebAddress(.string(good)), "\(good)")
        }
    }

    @Test func everyKindOfCodeAndEverySecretIsRefusedByName() {
        for kind in ["boost", "userScript", "extension", "password", "vault", "lock", "history", "cookie", "session"] {
            #expect(SyncInbound.filter(kind: kind, id: "x", fields: [:]) == .refused(.neverSynced), "\(kind)")
        }
    }

    @Test func theLocalFieldsOfEveryKindAreTakenOffAndTheSyncedAndUnknownOnesKept() {
        let space: [String: JSONValue] = ["name": .string("Perso"), "image": .string("x.png"), "background": .object(["kind": .string("video")]), "webPanels": .array([]), "futureField": .array([.number(1)])]
        #expect(SyncInbound.filter(kind: "space", id: "s", fields: space) == .accepted(fields: ["name": .string("Perso"), "futureField": .array([.number(1)])]))
        #expect(SyncInbound.filter(kind: "folder", id: "f", fields: ["name": .string("A"), "live": .object(["url": .string("https://x")]), "collapsed": .bool(true)]) == .accepted(fields: ["name": .string("A"), "collapsed": .bool(true)]))
        #expect(SyncInbound.filter(kind: "archived", id: "a", fields: ["url": .string("https://x"), "history": .object(["entries": .array([])]), "container": .string("c1")]) == .accepted(fields: ["url": .string("https://x")]))
        #expect(SyncInbound.filter(kind: "widget", id: "w", fields: ["a": .array([.number(1), .object(["b": .number(2)])])]) == .accepted(fields: ["a": .array([.number(1), .object(["b": .number(2)])])]))
    }

    // MARK: A whole snapshot

    private let now = 1_790_000_000_000
    private func mark(_ ms: Int) -> String { String(format: "%013ld-0000-phone", ms) }
    private func entity(_ fields: [String: JSONValue], at ms: Int? = nil) -> SyncEntity {
        SyncEntity(fields: fields, stamps: Dictionary(uniqueKeysWithValues: fields.keys.map { ($0, mark(ms ?? now - 1000)) }))
    }

    @Test func refusedEntitiesAreDroppedListedWithTheirReasonAndTheOthersKept() {
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": entity(["name": .string("Perso")])],
                             "tab": ["t1": entity(["pinned": .bool(true), "url": .string("javascript:1")]), "t2": entity(["pinned": .bool(false)]), "t3": entity(["pinned": .bool(true), "anchorUrl": .string("https://a.example/")])],
                             "boost": ["b1": entity(["code": .string("x")])]]
        let cleaned = SyncInbound.clean(snapshot, now: now)
        #expect(cleaned.snapshot.entities["tab"]?.keys.sorted() == ["t3"])
        #expect(cleaned.snapshot.entities["boost"] == nil)
        #expect(cleaned.refused == [.init(kind: "boost", id: "b1", reason: .neverSynced), .init(kind: "tab", id: "t1", reason: .invalidURL), .init(kind: "tab", id: "t2", reason: .notPinned)])
    }

    @Test func theMarksOfTheLocalFieldsGoWithTheFields() {
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": entity(["name": .string("Perso"), "image": .string("x.png")])]]
        let cleaned = SyncInbound.clean(snapshot, now: now).snapshot.entities["space"]?["s1"]
        #expect(cleaned?.fields == ["name": .string("Perso")])
        #expect(cleaned?.stamps.keys.sorted() == ["name"])
    }

    @Test func aMarkMoreThanSevenDaysAheadIsRefusedAndOneExactlySevenDaysAheadIsKept() {
        let week = SyncInbound.futureRefusalMilliseconds
        #expect(week == 604_800_000)
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": entity(["name": .string("A")], at: now + week + 1), "s2": entity(["name": .string("B")], at: now + week)]]
        let cleaned = SyncInbound.clean(snapshot, now: now)
        #expect(cleaned.snapshot.entities["space"]?.keys.sorted() == ["s2"])
        #expect(cleaned.refused == [.init(kind: "space", id: "s1", reason: .futureMark)])
    }

    @Test func aTombstoneOrAListMoreThanSevenDaysAheadIsDroppedAndListedAndOneAtTheLimitIsKept() {
        let week = SyncInbound.futureRefusalMilliseconds
        var snapshot = SyncSnapshot()
        snapshot.tombstones = ["tab": ["far": mark(now + week + 1), "edge": mark(now + week)], "space": ["gone": mark(now + 100 * week)]]
        snapshot.order = ["spaces": ["a"], "tabs:s1:-": ["t"]]
        snapshot.orderStamps = ["spaces": mark(now + week + 1), "tabs:s1:-": mark(now + week), "lonely": mark(now + week + 1), "kept": mark(now)]
        let cleaned = SyncInbound.clean(snapshot, now: now)
        #expect(cleaned.snapshot.tombstones == ["tab": ["edge": mark(now + week)]], "a deletion dated in the year 2286 would delete what it names and push the clock of the marks out of reach")
        #expect(cleaned.snapshot.order == ["tabs:s1:-": ["t"]])
        #expect(cleaned.snapshot.orderStamps == ["tabs:s1:-": mark(now + week), "kept": mark(now)], "a mark of order with no list is checked the same way")
        #expect(cleaned.refused == [.init(kind: "order", id: "spaces", reason: .futureMark), .init(kind: "tombstone", id: "space/gone", reason: .futureMark), .init(kind: "tombstone", id: "tab/far", reason: .futureMark)])
    }

    @Test func theBaseStandsInForAnEntityThatCannotTravelNowAndNotForOneThatLeftWhatIsSynchronised() {
        let ahead = now + SyncInbound.futureRefusalMilliseconds + 1
        let kept = entity(["name": .string("Old")], at: now - 5000)
        var base = SyncSnapshot()
        base.entities = ["space": ["s1": kept, "s2": kept], "tab": ["t1": entity(["pinned": .bool(true), "anchorUrl": .string("https://a.example/")]), "t2": entity(["pinned": .bool(true)]), "t3": entity(["pinned": .bool(true)])],
                         "setting": ["sendGpc": entity(["value": .bool(true)])], "boost": ["b1": entity(["css": .string("x")])]]
        var input = SyncSnapshot()
        input.entities = ["space": ["s1": entity(["name": .string("New")], at: ahead), "s2": entity(["name": .string("Fine")]), "s9": entity(["name": .string("Never held")], at: ahead)],
                          "tab": ["t1": entity(["pinned": .bool(true), "anchorUrl": .string("javascript:1")]), "t2": entity(["pinned": .bool(false)]), "t3": entity(["pinned": .bool(true), "private": .bool(true)])],
                          "setting": ["sendGpc": entity(["value": .string("yes")])], "boost": ["b1": entity(["css": .string("y")])]]
        let cleaned = SyncInbound.clean(input, now: now, base: base)
        #expect(cleaned.snapshot.entities["space"] == ["s1": kept, "s2": entity(["name": .string("Fine")])], "refused for its marks: the base's version; one the base never held: dropped")
        #expect(cleaned.snapshot.entities["tab"]?.keys.sorted() == ["t1"], "refused for its address: the base's version; not pinned, private: they left what is synchronised, and are dropped")
        #expect(cleaned.snapshot.entities["tab"]?["t1"] == base.entities["tab"]?["t1"])
        #expect(cleaned.snapshot.entities["setting"] == ["sendGpc": base.entities["setting"]?["sendGpc"] ?? entity([:])], "refused for its value: the base's version")
        #expect(cleaned.snapshot.entities["boost"] == nil, "a kind that is never synchronised stays out, base or no base")
        #expect(cleaned.refused.map { "\($0.kind)/\($0.id):\($0.reason.rawValue)" } == ["boost/b1:never-synced", "setting/sendGpc:invalid-value", "space/s1:future-mark", "space/s9:future-mark", "tab/t1:invalid-url", "tab/t2:not-pinned", "tab/t3:private"])
        #expect(SyncInbound.clean(input, now: now).snapshot.entities["space"]?.keys.sorted() == ["s2"], "without a base: dropped")
    }

    @Test func theMarkZeroIsNotATime() {
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": SyncEntity(fields: ["name": .string("A")], stamps: ["name": "0"])]]
        #expect(SyncInbound.clean(snapshot, now: now).refused.isEmpty)
    }

    @Test func theTombstonesTheListsAndWhatTheyMarkAreLeftToTheMerge() {
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": entity(["name": .string("A"), "image": .string("x")])]]
        snapshot.tombstones = ["tab": ["t9": mark(now)]]
        snapshot.order = ["spaces": ["s1"]]
        snapshot.orderStamps = ["spaces": mark(now)]
        let cleaned = SyncInbound.clean(snapshot, now: now).snapshot
        #expect(cleaned.tombstones == snapshot.tombstones)
        #expect(cleaned.order == snapshot.order)
        #expect(cleaned.orderStamps == snapshot.orderStamps)
    }
}
