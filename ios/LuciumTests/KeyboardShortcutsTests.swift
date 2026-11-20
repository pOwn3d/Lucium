import LuciumKit
import XCTest
@testable import Lucium

/// The hardware keyboard of the iPad (docs/ios.md §3.5): every shortcut is played on the model, without a keyboard and without a window.
@MainActor
final class KeyboardShortcutsTests: BrowserCoreTestCase {
    private static let start = 1_790_000_000_000.0

    private func model(isPhone: Bool = false, lock: LockController? = nil) async -> BrowserModel {
        let now = Self.start
        var state = BrowserModel.defaultState()
        for (index, id) in ["one", "two", "three"].enumerated() {
            state.openTab(id: id, in: "work", url: "https://\(id).example/", title: id, now: now - Double(10 - index))
        }
        state.show(tabId: "two", now: now)
        let model = BrowserModel(state: state, clock: { now }, isPhone: isPhone)
        if let lock { model.attach(lock) }
        await model.prepare()
        return model
    }

    func testNextAndPreviousTabWrapAround() async {
        let model = await model()
        let order = model.activeTabs.map(\.id)
        model.perform(.nextTab)
        XCTAssertEqual(model.activeTab?.id, order[(order.firstIndex(of: "two")! + 1) % order.count])
        let shown = model.activeTab?.id
        model.perform(.previousTab)
        XCTAssertEqual(model.activeTab?.id, "two", "previous undoes next")
        XCTAssertNotEqual(shown, "two")
    }

    func testNewTabCloseAndReopen() async {
        let model = await model()
        let before = model.activeTabs.count
        model.perform(.newTab)
        XCTAssertEqual(model.activeTabs.count, before + 1)
        XCTAssertEqual(model.activeTab?.isBlank, true)
        model.perform(.nextTab)
        let closing = model.activeTab
        model.perform(.closeTab)
        XCTAssertFalse(model.activeTabs.contains { $0.id == closing?.id }, "⌘W archives the tab on screen")
        XCTAssertTrue(model.canPerform(.restoreClosed))
        let count = model.activeTabs.count
        model.perform(.restoreClosed)
        XCTAssertEqual(model.activeTabs.count, count + 1, "⌘⇧T brings the last closed tab back")
        XCTAssertEqual(model.activeTab?.url, closing?.url)
    }

    func testSpacesCycle() async {
        let model = await model()
        let start = model.state.activeSpaceId
        model.perform(.nextSpace)
        XCTAssertNotEqual(model.state.activeSpaceId, start)
        model.perform(.previousSpace)
        XCTAssertEqual(model.state.activeSpaceId, start)
    }

    func testTheCommandBarTheTabsAndTheSettingsOpen() async {
        let model = await model()
        model.perform(.openLocation)
        XCTAssertTrue(model.commandBarShown)
        model.perform(.tabSearch)
        XCTAssertTrue(model.tabsSheetShown)
        model.perform(.settings)
        XCTAssertTrue(model.settingsShown)
    }

    func testTheSidebarToggleHidesThePadSidebarAndOpensThePhoneDrawer() async {
        let pad = await model(isPhone: false)
        XCTAssertTrue(pad.padSidebarShown)
        pad.perform(.toggleSidebar)
        XCTAssertFalse(pad.padSidebarShown)
        pad.perform(.toggleSidebar)
        XCTAssertTrue(pad.padSidebarShown)
        let phone = await model(isPhone: true)
        phone.perform(.toggleSidebar)
        XCTAssertTrue(phone.drawerShown)
        XCTAssertTrue(phone.padSidebarShown, "the phone never touches the iPad's flag")
    }

    func testPinTogglesAndNothingNeedsATabInACoveredSpace() async throws {
        let model = await model()
        model.perform(.pin)
        XCTAssertEqual(model.activeTab?.pinned, true)
        model.perform(.pin)
        XCTAssertEqual(model.activeTab?.pinned, false)
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: YesOwner(), file: file)
        let locked = await self.model(lock: lock)
        let done = await lock.setSpace("work", guarded: true)
        XCTAssertTrue(done)
        XCTAssertNil(locked.activeTab)
        for command in [ShortcutCommand.closeTab, .pin, .reload, .find, .nextTab, .restoreClosed] {
            XCTAssertFalse(locked.canPerform(command), "\(command) must not walk around the lock")
        }
        let tabs = locked.state.tabs.count
        locked.perform(.closeTab)
        XCTAssertEqual(locked.state.tabs.count, tabs)
    }
}

private final class YesOwner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}
