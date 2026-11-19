import LuciumKit
import XCTest
@testable import Lucium

private final class Owner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}

/// A link handed over by another application (default-browser requirement, docs/ios.md §9.4): a new tab, by the ordinary load, http(s) only,
/// and nothing opens while the lock is on.
@MainActor
final class ExternalLinkBrowserTests: BrowserCoreTestCase {
    func testALinkOpensInANewTabAndLoadsThroughTheOrdinaryPath() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let before = model.state.tabs.count
        model.receive(address("/b.html"))
        XCTAssertEqual(model.state.tabs.count, before + 1, "a new tab, the one on screen is kept")
        XCTAssertEqual(model.activeTab?.url, address("/b.html").absoluteString)
        let view = try XCTUnwrap(model.webView)
        try await eventually("the page of the link is loaded") { view.url?.path == "/b.html" && !view.isLoading }
        XCTAssertTrue(model.state.tabs.contains { $0.url == address("/a.html").absoluteString }, "the first page stays in its tab")
    }

    func testOtherSchemesOpenNothing() async throws {
        let model = await makeModel()
        let before = model.state.tabs
        for text in ["file:///etc/hosts", "javascript:alert(1)", "data:text/html,hi", "lucium://x", "https://user:pw@example.com/"] {
            model.receive(URL(string: text)!)
        }
        XCTAssertEqual(model.state.tabs, before)
        XCTAssertNil(model.pendingExternalAddress)
    }

    func testALinkReceivedWhileLockedWaitsForTheOwner() async throws {
        let directory = self.directory!
        let lock = LockController(authenticator: Owner(), file: LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName)))
        let model = BrowserModel.launch(directory: directory, lock: lock, embeddedLists: { nil })
        await model.prepare()
        let turnedOn = await lock.setLockApp(true)
        XCTAssertTrue(turnedOn)
        model.lockOnLeaving()
        XCTAssertTrue(lock.appLocked)
        let before = model.state.tabs.count

        model.receive(address("/c.html"))
        XCTAssertEqual(model.state.tabs.count, before, "nothing opens, nothing is named, while locked")
        XCTAssertNil(model.webView)

        let unlocked = await lock.unlockApp()
        XCTAssertTrue(unlocked)
        XCTAssertEqual(model.state.tabs.count, before + 1)
        let view = try XCTUnwrap(model.webView)
        try await eventually("the page of the link is loaded after the unlock") { view.url?.path == "/c.html" && !view.isLoading }
        XCTAssertNil(model.pendingExternalAddress)
    }
}
