import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The proof of the converter, played by WebKit: `scripts/ios-filter-lists/fixtures/proof.txt` (a filter list in the syntax of EasyList) is
/// converted by `scripts/ios-filter-lists.mjs --fixture` into `Fixtures/` (the rules and their registry), read here by the application's own
/// `EmbeddedLists`, compiled by WebKit and applied to web views that load real pages from a local server. Every filter of the list has a probe:
/// a request it must stop, and a request it must let through. A blocked request must never reach the server, and the same page without the
/// rules loads everything (the test is able to fail).
@MainActor
final class FilterListProofTests: XCTestCase {
    // MARK: What the page asks for

    private enum Kind: String { case script, image, fetch, xhr, frame }
    private enum Origin { case first, third }

    /// One request of the page: how it is made, where it goes, and whether the proof list must stop it.
    private struct Probe {
        let key: String
        let kind: Kind
        let path: String
        let origin: Origin
        let blocked: Bool
    }

    private static let probes: [Probe] = [
        // `/probe/path-rule.js`: a path, whatever the type.
        Probe(key: "path-rule", kind: .script, path: "/probe/path-rule.js", origin: .first, blocked: true),
        // `||localhost^*/probe/anchored-`: anchored on a host; the page is on 127.0.0.1.
        Probe(key: "anchored-third", kind: .script, path: "/probe/anchored-a.js", origin: .third, blocked: true),
        Probe(key: "anchored-first", kind: .script, path: "/probe/anchored-b.js", origin: .first, blocked: false),
        // `/probe/tp-$third-party`.
        Probe(key: "tp-third", kind: .script, path: "/probe/tp-third.js", origin: .third, blocked: true),
        Probe(key: "tp-first", kind: .script, path: "/probe/tp-first.js", origin: .first, blocked: false),
        // `/probe/image-only-$image`, `/probe/xhr-only-$xmlhttprequest`.
        Probe(key: "image-as-image", kind: .image, path: "/probe/image-only-a.svg", origin: .first, blocked: true),
        Probe(key: "image-as-script", kind: .script, path: "/probe/image-only-b.js", origin: .first, blocked: false),
        Probe(key: "xhr-by-fetch", kind: .fetch, path: "/probe/xhr-only-a.json", origin: .first, blocked: true),
        Probe(key: "xhr-by-xhr", kind: .xhr, path: "/probe/xhr-only-b.json", origin: .first, blocked: true),
        Probe(key: "xhr-as-script", kind: .script, path: "/probe/xhr-only-c.js", origin: .first, blocked: false),
        // `$domain=127.0.0.1`, `$domain=example.org`, `$domain=~127.0.0.1`.
        Probe(key: "domain-this", kind: .script, path: "/probe/for-this-domain-a.js", origin: .first, blocked: true),
        Probe(key: "domain-other", kind: .script, path: "/probe/for-other-domain-a.js", origin: .first, blocked: false),
        Probe(key: "domain-not-this", kind: .script, path: "/probe/not-this-domain-a.js", origin: .first, blocked: false),
        // A block, its exception, an important block that an exception does not stop.
        Probe(key: "exception-blocked", kind: .script, path: "/probe/exc-blocked.js", origin: .first, blocked: true),
        Probe(key: "exception-allowed", kind: .script, path: "/probe/exc-allowed.js", origin: .first, blocked: false),
        Probe(key: "important", kind: .script, path: "/probe/imp-a.js", origin: .first, blocked: true),
        // A wildcard, and the separator.
        Probe(key: "wild-end", kind: .script, path: "/probe/wild-middle-end.js", origin: .first, blocked: true),
        Probe(key: "wild-other", kind: .script, path: "/probe/wild-middle-x.js", origin: .first, blocked: false),
        Probe(key: "sep-slash", kind: .script, path: "/probe/sep/marker.js", origin: .first, blocked: true),
        Probe(key: "sep-letter", kind: .script, path: "/probe/sepXmarker.js", origin: .first, blocked: false),
        // A sub-frame is blocked (`/probe/frame-blocked`, no type), another one is not.
        Probe(key: "frame-blocked", kind: .frame, path: "/probe/frame-blocked.html", origin: .first, blocked: true),
        Probe(key: "frame-fine", kind: .frame, path: "/probe/frame-fine.html", origin: .first, blocked: false),
    ]

