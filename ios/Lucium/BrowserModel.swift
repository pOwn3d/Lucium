import LuciumKit
import SwiftUI
import UIKit
import WebKit

/// What the screen shows and does. The state is the Mac's state in the shape of `LuciumKit`; on top of it each tab that is awake has a web view
/// of its own, made with the data store of its space's profile (two profiles share no cookie). A tab that sleeps has no view: it keeps its line
/// in the state, a picture and the state of its page (`TabSleep.swift`), and wakes where it left off.
@MainActor @Observable
final class BrowserModel {
    /// What a space looks like. The theme is not in `BrowserState` (it stays in the `rest` of the space, written back untouched).
    struct SpaceStyle {
        let symbol: String
        let tint: Color
    }

    private(set) var state: BrowserState
    private let styles: [String: SpaceStyle]

    /// What is locked (`BrowserModel+Lock.swift`). Nil in a model with no lock (most tests): nothing is covered then.
    var lock: LockController?

    var tabsSheetShown = false
    var addressText = ""
    private(set) var host = ""
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var isLoading = false

    /// False until the blocker is compiled (or has failed): no web view is made before, so that no page is ever loaded without the blocker.
    private(set) var isReady = false

    /// Why the blocker is missing, when it is: the screen can say so (a card of its own) and the tests can see it.
    private(set) var blockerFailure: Error?

    /// How the state file was read at launch. A file that was set aside or held is told to the person once (`startupNoticeShown`).
    let startup: StateLoad
    var startupNoticeShown: Bool

    /// What could not be written, by sort: the state file, the state of a page, the picture of a tab. A sort is cleared by its next success.
    enum StorageKind: Hashable { case state, pageState, picture }
    private(set) var storageProblems: [StorageKind: String] = [:]
    func problem(_ kind: StorageKind) -> String? { storageProblems[kind] }

    /// Changes when a picture of a tab is stored, so that the list of tabs redraws.
    var thumbnailRevision = 0

    /// What the privacy rules show and ask: a notice, a refused certificate, the settings sheet (`PrivacyNavigation.swift`).
    var privacyPrompts = PrivacyPrompts()
    /// The navigation delegate of every web view: the privacy rules of the Mac (docs/ios.md, "Vie privée").
    @ObservationIgnored let navigationPolicy = PrivacyNavigation()

    /// The short built-in list, used when this copy carries no embedded list; `embeddedLists` gives the lists the application carries (docs/ios.md,
    /// "Compiler les listes du Mac"), and `store` is where WebKit keeps what it compiled (tests give their own folder).
    @ObservationIgnored let rules: @MainActor () throws -> String
    @ObservationIgnored let embeddedLists: @MainActor () throws -> EmbeddedLists?
    @ObservationIgnored let store: WKContentRuleListStore
    /// The lists applied to every web view: the embedded ones, or the short built-in one when this copy has none.
    @ObservationIgnored var blockers: [WKContentRuleList] = []
    /// The embedded lists that did not compile; the others still block.
    private(set) var listFailures: [EmbeddedLists.Failure] = []
    @ObservationIgnored var stateFile: StateFile?
    @ObservationIgnored let sideStore: TabSideStore?
    @ObservationIgnored let awakeCap: Int
    @ObservationIgnored let clock: @MainActor () -> Double
    @ObservationIgnored var webViews: [String: WKWebView] = [:]
    @ObservationIgnored var observations: [String: [NSKeyValueObservation]] = [:]
    @ObservationIgnored var saveTask: Task<Void, Never>?
    @ObservationIgnored var thumbnailCache: [String: UIImage] = [:]

