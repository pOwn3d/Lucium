import LuciumKit
import UIKit
import WebKit
import XCTest
@testable import Lucium

/// Sleeping and waking tabs, and what a restart brings back. Real web views, real pages from a local server, a real state file in a folder
/// of the test; no window.
@MainActor
final class TabSleepTests: BrowserCoreTestCase {
    func testTabsBeyondTheCapSleepTheLeastRecentlyShownFirst() async throws {
        let model = await makeModel(cap: 2)
        try await load("/a.html", in: model)
        let a = try XCTUnwrap(model.activeTab)
        let b = try await openTab("/b.html", in: model)
        let c = try await openTab("/c.html", in: model)
        let d = try await openTab("/d.html", in: model)
        await model.sleepSurplus()

        XCTAssertEqual(model.awakeTabIds, Set([c.id, d.id]), "the two most recently shown stay awake")
        XCTAssertEqual(model.activeTab?.id, d.id)
        // A sleeping tab keeps its line in the state: nothing is lost by freeing its view.
        XCTAssertEqual(model.state.tabs.map(\.id), [a.id, b.id, c.id, d.id])
        XCTAssertEqual(model.state.tabs.first { $0.id == a.id }?.url, address("/a.html").absoluteString)
        XCTAssertEqual(model.state.tabs.first { $0.id == b.id }?.title, "Page B")
        // …and the state of its page, to wake where it left off.
        XCTAssertNotNil(model.sideStore?.read(.interaction, for: a.id))
        XCTAssertNotNil(model.sideStore?.read(.interaction, for: b.id))
        XCTAssertNil(model.sideStore?.read(.interaction, for: d.id), "a tab that is awake has not slept")
    }

    func testTheLimitChosenInTheSettingsIsTheCapTheSleepRulesUse() async throws {
        let model = await makeModel(cap: 4)
        try await load("/a.html", in: model)
        _ = try await openTab("/b.html", in: model)
        _ = try await openTab("/c.html", in: model)
        _ = try await openTab("/d.html", in: model)
        XCTAssertEqual(model.awakeTabIds.count, 4)
        model.chooseAwakeTabLimit(2)
        XCTAssertEqual(model.effectiveAwakeCap, 2)
        await model.sleepSurplus()
        XCTAssertEqual(model.awakeTabIds.count, 2, "the surplus sleeps by the limit of the state, not the one the model was made with")
        model.chooseAwakeTabLimit(0)
        XCTAssertEqual(model.effectiveAwakeCap, Int.max, "no limit")
        guard case .object(let settings)? = model.state.rest["settings"] else { return XCTFail("no settings") }
        XCTAssertEqual(settings["sleepAwakeMax"], .number(0), "written where the Mac reads it")
    }

    func testASleepingTabWakesWhereItLeftOffWithItsHistory() async throws {
        let model = await makeModel(cap: 1)
        try await load("/a.html", in: model)
        try await load("/b.html", in: model)  // a, then b: one step back
        let first = try XCTUnwrap(model.activeTab)
        model.newTab()
        await model.sleepSurplus()
        XCTAssertFalse(model.awakeTabIds.contains(first.id), "the first tab was freed")

        model.openTab(first)
        let view = try XCTUnwrap(model.webView)
        XCTAssertEqual(model.activeTab?.id, first.id)
        try await eventually("the page of the tab is back") { view.url?.path == "/b.html" && !view.isLoading }
        XCTAssertEqual(view.backForwardList.backList.map { $0.url.path }, ["/a.html"], "the history came back with the page")
        XCTAssertTrue(model.canGoBack)
        XCTAssertNil(model.sideStore?.read(.interaction, for: first.id), "the kept state is used once: left in place it would go stale")
    }

    func testWhenTheKeptStateIsMissingATabWakesFromItsAddress() async throws {
        let model = await makeModel(cap: 1)
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        model.newTab()
        await model.sleepSurplus()
        model.sideStore?.remove(for: first.id)
        model.openTab(first)
        let view = try XCTUnwrap(model.webView)
        try await eventually("the address of the state is loaded") { view.url?.path == "/a.html" && !view.isLoading }
        XCTAssertFalse(model.canGoBack, "no history without the kept state")
    }

