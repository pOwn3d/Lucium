import Foundation
import Testing
@testable import LuciumKit

/// The state of the phone as the synchronisation reads it (docs/synchronisation.md §8.3, §10), the marks it gets (§9.2) and the patch built from a merge (§8.5), played
/// against the vectors the Mac's own code produced and plays too (`ios/Contracts/sync-state-vectors.json`, `src/main/sync/state-view-vectors.test.ts`), then what the
/// vectors do not say.
enum SyncStateFixtures {
    static let now = 1_790_000_000_000

    static func state(_ value: JSONValue) throws -> BrowserState {
        try BrowserState.decode(JSONEncoder().encode(value))
    }

    static func categories(_ value: JSONValue?) -> Set<SyncCategory> { Set((value?.items ?? []).compactMap(\.text).compactMap(SyncCategory.init(rawValue:))) }

    static func strings(_ value: JSONValue?) -> [String] { (value?.items ?? []).compactMap(\.text) }

    /// A small state: two spaces, a folder in each, pinned tabs, a Today tab, a private tab, favourites, an archive and settings.
    static func sample() throws -> BrowserState {
        var state = BrowserState(spaces: [Space(id: "s1", name: "Travail", emoji: "💼", profileId: "work", rest: ["theme": SpaceTheme.make(hue: 250)]), Space(id: "s2", name: "Maison", emoji: "🏠", profileId: "default")],
                                 tabs: [], activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil])
        state.folders = [Folder(id: "f1", spaceId: "s1", name: "Réunions"), Folder(id: "f2", spaceId: "s1", name: "Sous", parentId: "f1")]
        var t1 = TabItem(id: "t1", spaceId: "s1", url: "https://a.example/now", title: "A now", pinned: true)
        t1.anchorUrl = "https://a.example/"
        t1.folderId = "f1"
        var t2 = TabItem(id: "t2", spaceId: "s1", url: "https://b.example/", title: "B", pinned: true)
        t2.anchorUrl = "https://b.example/"
        let today = TabItem(id: "today", spaceId: "s1", url: "https://today.example/", title: "Today")
        var secret = TabItem(id: "secret", spaceId: "s1", url: "https://secret.example/", title: "Private", pinned: true)
        secret.rest["private"] = .bool(true)
        state.tabs = [t1, t2, today, secret]
        state.favorites = [Favorite(id: "fav1", url: "https://fav.example/", title: "Fav", profileId: "default")]
        state.archive = [ArchivedTab(id: "a1", spaceId: "s1", url: "https://old.example/", title: "Old", archivedAt: 1_790_000_000_500)]
        state.rest["settings"] = .object(["httpsUpgrade": .bool(true), "sendGpc": .bool(false), "lockEnabled": .bool(true), "profileNames": .object(["work": .string("Travail")])])
        return state
    }
}

@Suite("Synchronisation: the state the phone reads, the vectors shared with the Mac")
struct SyncStateVectorTests {
    private let vectors = (try? Contract.load("sync-state-vectors.json")) ?? .null