    init(state: BrowserState, styles: [String: SpaceStyle] = [:], stateFile: StateFile? = nil, sideStore: TabSideStore? = nil,
         startup: StateLoad = .fresh, awakeCap: Int = SleepPlanner.defaultCap,
         clock: @escaping @MainActor () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() },
         rules: @escaping @MainActor () throws -> String = { try ContentBlocker.builtinRules() },
         embeddedLists: @escaping @MainActor () throws -> EmbeddedLists? = { try EmbeddedLists.load() },
         store: WKContentRuleListStore = .default()) {
        self.state = state.consistent() ?? Self.defaultState()
        self.styles = styles
        self.stateFile = stateFile
        self.sideStore = sideStore
        self.startup = startup
        self.awakeCap = awakeCap
        self.clock = clock
        self.rules = rules
        self.embeddedLists = embeddedLists
        self.store = store
        switch startup {
        case .setAside, .held: startupNoticeShown = true
        case .fresh, .loaded: startupNoticeShown = false
        }
        ensureActiveTab()
        navigationPolicy.model = self
    }

    var spaces: [Space] { state.spaces }
    var activeSpace: Space { state.spaces.first { $0.id == state.activeSpaceId } ?? state.spaces[0] }
    /// A space that is locked has no tab to show: whatever reads these (the screen, the list of tabs, the wake-up) finds nothing, which is the guard.
    var activeTabs: [TabItem] { activeSpaceCovered ? [] : state.tabs(in: state.activeSpaceId) }
    var activeTab: TabItem? { activeSpaceCovered ? nil : state.activeTab(in: state.activeSpaceId) }
    func style(of space: Space) -> SpaceStyle { styles[space.id] ?? SpaceStyle(symbol: "square", tint: .gray) }

    /// The view of the tab on screen. It exists once the model is ready; asking for it wakes the tab if it was asleep.
    var webView: WKWebView? {
        guard isReady, let tab = activeTab else { return nil }
        return wake(tab)
    }

    /// Compiles the blocker, wakes the tab on screen, and only then says it is ready. Called once, before the first page load.
    func prepare() async {
        guard !isReady else { return }
        if blockers.isEmpty {
            do {
                if let embedded = try embeddedLists() {
                    // The first launch compiles every embedded list (a few seconds); later launches find them in WebKit's store.
                    let outcome = await embedded.compile(in: store)
                    blockers = outcome.lists
                    listFailures = outcome.failures
                    if blockers.isEmpty { throw ContentBlocker.BlockerError.missingResource }
                } else {
                    // A copy with no embedded list (a checkout where the build step was not run): the short built-in list stands in.
                    blockers = [try await ContentBlocker.compile(rules(), identifier: ContentBlocker.builtinIdentifier, in: store)]
                }
                blockerFailure = nil
            } catch {
                // The person can still browse, without the blocker: the failure is kept (`blockerFailure`) and logged with its context.
                blockerFailure = error
                print("[blocker] rules not compiled, pages load unfiltered: \(error)")
            }
        }
        sideStore?.prune(keeping: state.tabs.map(\.id))
        isReady = true
        if let tab = activeTab { syncFrom(wake(tab)) }
    }

    // MARK: Navigation

    func submitAddress() {
        guard var request = Self.request(for: addressText), let view = webView else { return }
        navigationPolicy.prepare(&request, for: view)
        view.load(request)
    }

    /// The request an address field text stands for: an address, or a search (the same rules as the Mac, `AddressResolver`).
    static func request(for text: String) -> URLRequest? {
        guard let resolved = AddressResolver.resolve(text) else { return nil }
        switch resolved {
        case .url(let address), .search(let address): return URL(string: address).map { URLRequest(url: $0) }
        }
    }

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    func reloadOrStop() {
        guard let view = webView else { return }
        if isLoading { view.stopLoading() } else { view.reload() }
    }

    // MARK: Spaces and tabs

    func selectSpace(_ id: String) {
        guard id != state.activeSpaceId, state.spaces.contains(where: { $0.id == id }) else { return }
        leaveActiveTab()
        state.selectSpace(id)
        ensureActiveTab()
        arrive()
        if activeSpaceCovered { requestUnlock() }  // the person chose a locked space: the owner is asked at once
    }

    /// Shows a tab of the active space, waking it if it slept.
    func openTab(_ tab: TabItem) {
        tabsSheetShown = false
        guard !activeSpaceCovered, tab.id != activeTab?.id else { return }
        leaveActiveTab()
        state.show(tabId: tab.id, now: clock())
        arrive()
    }

    /// A new blank tab in the active space, unless the one on screen is blank already.
    func newTab() {
        tabsSheetShown = false
        if activeSpaceCovered || activeTab?.isBlank == true { return }
        leaveActiveTab()
        openBlankTab()
        arrive()
    }

    func close(_ tab: TabItem) {
        let wasShown = tab.id == activeTab?.id
        if let view = webViews[tab.id] { free(view, tabId: tab.id) }
        sideStore?.remove(for: tab.id)
        thumbnailCache[tab.id] = nil
        thumbnailRevision += 1
        state.close(tabId: tab.id)
        ensureActiveTab()
        if wasShown { arrive() } else { scheduleSave() }
    }

    /// A tab of the active space always shows: when a space has none, it gets a blank one (the start page).
    private func ensureActiveTab() {
        if state.activeTab(in: state.activeSpaceId) != nil { return }
        if let latest = state.tabs(in: state.activeSpaceId).max(by: { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }) {
            state.show(tabId: latest.id, now: clock())
        } else {
            openBlankTab()
        }
    }

    private func openBlankTab() {
        state.openTab(id: UUID().uuidString.lowercased(), in: state.activeSpaceId, now: clock())
    }

    /// What is done as a tab leaves the screen: its picture is taken now, while it is still on screen.
    private func leaveActiveTab() {
        if let tab = activeTab { captureThumbnail(of: tab.id) }
    }

    /// What is done when another tab is on screen: it wakes, the bar follows it, the change is kept, and the surplus of awake tabs sleeps.
    private func arrive() {
        if isReady, let tab = activeTab { syncFrom(wake(tab)) } else { syncFrom(nil) }
        scheduleSave()
        Task { await sleepSurplus() }
    }

    // MARK: Observing the page

    func observe(_ view: WKWebView, tabId: String) {
        let refresh: @Sendable (WKWebView, Any) -> Void = { [weak self] view, _ in
            MainActor.assumeIsolated { self?.pageChanged(view, tabId: tabId) }
        }
        observations[tabId] = [
            view.observe(\.url, changeHandler: refresh),
            view.observe(\.title, changeHandler: refresh),
            view.observe(\.canGoBack, changeHandler: refresh),
            view.observe(\.canGoForward, changeHandler: refresh),
            view.observe(\.isLoading, changeHandler: refresh),
        ]
    }

    private func pageChanged(_ view: WKWebView, tabId: String) {
        let before = state.tabs.first { $0.id == tabId }
        state.record(tabId: tabId, url: view.url?.absoluteString, title: view.title)
        if state.tabs.first(where: { $0.id == tabId }) != before { scheduleSave() }
        if tabId == activeTab?.id { syncFrom(view) }
    }

    func syncFrom(_ view: WKWebView?) {
        canGoBack = view?.canGoBack ?? false
        canGoForward = view?.canGoForward ?? false
        isLoading = view?.isLoading ?? false
        let address = view?.url?.absoluteString ?? ""
        host = AddressResolver.host(of: address)
        addressText = address.hasPrefix("about:") ? "" : address
    }

    // MARK: Keeping the state

    /// The state is written a moment after the last change, so that a page that changes its title ten times writes once.
    func scheduleSave() {
        guard stateFile != nil else { return }
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }  // cancelled: a newer change schedules its own write
            self?.flush()
        }
    }

    /// Writes the state now.
    func flush() {
        saveTask?.cancel()
        saveTask = nil
        guard stateFile != nil else { return }
        do {
            try stateFile?.save(state)
            storageProblems[.state] = nil
        } catch {
            report(.state, "the state was not written: \(error)")
        }
    }

    /// Something could not be written. The person keeps browsing; the failure is logged where it happened and kept for the screen and the tests.
    func report(_ kind: StorageKind, _ message: String) {
        storageProblems[kind] = message
        print("[storage] \(message)")
    }
}

