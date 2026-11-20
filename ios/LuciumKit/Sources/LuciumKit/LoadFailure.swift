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
        /// The site does not speak TLS properly (not a refused certificate, which has its own prompt).
        case secureConnection = "secure-connection"
        /// Anything else the system reports.
        case other
    }

    public let kind: Kind
    /// The address that could not be loaded, as the system reports it ("" when it did not say).
    public let address: String

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

    /// Whether to remind the person that iOS may not let Lucium reach the local network (and to offer the Settings of the application): the load of a
    /// device of that network failed in a way a refused permission looks like (the Mac says the same in `LOCAL_NETWORK_ERRORS`).
    public var suggestsLocalNetworkSettings: Bool {
        isLocalNetwork && [.offline, .cannotConnect, .timedOut, .hostNotFound, .connectionLost].contains(kind)
    }

    /// The `http://` address to offer on a failed secure connection to a device of the person's own network (this machine or the local network):
    /// no certificate authority signs for such a device, and the traffic stays on the network. Nil for any other site, which is never sent back to http
    /// by this screen.
    public var httpAddress: String? {
        guard kind == .secureConnection, address.lowercased().hasPrefix("https://"), var components = URLComponents(string: address),
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

    public init(kind: Kind, address: String) {
        self.kind = kind
        self.address = address
    }

    /// The failure for an error, or nil when it is not one the person needs a screen for:
    /// - a load that was replaced, stopped or turned into a download (`NSURLErrorCancelled`, WebKit's "frame load interrupted" 102, "cannot show
    ///   this type" 100, "plug-in handled" 204) says nothing about the site;
    /// - an address the application cannot show (`NSURLErrorUnsupportedURL`, WebKit 101) is an app link, which `ExternalLink` takes;
    /// - a certificate WebKit refused has its own prompt, and is left exactly as it was (`PrivacyNavigation`).
    public static func classify(domain: String, code: Int, failingAddress: String) -> LoadFailure? {
        if domain == "WebKitErrorDomain" {
            return [100, 101, 102, 204].contains(code) ? nil : LoadFailure(kind: .other, address: failingAddress)
        }
        guard domain == NSURLErrorDomain else { return LoadFailure(kind: .other, address: failingAddress) }
        let kind: Kind
        switch code {
        case NSURLErrorCancelled, NSURLErrorUnsupportedURL: return nil
        case NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot,
             NSURLErrorServerCertificateNotYetValid:
            return nil
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
        return LoadFailure(kind: kind, address: failingAddress)
    }

    /// The same, from the `NSError` of the delegate: the address comes from the error's own `userInfo`.
    public static func classify(_ error: NSError) -> LoadFailure? {
        let address = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.absoluteString
            ?? (error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? ""
        return classify(domain: error.domain, code: error.code, failingAddress: address)
    }
}
