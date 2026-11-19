import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// A page of the local network (Home Assistant, a NAS, a printer): the shape that gave a blank page on the first TestFlight builds (card 684). The
/// server is on the loopback of the simulator: it proves what the application does with such a page, not what iOS asks of a real device.
@MainActor
final class LocalNetworkPageTests: BrowserCoreTestCase {
    static let site: [String: LocalServer.Route] = [
        "/ha.html": .init(contentType: "text/html", body: "<!doctype html><title>Home</title><script src=\"/app.js\"></script><body>home"),
        "/app.js": .init(contentType: "text/javascript", body: """
        window.scriptRan = true
        const socket = new WebSocket('ws://' + location.host + '/api/websocket')
        socket.onopen = () => { window.socketState = 'open' }
        socket.onmessage = (event) => { window.socketMessage = event.data }
        socket.onerror = () => { window.socketState = 'error' }
        """),
        "/api/websocket": .webSocket(sending: "{\"type\":\"auth_required\"}"),
    ]

    override func setUp() async throws {
        try await super.setUp()
        server.stop()
        server = try LocalServer(routes: Self.site)
        port = try await server.start()
    }

    private func read(_ source: String, in view: WKWebView) async throws -> String? {
        let deadline = ContinuousClock.now + .seconds(10)
        var last: String?
        while ContinuousClock.now < deadline {
            last = try await view.evaluateJavaScript(source) as? String
            if let last, !last.isEmpty { return last }
            try await Task.sleep(for: .milliseconds(50))
        }
        return last
    }

    /// Typed as a person types it (no scheme, a port): the script of the page runs and its WebSocket (`ws://`, not `wss://`) opens and receives.
    func testAnInterfaceOfTheLocalNetworkLoadsItsScriptAndOpensItsWebSocket() async throws {
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        model.addressText = "127.0.0.1:\(port)/ha.html"
        model.submitAddress()
        try await eventually("the page loaded", timeout: .seconds(20), { view.url?.path == "/ha.html" && !view.isLoading })
        let state = try await read("window.socketState || ''", in: view)
        XCTAssertEqual(state, "open", "the WebSocket of the page did not open")
        let message = try await read("window.socketMessage || ''", in: view)
        XCTAssertEqual(message, "{\"type\":\"auth_required\"}")
        XCTAssertTrue(server.requestedPaths.contains("/app.js") && server.requestedPaths.contains("/api/websocket"))
    }

    /// « Open over HTTP » on the screen of a failed secure connection to a device of the person's own network loads the http address, as the person's own load.
    func testOpenOverHttpLoadsTheHttpAddressOfADeviceOfTheOwnNetwork() async throws {
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        let tab = try XCTUnwrap(model.activeTab?.id)
        model.loadFailures[tab] = LoadFailure(kind: .secureConnection, address: "https://127.0.0.1:\(port)/ha.html")
        model.navigationPolicy.openOverHttp(tab: tab)
        try await eventually("the http address loaded", timeout: .seconds(20), { view.url == address("/ha.html") && !view.isLoading })
        XCTAssertNil(model.loadFailures[tab], "the screen of the failure goes with the new load")
    }

    /// The screen offers nothing for another site: the failure of a public site is never sent back to http by this action.
    func testOpenOverHttpDoesNothingForAPublicSite() async throws {
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        let tab = try XCTUnwrap(model.activeTab?.id)
        // The blank document of the new tab settles first: its start clears a failure that was set while it was loading.
        try await eventually("the blank tab settled", { !view.isLoading })
        let failure = LoadFailure(kind: .secureConnection, address: "https://example.org/")
        model.loadFailures[tab] = failure
        let before = view.url
        model.navigationPolicy.openOverHttp(tab: tab)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(view.url, before, "no load was made")
        XCTAssertEqual(model.loadFailures[tab], failure)
    }
}