    /// The routes of the probes, and the pages the server serves itself.
    private static func routes() -> [String: LocalServer.Route] {
        var routes: [String: LocalServer.Route] = [:]
        for probe in probes {
            switch probe.kind {
            case .script: routes[probe.path] = .init(contentType: "text/javascript", body: "window.ran['\(probe.key)'] = true")
            case .image: routes[probe.path] = .init(contentType: "image/svg+xml", body: #"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#)
            case .fetch, .xhr: routes[probe.path] = .init(contentType: "application/json", body: "{}")
            case .frame: routes[probe.path] = .init(contentType: "text/html", body: "<!doctype html><script>parent.ran['\(probe.key)'] = true</script>")
            }
        }
        routes["/page.html"] = .init(contentType: "text/html", body: page(here: "location.origin", there: "'http://localhost:' + location.port"))
        routes["/probe/frame-blocked-top.html"] = .init(contentType: "text/html", body: "<!doctype html><title>top page loaded</title><body>top page loaded</body>")
        routes["/probe/top-blocked.html"] = .init(contentType: "text/html", body: "<!doctype html><title>must never load</title>")
        routes["/cosmetic.html"] = .init(contentType: "text/html", body: cosmeticPage)
        return routes
    }

    /// The page: it makes every probe, and `window.finished` settles when each one has succeeded or failed. `here` and `there` are JavaScript
    /// expressions for the origins of the first-party and of the third-party requests: the same server seen as 127.0.0.1 and as localhost (the only
    /// hosts App Transport Security lets through over http). `only` keeps the probes of some kinds: a page whose own address is not the server's
    /// cannot read an iframe nor ask the server for data.
    private static func page(here: String, there: String, only: Set<Kind>? = nil) -> String {
        let list = probes.filter { only?.contains($0.kind) ?? true }
            .map { ["key": $0.key, "kind": $0.kind.rawValue, "path": $0.path, "third": $0.origin == .third] as [String: Any] }
        let json = String(decoding: (try? JSONSerialization.data(withJSONObject: list)) ?? Data(), as: UTF8.self)
        return """
        <!doctype html><html><body><script>
        window.ran = {};
        const here = \(here), there = \(there);
        const load = ({ key, kind, path, third }) => new Promise((resolve) => {
          const url = (third ? there : here) + path;
          if (kind === 'script') { const e = document.createElement('script'); e.src = url; e.onload = e.onerror = resolve; document.head.appendChild(e) }
          else if (kind === 'image') { const e = new Image(); e.onload = () => { window.ran[key] = true; resolve() }; e.onerror = resolve; e.src = url }
          else if (kind === 'fetch') { fetch(url).then(() => { window.ran[key] = true }, () => {}).then(resolve) }
          else if (kind === 'xhr') { const x = new XMLHttpRequest(); x.onload = () => { window.ran[key] = true; resolve() }; x.onerror = resolve; x.open('GET', url); x.send() }
          else { const e = document.createElement('iframe'); e.src = url; e.onload = e.onerror = resolve; document.body.appendChild(e); setTimeout(resolve, 4000) }
        });
        window.finished = Promise.all(\(json).map(load));
        </script></body></html>
        """
    }

    private static let cosmeticPage = """
    <!doctype html><html><body>
    <div id="generic" class="lucium-ad">a</div><div id="excepted" class="lucium-excepted">b</div><div id="site" class="lucium-site-ad">c</div>
    <div id="other" class="lucium-other-site-ad">d</div><div id="c-ad" class="lucium-c-ad">e</div><div id="clean" class="lucium-content">f</div>
    </body></html>
    """

    // MARK: Support

    /// Where WebKit keeps the compiled lists of a test. It lives as long as the test: a list whose store is gone is no longer served.
    private var store: WKContentRuleListStore!

    override func setUp() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "lucium-proof-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        store = try XCTUnwrap(WKContentRuleListStore(url: directory))
    }

