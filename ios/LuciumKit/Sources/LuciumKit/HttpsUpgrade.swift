import Foundation

/// The Swift twin of the address rules of "HTTPS first" in `src/shared/privacy.ts` (the Mac), checked by the same vectors
/// (`ios/Contracts/privacy-vectors.json`).
public enum HttpsUpgrade {
    /// How long a site gets to start answering over HTTPS before the page opens over HTTP instead (`HTTPS_UPGRADE_TIMEOUT_MS`).
    public static let timeout: Duration = .seconds(5)

    /// Names that never leave the machine or the local network: no certificate authority signs for them.
    private static let localSuffixes = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".localdomain", ".intranet", ".corp"]

    /// The four numbers of an IPv4 address, or nil when `host` is not one (the Mac's `IPV4`: four groups of one to three digits).
    private static func ipv4(_ host: String) -> [Int]? {
        let groups = host.split(separator: ".", omittingEmptySubsequences: false)
        guard groups.count == 4 else { return nil }
        var numbers: [Int] = []
        for group in groups {
            guard (1...3).contains(group.count), group.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(group) else { return nil }
            numbers.append(number)
        }
        return numbers
    }

    /// Addresses that only mean something on this machine or this network: loopback, private, link-local, shared (CGNAT), unspecified.
    private static func isPrivateIp(_ host: String) -> Bool {
        if let v4 = ipv4(host) {
            let (a, b) = (v4[0], v4[1])
            return a == 0 || a == 10 || a == 127 || (a == 100 && (64...127).contains(b)) || (a == 169 && b == 254) || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
        }
        if host.hasPrefix("[") {
            let v6 = host.dropFirst().dropLast().lowercased()
            return v6 == "::" || v6 == "::1" || v6.hasPrefix("fc") || v6.hasPrefix("fd") || ["fe8", "fe9", "fea", "feb"].contains { v6.hasPrefix($0) } || v6.hasPrefix("::ffff:")
        }
        return false
    }

    /// Whether a host may be tried over HTTPS: a public name (with a dot) or a public IP address. An IPv6 address is written between brackets.
    public static func isUpgradableHost(_ hostname: String) -> Bool {
        var host = hostname.lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return false }
        if ipv4(host) != nil || host.hasPrefix("[") { return !isPrivateIp(host) }
        if !host.contains(".") { return false }
        return !localSuffixes.contains { host.hasSuffix($0) }
    }

    /// The `https://` address to try for an `http://` one, or nil when it should stay as it is: another scheme, a local or private host, a port
    /// other than 80 (a server on 8080 rarely speaks TLS on 8080), or a login in the address.
    public static func upgrade(_ address: String) -> String? {
        guard let parts = WebAddress(address), parts.scheme == "http", address.lowercased().hasPrefix("http://"),
              let components = URLComponents(string: address), let host = components.host else { return nil }
        // An IPv6 host comes with or without its brackets depending on the parser: the rules want them.
        let bare = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
        if !isUpgradableHost(bare.contains(":") ? "[\(bare)]" : bare) { return nil }
        if let port = components.port, port != 80 { return nil }
        if !(components.user ?? "").isEmpty || !(components.password ?? "").isEmpty { return nil }
        // "http" becomes "https", and the explicit port 80 goes: it is the default of http, not of https.
        var rest = String(address.dropFirst("http://".count))
        let authorityEnd = rest.firstIndex { "/?#".contains($0) } ?? rest.endIndex
        if rest[..<authorityEnd].hasSuffix(":80") { rest.removeSubrange(rest.index(authorityEnd, offsetBy: -3)..<authorityEnd) }
        return "https://" + rest
    }
}

/// The memory of "HTTPS first": which pages have an upgrade under way, what to do when it fails, and the guard against loops. The Swift twin of
/// `HttpsUpgrades` in `src/main/engine/https-upgrade.ts`. It holds no timer and knows nothing of WebKit: the application starts a timer when
/// `upgrade` answers, and asks `timedOut` when it rings, so the rules are tested here, on the Mac, without a simulator.
///
/// A "page" is whatever the application calls one (the identifier of a tab).
public struct HttpsUpgrades: Sendable {
    /// An upgrade that has begun: the address to load, and the number that tells its timer from the timers of earlier upgrades of the page.
    public struct Started: Equatable, Sendable {
        public let https: String
        public let token: Int
    }

