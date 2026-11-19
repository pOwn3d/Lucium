import Foundation

/// How the blocker treats the requests a page makes to its own site (`BlockMode` in `src/shared/model-settings.ts`): « Standard » leaves them alone
/// unless a rule is written for first parties, « Strict » applies every rule to them too.
public enum BlockMode: String, CaseIterable, Sendable {
    case standard, strict
}

/// The sites of the lists of the blocker (« sites où rien n'est bloqué »): a host written one way, as `normalizeBlockHost` of the Mac reads it.
public enum BlockHost {
    /// Sites in the list: more than anyone writes by hand, and a bound for a hand-edited file (`BLOCK_EXCEPTIONS_MAX`).
    public static let exceptionsMax = 200
    private static let textMax = 300
    private static let hostnameMax = 253

    /// The host a typed address stands for: lower case, no scheme, port, path or leading `www.`, or nil when it is neither a host name nor an IPv6
    /// address. A pasted address works, so does `*.example.com` (the Mac's `normalizeHostEntry`).
    public static func normalize(_ input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.hasPrefix("*.") { text.removeFirst(2) }
        guard !text.isEmpty, text.count <= textMax else { return nil }
        let hasScheme = text.range(of: "^[a-z][a-z0-9+.-]*://", options: .regularExpression) != nil
        guard let components = URLComponents(string: hasScheme ? text : "https://" + text), let scheme = components.scheme, scheme == "http" || scheme == "https",
              var host = components.host else { return nil }
        // The Mac keeps the brackets of an IPv6 literal (`URL.hostname`); `URLComponents` already hands them back (docs/ios.md, section 7.1).
        if host.contains(":"), !host.hasPrefix("[") { host = "[" + host + "]" }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        while host.hasSuffix(".") { host.removeLast() }
        guard host.count <= hostnameMax, isHostName(host) || isIPv6Literal(host) else { return nil }
        return host
    }

    private static func isHostName(_ host: String) -> Bool {
        host.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", options: .regularExpression) != nil
    }

    private static func isIPv6Literal(_ host: String) -> Bool {
        host.range(of: "^\\[[0-9a-f:.]+\\]$", options: .regularExpression) != nil
    }

    /// What a saved list may hold: valid hosts only, each once, in order, `exceptionsMax` at most (`cleanBlockExceptions`).
    public static func clean(_ value: JSONValue?) -> [String] {
        guard case .array(let entries)? = value else { return [] }
        var seen = Set<String>(), hosts: [String] = []
        for entry in entries {
            guard case .string(let text) = entry, let host = normalize(text), seen.insert(host).inserted else { continue }
            hosts.append(host)
            if hosts.count >= exceptionsMax { break }
        }
        return hosts
    }

    /// The host of the address of a page, as the lists compare it: lower case, without `www.` and without the final dot. Nil for anything but a web page.
    public static func host(ofPage address: String?) -> String? {
        guard let address, let components = URLComponents(string: address), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              var host = components.host?.lowercased(), !host.isEmpty else { return nil }
        if host.contains(":"), !host.hasPrefix("[") { host = "[" + host + "]" }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        while host.hasSuffix(".") { host.removeLast() }
        return host.isEmpty ? nil : host
    }

    private static func covers(_ entry: String, _ host: String) -> Bool { host == entry || host.hasSuffix("." + entry) }

    /// Whether a page is on a listed host or one of its subdomains: nothing is blocked there (`isBlockingExempt`).
    public static func isExempt(_ address: String?, in hosts: [String]) -> Bool {
        guard !hosts.isEmpty, let host = host(ofPage: address) else { return false }
        return hosts.contains { covers($0, host) }
    }

    /// What the list does with a typed site: the host to add, or why it cannot be added (`checkBlockException`).
    public enum Check: Equatable, Sendable {
        case host(String)
        case invalid
        case alreadyListed
        /// A parent domain of the site is listed already.
        case coveredBy(String)
        case full
    }

    public static func check(_ input: String, in hosts: [String]) -> Check {
        guard let host = normalize(input) else { return .invalid }
        if let parent = hosts.first(where: { covers($0, host) }) { return parent == host ? .alreadyListed : .coveredBy(parent) }
        if hosts.count >= exceptionsMax { return .full }
        return .host(host)
    }
}

