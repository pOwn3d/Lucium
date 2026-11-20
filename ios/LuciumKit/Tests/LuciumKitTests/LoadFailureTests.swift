import Foundation
import XCTest
@testable import LuciumKit

final class LoadFailureTests: XCTestCase {
    private func kind(_ code: Int, domain: String = NSURLErrorDomain) -> LoadFailure.Kind? {
        LoadFailure.classify(domain: domain, code: code, failingAddress: "https://example.org/a")?.kind
    }

    func testEachNetworkFailureGetsItsOwnKind() {
        XCTAssertEqual(kind(NSURLErrorNotConnectedToInternet), .offline)
        XCTAssertEqual(kind(NSURLErrorDataNotAllowed), .offline)
        XCTAssertEqual(kind(NSURLErrorCannotFindHost), .hostNotFound)
        XCTAssertEqual(kind(NSURLErrorDNSLookupFailed), .hostNotFound)
        XCTAssertEqual(kind(NSURLErrorTimedOut), .timedOut)
        XCTAssertEqual(kind(NSURLErrorCannotConnectToHost), .cannotConnect)
        XCTAssertEqual(kind(NSURLErrorNetworkConnectionLost), .connectionLost)
        XCTAssertEqual(kind(NSURLErrorHTTPTooManyRedirects), .tooManyRedirects)
        XCTAssertEqual(kind(NSURLErrorBadURL), .badAddress)
        XCTAssertEqual(kind(NSURLErrorSecureConnectionFailed), .secureConnection)
        XCTAssertEqual(kind(NSURLErrorResourceUnavailable), .other)
        XCTAssertEqual(kind(7, domain: "SomeOtherDomain"), .other)
    }

    func testACancelledLoadAndAnAppLinkGetNoScreen() {
        XCTAssertNil(kind(NSURLErrorCancelled), "a replaced or stopped load says nothing about the site")
        XCTAssertNil(kind(NSURLErrorUnsupportedURL), "an app link is taken by ExternalLink")
        for code in [100, 101, 102, 204] { XCTAssertNil(kind(code, domain: "WebKitErrorDomain"), "WebKit \(code)") }
        XCTAssertNotNil(kind(103, domain: "WebKitErrorDomain"))
    }

    /// A refused certificate on an address the person asked for directly used to give no screen at all: a blank page (card 684, a Home Assistant with
    /// a certificate of its own). The prompt of an upgrade of HTTPS first is another path (`HttpsUpgrades.failed`), which never comes here.
    func testARefusedCertificateGetsItsOwnScreen() {
        for code in [NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid] {
            XCTAssertEqual(kind(code), .certificate, "\(code)")
        }
    }

    func testARefusedCertificateOfAHomeDeviceOffersHttpAndNoOtherSiteDoes() {
        XCTAssertEqual(failure(.certificate, "https://homeassistant.local:8123/").httpAddress, "http://homeassistant.local:8123/")
        XCTAssertEqual(failure(.certificate, "https://192.168.1.20:8123/").httpAddress, "http://192.168.1.20:8123/")
        XCTAssertNil(failure(.certificate, "https://example.org/").httpAddress, "a public site is never sent back to http")
    }

    /// WebKit waits 60 s for a device that does not answer, which is what a `.local` name that does not resolve costs (61 s measured on the
    /// simulator): the devices of the person's network get a shorter wait, every other address keeps WebKit's.
    func testADeviceOfTheLocalNetworkGetsAShorterWait() {
        for address in ["http://homeassistant.local:8123/", "http://192.168.1.20:8123/lovelace", "https://nas.lan/", "http://10.0.0.5/", "http://[fd12::1]:8123/"] {
            XCTAssertEqual(LoadFailure.requestTimeout(for: address), LoadFailure.localNetworkTimeout, address)
        }
        XCTAssertLessThan(LoadFailure.localNetworkTimeout, 60)
        for address in ["https://example.org/", "http://8.8.8.8/", "http://local.example.com/", "http://localhost:3000/", "javascript:alert(1)", ""] {
            XCTAssertNil(LoadFailure.requestTimeout(for: address), address)
        }
    }