    @Test func theSnapshotAndTheListsAreTheOnesTheMacsCodeGave() throws {
        let cases = try #require(vectors["view"]).items
        #expect(cases.count >= 9)
        for item in cases {
            let name = item["name"]?.text ?? "?"
            let state = try SyncStateFixtures.state(try #require(item["state"]))
            var marks = SyncMarkBook(device: "phone")
            marks.update(SyncStateView.trackedView(of: state), now: SyncStateFixtures.now)
            let base = try Contract.optionalSnapshot(item["base"])
            let snapshot = SyncStateView.snapshot(of: state, marks: marks, categories: SyncStateFixtures.categories(item["categories"]), withheld: Set(SyncStateFixtures.strings(item["withheld"])), base: base)
            let expect = try #require(item["expect"])
            var entities: [String: JSONValue] = [:]
            for (kind, byID) in snapshot.entities {
                var kindObject: [String: JSONValue] = [:]
                for (id, entity) in byID {
                    kindObject[id] = .object(entity.fields)
                    // One mark per field it follows, seeds included: the marks name the fields.
                    #expect(Set(entity.stamps.keys) == Set(entity.fields.keys), "\(name): \(kind)/\(id)")
                    #expect(entity.stamps.values.allSatisfy(SyncStamp.isValid), "\(name): \(kind)/\(id)")
                }
                entities[kind] = .object(kindObject)
            }
            #expect(JSONValue.object(entities) == expect["entities"], "\(name): entities")
            #expect(JSONValue.object(snapshot.order.mapValues { .array($0.map { .string($0) }) }) == expect["order"], "\(name): order")
            #expect(Set(snapshot.orderStamps.keys) == Set(snapshot.order.keys), "\(name): a mark for each list")
            #expect(snapshot.tombstones.isEmpty, "\(name): a fresh book has no tombstone")
            #expect(Contract.isReadable(snapshot), "\(name): what a phone sends is what the Mac reads")
        }
    }

    /// The patch as the vectors hold it: upserts and removals sorted by kind then id, the lists of fields to remove sorted.
    private func normalized(_ patch: JSONValue) -> JSONValue {
        func key(_ item: JSONValue) -> String { (item["kind"]?.text ?? "") + (item["id"]?.text ?? "") }
        let upserts = (patch["upserts"]?.items ?? []).map { item -> JSONValue in
            guard case .object(var members) = item else { return item }
            members["remove"] = .array((item["remove"]?.items ?? []).sorted { ($0.text ?? "") < ($1.text ?? "") })
            return .object(members)
        }.sorted { key($0) < key($1) }
        let removals = (patch["removals"]?.items ?? []).sorted { key($0) < key($1) }
        return .object(["upserts": .array(upserts), "removals": .array(removals), "order": patch["order"] ?? .null, "settings": patch["settings"] ?? .null])
    }

    @Test func thePatchIsTheOneTheMacsCodeBuilt() throws {
        let cases = try #require(vectors["patch"]).items
        #expect(cases.count >= 10)
        for item in cases {
            let name = item["name"]?.text ?? "?"
            let patch = SyncPatch.build(frozen: try Contract.snapshot(item["frozen"]), merged: try Contract.snapshot(item["merged"]), withheld: Set(SyncStateFixtures.strings(item["withheld"])))
            #expect(normalized(patch.json) == normalized(try #require(item["expect"])), "\(name)")
        }
    }
}

extension Contract {
    /// Whether the Mac's reader (`SyncSnapshot.read`) takes the snapshot as it is.
    static func isReadable(_ snapshot: SyncSnapshot) -> Bool {
        if case .success(let read) = SyncSnapshot.read(snapshot.json) { return read == snapshot }
        return false
    }
}

@Suite("Synchronisation: what the phone follows of its state")
struct SyncStateViewTests {
    private let now = SyncStateFixtures.now

    @Test func theTodayTabsAndThePrivateTabsAreNotEntities() throws {
        let view = SyncStateView.trackedView(of: try SyncStateFixtures.sample())
        #expect(view.entities["tab"]?.keys.sorted() == ["t1", "t2"])
        #expect(view.order["tabs:s1:f1"] == ["t1"])
        #expect(view.order["tabs:s1:-"] == ["t2"])
        #expect(view.order["folders:s1:f1"] == ["f2"])
        #expect(view.order["favorites:default"] == ["fav1"])
        #expect(view.order["spaces"] == ["s1", "s2"])
    }

    @Test func aTabFollowsItsSyncedFieldsAndNeitherItsSeedsNorItsLocalOnes() throws {
        let tab = try #require(SyncStateView.trackedView(of: try SyncStateFixtures.sample()).entities["tab"]?["t1"])
        #expect(tab == ["spaceId": .string("s1"), "pinned": .bool(true), "anchorUrl": .string("https://a.example/"), "folderId": .string("f1")])
    }

    @Test func aFavouriteWithNoProfileIsGivenToTheDefaultOne() throws {
        var state = try SyncStateFixtures.sample()
        state.favorites = [Favorite(id: "bare", url: "https://bare.example/", title: "Bare")]
        let view = SyncStateView.trackedView(of: state)
        #expect(view.entities["favorite"]?["bare"]?["profileId"] == .string("default"))
        #expect(view.order["favorites:default"] == ["bare"])
    }

    @Test func onlyTheEightSettingsOfTheClosedListAreFollowed() throws {
        let view = SyncStateView.trackedView(of: try SyncStateFixtures.sample())
        #expect(view.entities["setting"]?.keys.sorted() == ["httpsUpgrade", "profileNames", "sendGpc"])
        #expect(view.entities["setting"]?["sendGpc"] == ["value": .bool(false)])
        // The lock is never a setting that travels, whatever the state holds.
        #expect(view.entities["setting"]?["lockEnabled"] == nil)
    }

    @Test func aStateWithNoSettingsHoldsNoSettingEntity() throws {
        var state = try SyncStateFixtures.sample()
        state.rest["settings"] = nil
        #expect(SyncStateView.trackedView(of: state).entities["setting"]?.isEmpty == true)
    }

