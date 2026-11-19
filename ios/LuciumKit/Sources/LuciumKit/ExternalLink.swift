import Foundation

/// What Lucium accepts from another application that hands it a link (the default-browser requirement of Apple, docs/ios.md §9.4). Anything else is
/// dropped: an app that can call `lucium://`-style URLs or craft a link must not be able to make the browser do more than open a web page.
public enum ExternalLink {
    /// Longest address kept: a longer one is an attack on the tab list and the state file, not a page.
    public static let maxLength = 8192

    /// The address to open in a new tab, or nil when the link is not a plain http(s) address with a host. The address is returned as given
    /// (no rewriting: HTTPS first and the privacy filters are applied by the ordinary page load, not here).
    public static func address(from url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        let text = url.absoluteString
        guard text.count <= maxLength, let host = url.host(percentEncoded: false), !host.isEmpty else { return nil }
        // Credentials in the address are the classic way to dress one site up as another.
        guard url.user == nil, url.password == nil else { return nil }
        return text
    }
}
