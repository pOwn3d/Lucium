import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The page guard, in a real web view against real pages: the scriptlets the table names run in the page of the site it names, before the page's own
/// scripts, and in no other page; the plan follows each navigation (redirects, back to a site, a site not in the table); the consent walls are hidden;
/// the scripts of others on the web view survive. (`PageGuardTests` of LuciumKit proves the plan itself, without WebKit.)
@MainActor
final class PageGuardTests: XCTestCase {
    private var server: LocalServer!
    private var port: UInt16 = 0
    private var directory: URL!
    private var store: WKContentRuleListStore!

    /// `window.seen` is what the page's own script read of `adsLoaded`: the guard's `set-constant` has made it `false` before that script ran, and
    /// without the guard it is not defined. The wall is the container of a consent platform the Mac knows by its id.
    private static let page = """
    <!doctype html><title>Guard</title><script>window.seen = String(window.adsLoaded)</script>
    <div id="onetrust-consent-sdk">consent wall</div><p id="content">content</p>
    """

    override func setUp() async throws {
        server = try LocalServer(routes: [
            "/page.html": .init(contentType: "text/html", body: Self.page),
            "/to-localhost": .redirect("http://localhost:{port}/page.html"),
            "/to-ip": .redirect("http://127.0.0.1:{port}/page.html"),
        ])
        port = try await server.start()
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-guard-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = try XCTUnwrap(WKContentRuleListStore(url: directory.appending(path: "rules", directoryHint: .isDirectory)))
    }

    override func tearDown() async throws {
        server.stop()
        try? FileManager.default.removeItem(at: directory)
    }

