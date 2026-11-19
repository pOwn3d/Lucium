import WebKit
import XCTest
@testable import Lucium

/// Loads something in a web view and waits for the page to finish (or fail), without a window and without polling.
@MainActor
final class NavigationWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?
    /// The delegate the web view had (the privacy rules and the page guard of the model, if it made them): it is put back when the load is over,
    /// and it answers the policy questions in the meantime, so that a test that waits for a page still loads it the way the application does.
    private weak var forwarded: PrivacyNavigation?

    struct TimedOut: Error {}

    func load(in webView: WKWebView, timeout: Duration = .seconds(30), _ start: () -> Void) async throws {
        let previous = webView.navigationDelegate
        forwarded = previous as? PrivacyNavigation
        webView.navigationDelegate = self
        defer { webView.navigationDelegate = previous }
        let timer = Task { [weak self] in
            try await Task.sleep(for: timeout)
            self?.finish(.failure(TimedOut()))
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.continuation = continuation
            start()
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let forwarded else { return .allow }
        return await forwarded.webView(webView, decidePolicyFor: navigationAction)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        guard let forwarded else { return (.allow, preferences) }
        return await forwarded.webView(webView, decidePolicyFor: navigationAction, preferences: preferences)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
}
