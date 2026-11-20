import Foundation

/// A main-frame load that failed, told in the terms the error screen needs. Pure: the application hands over the error WebKit reported
/// (`didFailProvisionalNavigation`) and gets back what to say, or nothing when no screen is due. The Mac's twin is `src/shared/error-pages.ts`
/// (`isReportableFailure`: a cancelled load gets no page; `describeLoadError`: one sentence per network failure).
public struct LoadFailure: Equatable, Sendable {
    /// What went wrong, in the few families the screen has words for. Each has its own sentence in the catalogue (`loadfailure.<kind>.*`).
    public enum Kind: String, CaseIterable, Sendable {  // raw values are the words of the catalogue keys (`loadfailure.<raw>.title`)
        /// The device has no network (or the system refuses it one: roaming off, mobile data off, a call in progress).
        case offline
        /// The name of the site does not resolve.
        case hostNotFound = "host-not-found"
        /// The site did not answer in time.
        case timedOut = "timed-out"
        /// The site refused the connection, or cannot be reached from this network.
        case cannotConnect = "cannot-connect"
        /// The connection broke while it was being made.
        case connectionLost = "connection-lost"
        /// The site sent the visitor round in a circle.
        case tooManyRedirects = "too-many-redirects"
        /// The address is not valid.
        case badAddress = "bad-address"
        /// The site does not speak TLS properly (not a refused certificate, which is `certificate`).
        case secureConnection = "secure-connection"
        /// The certificate of the site was refused (expired, self-signed, not trusted, not valid yet) on an address the person asked for directly. It
        /// used to leave a blank page: only a page that HTTPS first had upgraded got the prompt of `PrivacyNavigation` (`HttpsUpgrades.refused`).
        case certificate
        /// Anything else the system reports.
        case other
    }

    public let kind: Kind
    /// The address that could not be loaded, as the system reports it ("" when it did not say).
    public let address: String
    /// What the system said, for whoever has to find the cause from a phone: the error domain and its code (« NSURLErrorDomain -1001 »). Shown small on the
    /// screen, and nil when the failure was not made from an error (the tests, a screen built by hand).
    public let detail: String?

    /// The name of the site for the sentence: the host without its "www.", or the address itself when it has none.
    public var site: String {
        let host = AddressResolver.host(of: address)
        return host.isEmpty ? address : host
    }

    /// The address to load again when the person taps « Try again » (nil when the system gave none: nothing to retry).
    public var retryAddress: String? {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return address
    }

    /// Whether the address is a device of the local network (a name of that network or a private or link-local address), the Swift twin of
    /// `isLocalNetworkHost` in `src/shared/error-pages.ts`. The machine itself (`localhost`, a loopback address) is not the network.
    public var isLocalNetwork: Bool { Self.isLocalNetworkHost(AddressResolver.host(of: address).replacing(/:\d+$/, with: "")) }

    private static let notAnswering: [Kind] = [.offline, .cannotConnect, .timedOut, .hostNotFound, .connectionLost]

    /// A name that ends in `.local`: the system looks it up with multicast DNS.
    private var isDotLocalName: Bool { AddressResolver.host(of: address).replacing(/:\d+$/, with: "").lowercased().hasSuffix(".local") }

    /// Whether to remind the person that iOS may not let Lucium look up a `.local` name (and to offer the Settings of the application). Apple's technical
    /// note on local network privacy (TN3179) says the traffic of a `WKWebView` needs no permission but that resolving a local DNS name does, so the
    /// reminder is for such a name only: an IP address needs none, and the « Local Network » line of the Settings does not even exist for an application
    /// whose web views are the only thing that reached the network (card 684).
    public var suggestsLocalNetworkSettings: Bool { isDotLocalName && Self.notAnswering.contains(kind) }

    /// The `http://` address to offer on a failed or refused secure connection to a device of the person's own network (this machine or the local network):
    /// no certificate authority signs for such a device, and the traffic stays on the network. Nil for any other site, which is never sent back to http
    /// by this screen.
    public var httpAddress: String? {
        guard kind == .secureConnection || kind == .certificate, address.lowercased().hasPrefix("https://"), var components = URLComponents(string: address),
              let host = components.host else { return nil }
        let bare = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
        guard Self.isLocalNetworkHost(bare) || Self.isThisMachine(bare) else { return nil }
        components.scheme = "http"
        return components.string
    }

