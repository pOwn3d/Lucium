import LuciumKit
import SwiftUI
import XCTest
@testable import Lucium

/// The error screen has a sentence for every kind of failure, in both languages, and draws on a phone and on an iPad; a picture of each is written
/// when `LUCIUM_SHOTS` names a folder (`scripts/ios-check.sh` does).
@MainActor
final class LoadFailureViewTests: XCTestCase {
    func testEveryKindHasATitleAndASentenceInBothLanguages() throws {
        for language in ["en", "fr"] {
            let bundle = try XCTUnwrap(Bundle(path: try XCTUnwrap(Bundle.main.path(forResource: language, ofType: "lproj"))))
            for kind in LoadFailure.Kind.allCases {
                for key in ["loadfailure.\(kind.rawValue).title", "loadfailure.\(kind.rawValue).text %@"] {
                    XCTAssertNotEqual(bundle.localizedString(forKey: key, value: "MISSING", table: nil), "MISSING", "\(key) in \(language)")
                }
            }
            XCTAssertNotEqual(bundle.localizedString(forKey: "loadfailure.retry", value: "MISSING", table: nil), "MISSING")
        }
    }

    func testTheScreenDrawsOnAPhoneAndOnAnIPad() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the hosted tests run inside the application's scene")
        let shapes: [(String, CGSize)] = [("iphone", CGSize(width: 390, height: 844)), ("ipad", CGSize(width: 1024, height: 768))]
        let failures = [LoadFailure(kind: .offline, address: "https://www.example.org/a"), LoadFailure(kind: .hostNotFound, address: "https://exmple.org/"),
                        LoadFailure(kind: .timedOut, address: "https://example.org/")]
        for language in ["en", "fr"] {
            for (shape, size) in shapes {
                for failure in failures {
                    let controller = UIHostingController(rootView: LoadFailureView(failure: failure, retry: {}).environment(\.locale, Locale(identifier: language)))
                    let window = UIWindow(windowScene: scene)
                    window.frame = CGRect(origin: .zero, size: size)
                    window.rootViewController = controller
                    window.makeKeyAndVisible()
                    controller.view.layoutIfNeeded()
                    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.3))
                    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                    XCTAssertGreaterThan(image.size.width, 0)
                    if let folder = ProcessInfo.processInfo.environment["LUCIUM_SHOTS"], let png = image.pngData() {
                        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
                        try png.write(to: URL(fileURLWithPath: folder).appending(path: "lucium-ios-loadfailure-\(failure.kind.rawValue)-\(shape)-\(language).png"))
                    }
                    window.isHidden = true
                }
            }
        }
    }
}