    @Test func onlyTheLatestFiveHundredArchivedTabsOfEachSpaceAreFollowed() throws {
        var state = try SyncStateFixtures.sample()
        state.archive = (0..<520).map { ArchivedTab(id: "x\($0)", spaceId: "s1", url: "https://old.example/\($0)", title: "Old", archivedAt: Double(1_000 + $0)) }
            + [ArchivedTab(id: "other", spaceId: "s2", url: "https://other.example/", title: "Other", archivedAt: 1)]
        let archived = try #require(SyncStateView.trackedView(of: state).entities["archived"])
        #expect(archived.count == 501)
        #expect(archived["x519"] != nil && archived["x20"] != nil)
        #expect(archived["x19"] == nil && archived["x0"] == nil, "the oldest of the space are left out")
        #expect(archived["other"] != nil, "the count is by space")
    }

    @Test func theSeedsOfAnEntityTheMacDoesNotHoldGoWithItAndTheEarliestMarkOfItsFields() throws {
        let state = try SyncStateFixtures.sample()
        var marks = SyncMarkBook(device: "phone")
        marks.update(SyncStateView.trackedView(of: state), now: now)
        let fresh = SyncStateView.snapshot(of: state, marks: marks, categories: [.structure], withheld: [], base: nil)
        let tab = try #require(fresh.entities["tab"]?["t1"])
        #expect(tab.fields["url"] == .string("https://a.example/now") && tab.fields["title"] == .string("A now"))
        #expect(tab.stamps["url"] == SyncStamp.min(of: tab.stamps.filter { $0.key != "url" && $0.key != "title" }.map(\.value)), "a seed is marked with the earliest mark of its entity")
        #expect(fresh.entities["folder"]?["f1"]?.fields["collapsed"] == .bool(false))
        // Once the base holds the tab, its seeds are no longer sent: the page a pinned tab is on changes with every navigation.
        let known = SyncStateView.snapshot(of: state, marks: marks, categories: [.structure], withheld: [], base: SyncStateView.base(of: fresh))
        #expect(known.entities["tab"]?["t1"]?.fields["url"] == nil && known.entities["tab"]?["t1"]?.fields["title"] == nil)
        #expect(known.entities["folder"]?["f1"]?.fields["collapsed"] == nil)
    }

    @Test func aBaseIsKeptWithoutSeedsOrLocalFields() throws {
        var merged = SyncSnapshot()
        merged.entities = ["tab": ["t": SyncEntity(fields: ["pinned": .bool(true), "url": .string("https://a.example/"), "title": .string("A"), "lastActiveAt": .number(5)], stamps: ["pinned": "0", "url": "0"])],
                           "widget": ["w": SyncEntity(fields: ["a": .number(1)], stamps: [:])]]
        let base = SyncStateView.base(of: merged)
        #expect(base.entities["tab"]?["t"]?.fields == ["pinned": .bool(true)])
        #expect(base.entities["tab"]?["t"]?.stamps == ["pinned": "0"])
        #expect(base.entities["widget"]?["w"]?.fields == ["a": .number(1)], "a kind this version does not know goes through whole")
    }

    @Test func theTombstonesOfTheBookGoWithTheCategoriesThatCarryTheirKind() throws {
        var state = try SyncStateFixtures.sample()
        var marks = SyncMarkBook(device: "phone")
        marks.update(SyncStateView.trackedView(of: state), now: now)
        state.spaces.removeAll { $0.id == "s2" }
        state.favorites = []
        marks.update(SyncStateView.trackedView(of: state), now: now + 1000)
        var merged = SyncSnapshot()
        merged.tombstones = ["widget": ["w1": "1790000000500-0000-mac"]]
        marks.adopt(merged)
        marks.update(SyncStateView.trackedView(of: state), now: now + 2000)
        let structure = SyncStateView.snapshot(of: state, marks: marks, categories: [.structure], withheld: [], base: nil)
        #expect(structure.tombstones["widget"] != nil, "a kind this version does not know travels with every category")
        let settingsOnly = SyncStateView.snapshot(of: state, marks: marks, categories: [.settings], withheld: [], base: nil)
        #expect(settingsOnly.tombstones["space"] == nil && settingsOnly.tombstones["favorite"] == nil, "a deleted space is told only with the structure")
        #expect(settingsOnly.tombstones["widget"] != nil)
        // Deleting a space that was in the structure: its tombstone goes out with the structure.
        var again = SyncMarkBook(device: "phone")
        var before = try SyncStateFixtures.sample()
        again.update(SyncStateView.trackedView(of: before), now: now)
        before.spaces.removeAll { $0.id == "s2" }
        again.update(SyncStateView.trackedView(of: before), now: now + 1000)
        let sent = SyncStateView.snapshot(of: before, marks: again, categories: [.structure], withheld: [], base: nil)
        #expect(sent.tombstones["space"]?["s2"] == "1790000001000-0000-phone")
        #expect(SyncStateView.snapshot(of: before, marks: again, categories: [.settings], withheld: [], base: nil).tombstones["space"] == nil)
    }

