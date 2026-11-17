import XCTest
@testable import Lucium

/// Every text is in French and in English (AGENTS.md, section 3). The catalogue is checked key by key by `src/shared/ios-contract.test.ts`;
/// this checks that what the build produced really carries both languages, and that the screen reads them.
final class LocalizationTests: XCTestCase {
    private func bundle(_ language: String) throws -> Bundle {
        let path = try XCTUnwrap(Bundle.main.path(forResource: language, ofType: "lproj"), "\(language).lproj is missing from the application")
        return try XCTUnwrap(Bundle(path: path))
    }

    func testTheApplicationCarriesFrenchAndEnglish() {
        XCTAssertTrue(Bundle.main.localizations.contains("fr"))
        XCTAssertTrue(Bundle.main.localizations.contains("en"))
    }

    func testTheSameKeyReadsDifferentlyInEachLanguage() throws {
        for key in ["bar.back", "tabs.new", "start.title", "space.work"] {
            let english = String(localized: String.LocalizationValue(key), bundle: try bundle("en"))
            let french = String(localized: String.LocalizationValue(key), bundle: try bundle("fr"))
            XCTAssertNotEqual(english, key, "\(key) has no English text")
            XCTAssertNotEqual(french, key, "\(key) has no French text")
            XCTAssertNotEqual(english, french, "\(key) is the same in both languages")
        }
    }

    func testTheStartPageIsBuiltFromTheCatalogue() throws {
        let page = StartPage.html(bundle: try bundle("fr"))
        XCTAssertTrue(page.contains("Lucium pour iPhone"))
    }
}