    func testTheOneOnScreenAndOneThatLoadsAreNotPutToSleep() async throws {
        let model = await makeModel(cap: 1)
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        let firstView = try XCTUnwrap(model.webView)
        model.newTab()
        let second = try XCTUnwrap(model.activeTab)
        _ = try XCTUnwrap(model.webView)
        // A page that never answers: the first tab is loading, so it is spared even over the cap.
        firstView.load(URLRequest(url: address("/hang")))
        XCTAssertTrue(firstView.isLoading)
        await model.sleepSurplus()
        XCTAssertEqual(model.awakeTabIds, [first.id, second.id], "a tab that loads is spared")
        firstView.stopLoading()
    }

    func testUnderMemoryPressureOnlyTheTabOnScreenKeepsItsView() async throws {
        let model = await makeModel(cap: 4)
        try await load("/a.html", in: model)
        try await openTab("/b.html", in: model)
        let last = try await openTab("/c.html", in: model)
        XCTAssertEqual(model.awakeTabIds.count, 3)
        await model.sleepSurplus(underPressure: true)
        XCTAssertEqual(model.awakeTabIds, [last.id])
    }

    func testAPictureOfThePageIsKeptWhenATabLeavesTheScreen() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)  // a red page
        let first = try XCTUnwrap(model.activeTab)
        try putOnScreen(try XCTUnwrap(model.webView))
        model.newTab()
        try await eventually("the picture of the tab that left, or the reason it was not kept") {
            model.sideStore?.read(.thumbnail, for: first.id) != nil || model.problem(.picture) != nil
        }
        XCTAssertNil(model.problem(.picture), "\(model.problem(.picture) ?? "")")
        let picture = try XCTUnwrap(model.thumbnail(of: first))
        XCTAssertGreaterThan(picture.size.width, 0)
        // The picture is of the page, not an empty one: its middle is red.
        let (red, green) = try XCTUnwrap(Self.middlePixel(of: picture))
        XCTAssertGreaterThan(red, 200, "the picture is not the red page")
        XCTAssertLessThan(green, 80, "the picture is not the red page")
    }

    private static func middlePixel(of image: UIImage) -> (red: Int, green: Int)? {
        guard let cgImage = image.cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        let drawn = pixel.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(cgImage, in: CGRect(x: -cgImage.width / 2, y: -cgImage.height / 2, width: cgImage.width, height: cgImage.height))
            return true
        }
        return drawn ? (Int(pixel[0]), Int(pixel[1])) : nil
    }

    func testClosingATabFreesItsViewAndItsFilesAndShowsAnotherOfTheSpace() async throws {
        let model = await makeModel(cap: 1)
        try await load("/a.html", in: model)
        let a = try XCTUnwrap(model.activeTab)
        let b = try await openTab("/b.html", in: model)
        await model.sleepSurplus()  // a sleeps: it has files
        XCTAssertNotNil(model.sideStore?.read(.interaction, for: a.id))

        model.close(a)
        XCTAssertNil(model.sideStore?.read(.interaction, for: a.id))
        XCTAssertNil(model.sideStore?.read(.thumbnail, for: a.id))
        XCTAssertEqual(model.activeTabs.map(\.id), [b.id])

        model.close(b)  // the tab on screen: the space gets a blank one, never none
        XCTAssertFalse(model.awakeTabIds.contains(b.id))
        XCTAssertEqual(model.activeTabs.count, 1)
        XCTAssertTrue(try XCTUnwrap(model.activeTab).isBlank)
    }

    // MARK: A restart

    func testARestartBringsBackTheSpacesTheTabsAndTheHistory() async throws {
        let before = await makeModel()
        try await load("/a.html", in: before)
        try await load("/b.html", in: before)
        let first = try XCTUnwrap(before.activeTab)
        let second = try await openTab("/c.html", in: before)
        before.selectSpace("home")
        await before.enterBackground()  // what the application does when it goes to the background

        let after = await makeModel()  // iOS ended the application; this is the next launch
        XCTAssertNotNil(after.startup.loadedState, "the file was read, not set aside")
        XCTAssertEqual(after.activeSpace.id, "home", "the space on screen comes back")
        XCTAssertEqual(after.state.tabs.map(\.id), before.state.tabs.map(\.id))
        XCTAssertEqual(after.state.tabs.map(\.url), before.state.tabs.map(\.url))
        XCTAssertEqual(after.awakeTabIds, [try XCTUnwrap(after.activeTab).id], "only the tab on screen is awake after a restart")

        after.selectSpace("work")
        XCTAssertEqual(after.activeTab?.id, second.id, "a space shows the tab it showed")
        let secondView = try XCTUnwrap(after.webView)
        try await eventually("the second tab is back") { secondView.url?.path == "/c.html" && !secondView.isLoading }

        after.openTab(first)
        let firstView = try XCTUnwrap(after.webView)
        try await eventually("the first tab is back") { firstView.url?.path == "/b.html" && !firstView.isLoading }
        XCTAssertEqual(firstView.backForwardList.backList.map { $0.url.path }, ["/a.html"], "its history too")
    }

    func testAStateOfANewerVersionIsKeptUntouchedAndTheApplicationStartsAfresh() async throws {
        let newer = #"{ "version": 2, "spaces": [], "tabs": [], "activeSpaceId": "", "activeTabBySpace": {}, "fromTheFuture": true }"#
        try Data(newer.utf8).write(to: directory.appending(path: StateFile.fileName))
        let model = await makeModel()
        guard case .setAside(.future, let backup, _) = model.startup else { return XCTFail("expected the state to be set aside as a newer one, got \(model.startup)") }
        XCTAssertEqual(try String(contentsOf: backup, encoding: .utf8), newer, "kept byte for byte")
        XCTAssertTrue(model.startupNoticeShown, "the person is told")
        XCTAssertEqual(model.spaces.count, 3)
        model.flush()
        XCTAssertEqual(try String(contentsOf: backup, encoding: .utf8), newer, "writing the fresh state does not touch it")
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appending(path: StateFile.fileName).path))
    }

    func testADamagedStateIsKeptAsideAndTheApplicationStartsAfresh() async throws {
        try Data("{ nope".utf8).write(to: directory.appending(path: StateFile.fileName))
        let model = await makeModel()
        guard case .setAside(.corrupt, let backup, _) = model.startup else { return XCTFail("expected the state to be set aside, got \(model.startup)") }
        XCTAssertEqual(try String(contentsOf: backup, encoding: .utf8), "{ nope")
        XCTAssertTrue(model.startupNoticeShown)
        XCTAssertEqual(model.spaces.count, 3)
    }

    // MARK: Failures are kept, not swallowed

    func testAStateThatCannotBeWrittenIsReportedAndBrowsingGoesOn() async throws {
        // The folder of the state is a file: nothing can be written there.
        let blocker = directory.appending(path: "not-a-folder")
        try Data("x".utf8).write(to: blocker)
        let model = await makeModel(in: blocker)
        XCTAssertNil(model.problem(.state))
        model.flush()
        XCTAssertNotNil(model.problem(.state), "a failed write must not pass unnoticed")
        XCTAssertNotNil(model.webView, "the person keeps browsing")
        try await load("/a.html", in: model)
    }

    func testAPageStateThatCannotBeKeptIsReportedAndTheTabStillWakesFromItsAddress() async throws {
        // The folder of the tabs' files is a file: the page state of a tab that sleeps cannot be written.
        try Data("x".utf8).write(to: directory.appending(path: TabSideStore.directoryName))
        let model = await makeModel(cap: 1)
        try await load("/a.html", in: model)
        let first = try XCTUnwrap(model.activeTab)
        model.newTab()
        await model.sleepSurplus()
        XCTAssertFalse(model.awakeTabIds.contains(first.id), "the tab sleeps all the same")
        XCTAssertNotNil(model.problem(.pageState), "the state of its page was not kept, and that is said")
        model.openTab(first)
        let view = try XCTUnwrap(model.webView)
        try await eventually("it wakes from its address") { view.url?.path == "/a.html" && !view.isLoading }
    }
}

private extension StateLoad {
    var loadedState: BrowserState? {
        if case .loaded(let state) = self { return state }
        return nil
    }
}