    @Test func eachCategoryCarriesItsOwnKindsAndNoOtherOnes() throws {
        let state = try SyncStateFixtures.sample()
        var marks = SyncMarkBook(device: "phone")
        marks.update(SyncStateView.trackedView(of: state), now: now)
        func kinds(_ categories: Set<SyncCategory>) -> Set<String> {
            Set(SyncStateView.snapshot(of: state, marks: marks, categories: categories, withheld: [], base: nil).entities.keys)
        }
        #expect(kinds([.structure]) == ["space", "folder", "tab", "favorite"])
        #expect(kinds([.archive]) == ["archived"], "the archive carries no setting")
        #expect(kinds([.settings]) == ["setting"], "the settings carry no archived tab")
        #expect(kinds([.openTabs]).isEmpty, "the open tabs are an announcement, never an entity")
        #expect(kinds([]).isEmpty)
    }

    @Test func aPhoneThatAdoptsTheMacsStructureSendsNoStructureOfAnyKind() throws {
        var snapshot = SyncSnapshot()
        let entity = SyncEntity(fields: ["name": .string("A")], stamps: ["name": "1790000000000-0000-phone"])
        snapshot.entities = ["space": ["s": entity], "folder": ["f": entity], "tab": ["t": entity], "favorite": ["v": entity], "archived": ["a": entity], "setting": ["sendGpc": entity], "widget": ["w": entity]]
        snapshot.tombstones = ["space": ["s9": "0"], "tab": ["t9": "0"], "archived": ["a9": "0"], "widget": ["w9": "0"]]
        snapshot.order = ["spaces": ["s"], "tabs:s:-": ["t"]]
        snapshot.orderStamps = ["spaces": "0", "tabs:s:-": "0"]
        let sent = snapshot.withoutStructure()
        #expect(Set(sent.entities.keys) == ["archived", "setting", "widget"])
        #expect(Set(sent.tombstones.keys) == ["archived", "widget"], "the deletions of the structure are not told either")
        #expect(sent.order.isEmpty && sent.orderStamps.isEmpty)
    }

    @Test func theLockedSpacesAreTheOnesTheLockSays() throws {
        let state = try SyncStateFixtures.sample()
        #expect(SyncStateView.withheldSpaces(in: state, isLocked: { $0 == "s2" }) == ["s2"])
        #expect(SyncStateView.withheldSpaces(in: state, isLocked: { _ in false }).isEmpty)
    }

    @Test func theOpenTabsAreWebPagesOfTheOpenSpacesNeverPrivateTheLatestTwoHundred() throws {
        var state = try SyncStateFixtures.sample()
        var tabs: [TabItem] = []
        for index in 0..<250 {
            var tab = TabItem(id: "w\(index)", spaceId: "s1", url: "https://site.example/\(index)", title: "Page \(index)")
            tab.lastActiveAt = Double(index)
            tabs.append(tab)
        }
        var privateTab = TabItem(id: "p", spaceId: "s1", url: "https://private.example/", title: "Private")
        privateTab.rest["private"] = .bool(true)
        privateTab.lastActiveAt = 10_000
        var locked = TabItem(id: "l", spaceId: "s2", url: "https://locked.example/", title: "Locked")
        locked.lastActiveAt = 10_001
        var file = TabItem(id: "f", spaceId: "s1", url: "file:///etc/passwd", title: "File")
        file.lastActiveAt = 10_002
        var long = TabItem(id: "long", spaceId: "s1", url: "https://long.example/" + String(repeating: "a", count: 5000), title: "Long")
        long.lastActiveAt = 10_003
        var wide = TabItem(id: "wide", spaceId: "s1", url: "https://wide.example/", title: String(repeating: "é", count: 400))
        wide.lastActiveAt = 10_004
        state.tabs = tabs + [privateTab, locked, file, long, wide]
        let open = SyncStateView.openTabs(of: state, isSpaceLocked: { $0 == "s2" })
        #expect(open.count == 200)
        #expect(open.first?.id == "wide", "the latest first")
        #expect(!open.contains { ["p", "l", "f", "long"].contains($0.id) })
        #expect(open.first?.title.utf8.count == 300, "a title is cut to the bytes the message allows, on a character")
        #expect(open.last?.id == "w51", "250 tabs and the latest 200 kept: the oldest kept is the 52nd")
    }
}

@Suite("Synchronisation: the marks")
struct SyncMarkTests {
    private let now = SyncStateFixtures.now

