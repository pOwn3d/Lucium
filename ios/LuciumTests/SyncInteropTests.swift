import Foundation
import LuciumKit
import XCTest
@testable import Lucium

/// The Mac and the iPhone understand each other (docs/synchronisation.md §4.7, §27, §28): the real Swift of the phone (the application's controller, over the real TLS
/// connector, on a simulator) against the real TypeScript of the Mac (src/main/sync/, under Node), over a real address of this machine's local network. Started by
/// scripts/sync-interop/run.sh, which starts the Mac and gives these tests its control port; skipped without it. See scripts/sync-interop/README.md.
@MainActor
final class SyncInteropTests: BrowserCoreTestCase {
    private var store: TestIdentityStore!

    override func setUp() async throws {
        try await super.setUp()
        store = TestIdentityStore()
    }

    override func tearDown() async throws {
        store.cleanUp()
        try await super.tearDown()
    }

    private func makePhone(_ peer: MacPeerClient, categories: [SyncCategory], macCategories: [SyncCategory]? = nil) async throws -> InteropPhone {
        try await peer.reset()
        try await peer.enable(macCategories ?? categories)
        // A folder of its own: each phone has its own state file, its own settings and marks.
        let folder = directory.appending(path: "phone-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let model = await makeModel(in: folder)
        return try InteropPhone(peer: peer, model: model, directory: folder, store: store, categories: categories)
    }

    /// Everything both sides must agree on after a session: the structure (spaces, folders, favourites, pinned tabs) and, when the Today tabs are shared, theirs.
    private func assertSameStructure(_ phone: InteropPhone, _ label: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let mac = try await phone.peer.summary()
        XCTAssertEqual(phone.spaceIDs, mac.spaceIDs, "\(label): spaces", file: file, line: line)
        XCTAssertEqual(phone.folderIDs, mac.folderIDs, "\(label): folders", file: file, line: line)
        XCTAssertEqual(phone.favoriteIDs, mac.favoriteIDs, "\(label): favourites", file: file, line: line)
        XCTAssertEqual(phone.pinnedIDs(), mac.pinnedIDs, "\(label): pinned tabs", file: file, line: line)
    }

    private func assertSameToday(_ phone: InteropPhone, _ label: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let mac = try await phone.peer.summary()
        XCTAssertEqual(phone.todayIDs(), mac.todayIDs(), "\(label): Today tabs", file: file, line: line)
    }

    /// The base both devices keep after a session must be the same one (the `baseHash` of the next `hello`, §8.2).
    private func assertSameBase(_ phone: InteropPhone, _ label: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        guard let mac = phone.controller.settings.mac else { return XCTFail("\(label): no Mac paired", file: file, line: line) }
        let theirs = try await phone.peer.baseHash(forPhone: phone.deviceId)
        let ours = SyncBaseStore(directory: phone.directory).get(peerId: mac.id, now: Int(Date().timeIntervalSince1970 * 1000))
        XCTAssertNotNil(theirs, "\(label): the Mac kept a base", file: file, line: line)
        XCTAssertNotNil(ours, "\(label): the phone kept a base", file: file, line: line)
        XCTAssertEqual(ours?.hash, theirs?.hash, "\(label): the two bases are the same", file: file, line: line)
    }

    // MARK: The whole story

    func testPairingThenSessionsInBothDirections() async throws {
        let peer = try MacPeerClient.fromEnvironment()
        let phone = try await makePhone(peer, categories: [.structure, .todayTabs, .archive])
        let phoneSpace = phone.model.state.activeSpaceId
        let profile = phone.model.state.spaces.first?.profileId ?? "default"
        let now = Date().timeIntervalSince1970 * 1000

        // What each device has before it has met the other: a space of its own with a folder, a favourite, a pinned tab and some Today tabs.
        try await peer.dispatch("space/create", ["name": .string("Mac extra"), "emoji": .string("🍎"), "hue": .number(120)])
        try await peer.dispatch("folder/create", ["name": .string("Dossier Mac"), "spaceId": .string("sp-mac")])
        try await peer.dispatch("favorite/add", ["url": .string("https://mac-fav.example/"), "title": .string("Fav Mac"), "spaceId": .string("sp-mac")])
        try await peer.dispatch("tab/open", ["url": .string("https://mac-pinned.example/"), "spaceId": .string("sp-mac"), "background": .bool(true)])
        var macState = try await peer.summary()
        let macPinned = try XCTUnwrap(macState.tabs.first { $0.url == "https://mac-pinned.example/" }).id
        try await peer.dispatch("tab/pin", ["id": .string(macPinned)])
        try await peer.seedToday(3, space: "sp-mac", prefix: "mac-t")
        phone.edit { state in
            _ = state.createFolder(id: "folder-phone", name: "Dossier iPhone", fallbackName: "Folder", in: phoneSpace)
            _ = state.addFavorite(id: "fav-phone", url: "https://phone-fav.example/", title: "Fav iPhone", in: phoneSpace)
            _ = try? state.addSpace(id: "sp-phone-extra", name: "iPhone extra", emoji: "📱", profileId: profile, hue: 200)
        }
        phone.openToday("phone-pinned", in: phoneSpace)
        phone.edit { $0.pin(tabId: "phone-pinned") }
        phone.seedToday(3, in: phoneSpace, prefix: "phone-t")
        phone.openToday("phone-read", in: phoneSpace, ageMs: 1_800_000)

        // 1. The pairing of §4.7: the two devices show the same words, and a second phone with the same QR gets nothing.
        let view = try await peer.pair()
        let code = try SyncPairingCode.parse(qr: view.qr).get()
        let pairing = Task { await phone.controller.pair(with: code) }
        try await phone.waitFor("the words to compare") { if case .comparing = phone.controller.pairingStep { return true } else { return false } }
        guard case .comparing(let proposal) = phone.controller.pairingStep else { return XCTFail("no proposal") }
        let shownOnMac = try await peer.status().codesShown
        XCTAssertEqual(shownOnMac.count, 1)
        XCTAssertEqual(proposal.code, shownOnMac.first, "the two devices show the same words (§4.6, §4.7)")
        phone.controller.answerComparison(true)
        let paired = await pairing.value
        if case .failure(let failure) = paired { XCTFail("the pairing failed: \(failure)") }
        let afterPairing = try await peer.status()
        XCTAssertEqual(afterPairing.devices.map(\.id), [phone.deviceId], "the Mac knows the phone, and only it")
        try await expectBurntSecret(code: code)

        // The pairing started a first session by itself (§4.1): wait for it, then compare.
        try await phone.waitFor("the first session after the pairing") { phone.host.sessionsDone >= 1 && phone.controller.status != .running }
        try await assertSameStructure(phone, "first session")
        macState = try await peer.summary()
        XCTAssertTrue(phone.spaceIDs.isSuperset(of: ["sp-mac"]) && macState.spaceIDs.isSuperset(of: ["sp-phone-extra"]), "each device got the other's space")
        XCTAssertTrue(phone.pinnedIDs().contains(macPinned) && macState.pinnedIDs.contains("phone-pinned"), "pinned tabs cross both ways")
        XCTAssertEqual(phone.todayIDs(in: "sp-mac").filter { $0.hasPrefix("mac-t") }.count, 3, "the Mac's Today tabs arrived, asleep")
        XCTAssertEqual(macState.todayIDs().filter { $0.hasPrefix("phone-t") }.count, 3, "the phone's Today tabs arrived at the Mac")
        try await assertSameToday(phone, "first session")
        try await assertSameBase(phone, "first session")
        XCTAssertNil(phone.model.webViews["mac-t-000"], "a tab that arrives is asleep: nothing is loaded for it (§27.12)")

        // 2. Opening a tab: too young to be shared (§27.3, 20 seconds), then shared both ways once old enough, with its page.
        try await peer.dispatch("tab/open", ["url": .string("https://opened-on-mac.example/a"), "spaceId": .string("sp-mac"), "background": .bool(true)])
        phone.openToday("opened-on-phone", in: phoneSpace, url: "https://opened-on-phone.example/a", ageMs: 0)
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertFalse(macState.tabs.contains { $0.id == "opened-on-phone" }, "a tab younger than 20 seconds does not leave the phone (Mac side of the proof)")
        XCTAssertFalse(phone.model.state.tabs.contains { $0.url == "https://opened-on-mac.example/a" }, "a tab younger than 20 seconds does not leave the Mac (phone side of the proof)")
        try await Task.sleep(for: .seconds(21))
        // The phone's tab has no change since: it is seen as a change when it is admitted at the next freeze, so the person's change is what asks for the session.
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertEqual(macState.tabs.first { $0.id == "opened-on-phone" }?.url, "https://opened-on-phone.example/a", "the phone's new tab reached the Mac with its page")
        let onPhone = phone.model.state.tabs.first { $0.url == "https://opened-on-mac.example/a" }
        XCTAssertNotNil(onPhone, "the Mac's new tab reached the phone with its page")
        try await assertSameToday(phone, "tabs opened both ways")
        let macOpenedID = try XCTUnwrap(onPhone?.id)

        // 3. Closing: a tab closed on one device is archived on the other (source sync), both ways.
        try await peer.dispatch("tab/archive", ["id": .string("phone-t-000")])
        let macTabOnPhone = try XCTUnwrap(phone.tab("mac-t-000"))
        phone.model.archive(macTabOnPhone)
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertNil(phone.tab("phone-t-000"), "closed on the Mac, closed on the phone")
        XCTAssertEqual(phone.model.state.archive.first { $0.id == "phone-t-000" }?.source, "sync", "…and kept in the phone's archive, source sync (§27.5)")
        XCTAssertFalse(macState.tabs.contains { $0.id == "mac-t-000" }, "closed on the phone, closed on the Mac")
        XCTAssertEqual(macState.archive.first { $0.id == "mac-t-000" }?.source, "sync", "…and kept in the Mac's archive, source sync")
        XCTAssertEqual(phone.archiveIDs, macState.archiveIDs, "the archive is the same on both (same ids, §27.5)")
        try await assertSameToday(phone, "tabs closed both ways")

        // 4. Pinning and detaching: the tab stays, changes list, keeps its page, both ways.
        try await peer.dispatch("tab/pin", ["id": .string("phone-t-001")])
        let toDetach = try XCTUnwrap(phone.tab(macPinned))
        phone.edit { $0.unpin(tabId: toDetach.id) }
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertEqual(phone.tab("phone-t-001")?.pinned, true, "pinned on the Mac, pinned on the phone")
        XCTAssertEqual(phone.tab("phone-t-001")?.url, "https://phone-t-001.example/page/1", "…with the page it had")
        XCTAssertEqual(macState.tabs.first { $0.id == macPinned }?.pinned, false, "detached on the phone, detached on the Mac")
        XCTAssertEqual(macState.tabs.first { $0.id == macPinned }?.url, "https://mac-pinned.example/", "…with the page it had")
        try await assertSameStructure(phone, "pinned and detached")
        try await assertSameToday(phone, "pinned and detached")

        // 5. Closed here, read there: the tab that the Mac closes while the phone reads it stays (§27.5).
        let reading = try XCTUnwrap(phone.tab("phone-read"))
        _ = try await phone.session()  // the tab is admitted (it is old enough) before it is closed and read
        try await peer.dispatch("tab/archive", ["id": .string(reading.id)])
        phone.edit { $0.show(tabId: reading.id, now: Date().timeIntervalSince1970 * 1000) }
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertNotNil(phone.tab("phone-read"), "read on the phone: the Mac's closing does not close it there")
        XCTAssertTrue(macState.tabs.contains { $0.id == "phone-read" }, "…and it comes back to the Mac")
        try await assertSameToday(phone, "closed here, read there")

        // 6. A locked space: nothing of it moves while it is locked on the Mac, and nothing is lost when it opens again.
        phone.openToday("phone-in-locked", in: "sp-mac", ageMs: 120_000)
        try await peer.lock(space: "sp-mac", true)
        let macBeforeLock = try await peer.summary().todayIDs(in: "sp-mac")
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertFalse(macState.tabs.contains { $0.id == "phone-in-locked" }, "a locked space receives nothing")
        XCTAssertEqual(macState.todayIDs(in: "sp-mac"), macBeforeLock, "…and loses nothing")
        XCTAssertTrue(phone.todayIDs(in: "sp-mac").isSuperset(of: macBeforeLock), "the phone did not close the Mac's tabs of the locked space")
        try await peer.lock(space: "sp-mac", false)
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertTrue(macState.tabs.contains { $0.id == "phone-in-locked" }, "unlocked: the phone's tab arrives")
        XCTAssertTrue(phone.tab(macOpenedID) != nil, "nothing was closed on the phone by the lock")

        // 7. Structure deleted both ways: a folder, a favourite, a space, a pinned tab, each by the device that did not make it.
        let macExtra = try XCTUnwrap(macState.spaces.first { $0.name == "Mac extra" }).id
        let macFolder = try XCTUnwrap(macState.folders.first { $0.name == "Dossier Mac" }).id
        let macFav = try XCTUnwrap(macState.favorites.first { $0.url == "https://mac-fav.example/" }).id
        try await phone.session()
        XCTAssertTrue(phone.spaceIDs.contains(macExtra) && phone.folderIDs.contains(macFolder) && phone.favoriteIDs.contains(macFav), "before the deletions the phone has what the Mac made")
        phone.edit { state in
            state.deleteFolder(id: macFolder)
            state.removeFavorite(id: macFav)
            _ = try? state.deleteSpace(macExtra)
        }
        try await peer.dispatch("folder/delete", ["id": .string("folder-phone")])
        try await peer.dispatch("favorite/remove", ["id": .string("fav-phone")])
        try await peer.dispatch("space/delete", ["id": .string("sp-phone-extra")])
        try await peer.dispatch("tab/remove-pinned", ["id": .string("phone-pinned")])
        try await phone.session()
        macState = try await peer.summary()
        XCTAssertFalse(macState.folderIDs.contains(macFolder) || macState.favoriteIDs.contains(macFav) || macState.spaceIDs.contains(macExtra), "what the phone deleted is deleted on the Mac")
        XCTAssertFalse(phone.folderIDs.contains("folder-phone") || phone.favoriteIDs.contains("fav-phone") || phone.spaceIDs.contains("sp-phone-extra"), "what the Mac deleted is deleted on the phone")
        XCTAssertNil(phone.tab("phone-pinned"), "a pinned tab removed on the Mac is removed on the phone")
        try await phone.session()
        try await assertSameStructure(phone, "after the deletions, and one session more: nothing comes back")
        try await assertSameToday(phone, "after the deletions")
        try await assertSameBase(phone, "end")
        _ = now
    }

    /// A second phone with the QR of a pairing that is over: the secret is burnt (§4.7), nothing is paired.
    private func expectBurntSecret(code: SyncPairingCode) async throws {
        let folder = directory.appending(path: "second")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let model = await makeModel(in: folder)
        let other = TestIdentityStore()
        defer { other.cleanUp() }
        let second = try InteropPhone(peer: try MacPeerClient.fromEnvironment(), model: model, directory: folder, store: other, modified: false, categories: [.structure])
        let result = await second.controller.pair(with: code)
        if case .success = result { XCTFail("a QR that was used paired a second phone") }
        let devices = try await second.peer.status().devices
        XCTAssertEqual(devices.count, 1, "nothing was added to the Mac by the second attempt")
    }

    // MARK: The refusals of the pairing

    func testPairingRefusedOnThePhoneKeepsNothing() async throws {
        let peer = try MacPeerClient.fromEnvironment()
        let phone = try await makePhone(peer, categories: [.structure])
        let view = try await peer.pair()
        let code = try SyncPairingCode.parse(qr: view.qr).get()
        let pairing = Task { await phone.controller.pair(with: code) }
        try await phone.waitFor("the words to compare") { if case .comparing = phone.controller.pairingStep { return true } else { return false } }
        phone.controller.answerComparison(false)
        let result = await pairing.value
        if case .success = result { XCTFail("a declined pairing was kept") }
        XCTAssertNil(phone.controller.settings.mac, "the phone kept no Mac")
        let devices = try await peer.status().devices
        XCTAssertEqual(devices.count, 0, "the Mac kept no phone")
    }

    // MARK: Categories: what one side ticks alone never empties the other

    func testACategoryTickedAloneOrWithoutStructureTakesNothingAwayFromEitherSide() async throws {
        let peer = try MacPeerClient.fromEnvironment()
        for (phoneCategories, macCategories, label) in [([SyncCategory.structure, .todayTabs], [SyncCategory.structure], "Today tabs on the phone only"),
                                                        ([.todayTabs], [.structure, .todayTabs], "Today tabs without the structure on the phone (the Mac refuses to tick them without it)"),
                                                        ([.archive], [.structure, .archive], "the archive without the structure on the phone (the Mac refuses to tick it without it)"),
                                                        ([.structure], [.structure, .todayTabs, .archive], "the Mac ticks more")] {
            let phone = try await makePhone(peer, categories: phoneCategories, macCategories: macCategories)
            let phoneSpace = phone.model.state.activeSpaceId
            try await peer.seedToday(5, space: "sp-mac", prefix: "mac-t")
            try await peer.dispatch("tab/open", ["url": .string("https://mac-arch.example/"), "spaceId": .string("sp-mac"), "background": .bool(true)])
            let toArchive = try await peer.summary().tabs.first { $0.url == "https://mac-arch.example/" }
            try await peer.dispatch("tab/archive", ["id": .string(try XCTUnwrap(toArchive).id)])
            phone.seedToday(5, in: phoneSpace, prefix: "phone-t")
            phone.model.archive(try XCTUnwrap(phone.tab("phone-t-000")))
            let phoneTodayBefore = phone.todayIDs()
            let phoneArchiveBefore = phone.archiveIDs
            let macBefore = try await peer.summary()
            try await phone.pair()
            try await phone.waitFor("\(label): the first session") { phone.host.sessionsDone >= 1 && phone.controller.status != .running }
            try await phone.session()
            let macAfter = try await peer.summary()
            XCTAssertTrue(phone.todayIDs().isSuperset(of: phoneTodayBefore), "\(label): the phone lost Today tabs")
            XCTAssertTrue(macAfter.todayIDs().isSuperset(of: macBefore.todayIDs()), "\(label): the Mac lost Today tabs")
            XCTAssertTrue(macAfter.archiveIDs.isSuperset(of: macBefore.archiveIDs), "\(label): the Mac lost archive entries")
            XCTAssertTrue(phone.archiveIDs.isSuperset(of: phoneArchiveBefore), "\(label): the phone lost archive entries")
            XCTAssertTrue(macAfter.spaceIDs.contains("sp-mac"), "\(label): the Mac lost its space")
            // Today tabs cross only when both tick them with the structure.
            let crossed = macAfter.todayIDs().contains { $0.hasPrefix("phone-t") }
            XCTAssertEqual(crossed, phoneCategories.contains(.structure) && phoneCategories.contains(.todayTabs) && macCategories.contains(.structure) && macCategories.contains(.todayTabs), "\(label): Today tabs cross exactly when both tick them with the structure")
            phone.controller.forgetMac()
        }
    }

    // MARK: Measures: 200 Today tabs on each device

    func testMeasuresWith200TodayTabsOnEachDevice() async throws {
        let peer = try MacPeerClient.fromEnvironment()
        let phone = try await makePhone(peer, categories: [.structure, .todayTabs])
        let phoneSpace = phone.model.state.activeSpaceId
        let count = Int(ProcessInfo.processInfo.environment["LUCIUM_INTEROP_TABS"] ?? "") ?? 200
        try await peer.seedToday(count, space: "sp-mac", prefix: "mac-t")
        phone.seedToday(count, in: phoneSpace, prefix: "phone-t")
        var report: [String: Any] = ["tabsPerDevice": count]
        _ = phone.counter.take()
        try await phone.pair()
        try await phone.waitFor("the first session") { phone.host.sessionsDone >= 1 && phone.controller.status != .running }
        let first = phone.counter.take()
        let firstApply = phone.host.takeApply()
        report["firstSessionWithTabsOnBothSides"] = ["sentBytes": first.sent, "receivedBytes": first.received, "connections": first.connections, "phoneApplyMs": (firstApply.ms * 10).rounded() / 10, "phoneApplies": firstApply.count,
                                                      "note": "includes the pairing connection (a few hundred bytes)"]
        var macState = try await peer.summary()
        XCTAssertEqual(phone.todayIDs().filter { $0.hasPrefix("mac-t") }.count, count, "the phone has the Mac's \(count) tabs")
        XCTAssertEqual(macState.todayIDs().filter { $0.hasPrefix("phone-t") }.count, count, "the Mac has the phone's \(count) tabs")
        try await assertSameToday(phone, "\(count) tabs each")
        try await assertSameBase(phone, "\(count) tabs each")

        // A session with nothing changed: what the interval of 30 seconds does most of the time.
        report["quietSession"] = costJSON(try await phone.session())

        // The cap (§27.4): each device shares 200 tabs; a tab more is « not shared » and stays where it is.
        phone.openToday("over-phone", in: phoneSpace, ageMs: 120_000)
        try await peer.dispatch("tab/open", ["url": .string("https://over-mac.example/"), "spaceId": .string("sp-mac"), "background": .bool(true)])
        try await Task.sleep(for: .seconds(21))
        try await phone.session()
        macState = try await peer.summary()
        let cappedOnMac = macState.tabs.contains { $0.url == "https://over-mac.example/" }
        XCTAssertFalse(macState.tabs.contains { $0.id == "over-phone" }, "the phone's 201st tab is not shared")
        XCTAssertNotNil(phone.tab("over-phone"), "…and it is still on the phone")
        XCTAssertFalse(phone.model.state.tabs.contains { $0.url == "https://over-mac.example/" }, "the Mac's 201st tab is not shared")
        XCTAssertTrue(cappedOnMac, "…and it is still on the Mac")
        try await peer.seedToday(30, space: "sp-mac", prefix: "mac-over")
        try await phone.session()
        XCTAssertEqual(phone.todayIDs().filter { $0.hasPrefix("mac-over") }.count, 0, "30 more tabs on the Mac stay on the Mac")
        // A shared tab closed on each side: one session carries both closings (the work of a person who tidies their tabs).
        try await peer.dispatch("tab/archive", ["id": .string("phone-t-000")])
        phone.model.archive(try XCTUnwrap(phone.tab("mac-t-000")))
        report["sessionWithOneTabClosedOnEachSide"] = costJSON(try await phone.session())
        macState = try await peer.summary()
        XCTAssertNil(phone.tab("phone-t-000"))
        XCTAssertFalse(macState.tabs.contains { $0.id == "mac-t-000" })
        report["capCheck"] = ["macTodayTabs": macState.todayIDs().count, "phoneTodayTabs": phone.todayIDs().count]

        // The first session of a phone that has nothing, against a Mac that has `count` tabs: the application of `count` creations in one patch.
        report["firstSessionOfAnEmptyPhone"] = try await measureAdoption(peer, count: count)
        print("[interop-report] \(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8) ?? "?")")
        try write(report: report, named: "measures")
    }

    private func costJSON(_ cost: SessionCost) -> [String: Any] {
        ["sentBytes": cost.sentBytes, "receivedBytes": cost.receivedBytes, "connections": cost.connections, "durationMs": cost.durationMs.rounded(),
         "phoneApplyMs": (cost.phoneApplyMs * 10).rounded() / 10, "phoneApplies": cost.phoneApplies, "macApplyMs": (cost.macApplyMs * 10).rounded() / 10, "macApplies": cost.macApplies]
    }

    /// A phone that has nothing and a new Mac that has `count` Today tabs: the tabs reach the phone in one session.
    private func measureAdoption(_ peer: MacPeerClient, count: Int) async throws -> [String: Any] {
        try await peer.reset()
        try await peer.enable([.structure, .todayTabs])
        try await peer.seedToday(count, space: "sp-mac", prefix: "mac-t")
        let other = TestIdentityStore()
        defer { other.cleanUp() }
        let folder = directory.appending(path: "adopt")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let model = await makeModel(in: folder)
        let fresh = try InteropPhone(peer: peer, model: model, directory: folder, store: other, modified: false, categories: [.structure, .todayTabs])
        _ = fresh.counter.take()
        let started = ContinuousClock.now
        try await fresh.pair()
        try await fresh.waitFor("the first session of the new phone") { fresh.host.sessionsDone >= 1 && fresh.controller.status != .running }
        let elapsed = ContinuousClock.now - started
        let wire = fresh.counter.take()
        let apply = fresh.host.takeApply()
        let adopted = fresh.todayIDs().filter { $0.hasPrefix("mac-t") }.count
        XCTAssertEqual(adopted, count, "a phone that never had a tab adopts the Mac's \(count)")
        let macMetrics = try await peer.metrics().sessions.last
        return ["sentBytes": wire.sent, "receivedBytes": wire.received, "connections": wire.connections, "pairingAndSessionMs": (Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15).rounded(),
                "phoneApplyMs": (apply.ms * 10).rounded() / 10, "phoneApplies": apply.count, "macApplyMs": (macMetrics?.applyMs ?? -1), "note": "includes the pairing connection"]
    }

    // MARK: What the cap counts

    /// §27.4 says each device shares at most 200 tabs, two devices up to 400 together. The shared set a device holds is what it admitted and what it received, and the cap is read against all
    /// of it: a Mac that received 200 tabs from the phone, and has none of its own, cannot share the first one it opens. Found by this check (card 512), proposed as a card.
    func testADeviceThatReceived200TabsStillSharesItsOwnFirstOne() async throws {
        let peer = try MacPeerClient.fromEnvironment()
        let phone = try await makePhone(peer, categories: [.structure, .todayTabs])
        phone.seedToday(200, in: phone.model.state.activeSpaceId, prefix: "phone-t")
        try await phone.pair()
        try await phone.waitFor("the first session") { phone.host.sessionsDone >= 1 && phone.controller.status != .running }
        var mac = try await peer.summary()
        XCTAssertEqual(mac.todayIDs().count, 200, "the Mac received the 200 tabs")
        try await peer.dispatch("tab/open", ["url": .string("https://mac-first.example/"), "spaceId": .string("sp-mac"), "background": .bool(true)])
        try await Task.sleep(for: .seconds(21))
        try await phone.session()
        mac = try await peer.summary()
        XCTAssertNotNil(mac.tabs.first { $0.url == "https://mac-first.example/" }, "it is still on the Mac")
        XCTExpectFailure("card 512 finding: the cap counts the tabs received, so the Mac's first own tab is not shared", strict: true) {
            XCTAssertTrue(phone.model.state.tabs.contains { $0.url == "https://mac-first.example/" }, "the Mac's own first tab reaches the phone")
        }
    }

    // MARK: A session every 30 seconds

    /// The interval loop of the application on the real Mac, at 30 seconds, for `LUCIUM_INTEROP_SOAK_SECONDS` (600 for the measure; the default is 90 so that the check stays short).
    func testASessionEvery30SecondsForTheLengthOfTheSoak() async throws {
        let peer = try MacPeerClient.fromEnvironment()
        let seconds = Int(ProcessInfo.processInfo.environment["LUCIUM_INTEROP_SOAK_SECONDS"] ?? "") ?? 90
        let count = Int(ProcessInfo.processInfo.environment["LUCIUM_INTEROP_TABS"] ?? "") ?? 200
        let phone = try await makePhone(peer, categories: [.structure, .todayTabs])
        let phoneSpace = phone.model.state.activeSpaceId
        try await peer.seedToday(count, space: "sp-mac", prefix: "mac-t")
        phone.seedToday(count, in: phoneSpace, prefix: "phone-t")
        try await phone.pair()
        try await phone.waitFor("the first session") { phone.host.sessionsDone >= 1 && phone.controller.status != .running }
        phone.controller.setInterval(.seconds30)
        let sessionsAtStart = phone.host.sessionsDone
        _ = phone.counter.take()
        _ = phone.host.takeApply()
        let phoneStart = ProcessCost.now()
        let macStart = try await peer.metrics()
        phone.controller.becameActive()
        var samples: [[String: Any]] = []
        let started = ContinuousClock.now
        var opened = 0
        while ContinuousClock.now - started < .seconds(seconds) {
            try await Task.sleep(for: .seconds(30))
            // A person who tidies their tabs: every 30 seconds one shared tab is closed on each device, and the other device has to apply it. The tabs they open instead are not shared
            // while each device holds 200 shared tabs (§27.4).
            opened += 1
            try await peer.dispatch("tab/archive", ["id": .string("phone-t-\(String(format: "%03d", opened))")])
            if let closing = phone.tab("mac-t-\(String(format: "%03d", opened))") { phone.model.archive(closing) }
            phone.openToday("soak-phone-\(opened)", in: phoneSpace, ageMs: 120_000)
            let cost = ProcessCost.now()
            let mac = try await peer.metrics()
            samples.append(["tSeconds": Int((ContinuousClock.now - started).components.seconds), "phoneCpuMs": (cost.cpuMs - phoneStart.cpuMs).rounded(), "phoneFootprintMB": cost.footprint / 1_048_576,
                            "macCpuMs": (mac.cpuMs - macStart.cpuMs).rounded(), "macRssMB": mac.rssBytes / 1_048_576, "sessions": phone.host.sessionsDone - sessionsAtStart])
        }
        phone.controller.leftScreen()
        let wire = phone.counter.take()
        let sessions = phone.host.sessionsDone - sessionsAtStart
        let apply = phone.host.takeApply()
        let phoneEnd = ProcessCost.now()
        let macEnd = try await peer.metrics()
        let elapsed = Double((ContinuousClock.now - started).components.seconds)
        XCTAssertGreaterThanOrEqual(sessions, max(1, seconds / 30 - 2), "a session about every 30 seconds")
        XCTAssertEqual(phone.controller.consecutiveFailures, 0, "no session failed")
        let report: [String: Any] = ["seconds": elapsed, "tabsPerDevice": count, "sessions": sessions, "wireSentBytes": wire.sent, "wireReceivedBytes": wire.received, "connections": wire.connections,
                                     "phoneApplyMsTotal": (apply.ms * 10).rounded() / 10, "phoneApplies": apply.count,
                                     "phoneCpuMs": (phoneEnd.cpuMs - phoneStart.cpuMs).rounded(), "phoneCpuPercentOfOneCore": ((phoneEnd.cpuMs - phoneStart.cpuMs) / (elapsed * 10)).rounded() / 100 * 100,
                                     "phoneFootprintMBStart": phoneStart.footprint / 1_048_576, "phoneFootprintMBEnd": phoneEnd.footprint / 1_048_576,
                                     "macCpuMs": (macEnd.cpuMs - macStart.cpuMs).rounded(), "macRssMBStart": macStart.rssBytes / 1_048_576, "macRssMBEnd": macEnd.rssBytes / 1_048_576, "samples": samples]
        print("[interop-report] \(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8) ?? "?")")
        try write(report: report, named: "soak")
        try await phone.session()
        try await phone.session()
        let mac = try await peer.summary()
        let shared = { (ids: Set<String>) in ids.filter { !$0.hasPrefix("soak-") } }
        XCTAssertEqual(shared(phone.todayIDs()), shared(mac.todayIDs()), "after the soak and a last session, the two devices have the same shared Today tabs")
        XCTAssertEqual(shared(phone.todayIDs()).count, 2 * count - 2 * opened, "every closing crossed")
    }

    private func write(report: [String: Any], named name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["LUCIUM_INTEROP_REPORT_DIR"], !path.isEmpty else { return }
        let url = URL(fileURLWithPath: path).appending(path: "\(name).json")
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url)
    }
}
