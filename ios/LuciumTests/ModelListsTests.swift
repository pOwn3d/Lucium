import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The model and the embedded lists: it applies every list to the web views it makes, falls back to the short built-in list when the copy has none,
/// and says so when the registry of the lists cannot be read. (`BrowserModelTests` runs the browser core with no embedded list, so that what it
/// proves does not depend on what the build carries.)
@MainActor
final class ModelListsTests: XCTestCase {
    /// Where WebKit keeps the compiled lists of a test; it lives as long as the test (a list whose store is gone is no longer served).
    private var store: WKContentRuleListStore!
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-model-lists-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = try XCTUnwrap(WKContentRuleListStore(url: directory.appending(path: "rules", directoryHint: .isDirectory)))
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func proofLists() throws -> EmbeddedLists {
        try XCTUnwrap(EmbeddedLists.load(in: Bundle(for: Self.self)), "Fixtures/filter-lists-registry.json is missing from the test bundle")
    }

    func testTheModelAppliesTheEmbeddedListsToTheViewsItMakes() async throws {
        let page = "<!doctype html><script src=\"/probe/path-rule.js\"></script><script src=\"/probe/fine.js\"></script>"
        let server = try LocalServer(routes: [
            "/page.html": .init(contentType: "text/html", body: page),
            "/probe/path-rule.js": .init(contentType: "text/javascript", body: "window.blockedRan = true"),
            "/probe/fine.js": .init(contentType: "text/javascript", body: "window.fineRan = true"),
        ])
        let port = try await server.start()
        defer { server.stop() }

        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { try self.proofLists() }, store: store)
        // The proof list's probe is a path of the site's own, which only « Strict » filters (« Standard » leaves a site's own requests alone, section 6.6).
        model.updatePrivacy { $0.blockMode = .strict }
        await model.prepare()
        XCTAssertNil(model.blockerFailure)
        XCTAssertTrue(model.listFailures.isEmpty)
        XCTAssertEqual(model.blockers.count, 2, "the network rules and the element hiding of the proof list")

        let view = try XCTUnwrap(model.webView)
        let address = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/page.html"))
        try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: address)) }
        let blocked = try await view.evaluateJavaScript("window.blockedRan === true") as? Bool
        let fine = try await view.evaluateJavaScript("window.fineRan === true") as? Bool
        XCTAssertEqual(blocked, false, "the proof list's `/probe/path-rule.js` must be stopped")
        XCTAssertEqual(fine, true)
        XCTAssertFalse(server.requestedPaths.contains("/probe/path-rule.js"))
    }

    /// A copy with no embedded list browses with the short built-in list, not with nothing.
    func testACopyWithNoEmbeddedListUsesTheBuiltInList() async throws {
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil }, store: store)
        await model.prepare()
        XCTAssertNil(model.blockerFailure)
        XCTAssertEqual(model.blockers.map { $0.identifier }, [ContentBlocker.builtinIdentifier])
    }

    /// A registry that cannot be read must not stop browsing either: the failure is kept and the pages load unfiltered.
    func testAnEmbeddedRegistryThatCannotBeReadIsReportedAndBrowsingGoesOn() async throws {
        struct BadRegistry: Error {}
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { throw BadRegistry() }, store: store)
        await model.prepare()
        XCTAssertTrue(model.blockerFailure is BadRegistry)
        XCTAssertTrue(model.blockers.isEmpty)
        XCTAssertNotNil(model.webView, "the view is still there, unfiltered")
    }
}
