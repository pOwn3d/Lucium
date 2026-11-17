import LuciumKit
import WebKit
import XCTest
@testable import Lucium

@MainActor
final class EmbeddedListsTests: XCTestCase {
    private func temporaryStore() throws -> WKContentRuleListStore {
        let directory = FileManager.default.temporaryDirectory.appending(path: "lucium-lists-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return try XCTUnwrap(WKContentRuleListStore(url: directory))
    }

    /// The proof list's registry, read from the test bundle, with a reader of our own so that a test can count what is read and break a file.
    private func proofLists(reading: @escaping @MainActor (FilterListFile) throws -> String) throws -> EmbeddedLists {
        let bundle = Bundle(for: Self.self)
        let registry = try FilterListRegistry.decode(Data(contentsOf: XCTUnwrap(bundle.url(forResource: EmbeddedLists.registryResource, withExtension: "json"))))
        return EmbeddedLists(registry: registry, readRules: reading)
    }

    private func realRules(_ file: FilterListFile) throws -> String {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: file.name, withExtension: nil), "\(file.name) is missing from the test bundle")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testEveryFileIsCompiledUnderTheNameOfItsContentAndNotCompiledAgain() async throws {
        let store = try temporaryStore()
        var reads = 0
        let lists = try proofLists { file in
            reads += 1
            return try self.realRules(file)
        }
        let first = await lists.compile(in: store)
        XCTAssertTrue(first.failures.isEmpty)
        XCTAssertEqual(first.lists.map { $0.identifier }, lists.registry.lists.flatMap { $0.files }.map { $0.storeIdentifier }, "in the order of the registry")
        XCTAssertEqual(reads, 2)
        XCTAssertTrue(first.lists.allSatisfy { $0.identifier.hasPrefix("app.lucium.list.proof.") })

        // A second launch finds them in WebKit's store: the files are not read nor compiled again.
        let second = await lists.compile(in: store)
        XCTAssertTrue(second.failures.isEmpty)
        XCTAssertEqual(second.lists.count, 2)
        XCTAssertEqual(reads, 2, "a list already in the store must not be read again")
    }

