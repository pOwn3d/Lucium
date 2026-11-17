import LuciumKit
import SwiftUI
import XCTest
@testable import Lucium

@MainActor
final class LicensesTests: XCTestCase {
    func testTheTextsOfTheProjectLicenceAreInTheApplication() throws {
        for text in LicenseText.allCases {
            let contents = try XCTUnwrap(text.contents(), "\(text.resource) must be in the application: it is shown on the licences screen")
            XCTAssertGreaterThan(contents.count, 500, text.resource)
        }
        XCTAssertTrue(try XCTUnwrap(LicenseText.license.contents()).contains("GNU GENERAL PUBLIC LICENSE"))
        let permission = try XCTUnwrap(LicenseText.permission.contents())
        XCTAssertTrue(permission.contains("App Store"))
        // The notice carries the permission in full (src/main/about-files.test.ts keeps the two equal on the Mac's side).
        XCTAssertTrue(try XCTUnwrap(LicenseText.notice.contents()).contains("App Store"))
    }

    func testAMissingTextIsReportedNotInvented() {
        XCTAssertNil(LicenseText.license.contents(in: Bundle(for: NSObject.self)))
    }

    /// The screen draws a list under its title with its author, licence, source and date, in the language it is given; a picture of it, in each
    /// language, is written when `LUCIUM_SHOTS` names a folder (`scripts/ios-check.sh` does), for the person who reads the captures.
    func testTheLicencesScreenDrawsTheListsOfTheRegistry() throws {
        let lists = try XCTUnwrap(EmbeddedLists.load(in: Bundle(for: Self.self)))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the hosted tests run inside the application's scene")
        for language in ["en", "fr"] {
            let controller = UIHostingController(rootView: LicensesSheet(lists: lists).environment(\.locale, Locale(identifier: language)))
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            controller.view.layoutIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 1))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            XCTAssertGreaterThan(image.size.width, 0)
            if let folder = ProcessInfo.processInfo.environment["LUCIUM_SHOTS"], let png = image.pngData() {
                try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
                try png.write(to: URL(fileURLWithPath: folder).appending(path: "lucium-ios-licenses-\(language).png"))
            }
            window.isHidden = true
        }
    }
}
