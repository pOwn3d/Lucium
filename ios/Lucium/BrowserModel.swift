import LuciumKit
import SwiftUI
import UIKit
import WebKit

/// What the screen shows and does. The state is the Mac's state in the shape of `LuciumKit`; on top of it each tab that is awake has a web view
/// of its own, made with the data store of its space's profile (two profiles share no cookie). A tab that sleeps has no view: it keeps its line
/// in the state, a picture and the state of its page (`TabSleep.swift`), and wakes where it left off.
@MainActor @Observable
final class BrowserModel {
    /// The state in the shape of the Mac's. Changed here and in `SpacesModel.swift` (spaces, profiles, private tabs), never from a view.
    var state: BrowserState {
        // A tab that disappears may empty a site of « Effacer à la fermeture » (`BrowserModel+SiteClear.swift`); nothing is looked at while the list is off.
        didSet { if clearWatch != nil { tabsMayHaveClosed() } }
    }

    /// What is locked (`BrowserModel+Lock.swift`). Nil in a model with no lock (most tests): nothing is covered then.
    var lock: LockController?

    /// A link received from another application that waits for the lock (`BrowserModel+ExternalLink.swift`). Only the last one is kept, and never written to disk.
    @ObservationIgnored var pendingExternalAddress: String?

    /// The synchronisation with the Mac (`SyncController`). Nil in a model with none (most tests): the settings list has no page for it then.
    var sync: SyncController?

    /// Whether this phone has ever been changed by its person: kept from the first launch, read by the synchronisation at its first exchange (`SyncOrigin`).
    @ObservationIgnored var syncOrigin: SyncOriginKeeper?

    /// A synchronisation session is writing its patch into the state (`applySyncPatch`): the book of marks does not look at the state meanwhile, so that what the Mac
    /// wrote is not marked as this phone's change.
    @ObservationIgnored var isApplyingSync = false

    /// The tab that was on screen when the other device closed it, as the last session wrote it (docs/synchronisation.md §27.5, [Q11]): it was archived here and the neighbour is
    /// shown. The line « Fermé sur le Mac », which the interface change that follows adds, reads this and clears it once it has been shown; nothing else does.
    var syncClosedShownTab: SyncClosedShownTab?

    var tabsSheetShown = false
    /// The sidebar that slides out from the left edge of an iPhone (`EdgeDrawerHost`). Only changed through `drawerEvent(_:)`, which knows what opens it and
    /// what closes it (`EdgeDrawer.isOpen(after:wasOpen:)`, in `LuciumKit`).
    private(set) var drawerShown = false
    var spacesSheetShown = false
    /// The iPad's permanent sidebar: shown or put away (the button of its header and the keyboard shortcut). Kept here so that a turn or a narrow window does not forget it.
    var padSidebarShown = true
    /// The settings screen (`SettingsScreen`), opened by the gear of the bottom bar and of the iPad's sidebar, and the page it opens on (the list when nil).
    var settingsShown = false
    /// The sheet of bookmarks and "Read later" (`KeptPagesScreen`), the list it shows, and the line that tells what keeping a page did (`KeepBanner`).
    var keptShown = false
    var keptList = KeptList.bookmarks
    var keepNotice: KeepNotice?
    var settingsStart: SettingsRow?
    /// The site "Clear this site's data" was asked for, until the person answers (`SiteDataFlow`).
    var siteDataAsked: String?
    /// The full-screen command bar (mockup `Commandes`): opened by the address pill.
    var commandBarShown = false
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

    /// How many entries of the folders, the favourites and the archive of the saved state do not read, by list: they are left out of the screen and
    /// lost when that list is next written (the Mac's own repair drops the same ones). Empty when every entry reads; logged when the model is made.
    let unreadableLibraryEntries: [String: Int]

    /// What could not be written, by sort: the state file, the state of a page, the picture of a tab. A sort is cleared by its next success.
    enum StorageKind: Hashable { case state, pageState, picture, display, history }
    var storageProblems: [StorageKind: String] = [:]
    func problem(_ kind: StorageKind) -> String? { storageProblems[kind] }

    /// How each tab shows its page (desktop version, text size), read from the tab's folder the first time it is asked for (`BrowserModel+PageDisplay.swift`).
    /// Only a tab that was changed has an entry; a private tab's entry never leaves this dictionary.
    var pageDisplays: [String: PageDisplay] = [:]