    /// What became of a failed main-frame load.
    public enum Failure: Equatable, Sendable {
        /// Not the failure of an upgrade (another address, a load that was cancelled): the error shows as usual.
        case none
        /// The site did not answer over HTTPS: the page goes back to `http` by itself and says so.
        case fellBack(http: String)
        /// The site answered over HTTPS with a certificate that is not valid. This is never a reason to go to HTTP by itself (someone on the way can
        /// present any certificate): the error shows, and offers `http` on the person's click only.
        case refused(http: String)
    }

    private struct Pending {
        let http: String
        let https: String
        let token: Int
    }

    private let rule: @Sendable (String) -> String?
    private var pending: [String: Pending] = [:]
    /// The http addresses upgraded since the page last committed or was told to go elsewhere: one is never upgraded twice, so a site that sends
    /// its https visitors back to http cannot loop.
    private var tried: [String: Set<String>] = [:]
    /// The http addresses a page was sent back to after a failure: they go through once without being upgraded.
    private var letThrough: [String: Set<String>] = [:]
    private var counter = 0

    /// `rule` says which http address goes to which https one; the tests give another (the real one never upgrades a local address).
    public init(rule: @escaping @Sendable (String) -> String? = HttpsUpgrade.upgrade) { self.rule = rule }

    /// The request hook asks: may this http address, loaded by `page`, go to https now? Returns the upgrade that begins, or nil.
    public mutating func upgrade(page: String, http: String) -> Started? {
        if letThrough[page]?.remove(http) != nil { return nil }
        if tried[page]?.contains(http) == true { return nil }
        guard let https = rule(http) else { return nil }
        tried[page, default: []].insert(http)
        counter += 1
        pending[page] = Pending(http: http, https: https, token: counter)
        return Started(https: https, token: counter)
    }

    /// A navigation the person started (an address typed, a link tapped, a reload) begins: the loop guard is forgotten, and an upgrade that was
    /// under way is dropped when this is another address. A navigation the page made itself (a redirect, a script) uses `pageNavigated` instead.
    public mutating func navigationStarted(page: String, url: String) {
        tried[page] = nil
        pageNavigated(page: page, url: url)
    }

    /// A main-frame navigation begins that the person did not start: an upgrade under way is dropped when it is another address; the loop guard stays.
    public mutating func pageNavigated(page: String, url: String) {
        if let current = pending[page], url != current.http, url != current.https { pending[page] = nil }
    }

    /// The page committed a document: nothing is under way any more.
    public mutating func committed(page: String) { forget(page: page) }

    /// A main-frame load failed. `cancelled`: it was replaced or cancelled, which says nothing about the site. `certificate`: the certificate of the
    /// site was refused.
    public mutating func failed(page: String, failedUrl: String, cancelled: Bool, certificate: Bool) -> Failure {
        if cancelled { return .none }
        guard let current = pending[page], Self.hostname(of: current.https) == Self.hostname(of: failedUrl) else {
            forget(page: page)
            return .none
        }
        pending[page] = nil
        tried[page] = nil
        if certificate { return .refused(http: current.http) }
        letThrough[page, default: []].insert(current.http)
        return .fellBack(http: current.http)
    }

    /// The timer of an upgrade rings. Returns the http address to go back to when the upgrade is still the one under way and the page is still
    /// loading (a page that settled on its own, or a download, did not fail). `token` is the one `upgrade` gave: a timer of an older upgrade does nothing.
    public mutating func timedOut(page: String, token: Int, isLoading: Bool) -> String? {
        guard let current = pending[page], current.token == token else { return nil }
        pending[page] = nil
        guard isLoading else { return nil }
        letThrough[page, default: []].insert(current.http)
        return current.http
    }

    /// « Open over HTTP (not secure) » on the page of a refused certificate: `http` goes through once, without the upgrade. False when it is not
    /// an http address.
    public mutating func continueOverHttp(page: String, http: String) -> Bool {
        guard http.lowercased().hasPrefix("http://") else { return false }
        letThrough[page, default: []].insert(http)
        return true
    }

    public mutating func forget(page: String) {
        pending[page] = nil
        tried[page] = nil
        letThrough[page] = nil
    }

    /// Upgrades under way, for the tests.
    public var pendingCount: Int { pending.count }

    private static func hostname(of address: String) -> String? { URLComponents(string: address)?.host?.lowercased() }
}
