import LuciumKit
import SwiftUI
import WebKit

/// What the privacy rules tell the person, and what they ask of them. It lives in the model (one stored property), so the screen redraws.
struct PrivacyPrompts {
    /// A certificate WebKit refused on an address that HTTPS first had upgraded. The person may open the http address, on their click only.
    struct Refusal: Equatable, Identifiable {
        let id = UUID()
        let tabId: String
        let host: String
        let http: String
    }

    /// A line the screen shows for a few seconds: "this site does not answer over HTTPS, the page opens over HTTP".
    var notice: String?
    var refusal: Refusal?
}

/// The web views' navigation delegate: every main-frame navigation goes through the privacy rules of the Mac (docs/ios.md, "Vie privée").
///
/// - the known tracking parameters come off the address, and an `http://` address goes to `https://` first (`PrivacyRules.rewriteNavigation`);
/// - a site that does not answer over HTTPS in five seconds, or at all, opens over HTTP and the person is told; a certificate WebKit refuses
///   never does: it is shown, and the http address is offered on a click (`HttpsUpgrades`);
/// - `Sec-GPC: 1` goes with the navigation, and `navigator.globalPrivacyControl` reads `true` in every frame (`installScripts`).
///
/// WebKit gives no hook on the requests a page makes by itself (images, scripts, frames), so the header cannot reach them: the Mac's session hook
/// has no twin here, and the README says so. WebKit does hand over every main-frame navigation, which is where all three rules act: the navigation
/// is cancelled and the rewritten address is loaded in its place.
@MainActor
final class PrivacyNavigation: NSObject, WKNavigationDelegate {
    /// The header of the Global Privacy Control proposal.
    static let gpcHeader = "Sec-GPC"

    /// How many rewrites one navigation may chain before it is let through as it is: a server that sends a visitor in a circle must not keep the
    /// tab busy for ever, now that each hop of a redirect is a new load.
    static let maxRewrites = 10

    weak var model: BrowserModel?
    /// The memory of HTTPS first, and how long a site gets: the tests of the application change both (the real rule never upgrades a local address,
    /// and five seconds is long to wait in a test).
    var upgrades: HttpsUpgrades
    var timeout: Duration
    private var timers: [String: Task<Void, Never>] = [:]
    /// The tabs whose next navigation is one the person asked for (an address typed): it forgets the loop guard of HTTPS first.
    private var personLoads: Set<String> = []
    private var rewrites: [String: Int] = [:]
    private var noticeGeneration = 0

    override init() {
        upgrades = HttpsUpgrades()
        timeout = HttpsUpgrade.timeout
        super.init()
    }

    // MARK: Setting a web view up

