import Foundation

/// What the user typed in the address field: an address to open, or words to search for.
public enum ResolvedInput: Equatable, Sendable {
    case url(String)
    case search(String)
}

/// The Swift twin of `resolveInput` in `src/shared/url.ts` (the Mac): the same rules, checked by the same vectors
/// (`ios/Contracts/address-vectors.json`, read by both test suites). Change one side, and the vectors fail on the other.
public enum AddressResolver {
    public static let defaultSearchTemplate = "https://duckduckgo.com/?q=%s"

    private static let allowedSchemes: Set<String> = ["http", "https", "file"]
    // Same patterns as the Mac's LOCAL_HOST and DOMAIN_LIKE.
    private static let localHost = try! NSRegularExpression(
        pattern: #"^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(/.*)?$"#, options: [.caseInsensitive])
    private static let domainLike = try! NSRegularExpression(
        pattern: #"^[^\s/@]+\.[a-z]{2,}(:\d+)?([/?#].*)?$"#, options: [.caseInsensitive])
    private static let schemeWithSlashes = try! NSRegularExpression(
        pattern: #"^([a-z][a-z0-9+.-]*)://"#, options: [.caseInsensitive])

    public static func resolve(_ input: String, searchTemplate: String = defaultSearchTemplate) -> ResolvedInput? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if text == "about:blank" { return .url(text) }
        // "localhost:3000" reads as a scheme, so a scheme is only trusted when followed by "//".
        if let match = schemeWithSlashes.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           let range = Range(match.range(at: 1), in: text) {
            return allowedSchemes.contains(text[range].lowercased()) ? .url(text) : search(text, searchTemplate)
        }
        if !text.contains(where: \.isWhitespace) {
            if matches(localHost, text), canParse("http://\(text)") { return .url("http://\(text)") }
            if matches(domainLike, text), canParse("https://\(text)") { return .url("https://\(text)") }
        }
        return search(text, searchTemplate)
    }

    /// The host of an address without its "www.", or "" when it is not an address (the Mac's `hostOf`). Like JavaScript's `URL.host`, it
    /// keeps a port that is not the default one of the scheme and writes an IPv6 address between brackets.
    public static func host(of address: String) -> String {
        guard let components = URLComponents(string: address), var host = components.host, !host.isEmpty else { return "" }
        // The name the system loads: `URLComponents.host` gives an internationalised name in its Unicode form (`аррӏе.com`, which reads as a well-known site), `URL.host`
        // gives the ASCII one (`xn--80ak6aa92e.com`) that the Mac's `URL.host` gives and that the page really is at.
        if let ascii = URL(string: address)?.host, !ascii.isEmpty { host = ascii }
        if host.contains(":"), !host.hasPrefix("[") { host = "[\(host)]" }
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
        let defaultPort = ["http": 80, "https": 443][components.scheme?.lowercased() ?? ""]
        if let port = components.port, port != defaultPort { host += ":\(port)" }
        return host
    }

    private static func search(_ query: String, _ template: String) -> ResolvedInput {
        .search(template.replacingOccurrences(of: "%s", with: encodeURIComponent(query)))
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func canParse(_ text: String) -> Bool {
        guard let url = URL(string: text), let host = url.host(percentEncoded: false) else { return false }
        return !host.isEmpty && (url.port.map { (0...65535).contains($0) } ?? true)
    }

    /// JavaScript's `encodeURIComponent`: everything but letters, digits and `-_.!~*'()` is percent-encoded.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    static func encodeURIComponent(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
    }
}