    func testAListOfAnOlderCopyIsRemovedFromTheStore() async throws {
        let store = try temporaryStore()
        let stale = "\(FilterListRegistry.identifierPrefix)proof.network.000000000000"
        _ = try await ContentBlocker.compile(#"[{ "trigger": { "url-filter": "stale" }, "action": { "type": "block" } }]"#, identifier: stale, in: store)
        // A list that is not ours (another name) is left alone.
        _ = try await ContentBlocker.compile(#"[{ "trigger": { "url-filter": "other" }, "action": { "type": "block" } }]"#, identifier: "someone.else", in: store)

        let outcome = await (try proofLists { try self.realRules($0) }).compile(in: store)
        XCTAssertTrue(outcome.failures.isEmpty)
        let available = Set(await store.availableIdentifiers() ?? [])
        XCTAssertFalse(available.contains(stale), "a list that the registry no longer names must go")
        XCTAssertTrue(available.contains("someone.else"))
        XCTAssertTrue(Set(outcome.lists.map { $0.identifier }).isSubset(of: available))
    }

    func testAListThatDoesNotCompileDoesNotStopTheOthers() async throws {
        let outcome = await (try proofLists { file in
            if file.kind == .cosmetic { return #"[{ "trigger": {}, "action": { "type": "css-display-none", "selector": ".x" } }]"# }
            return try self.realRules(file)
        }).compile(in: try temporaryStore())
        XCTAssertEqual(outcome.failures.map(\.file), ["proof.cosmetic.json"])
        XCTAssertEqual((outcome.failures.first?.error as NSError?)?.domain, WKErrorDomain)
        XCTAssertEqual(outcome.lists.count, 1, "the network rules still work")
    }

    func testAMissingFileIsTheFailureOfItsListOnly() async throws {
        let outcome = await (try proofLists { file in
            if file.kind == .network { throw ContentBlocker.BlockerError.missingResource }
            return try self.realRules(file)
        }).compile(in: try temporaryStore())
        XCTAssertEqual(outcome.failures.map(\.file), ["proof.network.json"])
        XCTAssertEqual(outcome.lists.count, 1)
    }

    func testABundleWithoutListsHasNone() throws {
        XCTAssertNil(try EmbeddedLists.load(in: Bundle(for: NSObject.self)))
    }

    func testARegistryThatDoesNotSayWhereAListComesFromIsRefused() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "lucium-bundle-\(UUID().uuidString).bundle")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let good = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: EmbeddedLists.registryResource, withExtension: "json")))
        let broken = String(decoding: good, as: UTF8.self).replacingOccurrences(of: "\"sourceUrl\": \"https://", with: "\"sourceUrl\": \"http://")
        try Data(broken.utf8).write(to: directory.appending(path: "\(EmbeddedLists.registryResource).json"))
        let bundle = try XCTUnwrap(Bundle(url: directory))
        XCTAssertThrowsError(try EmbeddedLists.load(in: bundle)) { error in
            guard case FilterListRegistry.RegistryError.incomplete(let problems) = error else { return XCTFail("unexpected error \(error)") }
            XCTAssertTrue(problems.contains { $0.contains("sourceUrl is not an https address") }, "\(problems)")
        }
    }

    /// The gate of a build that is handed out: when this build carries the real lists (`scripts/ios-filter-lists.mjs` was run), every one of them
    /// must compile, or the person would silently lose a list on their phone. A checkout without them has nothing to check.
    func testEveryEmbeddedListOfThisBuildCompiles() async throws {
        guard let lists = try EmbeddedLists.load() else { throw XCTSkip("this build has no embedded filter lists: run scripts/ios-filter-lists.mjs first") }
        let started = ContinuousClock.now
        let outcome = await lists.compile(in: try temporaryStore())
        let seconds = (ContinuousClock.now - started).formatted(.units(allowed: [.seconds], fractionalPart: .show(length: 2)))
        let files = lists.registry.lists.flatMap(\.files)
        print("[blocker] \(files.count) files, \(files.reduce(0) { $0 + $1.rules }) rules compiled in \(seconds)")
        XCTAssertTrue(outcome.failures.isEmpty, "lists that WebKit refuses: \(outcome.failures.map { "\($0.file): \($0.error)" })")
        XCTAssertEqual(outcome.lists.count, files.count)
        XCTAssertTrue(files.allSatisfy { $0.rules <= FilterListRegistry.ruleLimit })
    }

    /// The real lists, all together on one view, against a real page: paths that EasyList names (on 17 November 2026) must not reach the server, and a
    /// path no list names must. Needs the real lists in this build; it fails, with a message, if EasyList no longer names these paths.
    func testTheRealListsStopWhatTheyNameOnOneView() async throws {
        guard let lists = try EmbeddedLists.load() else { throw XCTSkip("this build has no embedded filter lists: run scripts/ios-filter-lists.mjs first") }
        let named = ["/adserver.js", "/vendor/doubleclick.min.js"]
        let routes = Dictionary(uniqueKeysWithValues: (named + ["/lucium-fine-probe.js"]).map { ($0, LocalServer.Route(contentType: "text/javascript", body: "window.ran = (window.ran || []).concat('\($0)')")) })
            .merging(["/page.html": LocalServer.Route(contentType: "text/html", body: (named + ["/lucium-fine-probe.js"]).map { "<script src=\"\($0)\"></script>" }.joined())]) { first, _ in first }
        let server = try LocalServer(routes: routes)
        let port = try await server.start()
        defer { server.stop() }

        let store = try temporaryStore()
        let outcome = await lists.compile(in: store)
        XCTAssertTrue(outcome.failures.isEmpty)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        for list in outcome.lists { ContentBlocker.install(list, on: configuration) }
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700), configuration: configuration)
        let address = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/page.html"))
        try await NavigationWaiter().load(in: view) { view.load(URLRequest(url: address)) }
        let ran = try await view.evaluateJavaScript("JSON.stringify(window.ran || [])") as? String
        XCTAssertEqual(ran, #"["/lucium-fine-probe.js"]"#, "\(outcome.lists.count) lists on one view must stop \(named) and nothing else; a list may have dropped these paths")
        for path in named { XCTAssertFalse(server.requestedPaths.contains(path), "\(path) must never reach the server") }
        XCTAssertTrue(server.requestedPaths.contains("/lucium-fine-probe.js"))
        withExtendedLifetime(store) {}
    }
}
