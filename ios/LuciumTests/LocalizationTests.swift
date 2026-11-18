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
        for key in ["bar.back", "tabs.new", "start.favorites.empty", "space.work"] {
            let english = String(localized: String.LocalizationValue(key), bundle: try bundle("en"))
            let french = String(localized: String.LocalizationValue(key), bundle: try bundle("fr"))
            XCTAssertNotEqual(english, key, "\(key) has no English text")
            XCTAssertNotEqual(french, key, "\(key) has no French text")
            XCTAssertNotEqual(english, french, "\(key) is the same in both languages")
        }
    }

    /// The start page is drawn by SwiftUI and reads its three texts from the catalogue: the sentence at its foot is the one the project lead chose.
    func testTheStartPageSentencesAreInBothLanguages() throws {
        func text(_ key: String, _ language: String) throws -> String { String(localized: String.LocalizationValue(key), bundle: try bundle(language)) }
        XCTAssertEqual(try text("start.privacy", "fr"), "Rien ne quitte cet appareil.")
        XCTAssertEqual(try text("start.privacy", "en"), "Nothing leaves this device.")
        XCTAssertEqual(try text("bar.address.placeholder", "fr"), "Rechercher ou saisir une adresse")
        XCTAssertEqual(try text("bar.address.placeholder", "en"), "Search or enter an address")
        XCTAssertTrue(try text("start.favorites.empty", "fr").contains("Ajouter aux favoris"), "it names the command the sheet's menu offers")
        XCTAssertTrue(try text("start.favorites.empty", "en").contains("Add to favorites"))
    }
}

/// A count is one key with a text for each plural form: the system picks the one a language needs (French reads 0 as one, English as many).
final class PluralLocalizationTests: XCTestCase {
    private func bundle(_ language: String) throws -> Bundle {
        let path = try XCTUnwrap(Bundle.main.path(forResource: language, ofType: "lproj"), "\(language).lproj is missing from the application")
        return try XCTUnwrap(Bundle(path: path))
    }

    func testACountIsReadInTheFormTheLanguageNeeds() throws {
        let english = try bundle("en")
        let french = try bundle("fr")
        // The rule of the plural is the one of the locale given, not the one of the device the test runs on.
        let en = Locale(identifier: "en"), fr = Locale(identifier: "fr")
        func tabs(_ count: Int, _ bundle: Bundle, _ locale: Locale) -> String { String(localized: "folder.tabs \(count)", bundle: bundle, locale: locale) }
        XCTAssertEqual([0, 1, 2].map { tabs($0, english, en) }, ["0 tabs", "1 tab", "2 tabs"])
        XCTAssertEqual([0, 1, 2].map { tabs($0, french, fr) }, ["0 onglet", "1 onglet", "2 onglets"])
        XCTAssertEqual(String(localized: "tabs.search.results \(1)", bundle: french, locale: fr), "1 résultat")
        XCTAssertEqual(String(localized: "archive.count \(3)", bundle: english, locale: en), "3 tabs")
    }
}
