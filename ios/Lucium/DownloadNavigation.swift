import LuciumKit
import WebKit

/// The part of the web views' navigation delegate (`PrivacyNavigation`, the one delegate of every tab) that downloads: a navigation that WebKit
/// should download is turned into a download, and handed to `DownloadsModel`. The rules are `DownloadPolicy`'s (`LuciumKit`).
enum DownloadNavigation {
    /// A link marked `download`, or a navigation WebKit already knows should save: followed when its address is one a page may ask for. Decided on
    /// plain values: WebKit's own `WKNavigationAction` and `WKNavigationResponse` cannot be made by a test.
    static func policy(shouldPerformDownload: Bool, address: URL?) -> WKNavigationActionPolicy {
        guard shouldPerformDownload else { return .allow }
        return DownloadPolicy.canDownload(address) ? .download : .cancel
    }

    /// A response the web view cannot show, or that the server marks `attachment`.
    static func policy(canShowMIMEType: Bool, response: URLResponse) -> WKNavigationResponsePolicy {
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        return DownloadPolicy.shouldDownload(canShowMIMEType: canShowMIMEType, contentDisposition: disposition) ? .download : .allow
    }
}

extension BrowserModel {
    /// The space of the tab that shows `view`, or nil when no tab does.
    func spaceId(of view: WKWebView) -> String? {
        guard let tabId = webViews.first(where: { $0.value === view })?.key else { return nil }
        return state.tabs.first { $0.id == tabId }?.spaceId
    }
}

extension PrivacyNavigation {
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        DownloadNavigation.policy(canShowMIMEType: navigationResponse.canShowMIMEType, response: navigationResponse.response)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { adopt(download, from: webView) }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { adopt(download, from: webView) }

    /// A navigation became a download: the model takes it over, with the space of the tab it came from. (The model owns this delegate: it is there for as
    /// long as a download can begin.)
    private func adopt(_ download: WKDownload, from view: WKWebView) {
        model?.downloads.adopt(download, spaceId: model?.spaceId(of: view) ?? "")
    }
}
