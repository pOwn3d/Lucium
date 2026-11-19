import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The desktop version of a site and the size of the page's text, per tab: asked of real web views, kept in the tab's folder, never written for a
/// private tab. No window.
@MainActor
final class PageDisplayModelTests: BrowserCoreTestCase {
    private func userAgent(of view: WKWebView) async throws -> String {
        try await view.evaluateJavaScript("navigator.userAgent") as? String ?? ""
    }

    func testTheDesktopVersionIsAskedForTheTabAndOnlyForIt() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        let view = try XCTUnwrap(model.webView)
        let mobile = try await userAgent(of: view)
        XCTAssertTrue(mobile.contains("iPhone"), "an iPhone asks for the mobile version by default: \(mobile)")

        let waiter = NavigationWaiter()
        try await waiter.load(in: view) { model.setDesktopVersion(true) }
        let desktop = try await userAgent(of: view)
        XCTAssertTrue(desktop.contains("Macintosh"), "the page was asked for again as a desktop browser: \(desktop)")
        XCTAssertTrue(model.activeDisplay.desktop)

        // Another tab is not touched.
        _ = try await openTab("/b.html", in: model)
        XCTAssertFalse(model.activeDisplay.desktop, "the choice is the tab's, not the application's")
        let second = try await userAgent(of: try XCTUnwrap(model.webView))
        XCTAssertTrue(second.contains("iPhone"))
        XCTAssertTrue(model.display(of: first).desktop)

        // Back to the mobile version.
        model.openTab(first)
        try await waiter.load(in: try XCTUnwrap(model.webView)) { model.setDesktopVersion(false) }
        let again = try await userAgent(of: try XCTUnwrap(model.webView))
        XCTAssertTrue(again.contains("iPhone"))
        XCTAssertNil(model.sideStore?.read(.display, for: first.id), "a tab that is back to the standard display keeps nothing")
    }

    func testTheZoomStepsMoveThePageAndStayInRange() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let view = try XCTUnwrap(model.webView)
        XCTAssertEqual(view.pageZoom, 1)
        model.zoomPageIn()
        XCTAssertEqual(view.pageZoom, 1.15, accuracy: 0.001)
        model.zoomPageOut(); model.zoomPageOut()
        XCTAssertEqual(view.pageZoom, 0.85, accuracy: 0.001)
        for _ in 0..<20 { model.zoomPageOut() }
        XCTAssertEqual(view.pageZoom, 0.5, accuracy: 0.001)
        model.resetPageZoom()
        XCTAssertEqual(view.pageZoom, 1)
        XCTAssertTrue(model.activeDisplay.isStandard)
    }

    func testTheDisplayFollowsTheTabThroughSleepAndRestart() async throws {
        let model = await makeModel(cap: 1)
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        model.zoomPageIn(); model.zoomPageIn()
        XCTAssertNotNil(model.sideStore?.read(.display, for: first.id))
        model.newTab()
        await model.sleepSurplus()
        XCTAssertFalse(model.awakeTabIds.contains(first.id))

        model.openTab(first)
        let woken = try XCTUnwrap(model.webView)
        XCTAssertEqual(woken.pageZoom, 1.25, accuracy: 0.001, "the text size came back with the tab")

        model.flush()
        let restarted = BrowserModel.launch(directory: directory, embeddedLists: { nil })
        await restarted.prepare()
        XCTAssertEqual(restarted.activeDisplay.zoomPercent, 125, "…and after a restart")
        XCTAssertEqual(try XCTUnwrap(restarted.webView).pageZoom, 1.25, accuracy: 0.001)
    }

    func testClosingATabTakesItsDisplayWithIt() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        model.zoomPageIn()
        XCTAssertNotNil(model.sideStore?.read(.display, for: tab.id))
        model.close(tab)
        XCTAssertNil(model.sideStore?.read(.display, for: tab.id))
    }

    func testAPrivateTabKeepsItsDisplayInMemoryOnly() async throws {
        let model = await makeModel()
        model.newPrivateTab()
        let tab = try XCTUnwrap(model.activeTab)
        try await load("/a.html", in: model)
        model.zoomPageIn()
        XCTAssertEqual(model.activeDisplay.zoomPercent, 115, "it works on the page")
        XCTAssertNil(model.sideStore?.read(.display, for: tab.id), "…but nothing of a private tab is written")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.appending(path: TabSideStore.directoryName).path)) ?? []
        XCTAssertFalse(files.contains { $0.hasSuffix(".display") })
    }

    func testADisplayThatCannotBeKeptIsReportedAndStillApplies() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        // A file where the tabs' folder should be: the write fails.
        let folder = directory.appending(path: TabSideStore.directoryName)
        try? FileManager.default.removeItem(at: folder)
        try Data("x".utf8).write(to: folder)
        let view = try XCTUnwrap(model.webView)
        model.zoomPageIn()
        XCTAssertEqual(view.pageZoom, 1.15, accuracy: 0.001, "the person still sees the change")
        XCTAssertNotNil(model.problem(.display), "the failure is kept, not swallowed")
    }

    func testAnUnreadableKeptDisplayFallsBackToTheStandardOne() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        try model.sideStore?.write(Data("garbage".utf8), kind: .display, for: tab.id)
        model.pageDisplays[tab.id] = nil
        XCTAssertTrue(model.display(of: tab).isStandard)
    }

    func testAnIPadNeverAsksForTheDesktopVersionItAlreadyHas() {
        var state = BrowserModel.defaultState()
        state.openTab(id: "t", in: state.activeSpaceId, now: 1)
        let pad = BrowserModel(state: state, isPhone: false)
        pad.pageDisplays["t"] = PageDisplay(desktop: true)
        XCTAssertEqual(pad.contentMode(ofTab: "t"), .recommended)
        XCTAssertFalse(pad.offersDesktopVersion)
        let phone = BrowserModel(state: state, isPhone: true)
        phone.pageDisplays["t"] = PageDisplay(desktop: true)
        XCTAssertEqual(phone.contentMode(ofTab: "t"), .desktop)
        XCTAssertTrue(phone.offersDesktopVersion)
    }
}
