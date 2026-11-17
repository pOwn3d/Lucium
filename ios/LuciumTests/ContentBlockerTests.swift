import WebKit
import XCTest
@testable import Lucium

@MainActor
final class ContentBlockerTests: XCTestCase {
    private func temporaryStore() throws -> WKContentRuleListStore {
        let directory = FileManager.default.temporaryDirectory.appending(path: "lucium-rules-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return try XCTUnwrap(WKContentRuleListStore(url: directory))
    }

    func testEmbeddedRulesCompile() async throws {
        let list = try await ContentBlocker.compile(ContentBlocker.builtinRules(), identifier: "test.builtin", in: temporaryStore())
        XCTAssertEqual(list.identifier, "test.builtin")
    }

    func testRulesWebKitDoesNotUnderstandAreRefused() async throws {
        let store = try temporaryStore()
        do {
            _ = try await ContentBlocker.compile(#"[{ "trigger": {}, "action": { "type": "block" } }]"#, identifier: "test.bad", in: store)
            XCTFail("a rule without url-filter must not compile")
        } catch {
            XCTAssertEqual((error as NSError).domain, WKErrorDomain)
        }
    }

    /// The whole chain: rules compiled, applied to a real web view, a real page asking for two scripts. The blocked one must never
    /// reach the server (WebKit stops it first); the other one must. The same page without the rules loads both: the test is able to fail.
    func testBlockedRequestNeverLeavesTheWebView() async throws {
        let page = """
        <!doctype html><html><head><script src="/lucium-blocked-probe.js"></script><script src="/allowed-probe.js"></script></head><body>probe</body></html>
        """
        let routes: [String: LocalServer.Route] = [
            "/page.html": .init(contentType: "text/html", body: page),
            "/lucium-blocked-probe.js": .init(contentType: "text/javascript", body: "window.blockedRan = true"),
            "/allowed-probe.js": .init(contentType: "text/javascript", body: "window.allowedRan = true"),
        ]

        func run(withBlocker: Bool) async throws -> (blocked: Bool, allowed: Bool, asked: [String]) {
            let server = try LocalServer(routes: routes)
            let port = try await server.start()
            defer { server.stop() }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            if withBlocker {
                let list = try await ContentBlocker.compile(ContentBlocker.builtinRules(), identifier: "test.probe", in: temporaryStore())
                ContentBlocker.install(list, on: configuration)
            }
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
            let waiter = NavigationWaiter()
            let address = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/page.html"))
            try await waiter.load(in: view) { view.load(URLRequest(url: address)) }
            let blocked = try await view.evaluateJavaScript("window.blockedRan === true") as? Bool ?? false
            let allowed = try await view.evaluateJavaScript("window.allowedRan === true") as? Bool ?? false
            return (blocked, allowed, server.requestedPaths)
        }

        let control = try await run(withBlocker: false)
        XCTAssertTrue(control.blocked, "without the rules the probe script must run (the test must be able to fail)")
        XCTAssertTrue(control.allowed)

        let guarded = try await run(withBlocker: true)
        XCTAssertFalse(guarded.blocked, "the blocked script ran")
        XCTAssertTrue(guarded.allowed, "a script no rule names must still run")
        XCTAssertFalse(guarded.asked.contains("/lucium-blocked-probe.js"), "the blocked request reached the server: \(guarded.asked)")
        XCTAssertTrue(guarded.asked.contains("/allowed-probe.js"))
    }
}
