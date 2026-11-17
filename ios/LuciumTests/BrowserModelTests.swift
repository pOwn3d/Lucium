import LuciumKit
import XCTest
@testable import Lucium

@MainActor
final class BrowserModelTests: XCTestCase {
    func testAnAddressBecomesARequestAndWordsBecomeASearch() throws {
        XCTAssertEqual(BrowserModel.request(for: "example.com")?.url?.absoluteString, "https://example.com")
        XCTAssertEqual(BrowserModel.request(for: "hello world")?.url?.absoluteString, "https://duckduckgo.com/?q=hello%20world")
        XCTAssertNil(BrowserModel.request(for: "   "))
    }

    func testEverySpaceHasItsOwnProfileAndItsOwnWebView() async throws {
        let model = BrowserModel.makeDefault()
        XCTAssertEqual(model.spaces.map(\.id), ["work", "home", "projects"])
        let work = model.webView
        let workStore = work.configuration.websiteDataStore.identifier
        model.selectSpace("home")
        let home = model.webView
        XCTAssertEqual(model.activeSpace.id, "home")
        XCTAssertFalse(work === home)
        XCTAssertNotNil(workStore)
        XCTAssertNotEqual(workStore, home.configuration.websiteDataStore.identifier, "two profiles must not share cookies")
        model.selectSpace("work")
        XCTAssertTrue(model.webView === work, "going back to a space returns to its own view")
    }

    func testTheTabsOfASpaceAreThoseOfItsSpace() {
        let model = BrowserModel.makeDefault()
        XCTAssertEqual(model.activeTabs.map(\.id), ["t1"])
        model.selectSpace("home")
        XCTAssertEqual(model.activeTabs.map(\.id), ["t2"])
        model.selectSpace("projects")
        XCTAssertTrue(model.activeTabs.isEmpty)
    }

    /// A blocker that cannot be built must not stop browsing, and must not pass unnoticed.
    func testABlockerThatFailsToBuildIsReportedAndBrowsingGoesOn() async throws {
        struct NoRules: Error {}
        let defaults = BrowserModel.makeDefault()
        let model = BrowserModel(state: defaults.state, styles: [:], dataStoreIDs: [:], rules: { throw NoRules() })
        await model.prepare()
        XCTAssertTrue(model.blockerFailure is NoRules)
        XCTAssertNotNil(model.webView, "the view is still there, unfiltered")

        let healthy = BrowserModel.makeDefault()
        await healthy.prepare()
        XCTAssertNil(healthy.blockerFailure)
    }
}
