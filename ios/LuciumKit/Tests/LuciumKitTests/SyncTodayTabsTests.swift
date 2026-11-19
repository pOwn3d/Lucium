import Foundation
import Testing
@testable import LuciumKit

/// The Today tabs on the phone (docs/synchronisation.md §27, card 509): what enters the shared set, what the door lets through, what the state becomes when the other device opens,
/// closes, pins or reads a tab, and a whole session with the Mac's side played by `SyncTestMac`. The rules themselves (admission, gate, moves) are those of `SyncToday`, held by
/// `sync-today-vectors.json` (`SyncTodayVectorTests`); what is proved here is that the phone calls them where it must, and writes the state the way §27 says.
@Suite("Synchronisation: the Today tabs on the phone")
struct SyncTodayTabsTests {
    private let now = SyncStateFixtures.now
    private let both: Set<SyncCategory> = [.structure, .todayTabs]

    // MARK: Fixtures

    /// A Today tab open for `age` ms, last used at `lastUsed` (its creation by default).
    private func tab(_ id: String, space: String = "s1", url: String? = nil, title: String = "Page", age: Int = 60_000, lastUsed: Double? = nil) -> TabItem {
        var tab = TabItem(id: id, spaceId: space, url: url ?? "https://\(id).example/", title: title)
        tab.createdAt = Double(now - age)
        tab.lastActiveAt = lastUsed ?? Double(now - age)
        return tab
    }

    /// The sample state without its own Today tab, with `tabs` added.
    private func state(_ tabs: [TabItem]) throws -> BrowserState {
        var state = try SyncStateFixtures.sample()
        state.tabs.removeAll { $0.id == "today" }
        state.tabs += tabs
        return state
    }

    private func directory() -> URL { FileManager.default.temporaryDirectory.appending(path: "today-\(UUID().uuidString)") }