extension BrowserModel {
    /// The privacy settings of the state: the Mac's `settings`, read with the Mac's rules (`PrivacySettings`).
    var privacySettings: PrivacySettings { state.privacy }

    /// Changes the privacy settings. They are written into the state (kept like any other change), and the scripts of the awake web views are put
    /// back at once; a page that is already open keeps what it was loaded with.
    func updatePrivacy(_ change: (inout PrivacySettings) -> Void) {
        var settings = state.privacy
        change(&settings)
        guard settings != state.privacy else { return }
        state.privacy = settings
        navigationPolicy.optionsChanged(on: Array(webViews.values))
        scheduleSave()
    }
}

extension BrowserModel {
    /// A first state: three spaces, each with a profile of its own, in the shape of the Mac's state file.
    static func defaultState() -> BrowserState {
        BrowserState(revision: 2,
                     spaces: [Space(id: "work", name: String(localized: "space.work"), emoji: "💼", profileId: "work"),
                              Space(id: "home", name: String(localized: "space.home"), emoji: "🏠", profileId: "home"),
                              Space(id: "projects", name: String(localized: "space.projects"), emoji: "🧩", profileId: "projects")],
                     activeSpaceId: "work", activeTabBySpace: ["work": nil, "home": nil, "projects": nil])
    }

    static let defaultStyles: [String: SpaceStyle] = [
        "work": SpaceStyle(symbol: "briefcase", tint: .indigo),
        "home": SpaceStyle(symbol: "house", tint: .orange),
        "projects": SpaceStyle(symbol: "puzzlepiece", tint: .teal),
    ]

    /// The folder the application keeps its own files in (`state.json`, the pictures and page states of the tabs).
    static func supportDirectory() -> URL {
        URL.applicationSupportDirectory.appending(path: "Lucium", directoryHint: .isDirectory)
    }

    /// The model of the running application: the state file of `directory` is read, and what it cannot read is put aside.
    static func launch(directory: URL = supportDirectory(), awakeCap: Int = SleepPlanner.defaultCap, lock: LockController? = nil,
                       rules: @escaping @MainActor () throws -> String = { try ContentBlocker.builtinRules() },
                       embeddedLists: @escaping @MainActor () throws -> EmbeddedLists? = { try EmbeddedLists.load() },
                       store: WKContentRuleListStore = .default()) -> BrowserModel {
        var file = StateFile(url: directory.appending(path: StateFile.fileName))
        let load = file.load()
        var state = defaultState()
        if case .loaded(let loaded) = load { state = loaded }
        let model = BrowserModel(state: state, styles: defaultStyles, stateFile: file,
                                 sideStore: TabSideStore(directory: directory.appending(path: TabSideStore.directoryName, directoryHint: .isDirectory)), startup: load,
                                 awakeCap: awakeCap, rules: rules, embeddedLists: embeddedLists, store: store)
        if let lock { model.attach(lock) }
        return model
    }
}