    func testTheSiteAndTheAddressToRetryComeFromTheFailingAddress() throws {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                            userInfo: [NSURLErrorFailingURLErrorKey: URL(string: "https://www.example.org:8443/a?b=1")!])
        let failure = try XCTUnwrap(LoadFailure.classify(error))
        XCTAssertEqual(failure.site, "example.org:8443")
        XCTAssertEqual(failure.retryAddress, "https://www.example.org:8443/a?b=1")
        XCTAssertNil(LoadFailure(kind: .other, address: "").retryAddress, "no address, nothing to retry")
        XCTAssertNil(LoadFailure(kind: .other, address: "javascript:alert(1)").retryAddress, "only http(s) is retried")
    }
    // MARK: The local network (a home-automation UI, a NAS, a printer)

    private func failure(_ kind: LoadFailure.Kind, _ address: String) -> LoadFailure { LoadFailure(kind: kind, address: address) }

    func testADeviceOfTheLocalNetworkIsToldFromTheOthers() {
        for address in ["http://192.168.1.20:8123/", "http://10.0.0.5/", "http://172.16.3.4:80/", "http://169.254.1.1/", "http://homeassistant.local:8123/",
                        "http://nas.lan/", "http://router.home.arpa/", "http://[fe80::1]:8123/", "http://[fd12::1]/"] {
            XCTAssertTrue(failure(.cannotConnect, address).isLocalNetwork, address)
        }
        for address in ["https://example.org/", "http://127.0.0.1:8123/", "http://localhost:3000/", "http://172.32.0.1/", "http://8.8.8.8/", "https://local.example.com/"] {
            XCTAssertFalse(failure(.cannotConnect, address).isLocalNetwork, address)
        }
    }

    /// TN3179: web view traffic needs no local network permission, resolving a `.local` name does. An IP address never gets the reminder (the Settings line
    /// does not exist for an application that never asked), which would send the person looking for a switch that is not there.
    func testTheSettingsAreSuggestedForAnUnansweredDotLocalNameOnly() {
        for kind in [LoadFailure.Kind.offline, .cannotConnect, .timedOut, .hostNotFound, .connectionLost] {
            XCTAssertTrue(failure(kind, "http://homeassistant.local:8123/").suggestsLocalNetworkSettings, "\(kind)")
            XCTAssertFalse(failure(kind, "http://192.168.1.20:8123/").suggestsLocalNetworkSettings, "an IP address needs no permission: \(kind)")
            XCTAssertFalse(failure(kind, "https://example.org/").suggestsLocalNetworkSettings, "a public site: \(kind)")
            XCTAssertFalse(failure(kind, "http://127.0.0.1:8123/").suggestsLocalNetworkSettings, "this machine: \(kind)")
        }
        XCTAssertFalse(failure(.tooManyRedirects, "http://homeassistant.local/").suggestsLocalNetworkSettings, "the device answered")
        XCTAssertFalse(failure(.secureConnection, "https://homeassistant.local/").suggestsLocalNetworkSettings, "the device answered")
    }

    func testAFailedSecureConnectionToAHomeDeviceOffersHttp() {
        XCTAssertEqual(failure(.secureConnection, "https://homeassistant.local:8123/lovelace?x=1").httpAddress, "http://homeassistant.local:8123/lovelace?x=1")
        XCTAssertEqual(failure(.secureConnection, "https://192.168.1.20:8123/").httpAddress, "http://192.168.1.20:8123/")
        XCTAssertEqual(failure(.secureConnection, "https://localhost:3000/").httpAddress, "http://localhost:3000/")
        XCTAssertEqual(failure(.secureConnection, "https://[fd12::1]:8123/").httpAddress, "http://[fd12::1]:8123/")
    }

    func testNoOtherSiteIsEverSentBackToHttpByTheScreen() {
        XCTAssertNil(failure(.secureConnection, "https://example.org/").httpAddress, "a public site")
        XCTAssertNil(failure(.secureConnection, "https://8.8.8.8/").httpAddress, "a public address")
        XCTAssertNil(failure(.secureConnection, "https://local.example.com/").httpAddress, "a name that only contains local")
        XCTAssertNil(failure(.cannotConnect, "https://192.168.1.20/").httpAddress, "only a failed TLS handshake")
        XCTAssertNil(failure(.secureConnection, "http://192.168.1.20/").httpAddress, "already http")
        XCTAssertNil(failure(.secureConnection, "").httpAddress)
    }

    /// Card 684: on a phone nothing says why a page does not load, so the screen carries what the system said.
    func testTheFailureKeepsWhatTheSystemSaid() throws {
        let timedOut = try XCTUnwrap(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, failingAddress: "http://192.168.1.20:8123/"))
        XCTAssertEqual(timedOut.detail, "NSURLErrorDomain -1001")
        XCTAssertEqual(LoadFailure.classify(domain: "WebKitErrorDomain", code: 103, failingAddress: "http://a/")?.detail, "WebKitErrorDomain 103")
        XCTAssertNil(LoadFailure(kind: .other, address: "").detail)
    }

    func testAnIpAddressIsSuggestedForADotLocalNameThatDoesNotAnswerOnly() {
        for kind in [LoadFailure.Kind.timedOut, .hostNotFound, .cannotConnect, .connectionLost, .offline] {
            XCTAssertTrue(failure(kind, "http://homeassistant.local:8123/").suggestsIpAddress, "\(kind)")
        }
        XCTAssertFalse(failure(.timedOut, "http://192.168.1.20:8123/").suggestsIpAddress, "already an IP address")
        XCTAssertFalse(failure(.timedOut, "https://local.example.com/").suggestsIpAddress, "a public name that contains local")
        XCTAssertFalse(failure(.certificate, "https://homeassistant.local:8123/").suggestsIpAddress, "the device answered")
        XCTAssertFalse(failure(.secureConnection, "https://homeassistant.local:8123/").suggestsIpAddress, "the device answered")
    }
}
