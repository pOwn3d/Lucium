import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The blocker's switches on real web views and real WebKit rules (docs/ios.md, section 6.6): a switch attaches or takes away a list, the mode changes
/// what a site's own requests meet, and a site of the exceptions is not blocked. A page of a local server stands for a site; a request it makes that never
/// reaches the server was stopped by WebKit.
@MainActor
final class BlockerSwitchesTests: XCTestCase {
    private var directory: URL!
    private var store: WKContentRuleListStore!
    private var server: LocalServer!
    private var port: UInt16 = 0
    /// Another site, on another port, that holds the same ad script: what a page of `server` asks of a third party.
    private var thirdParty: LocalServer!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-switches-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = try XCTUnwrap(WKContentRuleListStore(url: directory.appending(path: "rules", directoryHint: .isDirectory)))
        // One page that asks for an ad script and a banner script of its own site, and one that asks for the ad script of another site (`localhost` is
        // another site than `127.0.0.1` to WebKit).
        thirdParty = try LocalServer(routes: ["/probe/ad.js": .init(contentType: "text/javascript", body: "window.thirdRan = true")])
        let thirdPort = try await thirdParty.start()
        server = try LocalServer(routes: [
            "/page.html": .init(contentType: "text/html", body: "<!doctype html><title>Page</title><body>page"),
            "/probe/ad.js": .init(contentType: "text/javascript", body: "window.adRan = true"),
            "/probe/banner.js": .init(contentType: "text/javascript", body: "window.bannerRan = true"),
            "/probe/own.html": .init(contentType: "text/html", body: """
            <!doctype html><title>Own</title><script src="/probe/ad.js"></script><script src="/probe/banner.js"></script>
            """),
            "/probe/third.html": .init(contentType: "text/html", body: """
            <!doctype html><title>Third</title><script src="http://localhost:\(thirdPort)/probe/ad.js"></script>
            """),
        ])
        port = try await server.start()
    }

    override func tearDown() async throws {
        server.stop()
        thirdParty.stop()
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Lists written for the test

    private func file(_ name: String, kind: String, rules: String) -> (json: String, text: String) {
        let sha = String(repeating: "a", count: 40) + String(format: "%024x", abs(name.hashValue) % 0xffffff)
        return ("""
        {"name":"\(name)","kind":"\(kind)","rules":1,"sha256":"\(sha)"}
        """, rules)
    }

    /// Two lists, as the registry of the application has them: one for the ads (a rule for `/probe/ad.js`), one for the cookie banners (a rule for
    /// `/probe/banner.js`). Neither says anything of the party, as most rules of EasyList do not.
    private func lists() throws -> EmbeddedLists {
        let ads = file("ads.network.json", kind: "network", rules: #"[{"trigger":{"url-filter":"/probe/ad\\.js"},"action":{"type":"block"}}]"#)
        let cookies = file("cookies.network.json", kind: "network", rules: #"[{"trigger":{"url-filter":"/probe/banner\\.js"},"action":{"type":"block"}}]"#)
        func entry(_ id: String, _ category: String, _ file: (json: String, text: String)) -> String {
            """
            {"id":"\(id)","title":{"en":"\(id)","fr":"\(id)"},"category":"\(category)","author":{"en":"a","fr":"a"},"license":{"en":"l","fr":"l"},
             "licenseUrl":"https://example.org/l","homepage":"https://example.org","sourceUrl":"https://example.org/s","fetchedAt":"2026-11-19T12:00:00Z",
             "sourceVersion":"1","sourceSha256":"00","filters":1,"dropped":{},"files":[\(file.json)]}
            """
        }
        let registry = """
        {"schema":1,"generatedAt":"2026-11-19T12:00:00Z","lists":[\(entry("ads", "ads", ads)),\(entry("cookies", "cookies", cookies))]}
        """
        let texts = ["ads.network.json": ads.text, "cookies.network.json": cookies.text]
        return EmbeddedLists(registry: try FilterListRegistry.decode(Data(registry.utf8))) { file in try XCTUnwrap(texts[file.name]) }
    }

    private func makeModel(mode: BlockMode? = nil, change: ((inout PrivacySettings) -> Void)? = nil) async throws -> BrowserModel {
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { try self.lists() }, store: store)
        if mode != nil || change != nil {
            model.updatePrivacy {
                if let mode { $0.blockMode = mode }
                change?(&$0)
            }
        }
        await model.prepare()
        XCTAssertNil(model.blockerFailure)
        XCTAssertTrue(model.listFailures.isEmpty)
        return model
    }

    private func load(_ path: String, host: String = "127.0.0.1", in model: BrowserModel) async throws {
        let view = try XCTUnwrap(model.webView)
        let address = try XCTUnwrap(URL(string: "http://\(host):\(port)\(path)"))
        try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: address)) }
    }

    /// The paths the server was asked for so far.
    private func asked() -> Set<String> { Set(server.requestedPaths) }

    private func eventually(_ what: String, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(60)
        while !condition() {
            XCTAssertLessThan(ContinuousClock.now, deadline, "timed out waiting for \(what)")
            if ContinuousClock.now > deadline { throw NavigationWaiter.TimedOut() }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    // MARK: The switches

    func testTheAdsSwitchTakesTheAdsListOffTheViewAtOnceAndPutsItBack() async throws {
        let model = try await makeModel(mode: .strict)
        try await load("/probe/own.html", in: model)
        XCTAssertFalse(asked().contains("/probe/ad.js"), "on: the ad script is stopped")
        XCTAssertFalse(asked().contains("/probe/banner.js"), "the banner script is stopped too: the banners switch is on")

        model.updatePrivacy { $0.blockAds = false }
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(asked().contains("/probe/ad.js"), "off: the ad script comes through, on the page that was already open")
        let ran = try await model.webView?.evaluateJavaScript("window.adRan === true") as? Bool
        XCTAssertEqual(ran, true)

        model.updatePrivacy { $0.blockAds = true }
        let before = server.requests.count
        try await load("/probe/own.html", in: model)
        XCTAssertFalse(server.requests.dropFirst(before).map(\.path).contains("/probe/ad.js"), "on again: stopped again")
    }

    func testTheBannersSwitchTakesTheCookieListOffAndLeavesTheAdsListOn() async throws {
        let model = try await makeModel(mode: .strict) { $0.blockCookieBanners = false }
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(asked().contains("/probe/banner.js"), "banners off: their script comes through")
        XCTAssertFalse(asked().contains("/probe/ad.js"), "the ads list is still on")
    }

    func testBothSwitchesOffAttachNoList() async throws {
        let model = try await makeModel(mode: .strict) { $0.blockAds = false; $0.blockCookieBanners = false }
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(asked().isSuperset(of: ["/probe/ad.js", "/probe/banner.js"]))
        XCTAssertTrue(model.attachedBlockers.values.allSatisfy(\.isEmpty))
    }

    // MARK: The exceptions

    func testASiteOfTheExceptionsIsNotBlockedAndAnotherIsStill() async throws {
        let model = try await makeModel(mode: .strict) { $0.blockExceptions = ["127.0.0.1"] }
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(asked().isSuperset(of: ["/probe/ad.js", "/probe/banner.js"]), "nothing is blocked on a site of the list")

        // Another host is blocked as before, in the same view: the lists follow the page, not the view.
        let before = server.requests.count
        try await load("/probe/own.html", host: "localhost", in: model)
        XCTAssertFalse(server.requests.dropFirst(before).map(\.path).contains("/probe/ad.js"), "localhost is not on the list")

        // Taking the site off the list blocks it again from the next page.
        model.updatePrivacy { $0.blockExceptions = [] }
        let again = server.requests.count
        try await load("/probe/own.html", in: model)
        XCTAssertFalse(server.requests.dropFirst(again).map(\.path).contains("/probe/ad.js"))
    }

    func testAnExceptionAddedWhileThePageIsOpenAppliesToItsNextRequests() async throws {
        let model = try await makeModel(mode: .strict)
        try await load("/page.html", in: model)
        model.updatePrivacy { $0.blockExceptions = ["127.0.0.1"] }
        let script = "var s = document.createElement('script'); s.src = '/probe/ad.js'; document.body.appendChild(s); true"
        _ = try await model.webView?.evaluateJavaScript(script)
        try await eventually("the ad script of the open page to be asked for") { self.asked().contains("/probe/ad.js") }
    }

    // MARK: The mode

    func testStandardModeLeavesASitesOwnRequestsAloneAndStillBlocksThirdParties() async throws {
        let model = try await makeModel(mode: .standard)
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(asked().contains("/probe/ad.js"), "standard: a site loading its own script is not filtered")

        try await load("/probe/third.html", in: model)
        // The page of 127.0.0.1 asks another site for the script: a third party, which the list blocks (a page is done loading when its scripts are).
        XCTAssertFalse(thirdParty.requestedPaths.contains("/probe/ad.js"), "standard: a third party is blocked")
    }

    func testStrictModeBlocksASitesOwnRequestsToo() async throws {
        let model = try await makeModel(mode: .strict)
        try await load("/probe/own.html", in: model)
        XCTAssertFalse(asked().contains("/probe/ad.js"), "strict: the site's own request meets the list")
    }

    func testSwitchingTheModeCompilesTheOtherListsAndPutsThemOnTheOpenViews() async throws {
        let model = try await makeModel(mode: .standard)
        XCTAssertEqual(model.compiledBlockerMode, .standard)
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(asked().contains("/probe/ad.js"), "standard first")

        model.updatePrivacy { $0.blockMode = .strict }
        try await eventually("the strict lists") { model.compiledBlockerMode == .strict && !model.blockerModeBusy }
        let before = server.requests.count
        try await load("/probe/own.html", in: model)
        XCTAssertFalse(server.requests.dropFirst(before).map(\.path).contains("/probe/ad.js"), "strict now, on the view that was open")

        model.updatePrivacy { $0.blockMode = .standard }
        try await eventually("the standard lists") { model.compiledBlockerMode == .standard && !model.blockerModeBusy }
        let last = server.requests.count
        try await load("/probe/own.html", in: model)
        XCTAssertTrue(server.requests.dropFirst(last).map(\.path).contains("/probe/ad.js"), "and standard again")
    }

    func testTheStoreHoldsOnlyTheListsOfTheModeInUse() async throws {
        let model = try await makeModel(mode: .standard)
        let standard = Set(await store.availableIdentifiers() ?? [])
        XCTAssertTrue(standard.contains { $0.hasSuffix(".std") })
        model.updatePrivacy { $0.blockMode = .strict }
        try await eventually("the strict lists") { model.compiledBlockerMode == .strict && !model.blockerModeBusy }
        let strict = Set(await store.availableIdentifiers() ?? [])
        XCTAssertFalse(strict.contains { $0.hasSuffix(".std") }, "the standard copy went when the strict one was compiled")
        XCTAssertFalse(strict.isEmpty)
    }

    // MARK: The state

    func testTheSwitchesAreWrittenWhereTheMacReadsThem() async throws {
        let model = try await makeModel()
        model.updatePrivacy { $0.blockAds = false; $0.blockMode = .strict; $0.blockExceptions = ["example.org"] }
        guard case .object(let settings)? = model.state.rest["settings"] else { return XCTFail("no settings") }
        XCTAssertEqual(settings["blockAds"], .bool(false))
        XCTAssertEqual(settings["blockTrackers"], .bool(false))
        XCTAssertEqual(settings["blockMode"], .string("strict"))
        XCTAssertEqual(settings["blockExceptions"], .array([.string("example.org")]))
    }
}
