import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// Card 672 on the real application: the accent that views draw is the one of the space they are in, in both schemes, and the screens that use it are drawn
/// off screen (no window is shown) with a green space and a red one; with `LUCIUM_SCREENSHOTS_DIR` set each drawing is written as a PNG.
@MainActor
final class SpaceAccentTests: XCTestCase {
    private func space(hue: Double) -> Space {
        Space(id: "s", name: "S", emoji: "✨", profileId: "default", rest: ["theme": SpaceTheme.make(hue: hue)])
    }

    private func draw<V: View>(_ view: V, size: CGSize, scheme: ColorScheme) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = UIHostingController(rootView: view.preferredColorScheme(scheme))
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(600))
        let bounds = CGRect(origin: .zero, size: size)
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in window.drawHierarchy(in: bounds, afterScreenUpdates: true) }
    }

    private func pixel(of image: UIImage, at point: CGPoint) throws -> HexColor {
        let cg = try XCTUnwrap(image.cgImage)
        let cropped = try XCTUnwrap(cg.cropping(to: CGRect(x: point.x * image.scale, y: point.y * image.scale, width: 1, height: 1)))
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return HexColor(red: Int(bytes[0]), green: Int(bytes[1]), blue: Int(bytes[2]))
    }

    private func save(_ image: UIImage, _ name: String) throws {
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData()).write(to: directory.appending(path: "accent-\(name).png"))
    }

    /// The fill a view draws with `.accentFill` is, to within the rounding of the display, the colour `SpaceAccent` works out for the hue and the scheme.
    func testTheFillTakesTheHueOfTheSpaceAndTheScheme() async throws {
        for (hue, dark) in [(130.0, false), (130.0, true), (345.0, false), (345.0, true)] {
            let probe = Rectangle().fill(.accentFill).ignoresSafeArea().spaceAccent(of: space(hue: hue))
            let image = try await draw(probe, size: CGSize(width: 200, height: 200), scheme: dark ? .dark : .light)
            let drawn = try pixel(of: image, at: CGPoint(x: 100, y: 100))
            let wanted = SpaceAccent.accent(hue: SpaceTheme.hue(of: space(hue: hue))!, dark: dark)
            for (a, b) in [(drawn.red, wanted.red), (drawn.green, wanted.green), (drawn.blue, wanted.blue)] {
                XCTAssertLessThanOrEqual(abs(a - b), 3, "hue \(hue), dark \(dark): drew \(drawn.text), wanted \(wanted.text)")
            }
        }
    }

    /// The sheet of tabs, whose "New tab" button is the accent, in a green space and in a red one, in both schemes.
    func testTheTabsSheetWearsTheAccentOfItsSpace() async throws {
        for (name, hue) in [("green", 130.0), ("red", 5.0)] {
            var state = BrowserModel.defaultState()
            state.spaces[0].rest["theme"] = SpaceTheme.make(hue: hue)
            let model = BrowserModel(state: state, clock: { 1_790_000_000_000 })
            await model.prepare()
            for dark in [false, true] {
                let image = try await draw(TabsSheet(model: model).spaceAccent(of: model.activeSpace), size: CGSize(width: 393, height: 852), scheme: dark ? .dark : .light)
                XCTAssertGreaterThan(image.size.width, 0)
                try save(image, "tabs-\(name)-\(dark ? "dark" : "light")")
            }
        }
    }
}
