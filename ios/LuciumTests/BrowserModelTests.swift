import LuciumKit
import UIKit
import WebKit
import XCTest
@testable import Lucium

/// Shared by the tests of the browser core: a local server with real pages, a folder of its own for the files of each test, and a way to wait
/// for something a web view does by itself.
@MainActor
class BrowserCoreTestCase: XCTestCase {
    var server: LocalServer!
    var port: UInt16 = 0
    var directory: URL!

    static let pages: [String: LocalServer.Route] = [
        "/a.html": .init(contentType: "text/html", body: "<!doctype html><title>Page A</title><body style=\"background:red\"><h1>A</h1>"),
        "/b.html": .init(contentType: "text/html", body: "<!doctype html><title>Page B</title><body style=\"background:green\"><h1>B</h1>"),
        "/c.html": .init(contentType: "text/html", body: "<!doctype html><title>Page C</title><body style=\"background:blue\"><h1>C</h1>"),
        "/d.html": .init(contentType: "text/html", body: "<!doctype html><title>Page D</title><body style=\"background:orange\"><h1>D</h1>"),
        "/hang": .hang,
        "/probe.html": .init(contentType: "text/html", body: """
        <!doctype html><title>Probe</title><script src="/lucium-blocked-probe.js"></script><script src="/allowed-probe.js"></script><body>probe
        """),
        "/lucium-blocked-probe.js": .init(contentType: "text/javascript", body: "window.blockedRan = true"),
        "/allowed-probe.js": .init(contentType: "text/javascript", body: "window.allowedRan = true"),
    ]

    override func setUp() async throws {
        server = try LocalServer(routes: Self.pages)
        port = try await server.start()
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-core-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        server.stop()
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
        try? FileManager.default.removeItem(at: directory)
    }

    func address(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }

    /// A model like the application's, on the folder of this test, ready to browse. `cap` is the number of awake tabs.
    func makeModel(cap: Int = SleepPlanner.defaultCap, in folder: URL? = nil) async -> BrowserModel {
        let model = BrowserModel.launch(directory: folder ?? directory, awakeCap: cap)
        await model.prepare()
        return model
    }

    /// Loads a page in the tab on screen and waits for it to finish, and for its line in the state to carry the title of the page (WebKit
    /// sets the title a moment after the page is done).
    func load(_ path: String, in model: BrowserModel, file: StaticString = #filePath, line: UInt = #line) async throws {
        let view = try XCTUnwrap(model.webView, "no web view", file: file, line: line)
        let waiter = NavigationWaiter()
        try await waiter.load(in: view) { view.load(URLRequest(url: address(path))) }
        let title = Self.pages[path].flatMap { $0.body.firstMatch(of: /<title>(.*?)<\/title>/)?.1 }.map(String.init)
        guard let title else { return }
        try await eventually("the title \(title) in the line of the tab", { model.activeTab?.title == title }, file: file, line: line)
    }