    @Test func aMarkHasThirteenDigitsFourHexadecimalDigitsAndTheDevice() {
        var book = SyncMarkBook(device: "phone-0001")
        let first = book.next(now: now)
        #expect(first == "1790000000000-0000-phone-0001")
        #expect(SyncStamp.isValid(first))
        #expect(book.next(now: now) == "1790000000000-0001-phone-0001", "the same millisecond counts")
        #expect(book.next(now: now + 5) == "1790000000005-0000-phone-0001")
        #expect(book.next(now: now) == "1790000000005-0001-phone-0001", "the clock never goes back")
    }

    @Test func aMarkOfTodayIsNotTruncatedToThirtyTwoBits() {
        // 1_790_000_000_000 does not fit in 32 bits: a text written with the wrong width would be wrong and still look like a mark.
        var book = SyncMarkBook(device: "d")
        #expect(book.next(now: 1_790_000_000_000).hasPrefix("1790000000000-"))
        #expect(SyncClock.parse("1790000000000-00ff-d") == SyncClock(milliseconds: 1_790_000_000_000, counter: 255))
        #expect(SyncClock.parse("1790000000000-00FF-d") == SyncClock(milliseconds: 1_790_000_000_000, counter: 255) || SyncClock.parse("1790000000000-00FF-d") == nil)
    }

    @Test func theCounterRollsOverIntoTheNextMillisecond() {
        var book = SyncMarkBook(device: "d")
        var last = ""
        for _ in 0...0x10000 { last = book.next(now: now) }
        #expect(last == "1790000000001-0000-d")
    }

    @Test func aMarkThatCameInKeepsTheClockAheadOfIt() {
        var book = SyncMarkBook(device: "phone")
        book.observe("1790000099000-0007-mac")
        #expect(book.next(now: now) == "1790000099000-0008-phone")
        book.observe("1790000000000-0000-mac")
        #expect(book.next(now: now) == "1790000099000-0009-phone", "an older mark changes nothing")
        book.observe("not a mark")
        #expect(book.next(now: now) == "1790000099000-000a-phone")
    }

    private func view(_ fields: [String: JSONValue], order: [String] = ["a"]) -> SyncTrackedView {
        SyncTrackedView(entities: ["space": ["a": fields]], order: ["spaces": order])
    }

    @Test func aFieldIsMarkedWhenItChangesAndOnlyThen() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A"), "emoji": .string("🏠")]), now: now)
        let first = book.stamps(of: "space", id: "a")
        #expect(Set(first.keys) == ["name", "emoji"])
        book.update(view(["name": .string("A"), "emoji": .string("🏠")]), now: now + 1000)
        #expect(book.stamps(of: "space", id: "a") == first, "nothing changed: nothing is marked")
        book.update(view(["name": .string("B"), "emoji": .string("🏠")]), now: now + 2000)
        let second = book.stamps(of: "space", id: "a")
        #expect(second["emoji"] == first["emoji"])
        #expect(second["name"] == "1790000002000-0000-phone")
    }