    /// The table of a list that names `adsLoaded = false` for the sites in `hosts`.
    private func table(for hosts: [String]) throws -> ScriptletTable {
        let domains = hosts.map { #""\#($0)":[["set-constant",["adsLoaded","false"]]]"# }.joined(separator: ",")
        var table = ScriptletTable()
        try table.merge(Data(#"{"schema":1,"domains":{\#(domains)}}"#.utf8), category: .ads)
        return table
    }

    /// The switches a test wants, put where the application reads them: the privacy settings of the state (the guard is given them at each page). The
    /// default `GuardSettings()` is everything on, extended rules included, which no level but « Stricte » stands for.
    private func switches(_ settings: GuardSettings, on model: BrowserModel) {
        model.updatePrivacy {
            $0.blockAds = settings.blockAds
            $0.blockCookieBanners = settings.blockCookieBanners
            $0.blockScriptlets = settings.blockScriptlets
            $0.blockExceptions = settings.exemptSites
        }
    }

    private func model(hosts: [String] = ["127.0.0.1"], settings: GuardSettings = GuardSettings()) async throws -> BrowserModel {
        let table = try table(for: hosts)
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil },
                                        pageGuard: { _ in try PageGuard.load(table: table, settings: settings) }, store: store)
        switches(settings, on: model)
        await model.prepare()
        XCTAssertNil(model.guardFailure)
        return model
    }

    private func load(_ address: String, in model: BrowserModel) async throws -> WKWebView {
        let view = try XCTUnwrap(model.webView)
        try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: URL(string: address)!)) }
        return view
    }

    private func seen(_ view: WKWebView) async throws -> String? { try await view.evaluateJavaScript("window.seen") as? String }
    private func url(_ host: String, _ path: String = "/page.html") -> String { "http://\(host):\(port)\(path)" }

    // MARK: The scriptlets

    func testAScriptletRunsInThePageOfTheSiteTheTableNamesBeforeThePagesOwnScripts() async throws {
        let view = try await load(url("127.0.0.1"), in: try await model())
        let value = try await seen(view)
        XCTAssertEqual(value, "false", "the page's own script read `adsLoaded` after the guard had set it")
    }

    func testAPageGetsNothingWhenNoCallIsNamedForItsSite() async throws {
        let view = try await load(url("127.0.0.1"), in: try await model(hosts: ["other.example"]))
        let value = try await seen(view)
        XCTAssertEqual(value, "undefined")
    }

    func testThePlanFollowsTheSiteOfEachPageAndTheNextPageDoesNotKeepTheLastOnes() async throws {
        let model = try await model(hosts: ["127.0.0.1"])
        var view = try await load(url("127.0.0.1"), in: model)
        var value = try await seen(view)
        XCTAssertEqual(value, "false", "a site the table names")
        view = try await load(url("localhost"), in: model)
        value = try await seen(view)
        XCTAssertEqual(value, "undefined", "the next page, of a site it does not name, does not inherit the last page's script")
        view = try await load(url("127.0.0.1"), in: model)
        value = try await seen(view)
        XCTAssertEqual(value, "false", "and the first site gets it back")
    }

    func testTheFinalAddressOfARedirectDecidesNotTheFirstOne() async throws {
        let model = try await model(hosts: ["127.0.0.1"])
        var view = try await load(url("127.0.0.1", "/to-localhost"), in: model)
        var value = try await seen(view)
        XCTAssertEqual(value, "undefined", "from a site the table names to one it does not")
        view = try await load(url("localhost", "/to-ip"), in: model)
        value = try await seen(view)
        XCTAssertEqual(value, "false", "from a site the table does not name to one it does")
    }

    func testTheSwitchOfTheExtendedRulesStopsTheCallsOfTheLists() async throws {
        let view = try await load(url("127.0.0.1"), in: try await model(settings: GuardSettings(blockScriptlets: false)))
        let value = try await seen(view)
        XCTAssertEqual(value, "undefined")
    }

    func testASiteWithAnExceptionIsLeftAlone() async throws {
        let view = try await load(url("127.0.0.1"), in: try await model(settings: GuardSettings(exemptSites: ["127.0.0.1"])))
        let value = try await seen(view)
        XCTAssertEqual(value, "undefined")
    }

    // MARK: The style sheet

    func testTheKnownConsentWallIsHiddenAndTheContentIsNot() async throws {
        let view = try await load(url("localhost"), in: try await model(hosts: []))
        let wall = try await view.evaluateJavaScript("getComputedStyle(document.getElementById('onetrust-consent-sdk')).display") as? String
        let content = try await view.evaluateJavaScript("getComputedStyle(document.getElementById('content')).display") as? String
        XCTAssertEqual(wall, "none")
        XCTAssertEqual(content, "block")
    }

    func testTheConsentWallStaysWhenTheCookieBannerSwitchIsOff() async throws {
        let view = try await load(url("localhost"), in: try await model(hosts: [], settings: GuardSettings(blockCookieBanners: false)))
        let wall = try await view.evaluateJavaScript("getComputedStyle(document.getElementById('onetrust-consent-sdk')).display") as? String
        XCTAssertEqual(wall, "block")
    }

    // MARK: The web view

    func testTheScriptsOfOthersOnTheWebViewSurviveEveryNavigation() async throws {
        let model = try await model()
        let view = try XCTUnwrap(model.webView)
        // What was on the view already (the privacy rules' script, say) is somebody else's too: it must survive as well.
        let already = view.configuration.userContentController.userScripts.filter { !$0.source.hasPrefix(PageGuard.marker) }.count
        let theirs = WKUserScript(source: "window.theirs = (window.theirs || 0) + 1", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        view.configuration.userContentController.addUserScript(theirs)
        for host in ["127.0.0.1", "localhost", "127.0.0.1"] {
            _ = try await load(url(host), in: model)
            let value = try await view.evaluateJavaScript("window.theirs") as? Int
            XCTAssertEqual(value, 1, "their script ran once on \(host)")
        }
        let scripts = view.configuration.userContentController.userScripts
        XCTAssertEqual(scripts.filter { !$0.source.hasPrefix(PageGuard.marker) }.count, already + 1)
        XCTAssertLessThanOrEqual(scripts.filter { $0.source.hasPrefix(PageGuard.marker) }.count, 1, "never two scripts of the guard on one web view")
    }

    /// A change of a privacy setting puts the scripts of every web view back (`PrivacyNavigation.installScripts`): the plan of the page on its way
    /// must not be lost in it, and the privacy rules' own script must stay.
    func testAChangeOfAPrivacySettingKeepsThePlanOfThePageOnItsWay() async throws {
        let model = try await model()
        let view = try await load(url("127.0.0.1"), in: model)
        let guards = { view.configuration.userContentController.userScripts.filter { $0.source.hasPrefix(PageGuard.marker) } }
        let others = { view.configuration.userContentController.userScripts.filter { !$0.source.hasPrefix(PageGuard.marker) }.count }
        let before = others()
        XCTAssertEqual(guards().count, 1)
        model.navigationPolicy.optionsChanged(on: Array(model.webViews.values))
        XCTAssertEqual(guards().count, 1, "the plan is still there after the scripts were put back")
        XCTAssertEqual(others(), before, "and what the privacy rules carry is as it was")
    }

    func testTheGuardIsTakenOffAPageThatHasNoPlan() async throws {
        let model = try await model()
        let view = try await load(url("127.0.0.1"), in: model)
        XCTAssertEqual(view.configuration.userContentController.userScripts.filter { $0.source.hasPrefix(PageGuard.marker) }.count, 1)
        try await NavigationWaiter().load(in: view) { view.loadHTMLString("<!doctype html><p>blank</p>", baseURL: nil) }
        XCTAssertEqual(view.configuration.userContentController.userScripts.filter { $0.source.hasPrefix(PageGuard.marker) }.count, 0, "a page with nothing to run carries no script")
    }

    // MARK: A copy that lacks something

    func testACopyWithNoRuntimeBrowsesWithoutAGuard() async throws {
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil }, pageGuard: { _ in nil }, store: store)
        await model.prepare()
        XCTAssertNil(model.guardFailure)
        XCTAssertNil(model.pageGuard)
        let view = try await load(url("127.0.0.1"), in: model)
        let value = try await seen(view)
        XCTAssertEqual(value, "undefined")
        XCTAssertTrue(view.configuration.userContentController.userScripts.filter { $0.source.hasPrefix(PageGuard.marker) }.isEmpty, "no guard script on a copy that has none")
    }

    /// A plan that cannot be written must not stop the page: it loads without the guard, and the guard says why.
    func testAPlanThatCannotBeWrittenLoadsThePageWithoutTheGuardAndSaysSo() async throws {
        struct Unwritable: Error {}
        let table = try table(for: ["127.0.0.1"])
        let broken = try XCTUnwrap(PageGuard.load(table: table))
        broken.encodePlan = { _ in throw Unwritable() }
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil }, pageGuard: { _ in broken }, store: store)
        await model.prepare()
        let view = try await load(url("127.0.0.1"), in: model)
        let value = try await seen(view)
        XCTAssertEqual(value, "undefined", "no guard on that page")
        let content = try await view.evaluateJavaScript("document.getElementById('content').textContent") as? String
        XCTAssertEqual(content, "content", "and the page is there")
        XCTAssertTrue(try XCTUnwrap(broken.lastProblem).contains("could not be written"))
        XCTAssertEqual(view.configuration.userContentController.userScripts.filter { $0.source.hasPrefix(PageGuard.marker) }.count, 0)
        // The next page that can be written clears the problem.
        broken.encodePlan = PageGuard.encode
        _ = try await load(url("127.0.0.1"), in: model)
        XCTAssertNil(broken.lastProblem)
    }

    func testAGuardThatCannotBeMadeIsReportedAndBrowsingGoesOn() async throws {
        struct Broken: Error {}
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil }, pageGuard: { _ in throw Broken() }, store: store)
        await model.prepare()
        XCTAssertTrue(model.guardFailure is Broken)
        let view = try await load(url("127.0.0.1"), in: model)
        let content = try await view.evaluateJavaScript("document.getElementById('content').textContent") as? String
        XCTAssertEqual(content, "content")
    }

    // MARK: What the build carries

    /// The files the application embeds are the ones the build step made: the runtime is there, the rules are read, and WebKit takes the rules of
    /// our own (YouTube's ad paths), compiled under a name that carries their content.
    func testTheEmbeddedRuntimeAndRulesAreThereAndWebKitTakesTheRules() async throws {
        let guardInBundle = try XCTUnwrap(PageGuard.load(), "guard-runtime.js is missing from the application: run scripts/ios-guard.mjs")
        let rules = try XCTUnwrap(guardInBundle.rules, "guard-rules.json is missing from the application")
        XCTAssertFalse(rules.youtube.scriptlets.isEmpty)
        XCTAssertTrue(rules.youtube.scriptlets.map(\.id).contains("json-prune"))
        // A list of an older copy goes when the current one is compiled.
        _ = try await ContentBlocker.compile("[{\"trigger\":{\"url-filter\":\"^x\"},\"action\":{\"type\":\"block\"}}]", identifier: "\(GuardRules.identifierPrefix)stale", in: store)
        let list = try await guardInBundle.compileNetworkRules(in: store)
        XCTAssertEqual(list?.identifier, rules.networkRulesIdentifier)
        let identifiers = await store.availableIdentifiers() ?? []
        XCTAssertEqual(identifiers, [rules.networkRulesIdentifier], "the stale list is removed")
        let again = try await guardInBundle.compileNetworkRules(in: store)
        XCTAssertEqual(again?.identifier, rules.networkRulesIdentifier, "found again, not compiled twice")
    }

    /// The real runtime and the real YouTube rules, on a page that stands for the player's answer: the guard prunes the ad entries the page reads
    /// out of the JSON, as it does on youtube.com (the plan for the YouTube address itself is proven in LuciumKit and by the shared vectors).
    func testTheYouTubeCallsPruneTheAdEntriesOfAPlayerAnswer() async throws {
        let rules = try XCTUnwrap(PageGuard.load()?.rules)
        var table = ScriptletTable()
        let calls = rules.youtube.scriptlets.map { #"["\#($0.id)",\#(String(decoding: try! JSONEncoder().encode($0.args), as: UTF8.self))]"# }.joined(separator: ",")
        try table.merge(Data(#"{"schema":1,"domains":{"127.0.0.1":[\#(calls)]}}"#.utf8), category: .ads)
        let answer = #"{"videoDetails":{"videoId":"x"},"adPlacements":[{"a":1}],"playerAds":[{"b":2}],"adSlots":[{"c":3}],"streamingData":{"ok":true}}"#
        let page = "<!doctype html><title>Player</title><script>window.parsed = JSON.parse('\(answer)'); window.seen = 'done'</script>"
        let local = try LocalServer(routes: ["/player.html": .init(contentType: "text/html", body: page)])
        let localPort = try await local.start()
        defer { local.stop() }
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil },
                                        pageGuard: { _ in try PageGuard.load(table: table) }, store: store)
        switches(GuardSettings(), on: model)
        await model.prepare()
        let view = try XCTUnwrap(model.webView)
        try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(localPort)/player.html")!)) }
        let json = try await view.evaluateJavaScript("JSON.stringify(window.parsed)") as? String
        let parsed = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(json).utf8)) as? [String: Any]
        XCTAssertNotNil(parsed?["streamingData"], "what the player needs stays")
        XCTAssertNotNil(parsed?["videoDetails"])
        for key in ["adPlacements", "playerAds", "adSlots"] { XCTAssertNil(parsed?[key], "\(key) is pruned from a player answer") }
    }

    /// A registry of two lists, each with the files named in `files` (`ads` has a network file; both have a scriptlet table).
    private func registry() throws -> FilterListRegistry {
        let sha = String(repeating: "a", count: 64)
        return try FilterListRegistry.decode(Data("""
        {"schema":1,"generatedAt":"2026-11-17T20:05:00Z","lists":[
          {"id":"ads","title":{"en":"Ads","fr":"Pubs"},"category":"ads","author":{"en":"A","fr":"A"},"license":{"en":"GPL","fr":"GPL"},"licenseUrl":"https://example.org/l",
           "homepage":"https://example.org/","sourceUrl":"https://example.org/ads.txt","fetchedAt":"2026-11-17T20:00:00Z","sourceVersion":null,"sourceSha256":"\(sha)","filters":2,"dropped":{},
           "files":[{"name":"ads.network.json","kind":"network","rules":1,"sha256":"\(sha)"},{"name":"ads.scriptlets.json","kind":"scriptlets","rules":1,"sha256":"\(sha)"}]},
          {"id":"cookies","title":{"en":"C","fr":"C"},"category":"cookies","author":{"en":"A","fr":"A"},"license":{"en":"GPL","fr":"GPL"},"licenseUrl":"https://example.org/l",
           "homepage":"https://example.org/","sourceUrl":"https://example.org/c.txt","fetchedAt":"2026-11-17T20:00:00Z","sourceVersion":null,"sourceSha256":"\(sha)","filters":1,"dropped":{},
           "files":[{"name":"cookies.scriptlets.json","kind":"scriptlets","rules":1,"sha256":"\(sha)"}]}]}
        """.utf8))
    }

    /// A table of the lists that cannot be read is reported; the rules still block, and the guard keeps our own rules (here, the consent walls).
    func testATableOfTheListsThatCannotBeReadIsReportedAndTheRestKeepsWorking() async throws {
        let lists = EmbeddedLists(registry: try registry()) { file in
            switch file.kind {
            case .network: return #"[{"trigger":{"url-filter":"^x"},"action":{"type":"block"}}]"#
            case .scriptlets: return "this is not a table"
            case .cosmetic: return "[]"
            }
        }
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { lists }, store: store)
        await model.prepare()
        XCTAssertNotNil(model.guardFailure, "the unreadable table is kept")
        XCTAssertNil(model.blockerFailure)
        XCTAssertEqual(model.blockers.count, 1, "the rules of the list still block")
        XCTAssertNotNil(model.pageGuard, "the guard goes on with our own rules")
        let view = try await load(url("localhost"), in: model)
        let wall = try await view.evaluateJavaScript("getComputedStyle(document.getElementById('onetrust-consent-sdk')).display") as? String
        XCTAssertEqual(wall, "none")
    }

    /// `prune-response`, the scriptlet YouTube's player answers need, in the real WebKit: what a page reads through `fetch` (`json()` and `text()`) and
    /// through `XMLHttpRequest` loses the ad entries, the rest of the answer stays, and the same page without the call keeps them (the witness).
    func testPruneResponseRemovesTheAdEntriesOfWhatThePageReadsThroughFetchAndXHR() async throws {
        let answer = #"{"videoDetails":{"id":1},"adPlacements":[1],"playerAds":[2],"adSlots":[3],"streamingData":{"ok":true}}"#
        let reader = """
        <!doctype html><title>Reader</title><script>
        (async () => {
          const viaJson = await (await fetch('/answer.json')).json();
          const viaText = JSON.parse(await (await fetch('/answer.json')).text());
          const viaXhr = await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', '/answer.json'); x.onload = () => resolve(JSON.parse(x.responseText)); x.send() });
          window.results = JSON.stringify({ viaJson, viaText, viaXhr });
        })();
        </script>
        """
        let local = try LocalServer(routes: ["/answer.json": .init(contentType: "application/json", body: answer), "/reader.html": .init(contentType: "text/html", body: reader)])
        let localPort = try await local.start()
        defer { local.stop() }

        func read(guarded: Bool) async throws -> [String: [String: Any]] {
            var table = ScriptletTable()
            if guarded { try table.merge(Data(#"{"schema":1,"domains":{"127.0.0.1":[["prune-response",["/answer.json","adPlacements playerAds adSlots"]]]}}"#.utf8), category: .ads) }
            let model = BrowserModel.launch(directory: directory.appending(path: guarded ? "g" : "u"), embeddedLists: { nil }, pageGuard: { [table] _ in try PageGuard.load(table: table) }, store: store)
            switches(GuardSettings(), on: model)
            await model.prepare()
            let view = try XCTUnwrap(model.webView)
            try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(localPort)/reader.html")!)) }
            var json: String?
            for _ in 0..<50 where json == nil {
                json = try await view.evaluateJavaScript("window.results || null") as? String
                if json == nil { try await Task.sleep(for: .milliseconds(100)) }
            }
            return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(json, "the page read nothing").utf8)) as? [String: [String: Any]])
        }

        let witness = try await read(guarded: false)
        for way in ["viaJson", "viaText", "viaXhr"] { XCTAssertNotNil(witness[way]?["adPlacements"], "without the call the page reads the ad entries \(way)") }
        let pruned = try await read(guarded: true)
        for way in ["viaJson", "viaText", "viaXhr"] {
            for key in ["adPlacements", "playerAds", "adSlots"] { XCTAssertNil(pruned[way]?[key], "\(key) is pruned \(way)") }
            XCTAssertNotNil(pruned[way]?["streamingData"], "what the player needs stays \(way)")
            XCTAssertNotNil(pruned[way]?["videoDetails"])
        }
    }

    /// The scriptlet files of the embedded lists are read as a table, and WebKit is never asked to compile them as rules.
    func testTheScriptletFilesOfTheListsMakeATableAndAreNotCompiledAsRules() async throws {
        let parsed = try registry()
        XCTAssertEqual(parsed.lists[0].rules, 1, "the rules WebKit reads, not the calls")
        XCTAssertEqual(parsed.lists[0].scriptletCalls, 1)
        var read: [String] = []
        let lists = EmbeddedLists(registry: parsed) { file in
            read.append(file.name)
            switch file.kind {
            case .network: return #"[{"trigger":{"url-filter":"^x"},"action":{"type":"block"}}]"#
            case .scriptlets: return file.name.hasPrefix("ads") ? #"{"schema":1,"domains":{"a.example":[["aopr",["ads"]]]}}"# : #"{"schema":1,"domains":{"a.example":[["aopr",["cookies"]]]}}"#
            case .cosmetic: XCTFail("no cosmetic file"); return "[]"
            }
        }
        let outcome = await lists.compile(in: store)
        XCTAssertEqual(outcome.lists.count, 1)
        XCTAssertTrue(outcome.failures.isEmpty)
        XCTAssertEqual(read, ["ads.network.json"], "a table of calls is not a file of rules")
        let table = try lists.scriptletTable()
        XCTAssertEqual(table.calls(forHost: "a.example", categories: [.ads]).map { $0.args[0] }, ["ads"])
        XCTAssertEqual(table.calls(forHost: "a.example", categories: [.cookies]).map { $0.args[0] }, ["cookies"])
        XCTAssertEqual(Set(read), ["ads.network.json", "ads.scriptlets.json", "cookies.scriptlets.json"])
    }
}