/// A site of the list « Effacer à la fermeture »: a host with an optional port, spelled as the Mac's `parseSiteHost` prints it.
public enum SiteHostEntry {
    /// Sites on the list: `SITE_DATA_HOSTS_MAX * 5` on the Mac.
    public static let max = 100
    private static let hostnameMax = 253

    /// The canonical host (lower case, with the port when one was given), or nil when the text is not a domain, `localhost`, a single-label name, or an
    /// IP address (an IPv6 one in brackets). The Mac's `parseSiteHost`, held to it by `ios/Contracts/blocker-vectors.json`.
    public static func parse(_ input: String) -> String? {
        guard !input.isEmpty, input.count <= hostnameMax + 6 else { return nil }
        let text = input.lowercased()
        let hostname: String
        var port: Int?
        if text.hasPrefix("[") {
            guard let close = text.firstIndex(of: "]") else { return nil }
            hostname = String(text[...close])
            let rest = text[text.index(after: close)...]
            if !rest.isEmpty {
                guard rest.hasPrefix(":"), let parsed = parsePort(rest.dropFirst()) else { return nil }
                port = parsed
            }
        } else {
            let parts = text.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count <= 2, let first = parts.first, !first.isEmpty else { return nil }
            hostname = String(first)
            if parts.count == 2 {
                guard let parsed = parsePort(parts[1]) else { return nil }
                port = parsed
            }
        }
        guard hostname.count <= hostnameMax else { return nil }
        let canonical: String
        let isIP: Bool
        if matches(hostname, "^(?:0|[1-9]\\d{0,2})(?:\\.(?:0|[1-9]\\d{0,2})){3}$") {
            guard hostname.split(separator: ".").allSatisfy({ (Int($0) ?? 256) <= 255 }) else { return nil }
            canonical = hostname; isIP = true
        } else if matches(hostname, "^\\[[0-9a-f:.]+\\]$") {
            guard hostname.filter({ $0 == ":" }).count >= 2, let host = URLComponents(string: "http://" + hostname)?.host else { return nil }
            canonical = host.hasPrefix("[") ? host : "[" + host + "]"; isIP = true
        } else {
            let label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            let valid = hostname.contains(".") ? matches(hostname, "^(?:\(label)\\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$") : matches(hostname, "^\(label)$")
            guard valid else { return nil }
            canonical = hostname; isIP = false
        }
        let host = port.map { "\(canonical):\($0)" } ?? canonical
        // The URL parser reads some spellings as numbers (127, 0x7f): what it would visit must be what was typed. A name with a dot ends in letters here
        // (`[a-z]{2,}` or `xn--`), so only a single label can be read as a number: all digits, or `0x` and hexadecimal digits.
        if !isIP, !hostname.contains("."), matches(hostname, "^(?:[0-9]+|0x[0-9a-f]*)$") { return nil }
        return host
    }

    private static func parsePort(_ text: Substring) -> Int? {
        guard (1...5).contains(text.count), text.allSatisfy(\.isASCII), text.allSatisfy(\.isNumber), let port = Int(text), (1...65535).contains(port) else { return nil }
        return port
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }

    /// A saved list: valid hosts only, each once, no more than `max` (`cleanClearOnClose`).
    public static func clean(_ value: JSONValue?) -> [String] {
        guard case .array(let entries)? = value else { return [] }
        var seen = Set<String>(), hosts: [String] = []
        for entry in entries {
            guard case .string(let text) = entry, let host = parse(text), seen.insert(host).inserted else { continue }
            hosts.append(host)
            if hosts.count >= max { break }
        }
        return hosts
    }

    /// The host (with its port) a typed text or a whole address stands for, for the field that adds a site (`siteHostOf`, then `parseSiteHost`).
    public static func parseTyped(_ input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.range(of: "^https?://[^/?#\\s]", options: [.regularExpression, .caseInsensitive]) != nil, let url = URL(string: text), let host = url.host(percentEncoded: false) {
            let bracketed = host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host
            return parse(url.port.map { "\(bracketed):\($0)" } ?? bracketed)
        }
        return parse(text)
    }
}