    /// Changes when a picture of a tab is stored, so that the list of tabs redraws.
    var thumbnailRevision = 0

    /// What the privacy rules show and ask: a notice, a refused certificate, the settings sheet (`PrivacyNavigation.swift`).
    var privacyPrompts = PrivacyPrompts()
    /// The tabs whose last main-frame load failed and whose screen says why (`LoadFailureView`), by tab id. Set and cleared by `PrivacyNavigation`.
    var loadFailures: [String: LoadFailure] = [:]
    /// The navigation delegate of every web view: the privacy rules of the Mac (docs/ios.md, "Vie privée").
    @ObservationIgnored let navigationPolicy = PrivacyNavigation()

    /// Whether this is an iPhone. The iPhone has the sidebar that slides out from its left edge and no swipe back of WebKit; the iPad has neither (its
    /// permanent sidebar and its swipe back are as they were). Given by the tests, which play both.
    let isPhone: Bool

    /// The downloads (files, and pages saved as PDF); `PrivacyNavigation` hands a navigation that became one over to it (`DownloadNavigation.swift`).
    let downloads: DownloadsModel

    /// The short built-in list, used when this copy carries no embedded list; `embeddedLists` gives the lists the application carries (docs/ios.md,
    /// "Compiler les listes du Mac"), and `store` is where WebKit keeps what it compiled (tests give their own folder).
    @ObservationIgnored let rules: @MainActor () throws -> String
    @ObservationIgnored let embeddedLists: @MainActor () throws -> EmbeddedLists?
    @ObservationIgnored let store: WKContentRuleListStore
    /// The lists the blocker can attach to a web view, each with what it is: the embedded ones, or the short built-in one when this copy has none
    /// (`BrowserModel+Blocker.swift`). Which of them a view carries depends on the person's switches and on the page.
    @ObservationIgnored var blockerParts: [BlockerList] = []
    var blockers: [WKContentRuleList] { blockerParts.map(\.list) }
    /// The embedded lists, kept to compile the other mode's copy when the person switches the mode.
    @ObservationIgnored var embedded: EmbeddedLists?
    /// The mode the network lists in `blockerParts` were compiled for.
    @ObservationIgnored var compiledBlockerMode: BlockMode = .standard
    /// The lists each awake view carries now, by view: what `applyBlocker` compares to what the page wants.
    @ObservationIgnored var attachedBlockers: [ObjectIdentifier: [WKContentRuleList]] = [:]
    /// True while the lists of the other mode are being compiled (a few seconds, the first time): the settings page says so.
    var blockerModeBusy = false
    /// The embedded lists that did not compile; the others still block.
    var listFailures: [EmbeddedLists.Failure] = []
    /// What a page is given when it starts (scriptlets, consent-wall style sheet, `PageGuard`), and the rules WebKit reads that go with it (YouTube's ad paths).
    /// Nil when this copy carries no runtime; the application then browses with the blocker's rules alone.
    @ObservationIgnored let makePageGuard: @MainActor (ScriptletTable) throws -> PageGuard?
    @ObservationIgnored var pageGuard: PageGuard?
    @ObservationIgnored var guardList: WKContentRuleList?
    /// Why the page guard (or its table of scriptlets) is missing or incomplete, when it is.
    private(set) var guardFailure: Error?
    /// The tabs as they were at the last change, while « Effacer à la fermeture » has a site to watch (`BrowserModel+SiteClear.swift`); nil when it has none.
    @ObservationIgnored var clearWatch: [TabItem]?
    @ObservationIgnored var stateFile: StateFile?
    /// The pages visited on this phone (`BrowserModel+History.swift`): its own file, never the state, so nothing of it reaches the synchronisation.
    var history = HistoryBook()
    @ObservationIgnored var historyFile: HistoryFile?
    @ObservationIgnored var historySaveTask: Task<Void, Never>?
    /// The address each tab last noted as a visit, so that the many changes of one load note it once.
    @ObservationIgnored var historyLastVisit: [String: String] = [:]
    @ObservationIgnored let sideStore: TabSideStore?
    @ObservationIgnored let awakeCap: Int
    @ObservationIgnored let clock: @MainActor () -> Double
    /// The in-memory data store of the private tabs, while at least one private tab has a view (`SpacesModel.swift`).
    @ObservationIgnored var privateStore: WKWebsiteDataStore?
    /// The data store of each profile that was used, kept as long as the model lives (`SpacesModel.swift`).
    @ObservationIgnored var profileStores: [String: WKWebsiteDataStore] = [:]
    @ObservationIgnored var webViews: [String: WKWebView] = [:]
    /// How the find bar is shown. A seam for tests: a find bar needs a real window scene, which a test host does not give.
    @ObservationIgnored var presentFind: (UIFindInteraction) -> Void = { $0.presentFindNavigator(showingReplace: false) }
    @ObservationIgnored var observations: [String: [NSKeyValueObservation]] = [:]
    @ObservationIgnored var saveTask: Task<Void, Never>?
    @ObservationIgnored var thumbnailCache: [String: UIImage] = [:]

