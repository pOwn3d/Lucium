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

    func testARefusedCertificateKeepsItsOwnPromptAndGetsNoScreen() {
        for code in [NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid] {
            XCTAssertNil(kind(code), "\(code)")
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
}
