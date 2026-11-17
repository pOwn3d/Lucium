import LuciumKit
import SwiftUI
import WebKit

/// What the screen shows and does. One web view per space, each with the data store of its profile: two spaces of two profiles share
/// no cookie. (The final application keeps one view per awake tab; this is the smallest thing that proves the chain.)
@MainActor @Observable
final class BrowserModel {
    /// What a space looks like. The theme is not in `BrowserState` (it stays in the `rest` of the space, written back untouched).
    struct SpaceStyle {
        let symbol: String
        let tint: Color
    }

    private(set) var state: BrowserState
    private let styles: [String: SpaceStyle]
    private let dataStoreIDs: [String: UUID]

    var tabsSheetShown = false
    var addressText = ""
    private(set) var host = ""
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var isLoading = false

    /// Why the blocker is missing, when it is: the screen can say so (a card of its own) and the tests can see it.
    private(set) var blockerFailure: Error?

    private let rules: @MainActor () throws -> String
    private var blocker: WKContentRuleList?
    private var webViews: [String: WKWebView] = [:]
    private var observations: [NSKeyValueObservation] = []

    init(state: BrowserState, styles: [String: SpaceStyle], dataStoreIDs: [String: UUID],
         rules: @escaping @MainActor () throws -> String = { try ContentBlocker.builtinRules() }) {
        self.rules = rules
        self.state = state
        self.styles = styles
        self.dataStoreIDs = dataStoreIDs
    }

    var spaces: [Space] { state.spaces }
    var activeSpace: Space { state.spaces.first { $0.id == state.activeSpaceId } ?? state.spaces[0] }
    var activeTabs: [TabItem] { state.tabs.filter { $0.spaceId == state.activeSpaceId } }
    func style(of space: Space) -> SpaceStyle { styles[space.id] ?? SpaceStyle(symbol: "square", tint: .gray) }

    /// The view of the active space, created on first use so that it gets the blocker and the data store of its profile.
    var webView: WKWebView {
        if let existing = webViews[state.activeSpaceId] { return existing }
        let configuration = WKWebViewConfiguration()
        if let id = dataStoreIDs[activeSpace.profileId] { configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: id) }
        if let blocker { ContentBlocker.install(blocker, on: configuration) }
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        view.isInspectable = true
        webViews[state.activeSpaceId] = view
        observe(view)
        return view
    }

    /// Compiles the blocker, then shows the start page. Called once, before the first page load.
    func prepare() async {
        if blocker == nil {
            do {
                blocker = try await ContentBlocker.compile(rules(), identifier: ContentBlocker.builtinIdentifier)
                blockerFailure = nil
            } catch {
                // The person can still browse, without the blocker: the failure is kept (`blockerFailure`) and logged with its context.
                blockerFailure = error
                print("[blocker] rules \(ContentBlocker.builtinIdentifier) not compiled, pages load unfiltered: \(error)")
            }
        }
        if webView.url == nil { loadStartPage() }
    }

    func loadStartPage() { webView.loadHTMLString(StartPage.html(), baseURL: nil) }

    // MARK: Navigation

    func submitAddress() {
        guard let request = Self.request(for: addressText) else { return }
        webView.load(request)
    }

    /// The request an address field text stands for: an address, or a search (the same rules as the Mac, `AddressResolver`).
    static func request(for text: String) -> URLRequest? {
        guard let resolved = AddressResolver.resolve(text) else { return nil }
        switch resolved {
        case .url(let address), .search(let address): return URL(string: address).map { URLRequest(url: $0) }
        }
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func reloadOrStop() {
        if isLoading { webView.stopLoading() } else { webView.reload() }
    }

    func selectSpace(_ id: String) {
        guard id != state.activeSpaceId else { return }
        state.activeSpaceId = id
        let view = webView
        syncFrom(view)
        if view.url == nil { loadStartPage() }
    }

    func openTab(_ tab: TabItem) {
        tabsSheetShown = false
        if let request = Self.request(for: tab.url) { webView.load(request) }
    }

    func newTab() {
        tabsSheetShown = false
        loadStartPage()
    }

    // MARK: Observing the page

    private func observe(_ view: WKWebView) {
        let refresh: @Sendable (WKWebView, Any) -> Void = { [weak self] view, _ in
            MainActor.assumeIsolated { self?.syncFrom(view) }
        }
        observations.append(view.observe(\.url, changeHandler: refresh))
        observations.append(view.observe(\.canGoBack, changeHandler: refresh))
        observations.append(view.observe(\.canGoForward, changeHandler: refresh))
        observations.append(view.observe(\.isLoading, changeHandler: refresh))
    }

    private func syncFrom(_ view: WKWebView) {
        guard view === webViews[state.activeSpaceId] else { return }
        canGoBack = view.canGoBack
        canGoForward = view.canGoForward
        isLoading = view.isLoading
        let address = view.url?.absoluteString ?? ""
        host = AddressResolver.host(of: address)
        addressText = address.hasPrefix("about:") ? "" : address
    }
}

extension BrowserModel {
    /// A first state for the screen: three spaces, each with a profile of its own, in the shape of the Mac's state file.
    static func makeDefault() -> BrowserModel {
        let work = Space(id: "work", name: String(localized: "space.work"), emoji: "💼", profileId: "work")
        let home = Space(id: "home", name: String(localized: "space.home"), emoji: "🏠", profileId: "home")
        let projects = Space(id: "projects", name: String(localized: "space.projects"), emoji: "🧩", profileId: "projects")
        let tabs = [
            TabItem(id: "t1", spaceId: "work", url: "https://example.com/", title: "Example Domain", pinned: true),
            TabItem(id: "t2", spaceId: "home", url: "https://example.org/", title: "Example"),
        ]
        let state = BrowserState(revision: 2, spaces: [work, home, projects], tabs: tabs, activeSpaceId: "work",
                                 activeTabBySpace: ["work": "t1", "home": nil, "projects": nil])
        let styles = [
            "work": SpaceStyle(symbol: "briefcase", tint: .indigo),
            "home": SpaceStyle(symbol: "house", tint: .orange),
            "projects": SpaceStyle(symbol: "puzzlepiece", tint: .teal),
        ]
        // Identifiers of the data stores, one per profile. The final application draws them once and keeps them in its state.
        let stores = [
            "work": UUID(uuidString: "6D1C0F52-6F0B-4B1B-9C57-0A2A3B7D1001")!,
            "home": UUID(uuidString: "6D1C0F52-6F0B-4B1B-9C57-0A2A3B7D1002")!,
            "projects": UUID(uuidString: "6D1C0F52-6F0B-4B1B-9C57-0A2A3B7D1003")!,
        ]
        return BrowserModel(state: state, styles: styles, dataStoreIDs: stores)
    }
}