    private static func isThisMachine(_ host: String) -> Bool {
        let host = host.lowercased()
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return true }
        let groups = host.split(separator: ".", omittingEmptySubsequences: false)
        return groups.count == 4 && groups[0] == "127" && groups.allSatisfy { $0.count <= 3 && $0.allSatisfy { $0.isASCII && $0.isNumber } }
    }

    /// How long a load of a device of the local network waits for the device to answer, in seconds. WebKit waits 60 s by default, which is what a
    /// `.local` name that does not resolve costs (measured on the simulator: 61 s before « timed out »): a device of the person's own network answers
    /// in a second or two, and a long silence there is a refused « Local Network » permission or a device that is off. The limit is on silence, not on
    /// the whole load (`URLRequest.timeoutInterval`): a big page that keeps arriving is not cut. Nil for any other address.
    public static let localNetworkTimeout: TimeInterval = 15

    public static func requestTimeout(for address: String) -> TimeInterval? {
        isLocalNetworkHost(AddressResolver.host(of: address).replacing(/:\d+$/, with: "")) ? localNetworkTimeout : nil
    }

    static func isLocalNetworkHost(_ hostname: String) -> Bool {
        var host = hostname.lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.hasSuffix(".local") || host.hasSuffix(".lan") || host.hasSuffix(".home.arpa") { return true }
        let groups = host.split(separator: ".", omittingEmptySubsequences: false)
        if groups.count == 4, groups.allSatisfy({ (1...3).contains($0.count) && $0.allSatisfy { $0.isASCII && $0.isNumber } }),
           let a = Int(groups[0]), let b = Int(groups[1]) {
            return a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        return host.hasPrefix("fe80:") || (host.hasPrefix("fc") || host.hasPrefix("fd")) && host.contains(":")
    }

    public init(kind: Kind, address: String, detail: String? = nil) {
        self.kind = kind
        self.address = address
        self.detail = detail
    }

    /// Whether to suggest the IP address of the device: a `.local` name is looked up by the system with multicast DNS, which a phone can refuse to an
    /// application (the local network permission, a network that blocks multicast) while the same name works in Safari, and the IP address needs none of it.
    /// Only for a failure that looks like the name not being found or the device not answering.
    public var suggestsIpAddress: Bool { isDotLocalName && Self.notAnswering.contains(kind) }

    /// What « Change the address » puts back in the command bar: the address that failed, as the person typed it (no scheme, no closing slash), so that
    /// the name can be replaced by the IP address of the device while the port and the path stay (`homeassistant.local:8123/lovelace/0`). Nil when the
    /// system gave no http(s) address.
    public var editableAddress: String? {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        var text = String(address.dropFirst(scheme.count + 3))
        if text.hasSuffix("/") && text.filter({ $0 == "/" }).count == 1 { text.removeLast() }
        return text
    }

    /// The failure for an error, or nil when it is not one the person needs a screen for:
    /// - a load that was replaced, stopped or turned into a download (`NSURLErrorCancelled`, WebKit's "frame load interrupted" 102, "cannot show
    ///   this type" 100, "plug-in handled" 204) says nothing about the site;
    /// - an address the application cannot show (`NSURLErrorUnsupportedURL`, WebKit 101) is an app link, which `ExternalLink` takes;
    /// - a certificate WebKit refused after an upgrade of HTTPS first has its own prompt (`PrivacyNavigation` asks `HttpsUpgrades` first and only
    ///   comes here when no upgrade was under way); any other refused certificate is the `certificate` screen.
    public static func classify(domain: String, code: Int, failingAddress: String) -> LoadFailure? {
        let detail = "\(domain) \(code)"
        if domain == "WebKitErrorDomain" {
            return [100, 101, 102, 204].contains(code) ? nil : LoadFailure(kind: .other, address: failingAddress, detail: detail)
        }
        guard domain == NSURLErrorDomain else { return LoadFailure(kind: .other, address: failingAddress, detail: detail) }
        let kind: Kind
        switch code {
        case NSURLErrorCancelled, NSURLErrorUnsupportedURL: return nil
        case NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot,
             NSURLErrorServerCertificateNotYetValid:
            kind = .certificate
        case NSURLErrorNotConnectedToInternet, NSURLErrorInternationalRoamingOff, NSURLErrorCallIsActive, NSURLErrorDataNotAllowed: kind = .offline
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: kind = .hostNotFound
        case NSURLErrorTimedOut: kind = .timedOut
        case NSURLErrorCannotConnectToHost: kind = .cannotConnect
        case NSURLErrorNetworkConnectionLost: kind = .connectionLost
        case NSURLErrorHTTPTooManyRedirects, NSURLErrorRedirectToNonExistentLocation: kind = .tooManyRedirects
        case NSURLErrorBadURL: kind = .badAddress
        case NSURLErrorSecureConnectionFailed: kind = .secureConnection
        default: kind = .other
        }
        return LoadFailure(kind: kind, address: failingAddress, detail: detail)
    }

    /// The same, from the `NSError` of the delegate: the address comes from the error's own `userInfo`.
    public static func classify(_ error: NSError) -> LoadFailure? {
        let address = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.absoluteString
            ?? (error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? ""
        return classify(domain: error.domain, code: error.code, failingAddress: address)
    }
}
