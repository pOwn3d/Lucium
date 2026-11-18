import LuciumKit
import WebKit

/// Gives every page, as its document starts, what the page guard is to run in it: the scriptlet calls the embedded lists and our own YouTube
/// rules name for its site, and the style sheet of the consent walls (docs/ios.md, section 6.4).
///
/// A user script of WebKit is the same for every page of a web view, and the table of the lists is far too big to carry into each page, so the
/// script is chosen **per navigation**: when a page is about to load, the web views' navigation delegate (`PrivacyNavigation`, which lets the
/// navigation through; WebKit asks it again for every redirect, so the address that decides is the final one) calls `prepare`; the plan for its
/// host is looked up here, in the table the application holds, and the one script of this guard on the web view is replaced by the script for that page. The runtime is the Mac's own scriptlet code (`guard-runtime.js`, generated from
/// `src/preload/guard-world.ts` and committed); it is embedded and never downloaded (guideline 2.5.2), and it checks every call again before it
/// runs one. Only the main frame is covered: a frame has no navigation of its own to prepare for (docs/ios.md says what that leaves out).
@MainActor
final class PageGuard {
    /// What a script of this guard begins with, so that it is found again among the scripts of the web view, which others may use too.
    static let marker = "/* lucium:page-guard */"
    static let runtimeResource = "guard-runtime"
    static let rulesResource = "guard-rules"

    let table: ScriptletTable
    let rules: GuardRules?
    var settings: GuardSettings
    private let runtime: String
    /// How a plan is written for the page (JSON). A plan is only strings and cannot fail to be written; tests give a writer that does, to prove what happens.
    var encodePlan: (PagePlan) throws -> Data = PageGuard.encode
    /// Why the last page was loaded without the guard, when it was (cleared by the next page that gets its plan).
    private(set) var lastProblem: String?

    init(runtime: String, rules: GuardRules?, table: ScriptletTable, settings: GuardSettings = GuardSettings()) {
        self.runtime = runtime
        self.rules = rules
        self.table = table
        self.settings = settings
    }

    /// The guard of a bundle, or nil when this copy carries no runtime (the page guard is part of the build; nothing runs without it).
    /// `table` is what the embedded lists name; without lists the guard still carries our own rules.
    static func load(in bundle: Bundle = .main, table: ScriptletTable = ScriptletTable(), settings: GuardSettings = GuardSettings()) throws -> PageGuard? {
        guard let runtimeURL = bundle.url(forResource: runtimeResource, withExtension: "js") else { return nil }
        let runtime = try String(contentsOf: runtimeURL, encoding: .utf8)
        var rules: GuardRules?
        if let rulesURL = bundle.url(forResource: rulesResource, withExtension: "json") { rules = try GuardRules.decode(Data(contentsOf: rulesURL)) }
        return PageGuard(runtime: runtime, rules: rules, table: table, settings: settings)
    }

    // MARK: The script of a page

    /// The script for a plan: the marker, then the runtime, called with the plan.
    func source(for plan: PagePlan) throws -> String {
        let json = String(decoding: try encodePlan(plan), as: UTF8.self)
        return "\(Self.marker)\n\(runtime)(\(json));"
    }

    nonisolated static func encode(_ plan: PagePlan) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(plan)
    }

    /// Makes the scripts of the web view the ones this page needs: ours replaced by the script for `url`'s plan (or taken away when the page has no
    /// plan), every other script left as it was. A web view that already has the right script is not touched.
    func prepare(_ view: WKWebView, for url: URL?) {
        let plan = PagePlanner.plan(for: url?.absoluteString, settings: settings, table: table, rules: rules)
        let controller = view.configuration.userContentController
        let wanted: String?
        do {
            wanted = plan.isEmpty ? nil : try source(for: plan)
            lastProblem = nil
        } catch {
            // The page loads without the guard rather than not at all; the failure is said where it happened and kept for the tests.
            lastProblem = "the plan for \(url?.host() ?? "?") could not be written: \(error)"
            print("[guard] \(lastProblem ?? ""), the page loads without it")
            wanted = nil
        }
        let ours = controller.userScripts.filter { $0.source.hasPrefix(Self.marker) }
        if let wanted { if ours.count == 1, ours[0].source == wanted { return } } else if ours.isEmpty { return }
        let others = controller.userScripts.filter { !$0.source.hasPrefix(Self.marker) }
        // WebKit can only take every script off at once: the others are put back in the order they had.
        controller.removeAllUserScripts()
        for script in others { controller.addUserScript(script) }
        if let wanted { controller.addUserScript(WKUserScript(source: wanted, injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
    }

    /// The rules WebKit reads, for the requests of our own rules (YouTube's ad paths), kept in `store` under a name that carries their content.
    func compileNetworkRules(in store: WKContentRuleListStore = .default()) async throws -> WKContentRuleList? {
        guard let rules else { return nil }
        let identifier = rules.networkRulesIdentifier
        let found: WKContentRuleList?
        do {
            found = try await store.contentRuleList(forIdentifier: identifier)
        } catch let error as NSError where error.domain == WKErrorDomain && error.code == WKError.contentRuleListStoreLookUpFailed.rawValue {
            found = nil  // not compiled yet under this name
        }
        let list: WKContentRuleList
        if let found {
            list = found
        } else {
            list = try await ContentBlocker.compile(rules.youtube.networkRules, identifier: identifier, in: store)
        }
        for stale in await store.availableIdentifiers() ?? [] where stale.hasPrefix(GuardRules.identifierPrefix) && stale != identifier {
            do { try await store.removeContentRuleList(forIdentifier: stale) } catch { print("[guard] stale list \(stale) not removed: \(error)") }
        }
        return list
    }
}
