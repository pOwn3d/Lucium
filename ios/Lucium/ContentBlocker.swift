import WebKit

/// The blocker of the iOS application: rules compiled once by WebKit (`WKContentRuleList`), applied to every web view.
/// WebKit judges each request itself, in its own process, so the application never sees an address that is blocked. The rules are
/// embedded in the application: nothing is downloaded (docs/ios.md, "Bloqueur de publicités").
@MainActor
enum ContentBlocker {
    static let builtinIdentifier = "app.lucium.builtin"

    enum BlockerError: Error { case missingResource }

    /// The embedded sample rules. The real lists are compiled from the filter lists of `src/main` at build time (docs/ios.md).
    static func builtinRules(in bundle: Bundle = .main) throws -> String {
        guard let url = bundle.url(forResource: "blocker-rules", withExtension: "json") else { throw BlockerError.missingResource }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Compiles `rules` (the JSON array of the Safari content blocker format) into a list kept by `store`.
    static func compile(_ rules: String, identifier: String, in store: WKContentRuleListStore = .default()) async throws -> WKContentRuleList {
        guard let list = try await store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: rules) else {
            throw BlockerError.missingResource
        }
        return list
    }

    static func install(_ list: WKContentRuleList, on configuration: WKWebViewConfiguration) {
        configuration.userContentController.add(list)
    }
}
