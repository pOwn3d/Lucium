import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The privacy rules on a real web view: what reaches the server, what a page can read, and what the person is told. The pure rules are proved by
/// `swift test` (the shared vectors, `HttpsUpgrades`); this is the glue that WebKit asks for.
@MainActor
final class PrivacyNavigationTests: BrowserCoreTestCase {
    static let site: [String: LocalServer.Route] = [
        "/a.html": .init(contentType: "text/html", body: "<!doctype html><title>Page A</title><h1>A</h1>"),
        "/b.html": .init(contentType: "text/html", body: "<!doctype html><title>Page B</title><h1>B</h1>"),
        "/c.html": .init(contentType: "text/html", body: "<!doctype html><title>Page C</title><h1>C</h1>"),
        "/with-frame.html": .init(contentType: "text/html", body: "<!doctype html><title>Frame</title><iframe src=\"/frame.html\"></iframe>"),
        "/frame.html": .init(contentType: "text/html", body: "<!doctype html><script>parent.frameSignal = navigator.globalPrivacyControl</script>"),
        "/links.html": .init(contentType: "text/html", body: "<!doctype html><title>Links</title><a id=\"plain\" href=\"/b.html\">b</a><a id=\"tracked\" href=\"/c.html?utm_source=x&amp;keep=1\">c</a>"),
        "/with-script.html": .init(contentType: "text/html", body: "<!doctype html><title>Script</title><script src=\"/sub.js\"></script>"),
        "/hop": .redirect("/b.html"),
        "/sub.js": .init(contentType: "text/javascript", body: "window.subLoaded = true"),
        // A server that sends every visitor back to an address with a tracking parameter: stripping it would feed the loop for ever.
        "/loop": .redirect("/loop?utm_source=x"),
        "/loop?utm_source=x": .redirect("/loop?utm_source=x"),
    ]

    override func setUp() async throws {
        try await super.setUp()
        server.stop()
        server = try LocalServer(routes: Self.site)
        port = try await server.start()
    }

    /// Types an address and waits until the view shows the page it should end on.
    func go(_ typed: String, in model: BrowserModel, endingOn final: String? = nil, file: StaticString = #filePath, line: UInt = #line) async throws {
        let view = try XCTUnwrap(model.webView, "no web view", file: file, line: line)
        model.addressText = address(typed).absoluteString
        model.submitAddress()
        let expected = address(final ?? typed)
        try await eventually("\(expected) loaded", timeout: .seconds(20), { view.url == expected && !view.isLoading }, file: file, line: line)
    }