    private func keeper(in directory: URL) -> SyncMarkKeeper {
        SyncMarkKeeper(device: "vector-phone-000000002", file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)))
    }

    private func freeze(_ keeper: SyncMarkKeeper, _ state: BrowserState, categories: Set<SyncCategory>? = nil, withheld: Set<String> = [], base: SyncSnapshot? = nil, at time: Int? = nil) -> SyncSnapshot {
        keeper.freeze(state, categories: categories ?? both, withheld: withheld, base: base, now: time ?? now)
    }

    private func shared(_ snapshot: SyncSnapshot) -> [String: SyncEntity] { snapshot.entities[SyncToday.kind] ?? [:] }

    // MARK: The category

    @Test func theCategoryExistsIsNotTickedByDefaultAndSurvivesTheFile() throws {
        #expect(SyncCategory.allCases.map(\.rawValue).contains("todayTabs"), "the name the Mac announces in its hello")
        #expect(!SyncCategory.defaults.contains(.todayTabs) && !SyncSettings().categories.contains(.todayTabs), "[Q9]: not ticked until the person ticks it")
        let json = JSONEncoder()
        let ticked = SyncSettings(enabled: true, categories: [.structure, .todayTabs], deviceId: "vector-phone-000000002")
        #expect(try JSONDecoder().decode(SyncSettings.self, from: json.encode(ticked)).categories == [.structure, .todayTabs])
        let older = #"{"version":1,"enabled":true,"categories":["structure","todayTabs","somethingNewer"]}"#
        #expect(try JSONDecoder().decode(SyncSettings.self, from: Data(older.utf8)).categories == [.structure, .todayTabs])
    }

    @Test func todayTabsCannotBeTickedWithoutTheStructureAndGoWithIt() {
        #expect(SyncCategory.todayTabs.needsStructure)
        #expect(SyncCategory.allCases.filter(\.needsStructure) == [.todayTabs], "only the Today tabs need the structure")
        #expect(SyncCategory.ticked([.structure], category: .todayTabs, on: true) == [.structure, .todayTabs])
        #expect(SyncCategory.ticked([.settings], category: .todayTabs, on: true) == nil, "refused: a tab lives in a space")
        #expect(SyncCategory.ticked([], category: .todayTabs, on: true) == nil)
        #expect(SyncCategory.ticked([.structure, .todayTabs, .archive], category: .structure, on: false) == [.archive], "unticking the structure takes the Today tabs with it")
        #expect(SyncCategory.ticked([.structure, .todayTabs], category: .todayTabs, on: false) == [.structure])
        #expect(SyncCategory.ticked([.structure], category: .archive, on: true) == [.structure, .archive], "the order of the catalogue")
    }

    @Test func todayTabsAreAnnouncedAndTakenAsCommonOnlyWithTheStructure() {
        #expect(SyncCategory.announced([.todayTabs]) == [] && SyncCategory.announced([.todayTabs, .archive]) == [.archive])
        #expect(SyncCategory.announced([.structure, .todayTabs]) == [.structure, .todayTabs])
        #expect(SyncCategory.common(mine: [.structure, .todayTabs], theirs: ["todayTabs"]) == [], "the other device announced the category without the structure")
        #expect(SyncCategory.common(mine: [.structure, .todayTabs], theirs: ["structure", "todayTabs"]) == [.structure, .todayTabs])
        #expect(SyncCategory.common(mine: [.todayTabs], theirs: ["structure", "todayTabs"]) == [], "ticked here without the structure")
        #expect(SyncCategory.common(mine: [.structure], theirs: ["structure", "todayTabs"]) == [.structure])
    }

    // MARK: The shared set

    @Test func aTabEntersAfterTwentySecondsAndOnlyWhenTheCategoryIsCommon() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        let state = try state([tab("old", age: 21_000), tab("young", age: 5_000)])
        #expect(shared(freeze(keeper, state, categories: [.structure])).isEmpty, "the category is not common: nothing is shared, nothing is admitted")
        #expect(keeper.currentBook.admitted.isEmpty)
        let snapshot = freeze(keeper, state)
        #expect(Set(shared(snapshot).keys) == ["old"], "a tab open for 21 seconds enters, one open for 5 does not")
        #expect(keeper.currentBook.admitted == ["old"])
    }

    @Test func theEntityHoldsOnlyWhatIsSharedAndTheListFollowsTheOrderOfTheState() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        var first = tab("b", title: "Bee", lastUsed: Double(now - 3_700_000))
        first.rest["customTitle"] = .string("Mon nom")
        first.rest["icon"] = .string("🐝")
        first.rest["faviconUrl"] = .string("https://b.example/icon.png")
        first.rest["treeCollapsed"] = .bool(true)
        let state = try state([first, tab("a")])
        let snapshot = freeze(keeper, state)
        let entity = try #require(shared(snapshot)["b"])
        #expect(entity.fields["spaceId"] == .string("s1"))
        #expect(entity.fields["customTitle"] == .string("Mon nom"))
        #expect(entity.fields["icon"] == .string("🐝"))
        #expect(entity.fields["activeAt"] == .number(Double(SyncToday.roundActiveAt(Double(now - 3_700_000)))))
        #expect(entity.fields["url"] == .string("https://b.example/"), "the page is a seed: it goes with a tab the other device does not have yet")
        #expect(entity.fields["title"] == .string("Bee"))
        for local in ["faviconUrl", "treeCollapsed", "createdAt", "lastActiveAt", "pinned"] { #expect(entity.fields[local] == nil, "\(local) stays on the device") }
        #expect(entity.stamps["spaceId"] != nil && entity.stamps["activeAt"] != nil)
        #expect(snapshot.order["today:s1"] == ["b", "a"])
        #expect(snapshot.orderStamps["today:s1"] != nil)
        // Known to the other device (it is in the base): the seeds do not go again.
        let base = SyncStateView.base(of: snapshot)
        let again = try #require(shared(freeze(keeper, state, base: base))["b"])
        #expect(again.fields["url"] == nil && again.fields["title"] == nil)
    }

    @Test func aNavigationDoesNotTakeAnAdmittedTabOutAndItsPageIsNotATrackedField() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        var state = try state([tab("t")])
        let first = freeze(keeper, state)
        #expect(shared(first)["t"] != nil)
        let base = SyncStateView.base(of: first)
        state.tabs[state.tabs.firstIndex { $0.id == "t" }!].url = "about:blank"  // a page that could not enter
        state.tabs[state.tabs.firstIndex { $0.id == "t" }!].title = "Elsewhere"
        let second = freeze(keeper, state, base: base)
        let kept = try #require(shared(second)["t"], "admitted once, it stays in the snapshot: its absence would read as a closing")
        #expect(kept.stamps == shared(first)["t"]?.stamps.filter { SyncFieldClasses.follows(kind: SyncToday.kind, field: $0.key) }, "no mark moved: a page is not a change")
    }

    @Test func whatIsNotSharedStaysOnThePhone() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        var secret = tab("secret")
        secret.rest["private"] = .bool(true)
        var favorite = tab("fav")
        favorite.favoriteId = "fav1"
        var contained = tab("contained")
        contained.rest["container"] = .string("work")
        var pinned = tab("pinned")
        pinned.pinned = true
        let blank = tab("blank", url: BrowserState.blankURL)
        let file = tab("file", url: "file:///etc/hosts")
        let locked = tab("locked", space: "s2")
        let snapshot = freeze(keeper, try state([secret, favorite, contained, pinned, blank, file, locked, tab("ok")]), withheld: ["s2"])
        #expect(Set(shared(snapshot).keys) == ["ok"])
        #expect(keeper.currentBook.admitted == ["ok"])
    }

    @Test func aSpaceThatIsLockedLaterSetsItsAdmittedTabsAsideAndDoesNotForgetThem() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        let state = try state([tab("a", space: "s2"), tab("b")])
        #expect(Set(shared(freeze(keeper, state)).keys) == ["a", "b"])
        let locked = freeze(keeper, state, withheld: ["s2"])
        #expect(Set(shared(locked).keys) == ["b"], "the tab of a locked space is not sent")
        #expect(locked.order["today:s2"] == nil)
        #expect(keeper.currentBook.admitted == ["a", "b"], "it is set aside, not taken out of the shared set")
        #expect(Set(shared(freeze(keeper, state)).keys) == ["a", "b"])
    }

    @Test func aTabThatBecomesPrivateOrAFavouritesPageOrContainedIsOutAtOnceEvenBeforeTheNextFreeze() throws {
        var secret = tab("secret")
        secret.rest["private"] = .bool(true)
        var favorite = tab("fav")
        favorite.favoriteId = "fav1"
        var contained = tab("contained")
        contained.rest["container"] = .string("work")
        let state = try state([secret, favorite, contained, tab("ok")])
        let admitted: Set<String> = ["secret", "fav", "contained", "ok"]
        #expect(Set(SyncStateView.trackedView(of: state, admitted: admitted).entities[SyncToday.kind]?.keys.map { $0 } ?? []) == ["ok"], "the book does not follow them")
        #expect(SyncStateView.waitingForAdmission(in: state, admitted: []) == ["ok"], "they do not ask for a session either")
    }

    @Test func aTabThatBecomesPrivateLeavesTheSharedSet() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        var state = try state([tab("t")])
        #expect(shared(freeze(keeper, state))["t"] != nil)
        state.tabs[state.tabs.firstIndex { $0.id == "t" }!].rest["private"] = .bool(true)
        #expect(shared(freeze(keeper, state)).isEmpty)
        #expect(keeper.currentBook.tombstonesOfAllKinds()[SyncToday.kind]?["t"] != nil, "it left: the other device is told it was closed")
    }

    @Test func theSharedSetHoldsTwoHundredTabsAndTheOthersStayLocal() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        let many = (0..<205).map { tab(String(format: "t%03d", $0), lastUsed: Double(now - 100_000 + $0)) }
        let snapshot = freeze(keeper, try state(many))
        #expect(shared(snapshot).count == SyncToday.cap)
        #expect(shared(snapshot)["t204"] != nil && shared(snapshot)["t005"] != nil && shared(snapshot)["t004"] == nil, "the most recently used first")
    }

    @Test func aBookOfVersionOneIsReadAndTheAdmittedTabsSurviveTheFile() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        _ = freeze(keeper, try state([tab("a"), tab("b")]))
        let file = SyncMarksFile(url: dir.appending(path: SyncMarksFile.fileName))
        guard case .loaded(let book) = file.load(device: "vector-phone-000000002") else { Issue.record("not loaded"); return }
        #expect(book.admitted == ["a", "b"] && book == keeper.currentBook)
        let old = #"{"version":1,"clock":{"ms":1,"counter":0},"entities":{},"tombstones":{},"orders":{}}"#
        try Data(old.utf8).write(to: file.url)
        guard case .loaded(let v1) = file.load(device: "vector-phone-000000002") else { Issue.record("a book of version 1 is read"); return }
        #expect(v1.admitted.isEmpty)
        for hostile in [#"{"version":2,"clock":{"ms":1,"counter":0},"entities":{},"tombstones":{},"orders":{}}"#,
                        #"{"version":2,"clock":{"ms":1,"counter":0},"entities":{},"tombstones":{},"orders":{},"admitted":"a"}"#,
                        #"{"version":2,"clock":{"ms":1,"counter":0},"entities":{},"tombstones":{},"orders":{},"admitted":[1]}"#] {
            try Data(hostile.utf8).write(to: file.url)
            guard case .unreadable = file.load(device: "vector-phone-000000002") else { Issue.record("read as a book: \(hostile)"); continue }
        }
    }

    @Test func aTabThatComesFromTheOtherDeviceIsInTheSharedSetAndNotTakenForDeleted() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        var state = try state([])
        _ = freeze(keeper, state)
        // The session wrote the Mac's tab into the state and the book adopts the merged snapshot.
        state.tabs.append(tab("fromMac"))
        let stamp = String(format: "%013ld-%04lx-vector-mac-0000000001", now, 0)
        var merged = SyncSnapshot()
        merged.entities[SyncToday.kind] = ["fromMac": SyncEntity(fields: ["spaceId": .string("s1"), "activeAt": .number(Double(now))], stamps: ["spaceId": stamp, "activeAt": stamp])]
        keeper.hold()
        try keeper.adopt(merged, exchanged: { _ in true })
        #expect(keeper.currentBook.admitted == ["fromMac"])
        keeper.observe(state, now: now + 1_000)
        #expect(keeper.currentBook.tombstonesOfAllKinds()[SyncToday.kind]?["fromMac"] == nil, "a tab the other device sent is followed, not marked deleted")
        #expect(shared(freeze(keeper, state, at: now + 2_000))["fromMac"] != nil)
    }

    @Test func openingATabThatCouldBeSharedAsksForASessionOnce() throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keeper = keeper(in: dir)
        var state = try state([])
        keeper.observe(state, now: now, opening: true)
        state.tabs.append(tab("new", age: 1_000))
        #expect(keeper.observe(state, now: now, opening: true), "a tab to share appeared")
        #expect(!keeper.observe(state, now: now, opening: true), "the same tab again is not a change")
        state.tabs[state.tabs.firstIndex { $0.id == "new" }!].url = "https://elsewhere.example/"
        #expect(!keeper.observe(state, now: now, opening: true), "a navigation is not one")
        state.tabs.append(tab("blank", url: BrowserState.blankURL, age: 1_000))
        #expect(!keeper.observe(state, now: now, opening: true), "a blank tab is not shared, so it does not ask")
        state.tabs.append(tab("second", age: 1_000))
        #expect(!keeper.observe(state, now: now, opening: false), "the category is not ticked here")
    }

    // MARK: The door

    private func entity(_ fields: [String: JSONValue]) -> SyncEntity {
        let stamp = String(format: "%013ld-%04lx-vector-mac-0000000001", now - 1_000, 0)
        return SyncEntity(fields: fields, stamps: Dictionary(uniqueKeysWithValues: fields.keys.map { ($0, stamp) }))
    }

    @Test func theDoorRefusesAnAddressThatIsNotAPageAndTheBaseStandsIn() {
        var snapshot = SyncSnapshot()
        snapshot.entities[SyncToday.kind] = ["bad": entity(["spaceId": .string("s1"), "url": .string("javascript:alert(1)"), "title": .string("x"), "activeAt": .number(0)]),
                                             "ok": entity(["spaceId": .string("s1"), "url": .string("https://ok.example/"), "title": .string("ok"), "activeAt": .number(600_000)])]
        var base = SyncSnapshot()
        base.entities[SyncToday.kind] = ["bad": entity(["spaceId": .string("s1"), "activeAt": .number(0)])]
        let cleaned = SyncInbound.clean(snapshot, now: now, base: base)
        #expect(cleaned.refused.map { "\($0.id):\($0.reason.rawValue)" } == ["bad:invalid-url"])
        #expect(cleaned.snapshot.entities[SyncToday.kind]?["bad"] == base.entities[SyncToday.kind]?["bad"], "the entity of the base is given back: the gap is not a closing")
        #expect(cleaned.snapshot.entities[SyncToday.kind]?["ok"] != nil)
        #expect(SyncInbound.clean(snapshot, now: now).snapshot.entities[SyncToday.kind]?["bad"] == nil, "no base: it is left out")
    }

    @Test func theDoorTakesTheLocalFieldsOffCutsTheTitleAndKeepsTheBestFiveHundred() {
        let long = String(repeating: "é", count: 400)
        var snapshot = SyncSnapshot()
        snapshot.entities[SyncToday.kind] = ["t": entity(["spaceId": .string("s1"), "url": .string("https://t.example/"), "title": .string(long), "activeAt": .number(0), "lastActiveAt": .number(5), "createdAt": .number(5)])]
        let one = SyncInbound.clean(snapshot, now: now).snapshot.entities[SyncToday.kind]?["t"]
        #expect(one?.fields["lastActiveAt"] == nil && one?.fields["createdAt"] == nil && one?.stamps["createdAt"] == nil)
        if case .string(let title)? = one?.fields["title"] { #expect(title.utf8.count <= SyncToday.titleMaxBytes && title.utf8.count > SyncToday.titleMaxBytes - 2) } else { Issue.record("no title") }
        var big = SyncSnapshot()
        for index in 0...500 { big.entities[SyncToday.kind, default: [:]][String(format: "t%03d", index)] = entity(["spaceId": .string("s1"), "url": .string("https://t.example/"), "activeAt": .number(Double(index))]) }
        let cleaned = SyncInbound.clean(big, now: now)
        #expect(cleaned.snapshot.entities[SyncToday.kind]?.count == SyncToday.gate)
        #expect(cleaned.refused.map { "\($0.id):\($0.reason.rawValue)" } == ["t000:too-many-today-tabs"], "the least recently used one is left out")
    }

    @Test func aMarkFromTheFutureIsRefusedForATodayTabToo() {
        var snapshot = SyncSnapshot()
        let future = String(format: "%013ld-%04lx-vector-mac-0000000001", now + SyncInbound.futureRefusalMilliseconds + 60_000, 0)
        snapshot.entities[SyncToday.kind] = ["t": SyncEntity(fields: ["spaceId": .string("s1"), "url": .string("https://t.example/"), "activeAt": .number(0)], stamps: ["spaceId": future])]
        let cleaned = SyncInbound.clean(snapshot, now: now)
        #expect(cleaned.refused.map(\.reason) == [.futureMark])
        #expect(cleaned.snapshot.entities[SyncToday.kind]?["t"] == nil)
    }

    @Test func whatIsNotTheCommonCategoriesIsNotTakenAndTheTabsListGoesWithTheKind() {
        var snapshot = SyncSnapshot()
        snapshot.entities[SyncToday.kind] = ["t": entity(["spaceId": .string("s1"), "url": .string("https://t.example/"), "activeAt": .number(0)])]
        snapshot.order["today:s1"] = ["t"]
        snapshot.tombstones[SyncToday.kind] = ["gone": String(format: "%013ld-%04lx-vector-mac-0000000001", now, 0)]
        let without = SyncInbound.onlyExchanged(snapshot, categories: [.structure])
        #expect(without.snapshot.entities[SyncToday.kind] == nil && without.snapshot.order["today:s1"] == nil && without.snapshot.tombstones[SyncToday.kind] == nil)
        #expect(without.refused.count == 3)
        let with = SyncInbound.onlyExchanged(snapshot, categories: [.todayTabs])
        #expect(with.snapshot == snapshot && with.refused.isEmpty)
    }

    @Test func aPhoneThatAdoptsTheMacsStructureKeepsTheTodayTabsItSends() {
        var snapshot = SyncSnapshot()
        snapshot.entities = ["space": ["s1": entity(["name": .string("x")])], SyncToday.kind: ["t": entity(["spaceId": .string("s1"), "url": .string("https://t.example/"), "activeAt": .number(0)])]]
        snapshot.order = ["spaces": ["s1"], "today:s1": ["t"]]
        snapshot.orderStamps = ["spaces": "a", "today:s1": "b"]
        snapshot.tombstones = ["tab": ["p": "c"], SyncToday.kind: ["gone": "d"]]
        let left = snapshot.withoutStructure()
        #expect(left.entities.keys.sorted() == [SyncToday.kind] && left.order == ["today:s1": ["t"]] && left.orderStamps == ["today:s1": "b"] && left.tombstones == [SyncToday.kind: ["gone": "d"]])
    }

    // MARK: The state

    private func upsert(_ id: String, create: Bool = true, fields: [String: JSONValue], remove: [String] = [], expect: [String: JSONValue] = [:], kind: SyncFieldClasses.Kind = .todayTab) -> SyncPatch.Upsert {
        SyncPatch.Upsert(kind: kind, id: id, create: create, fields: fields, remove: remove, expect: expect)
    }

    private func apply(_ patch: SyncPatch, to state: BrowserState) -> SyncApply.Outcome { SyncApply.apply(patch, to: state, now: Double(now)) }

    private func patch(upserts: [SyncPatch.Upsert] = [], removals: [SyncPatch.Removal] = [], order: [String: [String]] = [:]) -> SyncPatch {
        var patch = SyncPatch()
        patch.upserts = upserts
        patch.removals = removals
        patch.order = order
        return patch
    }

    @Test func aTabOfTheOtherDeviceIsMadeAtRestWithItsAgeAndNeverShown() throws {
        let before = try state([tab("mine")])
        let activeAt = Double(now - 7_200_000)
        let outcome = apply(patch(upserts: [upsert("theirs", fields: ["spaceId": .string("s1"), "url": .string("https://theirs.example/p"), "title": .string("Theirs"), "customTitle": .string("Nom"), "icon": .string("🦊"),
                                                                      "activeAt": .number(activeAt)])]), to: before)
        let made = try #require(outcome.state.tabs.first { $0.id == "theirs" })
        #expect(!made.pinned && made.url == "https://theirs.example/p" && made.title == "Theirs")
        #expect(made.createdAt == activeAt && made.lastActiveAt == activeAt, "it arrives as old as it is: the archive treats it the same on both devices")
        #expect(made.rest["customTitle"] == .string("Nom") && made.rest["icon"] == .string("🦊"))
        #expect(made.rest["activeAt"] == nil, "activeAt is not a field of a tab")
        #expect(made.rest["private"] == nil && made.favoriteId == nil)
        #expect(outcome.state.activeSpaceId == before.activeSpaceId && outcome.state.activeTabBySpace == before.activeTabBySpace, "an arrival never changes what is on screen (§27.6)")
        #expect(outcome.state.tabs.last?.id == "theirs", "it goes after the tabs this device has")
    }

    @Test func aTabArrivesWithTheHostOfItsAddressAsTitleWhenTheOtherDeviceGaveNone() throws {
        let outcome = apply(patch(upserts: [upsert("t", fields: ["spaceId": .string("s1"), "url": .string("https://no-title.example/page"), "activeAt": .number(0)])]), to: try state([]))
        #expect(outcome.state.tabs.first { $0.id == "t" }?.title == AddressResolver.host(of: "https://no-title.example/page"))
    }

    @Test func aRestoreOfAClosedTabsFieldIsWrittenAndTheJournalNeverReadsLikeAHistory() throws {
        var before = try state([tab("t", title: "Secret title")])
        before.tabs[before.tabs.firstIndex { $0.id == "t" }!].rest["customTitle"] = .string("Mon nom")
        let restored = SyncApply.restore(.set(kind: SyncToday.kind, id: "t", field: "customTitle", value: .string("Rétabli")), to: before, now: Double(now))
        #expect(restored.state.tabs.first { $0.id == "t" }?.rest["customTitle"] == .string("Rétabli"))
        #expect(SyncConflicts.label(kind: SyncToday.kind, fields: ["customTitle": .string("Mon nom"), "title": .string("Secret title"), "url": .string("https://secret.example/")]) == "Mon nom")
        #expect(SyncConflicts.label(kind: SyncToday.kind, fields: ["title": .string("Secret title"), "url": .string("https://secret.example/")]) == nil, "no name: the line says « Onglet », not the page")
    }

    @Test func aTabOfTheOtherDeviceWithoutAPageOrInAnUnknownSpaceIsNotMade() throws {
        let before = try state([])
        let outcome = apply(patch(upserts: [upsert("nopage", fields: ["spaceId": .string("s1"), "activeAt": .number(0)]),
                                            upsert("nospace", fields: ["spaceId": .string("gone"), "url": .string("https://x.example/"), "activeAt": .number(0)]),
                                            upsert("script", fields: ["spaceId": .string("s1"), "url": .string("javascript:1"), "activeAt": .number(0)])]), to: before)
        #expect(outcome.state.tabs == before.tabs)
        #expect(outcome.rejected.count >= 2)
    }

    @Test func aTabReadOnTheOtherDeviceIsNotSweptHereAndAnOlderReadingDoesNotLowerIt() throws {
        let hours = 13.0
        let old = Double(now) - hours * 3_600_000
        var before = try state([tab("t", age: Int(hours * 3_600_000), lastUsed: old)])
        before.activeTabBySpace["s1"] = .some(nil)
        var swept = before
        #expect(swept.sweepIdleTabs(now: Double(now)).map(\.id) == ["t"], "alone, the tab is idle past the 12 hours of the default profile")
        let readThere = Double(now) - 600_000
        let read = apply(patch(upserts: [upsert("t", create: false, fields: ["activeAt": .number(readThere)], expect: ["activeAt": .number(Double(SyncToday.roundActiveAt(old)))])]), to: before)
        #expect(read.state.tabs.first { $0.id == "t" }?.lastActiveAt == readThere)
        var kept = read.state
        #expect(kept.sweepIdleTabs(now: Double(now)).isEmpty, "read on the other device ten minutes ago: not idle (§27.5, [Q10])")
        let lower = apply(patch(upserts: [upsert("t", create: false, fields: ["activeAt": .number(old)], expect: [:])]), to: read.state)
        #expect(lower.state.tabs.first { $0.id == "t" }?.lastActiveAt == readThere, "the later of the two moments")
    }

    @Test func aRenameAMoveAndAnIconCrossOnlyWhileTheFieldIsAsTheSessionFroze() throws {
        var before = try state([tab("t")])
        let at = before.tabs.firstIndex { $0.id == "t" }!
        before.tabs[at].rest["customTitle"] = .string("Avant")
        let changed = apply(patch(upserts: [upsert("t", create: false, fields: ["customTitle": .string("Après"), "spaceId": .string("s2"), "icon": .string("🔥")], remove: [],
                                                   expect: ["customTitle": .string("Avant"), "spaceId": .string("s1")])]), to: before)
        let tab = try #require(changed.state.tabs.first { $0.id == "t" })
        #expect(tab.rest["customTitle"] == .string("Après") && tab.spaceId == "s2" && tab.rest["icon"] == .string("🔥"))
        var renamedHere = before
        renamedHere.tabs[at].rest["customTitle"] = .string("Ici")
        let kept = apply(patch(upserts: [upsert("t", create: false, fields: ["customTitle": .string("Après")], expect: ["customTitle": .string("Avant")])]), to: renamedHere)
        #expect(kept.state.tabs.first { $0.id == "t" }?.rest["customTitle"] == .string("Ici"), "what the person did meanwhile keeps their change")
        let removed = apply(patch(upserts: [upsert("t", create: false, fields: [:], remove: ["customTitle"], expect: ["customTitle": .string("Avant")])]), to: before)
        #expect(removed.state.tabs.first { $0.id == "t" }?.rest["customTitle"] == nil)
    }

    @Test func aTabTheOtherDeviceClosedGoesToTheArchiveAsSyncWithThePageItIsOnNow() throws {
        var before = try state([tab("gone", url: "https://gone.example/now", title: "Gone now"), tab("stay")])
        before.activeTabBySpace["s1"] = .some("stay")
        before.archive.insert(ArchivedTab(id: "gone", spaceId: "s1", url: "https://gone.example/old", title: "Older", archivedAt: 1), at: 0)
        let frozen = ["spaceId": JSONValue.string("s1"), "activeAt": .number(Double(SyncToday.roundActiveAt(Double(now - 60_000))))]
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .todayTab, id: "gone", expect: frozen)]), to: before)
        #expect(!outcome.state.tabs.contains { $0.id == "gone" } && outcome.state.tabs.contains { $0.id == "stay" })
        #expect(outcome.closedTabIDs == ["gone"] && outcome.removedTabIDs == ["gone"])
        let entries = outcome.state.archive.filter { $0.id == "gone" }
        #expect(entries.count == 1, "the id of the entry is the id of the tab: an archive that is shared holds it once")
        #expect(entries.first?.url == "https://gone.example/now" && entries.first?.title == "Gone now" && entries.first?.source == ArchivedTab.Source.sync.rawValue)
    }

    @Test func aTabThatWasUsedHereSinceTheSessionFrozeIsNotClosed() throws {
        let before = try state([tab("t", lastUsed: Double(now - 1_000))])
        let frozen = ["spaceId": JSONValue.string("s1"), "activeAt": .number(Double(SyncToday.roundActiveAt(Double(now - 3_000_000))))]
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .todayTab, id: "t", expect: frozen)]), to: before)
        #expect(outcome.state.tabs.contains { $0.id == "t" } && outcome.closedTabIDs.isEmpty && outcome.state.archive == before.archive, "the read wins over the closing (§27.9)")
        var pinnedHere = before
        pinnedHere.tabs[pinnedHere.tabs.firstIndex { $0.id == "t" }!].pinned = true
        let notFrozen = ["spaceId": JSONValue.string("s1"), "activeAt": .number(Double(SyncToday.roundActiveAt(Double(now - 1_000))))]
        #expect(apply(patch(removals: [SyncPatch.Removal(kind: .todayTab, id: "t", expect: notFrozen)]), to: pinnedHere).state.tabs.contains { $0.id == "t" }, "a tab pinned here is not a Today tab any more: it is not closed")
    }

    @Test func theTabOnScreenThatTheOtherDeviceClosedGivesWayToTheMostRecentOne() throws {
        var before = try state([tab("older", lastUsed: Double(now - 500_000)), tab("shown", lastUsed: Double(now - 100_000)), tab("recent", lastUsed: Double(now - 200_000))])
        before.activeTabBySpace["s1"] = .some("shown")
        let frozen = ["spaceId": JSONValue.string("s1"), "activeAt": .number(Double(SyncToday.roundActiveAt(Double(now - 100_000))))]
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .todayTab, id: "shown", expect: frozen)]), to: before)
        #expect(outcome.closedTabIDs == ["shown"])
        #expect(outcome.state.activeTab(in: "s1")?.id == "recent", "the neighbour is shown (§27.5, [Q11]): the one used last")
        #expect(outcome.state.archive.first?.id == "shown")
    }

    @Test func aPrivateOrBlankTabClosedThereIsOnlyRemoved() throws {
        let blank = tab("blank", url: BrowserState.blankURL)
        let before = try state([blank])
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .todayTab, id: "blank", expect: [:])]), to: before)
        #expect(!outcome.state.tabs.contains { $0.id == "blank" } && !outcome.state.archive.contains { $0.id == "blank" } && outcome.closedTabIDs == ["blank"])
    }

    @Test func pinningOnTheOtherDeviceKeepsTheTabAndItsPageAndDetachingUnpinsIt() throws {
        let before = try state([tab("t", url: "https://t.example/deep/page", title: "Deep")])
        let pin = apply(patch(upserts: [upsert("t", fields: ["spaceId": .string("s1"), "pinned": .bool(true), "anchorUrl": .string("https://t.example/"), "folderId": .string("f1"),
                                                              "url": .string("https://t.example/"), "title": .string("Home")], kind: .tab)],
                              removals: [SyncPatch.Removal(kind: .todayTab, id: "t", expect: [:])]), to: before)
        let pinned = try #require(pin.state.tabs.first { $0.id == "t" })
        #expect(pinned.pinned && pinned.anchorUrl == "https://t.example/" && pinned.folderId == "f1" && pinned.url == "https://t.example/deep/page" && pinned.title == "Deep")
        #expect(pin.closedTabIDs.isEmpty && !pin.state.archive.contains { $0.id == "t" }, "a move is not a closing")
        let detach = apply(patch(upserts: [upsert("t", fields: ["spaceId": .string("s1"), "activeAt": .number(Double(now - 60_000)), "url": .string("https://t.example/other"), "title": .string("Other")])],
                                 removals: [SyncPatch.Removal(kind: .tab, id: "t", expect: [:])]), to: pin.state)
        let loose = try #require(detach.state.tabs.first { $0.id == "t" })
        #expect(!loose.pinned && loose.anchorUrl == nil && loose.folderId == nil && loose.url == "https://t.example/deep/page" && loose.title == "Deep", "the page it is on is not replaced by the seed")
    }

    @Test func aPinnedTabThatIsNeitherMovedNorTheOthersIsLeftAlone() throws {
        var before = try state([])
        before.tabs.append({ var pinned = tab("p"); pinned.pinned = true; return pinned }())
        let outcome = apply(patch(removals: [SyncPatch.Removal(kind: .todayTab, id: "p", expect: [:])]), to: before)
        #expect(outcome.state.tabs.contains { $0.id == "p" }, "a removal of todayTab/p is a closing of a Today tab, never of a pinned one")
    }

    @Test func theListOfTheOtherDeviceOrdersTheTabsItNamesAndLeavesTheOthersWhereTheyAre() throws {
        let before = try state([tab("a"), tab("local1"), tab("b"), tab("local2"), tab("c")])
        let outcome = apply(patch(order: ["today:s1": ["c", "a", "b"]]), to: before)
        #expect(outcome.state.tabs.filter { !$0.pinned }.map(\.id) == ["c", "local1", "a", "local2", "b"], "the shared tabs take each other's places; the local ones do not move")
    }

    // MARK: A whole session

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
        let body: SyncExchangeBody
        func cleanup() { try? FileManager.default.removeItem(at: directory) }
    }

    private func rig(_ tabs: [TabItem], clock: @escaping @Sendable () -> Int = { SyncStateFixtures.now }) throws -> Rig {
        let dir = directory()
        let host = SyncTestHost(state: try state(tabs))
        let marks = keeper(in: dir)
        let bases = SyncBaseStore(directory: dir)
        return Rig(directory: dir, host: host, marks: marks, bases: bases, body: SyncExchangeBody(host: host, marks: marks, bases: bases, now: clock, idleTimeout: .seconds(2)))
    }

    private func stamp(_ ms: Int, _ counter: Int = 0) -> String { String(format: "%013ld-%04lx-vector-mac-0000000001", ms, counter) }

    @discardableResult
    private func session(_ rig: Rig, mac script: SyncTestMac) async throws -> SyncTestMac.Seen {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let at = now
        let macTask = Task { try await script.run(fake, now: at) }
        defer { macTask.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        let baseHash = await rig.body.baseHash(forMac: peer.id)
        _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.structure, .todayTabs], appVersion: "0.1.0", supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16),
                                            baseHash: baseHash, now: { at }, body: rig.body, handshakeTimeout: .seconds(2))
        return (try? await macTask.value) ?? SyncTestMac.Seen()
    }

    /// What the Mac holds when it has one Today tab, `m1`, in the space `s1`, opened `age` ms ago.
    private func macWithATab(age: Int = 3_600_000) -> SyncSnapshot {
        let at = stamp(now - age)
        var snapshot = SyncSnapshot()
        snapshot.entities[SyncToday.kind] = ["m1": SyncEntity(fields: ["spaceId": .string("s1"), "url": .string("https://mac.example/a"), "title": .string("Mac page"), "activeAt": .number(Double(SyncToday.roundActiveAt(Double(now - age))))],
                                                              stamps: ["spaceId": at, "url": at, "title": at, "activeAt": at])]
        snapshot.order["today:s1"] = ["m1"]
        snapshot.orderStamps["today:s1"] = at
        return snapshot
    }

    @Test func theHelloLeavesTodayTabsOutWhenTheStructureIsNotTicked() async throws {
        let rig = try rig([tab("mine")])
        defer { rig.cleanup() }
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let at = now
        let macTask = Task { try await SyncTestMac(snapshot: SyncSnapshot(), categories: ["structure", "todayTabs"]).run(fake, now: at) }
        defer { macTask.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        _ = try await SyncSessionClient.run(connection: connection, peer: peer, device: phone, categories: [.todayTabs, .archive], appVersion: "0.1.0", supportedStateVersion: 1, nonce: Data(repeating: 9, count: 16),
                                            baseHash: nil, now: { at }, body: rig.body, handshakeTimeout: .seconds(2))
        let seen = try await macTask.value
        #expect(seen.hello["categories"] as? [String] == ["archive"])
        #expect(seen.phone.entities[SyncToday.kind] == nil, "nothing of the Today tabs was sent")
        let state = await rig.host.state
        #expect(state.tabs.contains { $0.id == "mine" }, "and the phone's own tab is not removed")
    }

    @Test func aTabOpenedOnTheMacArrivesAndAClosingOnTheMacArchivesIt() async throws {
        let rig = try rig([])
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: macWithATab(), categories: ["structure", "todayTabs"]))
        let held = SyncStateView.base(of: try #require(first.merged).snapshot)
        let afterFirst = await rig.host.state
        let arrived = try #require(afterFirst.tabs.first { $0.id == "m1" })
        #expect(!arrived.pinned && arrived.url == "https://mac.example/a" && arrived.title == "Mac page")
        #expect(afterFirst.activeTab(in: "s1")?.id != "m1", "it is not shown")
        // The next session with nothing new on either side writes nothing: the tab that came is not sent back, nor marked deleted.
        let quiet = try await session(rig, mac: SyncTestMac(snapshot: held, base: held, categories: ["structure", "todayTabs"]))
        #expect(await rig.host.patches.count == 1, "nothing more was written")
        #expect(quiet.phone.tombstones[SyncToday.kind] == nil, "the phone does not say it closed a tab it received")
        #expect(quiet.phone.entities[SyncToday.kind]?["m1"] != nil && quiet.phone.entities[SyncToday.kind]?["m1"]?.fields["url"] == nil, "it is sent again as a known tab: without its page")
        // The Mac closes it.
        var after = held
        after.entities[SyncToday.kind]?["m1"] = nil
        after.order["today:s1"] = []
        after.tombstones[SyncToday.kind] = ["m1": stamp(now + 5_000, 1)]
        _ = try await session(rig, mac: SyncTestMac(snapshot: after, base: held, categories: ["structure", "todayTabs"]))
        let state = await rig.host.state
        #expect(!state.tabs.contains { $0.id == "m1" })
        #expect(state.archive.first?.id == "m1" && state.archive.first?.source == ArchivedTab.Source.sync.rawValue && state.archive.first?.url == "https://mac.example/a")
        let outcome = try #require(await rig.host.outcomes.last)
        #expect(outcome.closedTabIDs == ["m1"])
    }

    @Test func theSummaryCountsTheTodayTabsTakenFromTheMacAndTheOnesKeptBecauseTheSetWasFull() async throws {
        // 203 tabs here, all old enough: 200 go in the shared set, 3 stay here (§27.4); the Mac gives one tab, which is new here.
        let many = (0..<203).map { tab(String(format: "t%03d", $0), lastUsed: Double(now - 100_000 + $0)) }
        let rig = try rig(many)
        defer { rig.cleanup() }
        try await session(rig, mac: SyncTestMac(snapshot: macWithATab(), categories: ["structure", "todayTabs"]))
        let summary = try #require(await rig.host.summaries.last)
        #expect(summary.todayTabsTaken == 1)
        #expect(summary.todayTabsUnshared == 3)
        #expect(SyncLastExchange.lines(of: summary, ticked: [.structure, .todayTabs]).contains(.todayTabsReceived(1)))
        #expect(SyncLastExchange.lines(of: summary, ticked: [.structure, .todayTabs]).contains(.todayTabsUnshared(3)))
    }

    @Test func aRenameOfATabTheMacAlreadyGaveIsNotATabReceivedAndTheLimitIsForgottenWhenTheCategoryStopsCrossing() async throws {
        let many = (0..<203).map { tab(String(format: "t%03d", $0), lastUsed: Double(now - 100_000 + $0)) }
        let rig = try rig(many)
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: macWithATab(), categories: ["structure", "todayTabs"]))
        #expect(try #require(await rig.host.summaries.last).todayTabsUnshared == 3)
        let held = SyncStateView.base(of: try #require(first.merged).snapshot)
        // The Mac renames the tab it gave: a change of a tab already here, not a tab that arrived.
        var renamed = held
        renamed.entities[SyncToday.kind]?["m1"]?.fields["customTitle"] = .string("Renamed")
        renamed.entities[SyncToday.kind]?["m1"]?.stamps["customTitle"] = stamp(now + 5_000, 1)
        try await session(rig, mac: SyncTestMac(snapshot: renamed, base: held, categories: ["structure", "todayTabs"]))
        let second = try #require(await rig.host.summaries.last)
        #expect(second.taken > 0 && second.todayTabsTaken == 0)
        // The Mac stops announcing the category: the phone does not repeat the number of the session before.
        try await session(rig, mac: SyncTestMac(snapshot: SyncSnapshot(), categories: ["structure"]))
        #expect(try #require(await rig.host.summaries.last).todayTabsUnshared == 0)
    }

    @Test func theSummaryCountsNoTodayTabWhileTheCategoryIsNotCommon() async throws {
        let rig = try rig([tab("mine")])
        defer { rig.cleanup() }
        try await session(rig, mac: SyncTestMac(snapshot: SyncSnapshot(), categories: ["structure"]))
        let summary = try #require(await rig.host.summaries.last)
        #expect(summary.todayTabsTaken == 0 && summary.todayTabsUnshared == 0)
    }

    @Test func aTabOpenedOnThePhoneGoesToTheMacAndItsClosingGoesToo() async throws {
        let rig = try rig([tab("mine")])
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: SyncSnapshot(), categories: ["structure", "todayTabs"]))
        #expect(first.phone.entities[SyncToday.kind]?["mine"]?.fields["url"] == .string("https://mine.example/"), "the Mac gets the page once, with the new tab")
        #expect(first.phone.order["today:s1"] == ["mine"])
        let held = SyncStateView.base(of: try #require(first.merged).snapshot)
        // The person closes it on the phone: the Mac is told, with a mark.
        var closed = await rig.host.state
        closed.archive(tabIds: ["mine"], source: .manual, now: Double(now))
        await rig.host.set(state: closed)
        let second = try await session(rig, mac: SyncTestMac(snapshot: held, base: held, categories: ["structure", "todayTabs"]))
        #expect(second.phone.entities[SyncToday.kind]?["mine"] == nil && second.phone.tombstones[SyncToday.kind]?["mine"] != nil)
        #expect(second.merged?.snapshot.entities[SyncToday.kind]?["mine"] == nil, "the merge closes it on the Mac")
    }

    @Test func aTabReadOnThePhoneWhileTheMacClosedItIsKept() async throws {
        let rig = try rig([tab("mine", age: 7_200_000, lastUsed: Double(now - 7_200_000))])
        defer { rig.cleanup() }
        let first = try await session(rig, mac: SyncTestMac(snapshot: SyncSnapshot(), categories: ["structure", "todayTabs"]))
        let held = SyncStateView.base(of: try #require(first.merged).snapshot)
        var read = await rig.host.state
        read.tabs[read.tabs.firstIndex { $0.id == "mine" }!].lastActiveAt = Double(now - 600_000 * 2)
        await rig.host.set(state: read)
        var macClosed = held
        macClosed.entities[SyncToday.kind]?["mine"] = nil
        macClosed.tombstones[SyncToday.kind] = ["mine": stamp(now + 5_000, 1)]
        _ = try await session(rig, mac: SyncTestMac(snapshot: macClosed, base: held, categories: ["structure", "todayTabs"]))
        let kept = await rig.host.state
        #expect(kept.tabs.contains { $0.id == "mine" }, "read here after it was frozen on the Mac's side: the modification wins the closing (§27.9)")
    }
}
