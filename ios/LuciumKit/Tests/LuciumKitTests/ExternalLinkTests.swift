import XCTest
@testable import LuciumKit

final class ExternalLinkTests: XCTestCase {
    private func address(_ text: String) -> String? { URL(string: text).flatMap(ExternalLink.address(from:)) }

    func testPlainWebAddressesAreAccepted() {
        XCTAssertEqual(address("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c")
        XCTAssertEqual(address("http://example.com"), "http://example.com")
        XCTAssertEqual(address("HTTPS://Example.com/x"), "HTTPS://Example.com/x")
        XCTAssertEqual(address("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x")
    }

    func testEverythingButHttpAndHttpsIsRefused() {
        for text in ["file:///etc/hosts", "file://example.com/x", "javascript:alert(1)", "data:text/html,hi", "about:blank", "ftp://example.com/", "lucium://settings",
                     "tel:+33123456789", "mailto:a@b.c", "blob:https://example.com/x", "view-source:https://example.com"] {
            XCTAssertNil(address(text), text)
        }
    }

    func testAddressesWithoutHostOrWithCredentialsOrTooLongAreRefused() {
        XCTAssertNil(address("https:///path"))
        XCTAssertNil(address("https://user:pass@example.com/"))
        XCTAssertNil(address("https://bank.com@evil.example/"))
        XCTAssertNil(address("https://example.com/" + String(repeating: "a", count: ExternalLink.maxLength)))
    }
}
