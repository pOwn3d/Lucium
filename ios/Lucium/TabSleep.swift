import LuciumKit
import UIKit
import WebKit

/// Waking and sleeping tabs. An awake tab has a web view; a sleeping one has none and costs no memory. What it keeps is a line in the state, a
/// picture (taken as it left the screen) and the state of its page as WebKit gives it (history and scroll position), both in `TabSideStore`.
extension BrowserModel {
    /// How wide the picture of a tab is, in points.
    static let thumbnailWidth: CGFloat = 320

    // MARK: Waking

    /// The web view of a tab, made now when the tab slept: with the blocker and the data store of its space's profile, and the page where it
    /// was left (its history too, when WebKit's state of it was kept), or the address of the state, or the start page for a blank tab.
    func wake(_ tab: TabItem) -> WKWebView {
        if let existing = webViews[tab.id] { return existing }
        let configuration = WKWebViewConfiguration()
        if let space = state.spaces.first(where: { $0.id == tab.spaceId }) {
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: ProfileStore.identifier(for: space.profileId))
        }
        for list in blockers { ContentBlocker.install(list, on: configuration) }
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        view.isInspectable = true
        webViews[tab.id] = view
        observe(view, tabId: tab.id)
        restore(tab, into: view)
        return view
    }

    private func restore(_ tab: TabItem, into view: WKWebView) {
        let saved = tab.isBlank ? nil : sideStore?.read(.interaction, for: tab.id)
        // The kept state is used once. Left in place it would go stale as soon as the page moves, and a restart after a crash would bring back
        // an older page than the address of the state.
        sideStore?.remove(.interaction, for: tab.id)
        if let saved { view.interactionState = saved }
        guard view.url == nil, !view.isLoading else { return }
        if !tab.isBlank, let request = Self.request(for: tab.url) {
            view.load(request)
        } else {
            view.loadHTMLString(StartPage.html(), baseURL: nil)
        }
    }

    // MARK: Sleeping

    /// Frees the view of a tab. The state of its page is kept first, so that it wakes where it left off.
    func putToSleep(_ tabId: String) {
        guard let view = webViews[tabId] else { return }
        keepPageState(of: view, tabId: tabId)
        free(view, tabId: tabId)
    }

    /// Lets go of a view without keeping anything: a closed tab, or one that was just kept.
    func free(_ view: WKWebView, tabId: String) {
        observations[tabId] = nil
        view.stopLoading()
        view.navigationDelegate = nil
        view.removeFromSuperview()
        webViews[tabId] = nil
    }

    /// The history and the scroll position of the page, in a file of the tab. A blank tab keeps nothing: its page is the start page.
    func keepPageState(of view: WKWebView, tabId: String) {
        guard let sideStore else { return }
        guard let tab = state.tabs.first(where: { $0.id == tabId }), !tab.isBlank else {
            sideStore.remove(.interaction, for: tabId)
            return
        }
        guard let saved = view.interactionState else { return }  // no page yet: nothing to keep
        guard let data = saved as? Data else {
            report(.pageState, "the state of the page of tab \(tabId) is not data (\(type(of: saved))), so it is not kept")
            return
        }
        do { try sideStore.write(data, kind: .interaction, for: tabId) } catch { report(.pageState, "the state of the page of tab \(tabId) was not kept: \(error)") }
    }

    /// Frees the tabs the rules choose: past the cap, the least recently shown first; the one on screen and the ones that load, play or capture stay.
    /// Under memory pressure only the tab on screen stays.
    func sleepSurplus(underPressure: Bool = false) async {
        // What only WebKit can tell is asked first. Nothing is decided until every answer is in, and the facts, the verdict and the sleeping
        // below are one step with no `await` in it: a tab shown meanwhile (the person switched while WebKit answered) is never freed by a verdict
        // made before it was shown.
        var playing: [String: Bool] = [:]
        for (id, view) in webViews { playing[id] = await view.requestMediaPlaybackState() == .playing }
        var facts: [AwakeTab] = []
        for (id, view) in webViews {
            guard let tab = state.tabs.first(where: { $0.id == id }) else { continue }
            facts.append(AwakeTab(id: id, lastShownAt: tab.lastActiveAt ?? 0, isSelected: id == activeTab?.id, isLoading: view.isLoading,
                                  isPlayingMedia: playing[id] ?? false, isCapturing: view.cameraCaptureState != .none || view.microphoneCaptureState != .none,
                                  keepAwake: tab.keepAwake))
        }
        for id in SleepPlanner.tabsToSleep(facts, cap: awakeCap, underPressure: underPressure) { putToSleep(id) }
    }

    /// The tabs that have a live view, for the tests and the screen.
    var awakeTabIds: Set<String> { Set(webViews.keys) }

    // MARK: Leaving and coming back

    /// The application goes to the background, where iOS may end it without warning: what a restart needs is written now.
    func enterBackground() async {
        for (id, view) in webViews { keepPageState(of: view, tabId: id) }
        flush()
        if let tab = activeTab, !tab.isBlank, let view = webViews[tab.id] { await storeThumbnail(of: view, tabId: tab.id) }
    }

    /// Back on screen, the pages that are awake are the truth again: the state kept for the background would restore an older page after a crash.
    func didBecomeActive() {
        for id in webViews.keys { sideStore?.remove(.interaction, for: id) }
    }

    // MARK: Pictures

    /// Takes the picture of a tab now, while it is on screen. A blank tab has none (its page is the start page). The snapshot is asked for
    /// at once, not from a task that would start after the screen has changed: the view must still be on screen when WebKit looks at it.
    func captureThumbnail(of tabId: String) {
        guard sideStore != nil, let view = webViews[tabId], state.tabs.first(where: { $0.id == tabId })?.isBlank == false else { return }
        view.takeSnapshot(with: Self.snapshotConfiguration()) { [weak self] image, error in
            MainActor.assumeIsolated { self?.keepThumbnail(image, error, tabId: tabId) }
        }
    }

    /// The same, waited for: used when the application goes to the background.
    func storeThumbnail(of view: WKWebView, tabId: String) async {
        do {
            keepThumbnail(try await view.takeSnapshot(configuration: Self.snapshotConfiguration()), nil, tabId: tabId)
        } catch {
            keepThumbnail(nil, error, tabId: tabId)
        }
    }

    private static func snapshotConfiguration() -> WKSnapshotConfiguration {
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = NSNumber(value: thumbnailWidth)
        return configuration
    }

    private func keepThumbnail(_ image: UIImage?, _ error: Error?, tabId: String) {
        guard let sideStore else { return }
        guard let image else {
            report(.picture, "the picture of tab \(tabId) was not taken: \(error.map(String.init(describing:)) ?? "no image")")
            return
        }
        guard let jpeg = image.jpegData(compressionQuality: 0.6) else {
            report(.picture, "the picture of tab \(tabId) could not be encoded")
            return
        }
        do {
            try sideStore.write(jpeg, kind: .thumbnail, for: tabId)
            thumbnailCache[tabId] = image
            thumbnailRevision += 1
        } catch {
            report(.picture, "the picture of tab \(tabId) was not kept: \(error)")
        }
    }

    /// The picture a tab was left with, if it has one.
    func thumbnail(of tab: TabItem) -> UIImage? {
        _ = thumbnailRevision  // read so that the list of tabs redraws when a picture is stored
        if let cached = thumbnailCache[tab.id] { return cached }
        guard let data = sideStore?.read(.thumbnail, for: tab.id), let image = UIImage(data: data) else { return nil }
        thumbnailCache[tab.id] = image
        return image
    }
}
