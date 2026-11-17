import WebKit
import XCTest

/// Loads something in a web view and waits for the page to finish (or fail), without a window and without polling.
@MainActor
final class NavigationWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?

    struct TimedOut: Error {}

    func load(in webView: WKWebView, timeout: Duration = .seconds(30), _ start: () -> Void) async throws {
        webView.navigationDelegate = self
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
}
