import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// The sheet of bookmarks and "Read later", the row of the sheet of tabs and the menu's line, drawn with real data. Without `LUCIUM_SCREENSHOTS_DIR` the test
/// only proves that something is drawn; with it (as `TEST_RUNNER_LUCIUM_SCREENSHOTS_DIR`) the pictures are written there, in the language of the run.
@MainActor
final class KeptScreenshotTests: XCTestCase {
    private static let phone = CGSize(width: 393, height: 852)
    private static let pad = CGSize(width: 820, height: 1180)

    private func model(filled: Bool) async -> BrowserModel {
        var state = BrowserModel.defaultState()
        if filled {
            let pages: [(String, String)] = [("Guide de Swift", "swift.example"), ("Tarte aux pommes", "cuisine.example"), ("Vélo en ville", "velo.example"),
                                             ("The long read of the week", "article.example")]
            for (index, page) in pages.enumerated() {
                state.addBookmark(id: "b\(index)", url: "https://\(page.1)/page", title: page.0, now: 1_790_000_000_000 - Double(index) * 86_400_000)
                state.addReadLater(id: "r\(index)", url: "https://\(page.1)/lire", title: page.0, now: 1_790_000_000_000 - Double(index) * 3 * 86_400_000)
            }
            var marks = state.bookmarks
            marks[0].tags = ["code", "référence"]
            marks[2].tags = ["code"]
            state.bookmarks = marks
        }
        let model = BrowserModel(state: state, clock: { 1_790_000_000_000 })
        await model.prepare()
        return model
    }

    private func draw<V: View>(_ view: V, size: CGSize, regular: Bool, scheme: ColorScheme = .light, textSize: DynamicTypeSize = .large) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let framed = view
            .environment(\.horizontalSizeClass, regular ? .regular : .compact)
            .environment(\.verticalSizeClass, .regular)
            .environment(\.dynamicTypeSize, textSize)
            .preferredColorScheme(scheme)
        window.rootViewController = UIHostingController(rootView: framed)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(900))
        let bounds = CGRect(origin: .zero, size: size)
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in window.drawHierarchy(in: bounds, afterScreenUpdates: true) }
    }

    private func colours(in image: UIImage) throws -> Int {
        let cg = try XCTUnwrap(image.cgImage)
        let width = 80, height = 120
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.interpolationQuality = .none
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Set(stride(from: 0, to: pixels.count, by: 4).map { "\(pixels[$0] / 8),\(pixels[$0 + 1] / 8),\(pixels[$0 + 2] / 8)" }).count
    }

    private func check(_ name: String, _ image: UIImage, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertGreaterThan(try colours(in: image), 8, "\(name) drew (almost) nothing", file: file, line: line)
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let language = Bundle.main.preferredLocalizations.first ?? "xx"
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "kept-\(name)-\(language).png"))
    }

    func testTheSheetOnAPhoneAndAnIPad() async throws {
        let model = await model(filled: true)
        for list in [KeptList.bookmarks, .readLater] {
            model.keptList = list
            let name = list == .bookmarks ? "bookmarks" : "later"
            try check("iphone-\(name)", try await draw(KeptPagesScreen(model: model), size: Self.phone, regular: false))
            try check("iphone-\(name)-dark", try await draw(KeptPagesScreen(model: model), size: Self.phone, regular: false, scheme: .dark))
            try check("ipad-\(name)", try await draw(KeptPagesScreen(model: model), size: Self.pad, regular: true))
        }
    }

    func testTheSheetWithTheLargestTextAndWithNothingKept() async throws {
        let filled = await model(filled: true)
        filled.keptList = .bookmarks
        try check("iphone-large-text", try await draw(KeptPagesScreen(model: filled), size: Self.phone, regular: false, textSize: .accessibility3))
        let empty = await model(filled: false)
        empty.keptList = .bookmarks
        try check("iphone-bookmarks-empty", try await draw(KeptPagesScreen(model: empty), size: Self.phone, regular: false))
        empty.keptList = .readLater
        try check("iphone-later-empty", try await draw(KeptPagesScreen(model: empty), size: Self.phone, regular: false))
    }

    func testTheSheetOfTabsOffersTheListsAndTheLineTellsWhatHappened() async throws {
        let model = await model(filled: true)
        model.keepNotice = .readLaterSaved
        try check("iphone-tabs-row", try await draw(TabsSheet(model: model), size: Self.phone, regular: false))
        try check("iphone-banner", try await draw(VStack { KeepBanner(model: model); Spacer() }, size: CGSize(width: 393, height: 160), regular: false))
    }
}