    init(state: BrowserState, stateFile: StateFile? = nil, historyFile: HistoryFile? = nil, sideStore: TabSideStore? = nil,
         startup: StateLoad = .fresh, awakeCap: Int = SleepPlanner.defaultCap,
         clock: @escaping @MainActor () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() },
         rules: @escaping @MainActor () throws -> String = { try ContentBlocker.builtinRules() },
         embeddedLists: @escaping @MainActor () throws -> EmbeddedLists? = { try EmbeddedLists.load() },
         pageGuard makePageGuard: @escaping @MainActor (ScriptletTable) throws -> PageGuard? = { table in try PageGuard.load(table: table) },
         store: WKContentRuleListStore = .default(), downloadsDirectory: URL = DownloadsModel.defaultDirectory(),
         isPhone: Bool = UIDevice.current.userInterfaceIdiom == .phone) {
        self.isPhone = isPhone
        self.downloads = DownloadsModel(directory: downloadsDirectory)
        let initial = state.consistent() ?? Self.defaultState()
        self.state = initial
        unreadableLibraryEntries = initial.unreadableLibraryEntries
        self.stateFile = stateFile
        self.historyFile = historyFile
        self.sideStore = sideStore
        self.startup = startup
        self.awakeCap = awakeCap
        self.clock = clock
        self.rules = rules
        self.embeddedLists = embeddedLists
        self.makePageGuard = makePageGuard
        self.store = store
        switch startup {
        case .setAside, .held: startupNoticeShown = true
        case .fresh, .loaded: startupNoticeShown = false
        }
        if !unreadableLibraryEntries.isEmpty {
            print("[state] entries that do not read, left out and lost when their list is next written: \(unreadableLibraryEntries.sorted { $0.key < $1.key })")
        }
        loadHistory()
        ensureActiveTab()
        refreshClearWatch()
        navigationPolicy.model = self
        downloads.isCovered = { [weak self] space in self?.lock?.covers(space: space) ?? false }
    }

    var spaces: [Space] { state.spaces }
    var activeSpace: Space { state.spaces.first { $0.id == state.activeSpaceId } ?? state.spaces[0] }
    /// A space that is locked has no tab to show: whatever reads these (the screen, the list of tabs, the wake-up) finds nothing, which is the guard.
    var activeTabs: [TabItem] { activeSpaceCovered ? [] : state.tabs(in: state.activeSpaceId) }
    var activeTab: TabItem? { activeSpaceCovered ? nil : state.activeTab(in: state.activeSpaceId) }

    /// The view of the tab on screen. It exists once the model is ready; asking for it wakes the tab if it was asleep.
    var webView: WKWebView? {
        guard isReady, let tab = activeTab else { return nil }
        return wake(tab)
    }

    /// Compiles the blocker, wakes the tab on screen, and only then says it is ready. Called once, before the first page load.
    func prepare() async {
        guard !isReady else { return }
        var scriptlets = ScriptletTable()
        if blockerParts.isEmpty {
            do {
                if let embedded = try embeddedLists() {
                    // The first launch compiles every embedded list (a few seconds); later launches find them in WebKit's store.
                    self.embedded = embedded
                    compiledBlockerMode = privacySettings.blockMode
                    let outcome = await embedded.compile(in: store, mode: compiledBlockerMode)
                    blockerParts = outcome.parts
                    listFailures = outcome.failures
                    do {
                        scriptlets = try embedded.scriptletTable()
                    } catch {
                        // The rules still block; only the scriptlets of the lists are missing, and the page guard keeps our own rules.
                        guardFailure = error
                        print("[guard] the scriptlets of the lists could not be read, the page guard runs without them: \(error)")
                    }
                    if blockerParts.isEmpty { throw ContentBlocker.BlockerError.missingResource }
                } else {
                    // A copy with no embedded list (a checkout where the build step was not run): the short built-in list stands in.
                    let list = try await ContentBlocker.compile(rules(), identifier: ContentBlocker.builtinIdentifier, in: store)
                    blockerParts = [BlockerList(list: list, part: BlockerPlan.Part(source: .builtin, kind: .network))]
                }
                blockerFailure = nil
            } catch {
                // The person can still browse, without the blocker: the failure is kept (`blockerFailure`) and logged with its context.
                blockerFailure = error
                print("[blocker] rules not compiled, pages load unfiltered: \(error)")
            }
        }
        await preparePageGuard(scriptlets: scriptlets)
        // The sites of « Effacer à la fermeture » that are to go when the application starts again, before any page of them is loaded.
        await eraseAtLaunch()
        sideStore?.prune(keeping: state.tabs.map(\.id))
        isReady = true
        if let tab = activeTab { syncFrom(wake(tab)) }
        // A tab left idle for longer than the delay of its profile is archived when the application starts, and again each time it comes back.
        sweepIdleTabs()
    }

    /// The page guard and its rules, made before the first web view like the blocker is: a page that starts before it would run without it.
    private func preparePageGuard(scriptlets: ScriptletTable) async {
        do {
            pageGuard = try makePageGuard(scriptlets)
            guardList = try await pageGuard?.compileNetworkRules(in: store)
        } catch {
            guardFailure = error
            print("[guard] the page guard is not complete, pages load with what could be made: \(error)")
        }
    }

    // MARK: Navigation

    func submitAddress() {
        guard var request = Self.request(for: addressText), let view = webView else { return }
        navigationPolicy.prepare(&request, for: view)
        view.load(request)
    }

    /// The request an address field text stands for: an address, or a search (the same rules as the Mac, `AddressResolver`).
    static func request(for text: String, searchTemplate: String = AddressResolver.defaultSearchTemplate) -> URLRequest? {
        guard let resolved = AddressResolver.resolve(text, searchTemplate: searchTemplate) else { return nil }
        switch resolved {
        case .url(let address), .search(let address):
            guard let url = URL(string: address) else { return nil }
            var request = URLRequest(url: url)
            if let limit = LoadFailure.requestTimeout(for: address) { request.timeoutInterval = limit }
            return request
        }
    }

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    func reloadOrStop() {
        guard let view = webView else { return }
        if isLoading { view.stopLoading() } else { view.reload() }
    }

    // MARK: The sidebar of the iPhone

    /// Something happened to the sidebar that slides out from the left edge of an iPhone: it opens, closes or stays as `EdgeDrawer` says. The iPad never has
    /// it, so nothing opens it there.
    /// The sidebar button of the bottom bar: out when away, away when out.
    func toggleDrawer() { drawerEvent(EdgeDrawer.buttonEvent(wasOpen: drawerShown)) }

    func drawerEvent(_ event: EdgeDrawerEvent) {
        let open = EdgeDrawer.isOpen(after: event, wasOpen: drawerShown)
        guard open != drawerShown, !open || isPhone else { return }
        drawerShown = open
    }

    // MARK: Spaces and tabs

    func selectSpace(_ id: String) {
        drawerEvent(.spaceChosen)
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
        drawerEvent(.pageShown)
        guard !activeSpaceCovered, tab.id != activeTab?.id else { return }
        leaveActiveTab()
        state.show(tabId: tab.id, now: clock())
        arrive()
    }

    /// A new blank tab in the active space, unless the one on screen is blank already.
    func newTab() {
        tabsSheetShown = false
        drawerEvent(.pageShown)
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
    func ensureActiveTab() {
        if state.activeTab(in: state.activeSpaceId) != nil { return }
        if let latest = state.tabs(in: state.activeSpaceId).max(by: { ($0.lastActiveAt ?? 0) < ($1.lastActiveAt ?? 0) }) {
            state.show(tabId: latest.id, now: clock())
        } else {
            openBlankTab()
        }
    }

    func openBlankTab() {
        state.openTab(id: UUID().uuidString.lowercased(), in: state.activeSpaceId, now: clock())
    }

    /// What is done as a tab leaves the screen: its picture is taken now, while it is still on screen.
    func leaveActiveTab() {
        if let tab = activeTab { captureThumbnail(of: tab.id) }
    }

    /// What is done when another tab is on screen: it wakes, the bar follows it, the change is kept, and the surplus of awake tabs sleeps.
    func arrive() {
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
        noteVisit(view, tabId: tabId)
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
        flushHistory()
        saveTask?.cancel()
        saveTask = nil
        guard stateFile != nil else { return }
        do {
            try stateFile?.save(state)
            storageProblems[.state] = nil
        } catch {
            report(.state, "the state was not written: \(error)")
        }
        syncOrigin?.observe(state)
        // The marks of the synchronisation are taken as the state is written (docs/synchronisation.md §9.2): the gesture is marked when it is kept, not when a session
        // happens to carry it away. Nothing is given to the book while the synchronisation is off or while a session writes.
        if !isApplyingSync { sync?.stateWritten(state) }
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
        let old = state.privacy
        state.privacy = settings
        navigationPolicy.optionsChanged(on: Array(webViews.values))
        blockerSwitchesChanged(from: old, to: settings)
        refreshClearWatch()
        scheduleSave()
    }
}