    /// What the page reads, once it can: scripts of the page run a moment after the load.
    func script(_ source: String, in view: WKWebView, equals expected: Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        var last: Bool?
        while ContinuousClock.now < deadline {
            last = try await view.evaluateJavaScript(source) as? Bool
            if last == expected { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("\(source) was \(String(describing: last)), expected \(expected)", file: file, line: line)
    }

    func headers(of path: String) -> [String: String]? { server.requests.last { $0.path == path }?.headers }

    // MARK: Tracking parameters

    func testTrackingParametersNeverReachTheServer() async throws {
        let model = await makeModel()
        try await go("/a.html?utm_source=news&keep=1&fbclid=abc", in: model, endingOn: "/a.html?keep=1")
        XCTAssertEqual(server.requestedPaths.filter { $0.hasPrefix("/a.html") }, ["/a.html?keep=1"], "the address with its parameters was never asked for")
    }

    func testNothingIsRewrittenAndNoSignalIsSentWhenTheOptionsAreOff() async throws {
        let model = await makeModel()
        model.updatePrivacy { $0.choose(.standard) }
        try await go("/a.html?utm_source=news", in: model)
        XCTAssertEqual(server.requestedPaths.filter { $0.hasPrefix("/a.html") }, ["/a.html?utm_source=news"])
        XCTAssertNil(headers(of: "/a.html?utm_source=news")?["sec-gpc"])
    }

    func testARedirectLoopThatTheRewritesWouldFeedStopsAtTheCap() async throws {
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        model.addressText = address("/loop").absoluteString
        model.submitAddress()
        // The load ends when the cap lets the redirects through to the network's own limit; without the cap it never ends.
        var before = -1
        try await eventually("the loop to end", timeout: .seconds(40), {
            defer { before = server.requestedPaths.count }
            return !view.isLoading && before == server.requestedPaths.count && before > 0
        })
        XCTAssertLessThan(server.requestedPaths.count, 60, "\(server.requestedPaths.count) requests: the cap of \(PrivacyNavigation.maxRewrites) rewrites did not hold")
    }

    // MARK: Global Privacy Control

    func testTheSignalGoesWithTheNavigationAndEveryFrameReadsIt() async throws {
        let model = await makeModel()
        try await go("/with-frame.html", in: model)
        XCTAssertEqual(headers(of: "/with-frame.html")?["sec-gpc"], "1")
        let view = try XCTUnwrap(model.webView)
        try await script("navigator.globalPrivacyControl === true", in: view, equals: true)
        try await script("window.frameSignal === true", in: view, equals: true)
    }

    /// WebKit adds nothing to a link that is followed: the application cancels it and loads the same address again with the header.
    func testALinkThatIsFollowedIsLoadedAgainWithTheSignal() async throws {
        let model = await makeModel()
        try await go("/links.html", in: model)
        let view = try XCTUnwrap(model.webView)
        _ = try await view.evaluateJavaScript("document.getElementById('plain').click()")
        try await eventually("/b.html asked for", timeout: .seconds(20), { server.requestedPaths.contains("/b.html") })
        XCTAssertEqual(server.requestedPaths.filter { $0 == "/b.html" }.count, 1, "the link without the signal never left the application")
        XCTAssertEqual(headers(of: "/b.html")?["sec-gpc"], "1")
    }

    func testALinkWithTrackingParametersIsCleanedAndCarriesTheSignal() async throws {
        let model = await makeModel()
        try await go("/links.html", in: model)
        let view = try XCTUnwrap(model.webView)
        _ = try await view.evaluateJavaScript("document.getElementById('tracked').click()")
        try await eventually("/c.html?keep=1 asked for", timeout: .seconds(20), { server.requestedPaths.contains("/c.html?keep=1") })
        XCTAssertFalse(server.requestedPaths.contains { $0.contains("utm_source") }, "\(server.requestedPaths)")
        XCTAssertEqual(headers(of: "/c.html?keep=1")?["sec-gpc"], "1")
    }

    /// The limit the README states: WebKit gives the application no hook on what a page requests by itself, so the header does not reach it.
    func testWhatAPageRequestsByItselfCarriesNoHeaderWhichIsTheLimitTheReadmeStates() async throws {
        let model = await makeModel()
        try await go("/with-script.html", in: model)
        let view = try XCTUnwrap(model.webView)
        try await script("window.subLoaded === true", in: view, equals: true)
        XCTAssertEqual(headers(of: "/with-script.html")?["sec-gpc"], "1")
        XCTAssertNil(headers(of: "/sub.js")?["sec-gpc"], "if WebKit now sends the header for a page's own requests, the README and the setting's help text are out of date")
    }

    /// Measured, not assumed: the hop of a server redirect after a typed address.
    func testTheHopOfARedirectCarriesTheSignalToo() async throws {
        let model = await makeModel()
        try await go("/hop", in: model, endingOn: "/b.html")
        XCTAssertEqual(headers(of: "/hop")?["sec-gpc"], "1")
        XCTAssertEqual(headers(of: "/b.html")?["sec-gpc"], "1", "the page a redirect leads to was asked for without the signal")
    }

    func testTheSignalIsNeitherSentNorReadWhenItIsOff() async throws {
        let model = await makeModel()
        model.updatePrivacy { $0.sendGpc = false }
        try await go("/a.html", in: model)
        XCTAssertNil(headers(of: "/a.html")?["sec-gpc"])
        let view = try XCTUnwrap(model.webView)
        try await script("navigator.globalPrivacyControl === true", in: view, equals: false)
    }

    /// The setting reaches the views that are already awake, in both directions.
    func testSwitchingTheSignalAppliesToThePagesOpenedAfterwards() async throws {
        let model = await makeModel()
        try await go("/a.html", in: model)
        let view = try XCTUnwrap(model.webView)
        try await script("navigator.globalPrivacyControl === true", in: view, equals: true)

        model.updatePrivacy { $0.sendGpc = false }
        try await go("/b.html", in: model)
        XCTAssertNil(headers(of: "/b.html")?["sec-gpc"])
        try await script("navigator.globalPrivacyControl === true", in: view, equals: false)

        model.updatePrivacy { $0.sendGpc = true }
        try await go("/c.html", in: model)
        XCTAssertEqual(headers(of: "/c.html")?["sec-gpc"], "1")
        try await script("navigator.globalPrivacyControl === true", in: view, equals: true)
    }

    // MARK: HTTPS first

    /// The tests give the rule another way to upgrade, because the real one never upgrades a local address: `http://127.0.0.1:<port>` goes to
    /// `https://<host>`, which is a port where nothing listens, or one that never answers.
    func upgrade(to secure: String) -> @Sendable (String) -> String? {
        let origin = "http://127.0.0.1:\(port)"
        return { http in http.hasPrefix(origin) ? secure + http.dropFirst(origin.count) : nil }
    }

    func testASiteThatRefusesTheConnectionOverHttpsOpensOverHttpAndSaysSo() async throws {
        // A port where nothing listens: the one a server just left. (Not port 1: WebKit does not even try the ports it keeps for other protocols.)
        let closed = try LocalServer(routes: [:])
        let closedPort = try await closed.start()
        closed.stop()
        let model = await makeModel()
        model.navigationPolicy.upgrades = HttpsUpgrades(rule: upgrade(to: "https://127.0.0.1:\(closedPort)"))
        try await go("/a.html", in: model)
        XCTAssertEqual(server.requestedPaths.filter { $0 == "/a.html" }.count, 1, "the page opened over http, once")
        let notice = try XCTUnwrap(model.privacyPrompts.notice, "the person was not told")
        XCTAssertTrue(notice.contains("127.0.0.1"), notice)
        XCTAssertNil(model.privacyPrompts.refusal, "a refused connection is not a refused certificate")
    }

    func testASiteThatStaysSilentOverHttpsOpensOverHttpAfterTheTimeout() async throws {
        let silent = try LocalServer(routes: [:], silent: true)
        let silentPort = try await silent.start()
        defer { silent.stop() }
        let model = await makeModel()
        model.navigationPolicy.timeout = .milliseconds(400)
        model.navigationPolicy.upgrades = HttpsUpgrades(rule: upgrade(to: "https://127.0.0.1:\(silentPort)"))
        try await go("/a.html", in: model)
        XCTAssertNotNil(model.privacyPrompts.notice, "the person was not told")
    }

    // MARK: The screen of a page that did not load

    func testAPageThatCannotLoadGetsAnErrorScreenThatRetryAndANewLoadClear() async throws {
        let closed = try LocalServer(routes: [:])
        let closedPort = try await closed.start()
        closed.stop()
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        let tab = try XCTUnwrap(model.activeTab).id
        let dead = "http://127.0.0.1:\(closedPort)/x"
        model.addressText = dead
        model.submitAddress()
        try await eventually("the error screen is on", timeout: .seconds(20), { model.loadFailures[tab] != nil })
        let failure = try XCTUnwrap(model.loadFailures[tab])
        XCTAssertEqual(failure.kind, .cannotConnect)
        XCTAssertEqual(failure.retryAddress, dead)

        // « Try again » loads the same address: the screen goes while it loads, and comes back as the site still does not answer.
        model.navigationPolicy.retry(tab: tab)
        try await eventually("the retry loaded the address again", timeout: .seconds(20), { model.loadFailures[tab] != nil && !view.isLoading })
        XCTAssertEqual(model.loadFailures[tab]?.retryAddress, dead)

        // Another address replaces the screen.
        try await go("/a.html", in: model)
        XCTAssertNil(model.loadFailures[tab], "a page that loaded leaves no error screen behind")
    }

    func testACancelledLoadLeavesNoErrorScreenAndARefusedCertificateGetsItsOwn() async throws {
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        let tab = try XCTUnwrap(model.activeTab).id
        let url = URL(string: "https://example.org/")!
        model.navigationPolicy.webView(view, didFailProvisionalNavigation: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSURLErrorFailingURLErrorKey: url]))
        XCTAssertNil(model.loadFailures[tab], "a cancelled load has no error screen")
        // No upgrade was under way: the page was asked for directly, and a blank page says nothing (card 684: a device with a certificate of its own).
        model.navigationPolicy.webView(view, didFailProvisionalNavigation: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateUntrusted, userInfo: [NSURLErrorFailingURLErrorKey: url]))
        XCTAssertEqual(model.loadFailures[tab]?.kind, .certificate)
        XCTAssertNil(model.privacyPrompts.refusal, "the prompt is the one of an upgrade of HTTPS first")
        model.navigationPolicy.webView(view, didFailProvisionalNavigation: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet, userInfo: [NSURLErrorFailingURLErrorKey: url]))
        XCTAssertEqual(model.loadFailures[tab]?.kind, .offline)
    }

    /// WebKit gives no way to make a certificate invalid here, so the failure is handed to the delegate as WebKit reports it.
    func testARefusedCertificateIsShownAndTheHttpAddressOpensOnlyOnTheClick() async throws {
        let model = await makeModel()
        let view = try XCTUnwrap(model.webView)
        let tab = try XCTUnwrap(model.activeTab).id
        let http = address("/a.html").absoluteString
        model.navigationPolicy.upgrades = HttpsUpgrades(rule: upgrade(to: "https://127.0.0.1:1"))
        XCTAssertNotNil(model.navigationPolicy.upgrades.upgrade(page: tab, http: http), "an upgrade is under way")
        let certificate = NSError(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateUntrusted, userInfo: [NSURLErrorFailingURLErrorKey: URL(string: "https://127.0.0.1:1/a.html")!])
        model.navigationPolicy.webView(view, didFailProvisionalNavigation: nil, withError: certificate)

        let refusal = try XCTUnwrap(model.privacyPrompts.refusal, "a refused certificate must be shown")
        XCTAssertEqual(refusal.http, http)
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertFalse(server.requestedPaths.contains("/a.html"), "the http address must never open by itself after a refused certificate")
        XCTAssertNil(model.privacyPrompts.notice)

        model.navigationPolicy.continueOverHttp(refusal)
        try await eventually("/a.html asked for after the click", timeout: .seconds(20), { server.requestedPaths.contains("/a.html") })
        XCTAssertNil(model.privacyPrompts.refusal)
    }

    /// Card 684: a `.local` name that does not resolve kept the page waiting 61 s; the loads of a device of the local network (typed, retried) wait 15 s.
    func testTheLoadsOfADeviceOfTheLocalNetworkWaitLessThanWebKitsSixtySeconds() async throws {
        let model = await makeModel()
        let defaultWait = URLRequest(url: URL(string: "https://example.org/")!).timeoutInterval
        let local = try XCTUnwrap(BrowserModel.request(for: "homeassistant.local:8123"))
        XCTAssertEqual(local.timeoutInterval, LoadFailure.localNetworkTimeout, "an address typed without scheme")
        XCTAssertEqual(try XCTUnwrap(model.navigationPolicy.request(for: "http://192.168.1.20:8123/")).timeoutInterval, LoadFailure.localNetworkTimeout,
                       "a retry, an « Open over HTTP »")
        XCTAssertEqual(try XCTUnwrap(BrowserModel.request(for: "example.org")).timeoutInterval, defaultWait, "another site keeps WebKit's wait")
        XCTAssertEqual(try XCTUnwrap(model.navigationPolicy.request(for: "https://example.org/")).timeoutInterval, defaultWait)
    }

    func testWhatIsAndIsNotACertificateFailure() {
        for code in [NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid] {
            XCTAssertTrue(PrivacyNavigation.isCertificateFailure(NSError(domain: NSURLErrorDomain, code: code)), "\(code)")
        }
        for code in [NSURLErrorSecureConnectionFailed, NSURLErrorCannotConnectToHost, NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet] {
            XCTAssertFalse(PrivacyNavigation.isCertificateFailure(NSError(domain: NSURLErrorDomain, code: code)), "\(code): the site did not answer, which is not a refused certificate")
        }
        XCTAssertTrue(PrivacyNavigation.isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        XCTAssertTrue(PrivacyNavigation.isCancellation(NSError(domain: "WebKitErrorDomain", code: 102)))
        XCTAssertFalse(PrivacyNavigation.isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)))
    }

    /// Without `NSAllowsArbitraryLoadsInWebContent` WebKit refuses every http page on a device, and with it the fall back of HTTPS first.
    func testAnHttpPageIsNotRefusedByAppTransportSecurity() async throws {
        let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any]
        XCTAssertEqual(ats?["NSAllowsArbitraryLoadsInWebContent"] as? Bool, true)
        XCTAssertNil(ats?["NSAllowsArbitraryLoads"], "only web content is let through, not the application's own connections")

        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let waiter = NavigationWaiter()
        do {
            try await waiter.load(in: view, timeout: .seconds(20)) { view.load(URLRequest(url: URL(string: "http://lucium-ats-probe.invalid/")!)) }
            XCTFail("a name that does not exist loaded")
        } catch is NavigationWaiter.TimedOut {
            // The name lookup did not answer in time: nothing refused the page for its scheme, which is all this checks.
            print("[test] the lookup of the probe name did not answer within 20 s: App Transport Security did not refuse it")
        } catch {
            XCTAssertNotEqual((error as NSError).code, NSURLErrorAppTransportSecurityRequiresSecureConnection, "App Transport Security refused an http page: \(error)")
        }
    }

    // MARK: The settings

    func testThePrivacyChoicesAreKeptInTheStateFileUnderTheMacsNames() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.privacySettings, .newProfile)
        model.updatePrivacy { $0.choose(.standard); $0.httpsUpgrade = false }
        model.flush()

        let reopened = BrowserModel.launch(directory: directory)
        XCTAssertEqual(reopened.privacySettings, PrivacySettings(httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false))
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appending(path: StateFile.fileName))) as? [String: Any]
        let settings = try XCTUnwrap(json?["settings"] as? [String: Any])
        XCTAssertEqual(settings["sendGpc"] as? Bool, false)
        XCTAssertEqual(settings["httpsUpgrade"] as? Bool, false)
        XCTAssertEqual(settings["protectionBaseline"] as? String, "renforcee")
    }
}