    @Test func aFieldThatWentKeepsAMarkBecauseARemovalIsAChange() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A"), "hideHeader": .bool(true)]), now: now)
        book.update(view(["name": .string("A")]), now: now + 1000)
        #expect(book.stamps(of: "space", id: "a")["hideHeader"] == "1790000001000-0000-phone")
        book.update(view(["name": .string("A")]), now: now + 5000)
        #expect(book.stamps(of: "space", id: "a")["hideHeader"] == "1790000001000-0000-phone", "a removal is marked once")
    }

    @Test func anEntityThatWentLeavesATombstoneAndComesBackWithoutOne() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")]), now: now)
        book.update(SyncTrackedView(entities: ["space": [:]], order: [:]), now: now + 1000)
        #expect(book.tombstonesOfAllKinds()["space"]?["a"] == "1790000001000-0000-phone")
        #expect(book.stamps(of: "space", id: "a").isEmpty)
        book.update(view(["name": .string("A")]), now: now + 2000)
        #expect(book.tombstonesOfAllKinds()["space"]?["a"] == nil)
    }

    @Test func aTombstoneIsKeptThirtyDaysThenForgotten() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")]), now: now)
        book.update(SyncTrackedView(entities: ["space": [:]], order: [:]), now: now)
        let day = 24 * 60 * 60 * 1000
        book.purge(now: now + 30 * day)
        #expect(book.tombstonesOfAllKinds()["space"] != nil, "exactly thirty days: kept")
        book.purge(now: now + 30 * day + 1)
        #expect(book.tombstonesOfAllKinds().isEmpty)
    }

    @Test func aListIsMarkedWhenItsOrderChanges() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")], order: ["a", "b"]), now: now)
        let first = book.orderStamp(of: "spaces")
        #expect(first != SyncStamp.zero)
        book.update(view(["name": .string("A")], order: ["a", "b"]), now: now + 1000)
        #expect(book.orderStamp(of: "spaces") == first)
        book.update(view(["name": .string("A")], order: ["b", "a"]), now: now + 2000)
        #expect(book.orderStamp(of: "spaces") == "1790000002000-0000-phone")
        #expect(book.orderStamp(of: "nothing") == SyncStamp.zero)
    }

    @Test func whatTheMergeDecidedIsTheBooksOwnSoItIsNotSentBack() {
        var merged = SyncSnapshot()
        merged.entities = ["space": ["a": SyncEntity(fields: ["name": .string("From the Mac")], stamps: ["name": "1790000050000-0003-mac"])]]
        merged.order = ["spaces": ["a"]]
        merged.orderStamps = ["spaces": "1790000050000-0004-mac"]
        var book = SyncMarkBook(device: "phone")
        book.adopt(merged)
        book.update(view(["name": .string("From the Mac")]), now: now)
        #expect(book.stamps(of: "space", id: "a") == ["name": "1790000050000-0003-mac"], "no new mark: the Mac's own is kept")
        #expect(book.orderStamp(of: "spaces") == "1790000050000-0004-mac")
        #expect(book.next(now: now) == "1790000050000-0005-phone", "and the clock is past what it saw")
        // What the person changes afterwards is theirs.
        book.update(view(["name": .string("Mine")]), now: now + 99_000_000)
        #expect(book.stamps(of: "space", id: "a")["name"]?.hasSuffix("-phone") == true)
    }

    @Test func theSeedsAndTheLocalFieldsAreNotFollowedWhenTheMergeIsAdopted() {
        var merged = SyncSnapshot()
        merged.entities = ["tab": ["t": SyncEntity(fields: ["pinned": .bool(true), "url": .string("https://a.example/")], stamps: ["pinned": "1790000000001-0000-mac", "url": "1790000000001-0000-mac"])]]
        var book = SyncMarkBook(device: "phone")
        book.adopt(merged)
        #expect(Set(book.stamps(of: "tab", id: "t").keys) == ["pinned"])
    }

    @Test func theMarkOfAnEarlyTimeIsWrittenOnThirteenDigitsToo() {
        var book = SyncMarkBook(device: "d")
        #expect(book.next(now: 5) == "0000000000005-0000-d", "a mark is 13 digits of time, whatever the time")
    }

    @Test func aFieldOfTheClassesFollowsAsTheMacFollowsIt() {
        #expect(!SyncFieldClasses.follows(kind: "space", field: "id"), "the identifier is the key, not a field")
        #expect(SyncFieldClasses.follows(kind: "space", field: "name"))
        #expect(!SyncFieldClasses.follows(kind: "space", field: "image"))
        #expect(!SyncFieldClasses.follows(kind: "tab", field: "url") && !SyncFieldClasses.follows(kind: "tab", field: "lastActiveAt"))
        #expect(SyncFieldClasses.follows(kind: "tab", field: "futureField"), "a field this version does not know is followed")
        #expect(SyncFieldClasses.follows(kind: "setting", field: "value") && !SyncFieldClasses.follows(kind: "setting", field: "other"))
        #expect(SyncFieldClasses.follows(kind: "widget", field: "anything"), "a kind this version does not know is followed as it comes")
    }

    @Test func anEntityWithNoValueLeftLeavesNoTombstone() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")]), now: now)
        book.update(view([:]), now: now + 1000)
        book.update(SyncTrackedView(entities: ["space": [:]], order: [:]), now: now + 2000)
        #expect(book.tombstonesOfAllKinds().isEmpty, "it held nothing when it went: there is no deletion to tell")
    }

    @Test func aListThatIsNoLongerThereLosesItsMarkAndGetsANewOneWhenItComesBack() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")], order: ["a"]), now: now)
        let first = book.orderStamp(of: "spaces")
        book.update(SyncTrackedView(entities: ["space": ["a": ["name": .string("A")]]], order: [:]), now: now + 1000)
        #expect(book.orderStamp(of: "spaces") == SyncStamp.zero)
        book.update(view(["name": .string("A")], order: ["a"]), now: now + 2000)
        #expect(book.orderStamp(of: "spaces") != first && book.orderStamp(of: "spaces") == "1790000002000-0000-phone", "the list that comes back is a new one")
    }

    @Test func aTombstoneIsForgottenWhenTheBookLooksAtTheStateAfterThirtyDays() {
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")]), now: now)
        book.update(SyncTrackedView(entities: ["space": [:]], order: [:]), now: now)
        #expect(book.tombstonesOfAllKinds()["space"]?["a"] != nil)
        let day = 24 * 60 * 60 * 1000
        book.update(SyncTrackedView(entities: ["space": [:]], order: [:]), now: now + 31 * day)
        #expect(book.tombstonesOfAllKinds().isEmpty)
    }

    @Test func theMarksOfTheFieldsOfAMergeAreSeenByTheClockEvenWithNoList() {
        var merged = SyncSnapshot()
        merged.entities = ["space": ["a": SyncEntity(fields: ["name": .string("From the Mac")], stamps: ["name": "1790000090000-0002-mac"])]]
        var book = SyncMarkBook(device: "phone")
        book.adopt(merged)
        #expect(book.next(now: now) == "1790000090000-0003-phone")
    }

    @Test func theTombstonesOfAMergeAreSeenByTheClockAndKept() {
        var merged = SyncSnapshot()
        merged.tombstones = ["tab": ["gone": "1790000070000-0009-mac"]]
        var book = SyncMarkBook(device: "phone")
        book.adopt(merged)
        #expect(book.tombstonesOfAllKinds() == ["tab": ["gone": "1790000070000-0009-mac"]])
        #expect(book.next(now: now) == "1790000070000-000a-phone")
    }

    @Test func aFieldOfAMergeThatHasNoMarkIsKeptWithTheMarkZero() {
        var merged = SyncSnapshot()
        merged.entities = ["space": ["a": SyncEntity(fields: ["name": .string("A")], stamps: [:])]]
        var book = SyncMarkBook(device: "phone")
        book.adopt(merged)
        #expect(book.stamps(of: "space", id: "a") == ["name": "0"])
        book.update(view(["name": .string("A")]), now: now)
        #expect(book.stamps(of: "space", id: "a") == ["name": "0"], "the same value: nothing new to mark")
    }

    @Test func theFileRoundTripsAndAHostileFileIsRefused() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "marks-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName))
        #expect(file.load(device: "phone") == .none)
        var book = SyncMarkBook(device: "phone")
        book.update(view(["name": .string("A")], order: ["a"]), now: now)
        book.update(SyncTrackedView(entities: ["space": [:]], order: [:]), now: now + 1)
        try file.save(book)
        #expect(file.load(device: "phone") == .loaded(book))
        // Rights of the owner only: the file says what changed and when.
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        for hostile in [#"{"version":2,"clock":{"ms":0,"counter":0},"entities":{},"tombstones":{},"orders":{}}"#,
                        #"{"version":1,"clock":{"ms":-1,"counter":0},"entities":{},"tombstones":{},"orders":{}}"#,
                        #"{"version":1,"clock":{"ms":1,"counter":70000},"entities":{},"tombstones":{},"orders":{}}"#,
                        #"{"version":1,"clock":{"ms":1,"counter":0},"entities":{"space":{"a":{"name":{"hash":"x","stamp":"nope"}}}},"tombstones":{},"orders":{}}"#,
                        #"{"version":1,"clock":{"ms":1,"counter":0},"entities":{},"tombstones":{"space":{"a":5}},"orders":{}}"#,
                        #"{"version":1,"clock":{"ms":1,"counter":0},"entities":{},"tombstones":{"space":{"a":"nope"}},"orders":{}}"#,
                        "[1,2,3]", "not json"] {
            try Data(hostile.utf8).write(to: file.url)
            guard case .unreadable = file.load(device: "phone") else { Issue.record("read as a book: \(hostile)"); continue }
        }
    }

    @Test func aFileThatIsTooLargeIsNotRead() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "marks-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: SyncMarksFile.fileName)
        try Data(repeating: 0x20, count: SyncMarksFile.maxBytes + 1).write(to: url)
        guard case .unreadable = SyncMarksFile(url: url).load(device: "phone") else { Issue.record("a file over the bound was read"); return }
    }
}