extension BrowserModel {
    /// A first state: three spaces, each with a profile of its own, in the shape of the Mac's state file.
    static func defaultState() -> BrowserState {
        func space(_ id: String, _ name: String, _ emoji: String, hue: Double) -> Space {
            Space(id: id, name: name, emoji: emoji, profileId: id, rest: ["theme": SpaceTheme.make(hue: hue)])
        }
        var state = BrowserState(revision: 2,
                                 spaces: [space("work", String(localized: "space.work"), "💼", hue: 250), space("home", String(localized: "space.home"), "🏠", hue: 30),
                                          space("projects", String(localized: "space.projects"), "🧩", hue: 175)],
                                 activeSpaceId: "work", activeTabBySpace: ["work": nil, "home": nil, "projects": nil])
        // Each space starts with a profile of its own, named like it: the list of profiles shows them, and a profile outlives its space.
        for space in state.spaces { state.setProfileName(space.name, for: space.profileId) }
        return state
    }

    /// The folder the application keeps its own files in (`state.json`, the pictures and page states of the tabs).
    static func supportDirectory() -> URL {
        URL.applicationSupportDirectory.appending(path: "Lucium", directoryHint: .isDirectory)
    }

    /// The model of the running application: the state file of `directory` is read, and what it cannot read is put aside.
    static func launch(directory: URL = supportDirectory(), awakeCap: Int = SleepPlanner.defaultCap, lock: LockController? = nil,
                       rules: @escaping @MainActor () throws -> String = { try ContentBlocker.builtinRules() },
                       embeddedLists: @escaping @MainActor () throws -> EmbeddedLists? = { try EmbeddedLists.load() },
                       pageGuard: @escaping @MainActor (ScriptletTable) throws -> PageGuard? = { table in try PageGuard.load(table: table) },
                       store: WKContentRuleListStore = .default(), downloadsDirectory: URL = DownloadsModel.defaultDirectory()) -> BrowserModel {
        var file = StateFile(url: directory.appending(path: StateFile.fileName))
        let load = file.load()
        var state = defaultState()
        if case .loaded(let loaded) = load { state = loaded }
        let model = BrowserModel(state: state, stateFile: file, historyFile: HistoryFile(url: directory.appending(path: HistoryFile.fileName)),
                                 sideStore: TabSideStore(directory: directory.appending(path: TabSideStore.directoryName, directoryHint: .isDirectory)), startup: load,
                                 awakeCap: awakeCap, rules: rules, embeddedLists: embeddedLists, pageGuard: pageGuard, store: store, downloadsDirectory: downloadsDirectory)
        if let lock { model.attach(lock) }
        // A state that was found, even one that had to be put aside, means this phone was used before: only a launch with no file at all is a first one.
        let stateWasFound: Bool
        if case .fresh = load { stateWasFound = false } else { stateWasFound = true }
        model.syncOrigin = SyncOriginKeeper(file: SyncOriginFile(url: directory.appending(path: SyncOriginFile.fileName)), stateWasFound: stateWasFound, state: state)
        return model
    }
}
