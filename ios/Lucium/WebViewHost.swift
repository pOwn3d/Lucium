import SwiftUI
import WebKit

/// Puts a `WKWebView` (owned by the model) on the screen. SwiftUI only places the view; navigation stays in the model.
struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