@Suite("Synchronisation: the book of marks held for the phone")
struct SyncMarkKeeperTests {
    private let now = SyncStateFixtures.now

    private func keeper() -> (SyncMarkKeeper, URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "keeper-\(UUID().uuidString)")
        return (SyncMarkKeeper(device: "phone", file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)), log: { _ in }), directory)
    }

    @Test func aHeldBookDoesNotLookAtTheStateAndAFreezeLetsGoOfTheHold() throws {
        let (keeper, directory) = keeper()
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = try SyncStateFixtures.sample()
        keeper.hold()
        keeper.observe(state, now: now)
        #expect(keeper.currentBook.stamps(of: "space", id: "s1").isEmpty, "held: nothing is marked")
        _ = keeper.freeze(state, categories: [.structure], withheld: [], base: nil, now: now)
        #expect(!keeper.currentBook.stamps(of: "space", id: "s1").isEmpty, "a new session never inherits a stale hold")
    }

    @Test func aReleaseMakesTheBookFollowTheStateAgain() throws {
        let (keeper, directory) = keeper()
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = try SyncStateFixtures.sample()
        keeper.hold()
        keeper.release()
        keeper.observe(state, now: now)
        #expect(!keeper.currentBook.stamps(of: "space", id: "s1").isEmpty)
    }

    @Test func theStateIsLookedAtOnlyWhenItChangedAndTheBookIsWrittenThen() throws {
        let (keeper, directory) = keeper()
        defer { try? FileManager.default.removeItem(at: directory) }
        var state = try SyncStateFixtures.sample()
        keeper.observe(state, now: now)
        let first = keeper.currentBook
        keeper.observe(state, now: now + 1000)
        #expect(keeper.currentBook == first, "the same state: nothing to see")
        state.spaces[0].name = "Autre"
        keeper.observe(state, now: now + 2000)
        #expect(keeper.currentBook.stamps(of: "space", id: "s1")["name"] == "1790000002000-0000-phone")
        let file = SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName))
        #expect(file.load(device: "phone") == .loaded(keeper.currentBook), "it is written at each change")
    }

    @Test func aStateThatDidNotChangeDoesNotRewriteTheFile() throws {
        let (keeper, directory) = keeper()
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = try SyncStateFixtures.sample()
        keeper.observe(state, now: now)
        let url = directory.appending(path: SyncMarksFile.fileName)
        let first = try FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? NSNumber
        keeper.observe(state, now: now + 5000)
        #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? NSNumber == first, "the file is replaced only when the book changed")
    }

    @Test func aBookOfAFileIsTheOneAKeeperStartsWith() throws {
        let (keeper, directory) = keeper()
        defer { try? FileManager.default.removeItem(at: directory) }
        keeper.observe(try SyncStateFixtures.sample(), now: now)
        let again = SyncMarkKeeper(device: "phone", file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)), log: { _ in })
        #expect(again.currentBook == keeper.currentBook)
    }

    @Test func aBookThatCannotBeReadStartsEmptyAndSaysSo() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "keeper-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: directory.appending(path: SyncMarksFile.fileName))
        let said = LogBox()
        let keeper = SyncMarkKeeper(device: "phone", file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)), log: { said.add($0) })
        #expect(keeper.currentBook == SyncMarkBook(device: "phone"))
        #expect(said.lines.contains { $0.contains("start again") })
    }

    @Test func aBookThatCannotBeWrittenIsKeptInMemoryAndSaysSo() throws {
        // The folder is a file: nothing can be written under it.
        let blocker = FileManager.default.temporaryDirectory.appending(path: "keeper-block-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: blocker) }
        try Data("x".utf8).write(to: blocker)
        let said = LogBox()
        let keeper = SyncMarkKeeper(device: "phone", file: SyncMarksFile(url: blocker.appending(path: SyncMarksFile.fileName)), log: { said.add($0) })
        keeper.observe(try SyncStateFixtures.sample(), now: now)
        #expect(!keeper.currentBook.stamps(of: "space", id: "s1").isEmpty, "the marks are in memory meanwhile")
        #expect(said.lines.contains { $0.contains("were not written") })
    }

    @Test func aMergeThatCannotBeKeptThrowsSoThatTheSessionDoesNotSayItIsDone() throws {
        let blocker = FileManager.default.temporaryDirectory.appending(path: "keeper-block-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: blocker) }
        try Data("x".utf8).write(to: blocker)
        let keeper = SyncMarkKeeper(device: "phone", file: SyncMarksFile(url: blocker.appending(path: SyncMarksFile.fileName)), log: { _ in })
        #expect(throws: (any Error).self) { try keeper.adopt(SyncSnapshot()) }
    }
}

final class LogBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []
    var lines: [String] { lock.withLock { stored } }
    func add(_ line: String) { lock.withLock { stored.append(line) } }
}