    /// Puts a web view on a real window, as the application does: a snapshot of a view that is on no screen is not what a person leaves.
    func putOnScreen(_ view: WKWebView) throws {
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first, "the host application has no window")
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        window.addSubview(view)
    }

    /// Waits for something a web view or a task does by itself. Polling is the honest way here: WebKit tells nothing when it restores a page.
    func eventually(_ what: String, timeout: Duration = .seconds(30), _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline {
                XCTFail("timed out waiting for: \(what)", file: file, line: line)
                throw NavigationWaiter.TimedOut()
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    /// Opens a new tab in the active space and loads a page in it.
    @discardableResult
    func openTab(_ path: String, in model: BrowserModel) async throws -> TabItem {
        model.newTab()
        try await load(path, in: model)
        return try XCTUnwrap(model.activeTab)
    }
}

@MainActor
final class BrowserModelTests: BrowserCoreTestCase {
    func testAnAddressBecomesARequestAndWordsBecomeASearch() throws {
        XCTAssertEqual(BrowserModel.request(for: "example.com")?.url?.absoluteString, "https://example.com")
        XCTAssertEqual(BrowserModel.request(for: "hello world")?.url?.absoluteString, "https://duckduckgo.com/?q=hello%20world")
        XCTAssertNil(BrowserModel.request(for: "   "))
    }

    /// No web view is made before the blocker is ready: the first page of the first tab must not load unfiltered.
    func testNoPageIsMadeBeforeTheBlockerIsReadyAndTheFirstTabHasIt() async throws {
        let model = BrowserModel.launch(directory: directory)
        XCTAssertNil(model.webView, "a view made now would load pages without the blocker")
        await model.prepare()
        XCTAssertNotNil(model.webView)
        try await load("/probe.html", in: model)
        let view = try XCTUnwrap(model.webView)
        let blocked = try await view.evaluateJavaScript("window.blockedRan === true") as? Bool
        let allowed = try await view.evaluateJavaScript("window.allowedRan === true") as? Bool
        XCTAssertEqual(blocked, false, "the first tab's view loaded the blocked script")
        XCTAssertEqual(allowed, true, "a script no rule names must still run")
        XCTAssertFalse(server.requestedPaths.contains("/lucium-blocked-probe.js"), "\(server.requestedPaths)")
    }

    /// A blocker that cannot be built must not stop browsing, and must not pass unnoticed.
    func testABlockerThatFailsToBuildIsReportedAndBrowsingGoesOn() async throws {
        struct NoRules: Error {}
        let broken = BrowserModel.launch(directory: directory, rules: { throw NoRules() })
        await broken.prepare()
        XCTAssertTrue(broken.blockerFailure is NoRules)
        XCTAssertNotNil(broken.webView, "the view is still there, unfiltered")

        let healthy = BrowserModel.launch(directory: directory.appending(path: "healthy"))
        await healthy.prepare()
        XCTAssertNil(healthy.blockerFailure)
    }

    func testEveryAwakeTabHasItsOwnViewAndEachProfileItsOwnDataStore() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.spaces.map(\.id), ["work", "home", "projects"])
        let first = try XCTUnwrap(model.activeTab)
        let firstView = try XCTUnwrap(model.webView)
        try await load("/a.html", in: model)
        let second = try await openTab("/b.html", in: model)
        let secondView = try XCTUnwrap(model.webView)
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertFalse(firstView === secondView, "one view per tab")
        XCTAssertEqual(model.awakeTabIds, [first.id, second.id])
        XCTAssertEqual(firstView.configuration.websiteDataStore.identifier, secondView.configuration.websiteDataStore.identifier, "two tabs of a space share its profile")

        model.selectSpace("home")
        let homeView = try XCTUnwrap(model.webView)
        XCTAssertEqual(model.activeSpace.id, "home")
        XCTAssertNotEqual(secondView.configuration.websiteDataStore.identifier, homeView.configuration.websiteDataStore.identifier, "two profiles must not share cookies")
        XCTAssertEqual(homeView.configuration.websiteDataStore.identifier, ProfileStore.identifier(for: "home"))
        model.selectSpace("work")
        XCTAssertTrue(model.webView === secondView, "going back to a space shows the tab it showed, in the view it had")
    }

    func testEverySpaceShowsItsOwnTabsAndAlwaysOne() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let workTab = try XCTUnwrap(model.activeTab)
        XCTAssertEqual(model.activeTabs.map(\.id), [workTab.id])
        model.selectSpace("home")
        XCTAssertEqual(model.activeTabs.count, 1, "a space that has no tab gets a blank one")
        XCTAssertTrue(try XCTUnwrap(model.activeTab).isBlank)
        XCTAssertNotEqual(model.activeTab?.id, workTab.id)
        model.selectSpace("work")
        XCTAssertEqual(model.activeTab?.id, workTab.id)
    }

    func testABlankTabShowsTheStartPageAndKeepsNoPageStateWhenItSleeps() async throws {
        let model = await makeModel(cap: 1)
        let blank = try XCTUnwrap(model.activeTab)
        let view = try XCTUnwrap(model.webView)
        try await eventually("the start page") { view.url?.absoluteString == "about:blank" && !view.isLoading }
        XCTAssertTrue(blank.isBlank)

        model.selectSpace("home")  // the blank tab of "work" leaves the screen and, with a cap of one, sleeps
        await model.sleepSurplus()
        XCTAssertFalse(model.awakeTabIds.contains(blank.id))
        XCTAssertNil(model.sideStore?.read(.interaction, for: blank.id), "a blank tab keeps no page state: its page is the start page")

        model.selectSpace("work")
        let again = try XCTUnwrap(model.webView)
        try await eventually("the start page again") { again.url?.absoluteString == "about:blank" && !again.isLoading }
        XCTAssertEqual(model.activeTab?.url, BrowserState.blankURL, "the start page is not a page to remember")
    }

    func testAPageUpdatesTheLineOfItsTabAndTheStateFileFollows() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let tab = try XCTUnwrap(model.activeTab)
        XCTAssertEqual(tab.url, address("/a.html").absoluteString)
        XCTAssertEqual(tab.title, "Page A")  // `load` waited for it
        // The write is a moment after the change.
        let file = directory.appending(path: StateFile.fileName)
        try await eventually("state.json with the page of the tab") {
            guard let data = try? Data(contentsOf: file), let saved = try? BrowserState.decode(data) else { return false }
            return saved.tabs.first { $0.id == tab.id }?.title == "Page A"
        }
    }
}