    /// The scripts every web view carries. They are put back whole when a setting changes: `WKUserContentController` can only remove all of
    /// its scripts, so whatever else wants one (the YouTube and cookie-banner scripts, later) is added here too.
    static func installScripts(on controller: WKUserContentController, options: PrivacyOptions) {
        // The page guard's script (`PageGuard`) is the plan of the page that is on its way: it stays, the others are put back.
        let pageGuard = controller.userScripts.filter { $0.source.hasPrefix(PageGuard.marker) }
        controller.removeAllUserScripts()
        for script in pageGuard { controller.addUserScript(script) }
        if options.globalPrivacyControl {
            controller.addUserScript(WKUserScript(source: gpcScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
    }

    /// `navigator.globalPrivacyControl`, as the proposal defines it: a read-only boolean on `Navigator`, `true` when the person does not consent to
    /// the sale or sharing of their data. A page that never reads it is unaffected.
    static let gpcScript = """
    (function () {
      try {
        Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: function () { return true; }, configurable: true, enumerable: true });
      } catch (e) {}
    })();
    """

    /// A web view that is about to be made: its configuration gets the scripts.
    func configure(_ configuration: WKWebViewConfiguration) {
        Self.installScripts(on: configuration.userContentController, options: currentOptions)
    }

    /// A web view that was just made.
    func attach(to view: WKWebView) { view.navigationDelegate = self }

    /// The setting changed: the awake web views carry the new scripts from their next page on.
    func optionsChanged(on views: [WKWebView]) {
        for view in views { Self.installScripts(on: view.configuration.userContentController, options: currentOptions) }
    }

    private var currentOptions: PrivacyOptions { model?.privacySettings.options ?? .none }

    /// The request for an address: with the signal when the setting is on.
    func request(for address: String) -> URLRequest? {
        guard let url = URL(string: address) else { return nil }
        var request = URLRequest(url: url)
        if currentOptions.globalPrivacyControl { request.setValue("1", forHTTPHeaderField: Self.gpcHeader) }
        return request
    }

    /// The person asks for an address (typed in the bar): the request carries the signal, and the next navigation of this view forgets what the
    /// loop guard of HTTPS first remembered.
    func prepare(_ request: inout URLRequest, for view: WKWebView) {
        if currentOptions.globalPrivacyControl { request.setValue("1", forHTTPHeaderField: Self.gpcHeader) }
        if let tab = tabId(of: view) { personLoads.insert(tab) }
    }

    private func tabId(of view: WKWebView) -> String? {
        model?.webViews.first { $0.value === view }?.key
    }

    // MARK: Deciding

    /// Every navigation also says which version of the site is asked for: the desktop one when the person chose it for this tab (iPhone only: the
    /// iPad already asks for desktop sites). WebKit reads the preference of the answer for this navigation, a reload included.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        let policy = await self.webView(webView, decidePolicyFor: action)
        if let tab = tabId(of: webView), let model { preferences.preferredContentMode = model.contentMode(ofTab: tab) }
        return (policy, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        let policy = await decide(webView, action)
        // A page that is let through is given what the page guard runs in it (the scriptlets and the style sheet of its site, `PageGuard`). One that
        // was cancelled is replaced by the load the rules made, which comes through here again: the address that decides is the final one.
        if policy == .allow, action.targetFrame?.isMainFrame == true { model?.pageGuard?.prepare(webView, for: action.request.url) }
        return policy
    }

    private func decide(_ webView: WKWebView, _ action: WKNavigationAction) async -> WKNavigationActionPolicy {
        // A link marked `download` is a file, not a page: it never goes through the rewrites below, which would load it as a page.
        if action.shouldPerformDownload { return DownloadNavigation.policy(shouldPerformDownload: true, address: action.request.url) }
        guard let tab = tabId(of: webView), action.targetFrame?.isMainFrame == true, let url = action.request.url,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return .allow }
        let address = url.absoluteString
        // The history holds the address that was loaded, which the rules already treated. A reload or a step back does not go through them again.
        if action.navigationType == .backForward || action.navigationType == .reload { return .allow }

        // The person started this (a link, a form, an address typed): HTTPS first forgets what it remembered. Anything else (a redirect, a script)
        // keeps the loop guard.
        if personLoads.remove(tab) != nil || action.navigationType != .other {
            upgrades.navigationStarted(page: tab, url: address)
            rewrites[tab] = 0
        } else {
            upgrades.pageNavigated(page: tab, url: address)
        }

        let options = currentOptions
        var started: HttpsUpgrades.Started?
        let target = PrivacyRules.rewriteNavigation(RewriteRequest(url: address, method: action.request.httpMethod ?? "GET"), options: options) { http in
            started = upgrades.upgrade(page: tab, http: http)
            return started?.https
        }
        // An unchanged address needs a new load when the signal is on and the request does not carry it: a link or a form, to which WebKit adds
        // nothing. A load the application made itself (`prepare`) and the hops of a redirect already carry it. A page restored from its saved state,
        // or one a script loads, is left alone: loading it again would add an entry to its history.
        let fromLinkOrForm = action.navigationType == .linkActivated || action.navigationType == .formSubmitted
        let needsSignal = options.globalPrivacyControl && fromLinkOrForm && action.request.httpMethod ?? "GET" == "GET"
            && action.request.value(forHTTPHeaderField: Self.gpcHeader) != "1"
        guard target != nil || needsSignal else { return .allow }

        let chained = rewrites[tab, default: 0]
        guard chained < Self.maxRewrites else {
            print("[privacy] \(chained) rewrites in a row for tab \(tab), the next navigation goes through as it is: \(address)")
            upgrades.forget(page: tab)
            return .allow
        }
        rewrites[tab] = chained + 1
        guard let request = request(for: target ?? address) else { return .allow }
        if let started { startTimer(tab: tab, token: started.token, view: webView) }
        // The load starts once this answer is given: a load made before it would be the one that the answer cancels.
        Task { @MainActor [weak webView] in webView?.load(request) }
        return .cancel
    }

    // MARK: Following a load

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // A new load (a retry, another address, a step back) replaces the screen of the failure that was there.
        if let tab = tabId(of: webView) { model?.loadFailures[tab] = nil }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard let tab = tabId(of: webView) else { return }
        model?.loadFailures[tab] = nil
        upgrades.committed(page: tab)
        timers[tab]?.cancel()
        timers[tab] = nil
        rewrites[tab] = 0
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let tab = tabId(of: webView) else { return }
        let failure = error as NSError
        let failed = (failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.absoluteString ?? ""
        let cancelled = Self.isCancellation(failure)
        switch upgrades.failed(page: tab, failedUrl: failed, cancelled: cancelled, certificate: Self.isCertificateFailure(failure)) {
        case .none:
            // Not an upgrade that failed: the tab shows the error screen (`LoadFailureView`), unless the failure is one that gets none (a cancelled
            // load, an app link, a refused certificate: `LoadFailure.classify`). The host and the code are kept in the log for whoever looks for the cause.
            if let page = LoadFailure.classify(failure) { model?.loadFailures[tab] = page }
            if !cancelled { print("[privacy] a load of \(AddressResolver.host(of: failed)) failed (\(failure.domain) \(failure.code)), no upgrade was under way for it") }
        case .fellBack(let http):
            timers[tab]?.cancel()
            fallBack(to: http, in: webView)
        case .refused(let http):
            timers[tab]?.cancel()
            let host = AddressResolver.host(of: http)
            model?.privacyPrompts.refusal = PrivacyPrompts.Refusal(tabId: tab, host: host, http: http)
            print("[privacy] certificate of \(host) refused after an upgrade to HTTPS (\(failure.domain) \(failure.code)); the http address is offered on a click")
        }
    }

    /// A load that was replaced, stopped or turned into a download says nothing about the site: `NSURLErrorCancelled`, or WebKit's "frame load
    /// interrupted" (102).
    static func isCancellation(_ error: NSError) -> Bool {
        (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled) || (error.domain == "WebKitErrorDomain" && error.code == 102)
    }

    /// The certificate of the site was refused (bad date, untrusted, unknown root, not valid yet). A TLS failure that is not about the certificate
    /// (`NSURLErrorSecureConnectionFailed`: the site does not speak TLS on that port) is the site not answering over HTTPS.
    static func isCertificateFailure(_ error: NSError) -> Bool {
        error.domain == NSURLErrorDomain && [NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
                                             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid].contains(error.code)
    }

    // MARK: Falling back

    private func startTimer(tab: String, token: Int, view: WKWebView) {
        timers[tab]?.cancel()
        timers[tab] = Task { [weak self, weak view, timeout] in
            do { try await Task.sleep(for: timeout) } catch { return }  // cancelled: the upgrade ended, or another one began
            guard let self, let view else { return }
            self.timerRang(tab: tab, token: token, view: view)
        }
    }

    private func timerRang(tab: String, token: Int, view: WKWebView) {
        guard let http = upgrades.timedOut(page: tab, token: token, isLoading: view.isLoading) else { return }
        view.stopLoading()
        fallBack(to: http, in: view)
    }

    private func fallBack(to http: String, in view: WKWebView) {
        if let request = request(for: http) { view.load(request) }
        let host = AddressResolver.host(of: http)
        show(notice: String(localized: "privacy.fallback \(host)"))
    }

    /// « Open over HTTP (not secure) »: the person's click. The address goes through once, without the upgrade.
    func continueOverHttp(_ refusal: PrivacyPrompts.Refusal) {
        model?.privacyPrompts.refusal = nil
        guard let view = model?.webViews[refusal.tabId], upgrades.continueOverHttp(page: refusal.tabId, http: refusal.http),
              let request = request(for: refusal.http) else { return }
        personLoads.insert(refusal.tabId)
        view.load(request)
    }

    /// Shows a line for a few seconds. A newer line replaces it, and the timer of the older one then does nothing.
    private func show(notice: String) {
        noticeGeneration += 1
        let generation = noticeGeneration
        model?.privacyPrompts.notice = notice
        Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(6)) } catch { return }  // cancelled with the application: nothing left to hide
            guard let self, self.noticeGeneration == generation else { return }
            self.model?.privacyPrompts.notice = nil
        }
    }

    /// « Try again »: the address that failed is loaded once more, as the person's own load (the loop guard of HTTPS first forgets what it knew).
    func retry(tab: String) {
        guard let failure = model?.loadFailures[tab], let address = failure.retryAddress, var request = request(for: address),
              let view = model?.webViews[tab] else { return }
        prepare(&request, for: view)
        view.load(request)
    }

    /// A tab was closed or went to sleep: nothing of it is remembered.
    func forget(tab: String) {
        model?.loadFailures[tab] = nil
        upgrades.forget(page: tab)
        timers[tab]?.cancel()
        timers[tab] = nil
        personLoads.remove(tab)
        rewrites[tab] = nil
    }
}
