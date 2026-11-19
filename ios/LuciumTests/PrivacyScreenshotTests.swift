import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// The privacy pages, drawn off screen in the test host (no window is shown: the simulator runs in the background), in both languages, both schemes and
/// at a large text size. Each is checked to draw something; with `LUCIUM_SCREENSHOTS_DIR` set (`TEST_RUNNER_LUCIUM_SCREENSHOTS_DIR` for `xcodebuild`)
/// each is also written as a PNG, to look at.
@MainActor
final class PrivacyScreenshotTests: XCTestCase {
    private func model(_ change: (inout PrivacySettings) -> Void = { _ in }) async -> BrowserModel {
        let model = BrowserModel(state: BrowserModel.defaultState())
        await model.prepare()
        model.updatePrivacy(change)
        return model
    }

    private func draw<V: View>(_ view: V) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: view)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(900))
        return UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    }

    private func distinctColours(in image: UIImage) throws -> Int {
        let cg = try XCTUnwrap(image.cgImage)
        let width = 40, height = 80
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Set(stride(from: 0, to: pixels.count, by: 4).map { "\(pixels[$0] / 8),\(pixels[$0 + 1] / 8),\(pixels[$0 + 2] / 8)" }).count
    }

    private func check(_ name: String, _ image: UIImage, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertGreaterThan(try distinctColours(in: image), 6, "\(name) drew (almost) nothing", file: file, line: line)
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "\(name).png"))
    }

    private func page<V: View>(_ language: String, _ view: V) -> some View {
        NavigationStack { view }.environment(\.locale, Locale(identifier: language))
    }

    func testThePrivacyPageInBothLanguagesAndSchemes() async throws {
        let model = await model()
        for language in ["fr", "en"] {
            try check("privacy-\(language)-light", try await draw(page(language, PrivacyForm(model: model)).preferredColorScheme(.light)))
            try check("privacy-\(language)-dark", try await draw(page(language, PrivacyForm(model: model)).preferredColorScheme(.dark)))
        }
        try check("privacy-fr-large-text", try await draw(page("fr", PrivacyForm(model: model)).environment(\.dynamicTypeSize, .accessibility3)))
    }

    func testTheStrictLevelAndACustomOne() async throws {
        let strict = await model { $0.choose(.strict) }
        try check("privacy-strict-fr", try await draw(page("fr", PrivacyForm(model: strict))))
        let custom = await model { $0.blockAds = false }
        try check("privacy-custom-fr", try await draw(page("fr", PrivacyForm(model: custom))))
    }

    func testTheListsOfSites() async throws {
        let model = await model {
            $0.blockExceptions = ["example.org", "mon-site.example"]
            $0.clearOnClose = .init(enabled: true, sites: ["banque.example", "localhost:3000"], onQuit: true)
        }
        for language in ["fr", "en"] {
            try check("exceptions-\(language)", try await draw(page(language, BlockExceptionsPage(model: model))))
            try check("clear-\(language)", try await draw(page(language, ClearOnClosePage(model: model))))
        }
        let empty = await self.model()
        try check("exceptions-empty-fr", try await draw(page("fr", BlockExceptionsPage(model: empty))))
        try check("exceptions-fr-large-text", try await draw(page("fr", BlockExceptionsPage(model: model)).environment(\.dynamicTypeSize, .accessibility3)))
        try check("clear-fr-dark", try await draw(page("fr", ClearOnClosePage(model: model)).preferredColorScheme(.dark)))
    }
}