    /// The proof list as the application reads its embedded lists: a registry and two files in the test bundle.
    private func proofLists() throws -> EmbeddedLists {
        try XCTUnwrap(EmbeddedLists.load(in: Bundle(for: Self.self)), "Fixtures/filter-lists-registry.json is missing from the test bundle")
    }

    private func compiledProofLists() async throws -> [WKContentRuleList] {
        let outcome = await (try proofLists()).compile(in: store)
        XCTAssertTrue(outcome.failures.isEmpty, "the proof list must compile: \(outcome.failures.map { "\($0.file): \($0.error)" })")
        XCTAssertEqual(outcome.lists.count, 2, "one file of network rules and one of element hiding")
        return outcome.lists
    }

    private func makeView(with lists: [WKContentRuleList]) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        for list in lists { ContentBlocker.install(list, on: configuration) }
        return WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700), configuration: configuration)
    }

    private struct Page {
        let ran: [String: Bool]
        let asked: [String]
    }

    /// Loads the page of the probes from the server (a real navigation) and says what ran and what reached the server.
    private func runProbes(lists: [WKContentRuleList]) async throws -> Page {
        let server = try LocalServer(routes: Self.routes())
        let port = try await server.start()
        defer { server.stop() }
        let view = makeView(with: lists)
        let address = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/page.html"))
        try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: address)) }
        return Page(ran: try await ranProbes(in: view), asked: server.requestedPaths)
    }

    /// The same probes in a page whose own address is `host` (it is given to WebKit as the base address of an HTML string, so no server has to
    /// answer to that host): what the rules decide from the page's domain. The requests still go to the real server.
    private func runProbes(onPageOf host: String, only: Set<Kind>, lists: [WKContentRuleList]) async throws -> Page {
        let server = try LocalServer(routes: Self.routes())
        let port = try await server.start()
        defer { server.stop() }
        let view = makeView(with: lists)
        let html = Self.page(here: "'http://127.0.0.1:\(port)'", there: "'http://localhost:\(port)'", only: only)
        let base = try XCTUnwrap(URL(string: "http://\(host):\(port)/"))
        try await NavigationWaiter().load(in: view) { view.loadHTMLString(html, baseURL: base) }
        return Page(ran: try await ranProbes(in: view), asked: server.requestedPaths)
    }

    private func ranProbes(in view: WKWebView) async throws -> [String: Bool] {
        let raw = try await view.callAsyncJavaScript("await window.finished; return JSON.stringify(window.ran)", contentWorld: .page) as? String
        return try JSONDecoder().decode([String: Bool].self, from: Data(XCTUnwrap(raw).utf8))
    }

    // MARK: The proof

    func testEveryFilterOfTheProofListDoesWhatItSays() async throws {
        // The control: the same page, no rule. Every probe runs and reaches the server, so a probe that does not run below was stopped by a rule.
        let control = try await runProbes(lists: [])
        for probe in Self.probes {
            XCTAssertEqual(control.ran[probe.key], true, "without rules, \(probe.key) must run")
            XCTAssertTrue(control.asked.contains(probe.path), "without rules, \(probe.path) must reach the server")
        }

        let guarded = try await runProbes(lists: try await compiledProofLists())
        for probe in Self.probes {
            if probe.blocked {
                XCTAssertNotEqual(guarded.ran[probe.key], true, "\(probe.key) must be stopped")
                XCTAssertFalse(guarded.asked.contains(probe.path), "\(probe.path) must never reach the server")
            } else {
                XCTAssertEqual(guarded.ran[probe.key], true, "\(probe.key) must still run")
                XCTAssertTrue(guarded.asked.contains(probe.path), "\(probe.path) must reach the server")
            }
        }
    }

    /// `@@||a.localhost^$document`: on a page of that domain nothing is filtered, whatever the rules above say, important ones and third-party ones
    /// included. The witness is the same page on 127.0.0.1, where the same probes are stopped.
    func testAPageWhereFilteringStopsLoadsEverything() async throws {
        let lists = try await compiledProofLists()
        let kinds: Set<Kind> = [.script, .image]
        let witness = try await runProbes(onPageOf: "127.0.0.1", only: kinds, lists: lists)
        let stopped = Self.probes.filter { $0.blocked && kinds.contains($0.kind) }
        XCTAssertFalse(stopped.isEmpty)
        for probe in stopped { XCTAssertNotEqual(witness.ran[probe.key], true, "\(probe.key) must be stopped on an ordinary page") }

        let page = try await runProbes(onPageOf: "a.localhost", only: kinds, lists: lists)
        for probe in Self.probes where kinds.contains(probe.kind) {
            XCTAssertEqual(page.ran[probe.key], true, "on a page without filtering, \(probe.key) must run")
        }
    }

    /// A rule without a type must not stop the person from opening the address of a tracker (the shield); a rule that names the page does.
    func testTheTopLevelPageIsOnlyBlockedByARuleThatNamesIt() async throws {
        let lists = try await compiledProofLists()
        let server = try LocalServer(routes: Self.routes())
        let port = try await server.start()
        defer { server.stop() }

        let open = makeView(with: lists)
        let allowed = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/probe/frame-blocked-top.html"))
        try await NavigationWaiter().load(in: open) { open.load(URLRequest(url: allowed)) }
        let text = try await open.evaluateJavaScript("document.body.innerText") as? String
        XCTAssertEqual(text, "top page loaded", "a rule without a type must not block the page itself")
        XCTAssertTrue(server.requestedPaths.contains("/probe/frame-blocked-top.html"))

        let closed = makeView(with: lists)
        let blocked = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/probe/top-blocked.html"))
        var failure: Error?
        do {
            try await NavigationWaiter().load(in: closed) { closed.load(URLRequest(url: blocked)) }
        } catch {
            failure = error
        }
        XCTAssertNotNil(failure, "a rule with $document must block the page")
        XCTAssertFalse(failure is NavigationWaiter.TimedOut, "the blocked page must fail at once, not time out")
        XCTAssertFalse(server.requestedPaths.contains("/probe/top-blocked.html"), "a blocked page must never reach the server")
    }

    /// Element hiding, and its exceptions, on the five hosts the list names. The page is an HTML string given each host as its base address: what
    /// WebKit decides here is decided from the address of the page, which is the part under test.
    func testElementHidingAndItsExceptions() async throws {
        let lists = try await compiledProofLists()

        func hidden(on host: String, lists: [WKContentRuleList]) async throws -> Set<String> {
            let view = makeView(with: lists)
            let base = try XCTUnwrap(URL(string: "http://\(host)/"))
            try await NavigationWaiter().load(in: view) { view.loadHTMLString(Self.cosmeticPage, baseURL: base) }
            let script = "return [...document.querySelectorAll('div')].filter((e) => getComputedStyle(e).display === 'none').map((e) => e.id)"
            let ids = try await view.callAsyncJavaScript(script, contentWorld: .page) as? [String]
            return Set(try XCTUnwrap(ids))
        }

        let control = try await hidden(on: "127.0.0.1", lists: [])
        XCTAssertEqual(control, [], "without rules nothing is hidden")

        // 127.0.0.1: the generic selector and the site's own are hidden; the generic one that this site excepts is not; the other site's is not.
        let own = try await hidden(on: "127.0.0.1", lists: lists)
        XCTAssertEqual(own, ["generic", "site"])
        // localhost: the generic selectors, the exception was for 127.0.0.1 only.
        let third = try await hidden(on: "localhost", lists: lists)
        XCTAssertEqual(third, ["generic", "excepted"])
        // a.localhost ($document) and b.localhost ($elemhide): nothing is hidden.
        let none = try await hidden(on: "a.localhost", lists: lists)
        XCTAssertEqual(none, [])
        let noElementHiding = try await hidden(on: "b.localhost", lists: lists)
        XCTAssertEqual(noElementHiding, [])
        // c.localhost ($generichide): the generic selectors are off, the site's own selector still works.
        let noGeneric = try await hidden(on: "c.localhost", lists: lists)
        XCTAssertEqual(noGeneric, ["c-ad"])
    }
}
