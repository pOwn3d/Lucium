import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// The start page of a blank tab, drawn off screen in the test host (no window is shown: the simulator runs in the background) at the size of a
/// phone and of an iPad, in both schemes, with the largest text, with no favourite and in a private tab. They prove each layout builds, lays out
/// and draws the colours of the space and not a blank page; with `LUCIUM_SCREENSHOTS_DIR` set each drawing is also written as a PNG, to be read
/// (docs/ios.md, "La page de démarrage"). The accessibility tree is not published in a process nobody listens to, so what is read is the picture.
@MainActor
final class StartPageScreenshotTests: XCTestCase {
    static let phone = CGSize(width: 393, height: 852)  // iPhone 17 Pro
    static let padPortrait = CGSize(width: 820, height: 1180)  // iPad Air 11-inch
    static let padLandscape = CGSize(width: 1180, height: 820)

    private static let sites = [("Agenda de la semaine", "agenda.example"), ("Guide de style", "guide.example"), ("Bibliothèque", "biblio.example"),
                                ("Musée", "musee.example"), ("Météo", "meteo.example"), ("Recettes de saison", "recettes.example")]

    /// The first space on a blank tab, with `favorites` favourites in its profile (six make a second row of two).
    private func model(favorites: Int, isPrivate: Bool = false) async -> BrowserModel {
        var state = BrowserModel.defaultState()
        for (index, site) in Self.sites.prefix(favorites).enumerated() {
            state.addFavorite(id: "fav\(index)", url: "https://\(site.1)/", title: site.0, in: "work")
        }
        let model = BrowserModel(state: state, clock: { 1_790_000_000_000 })
        await model.prepare()
        if isPrivate { model.newPrivateTab() }
        return model
    }

    private func draw<V: View>(_ view: V, size: CGSize, regular: Bool, scheme: ColorScheme = .light, textSize: DynamicTypeSize = .large) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let framed = view
            .environment(\.horizontalSizeClass, regular ? .regular : .compact)
            .environment(\.verticalSizeClass, size.height > size.width || regular ? .regular : .compact)
            .environment(\.dynamicTypeSize, textSize)
            .preferredColorScheme(scheme)
        window.rootViewController = UIHostingController(rootView: framed)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(900))
        let bounds = CGRect(origin: .zero, size: size)
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in window.drawHierarchy(in: bounds, afterScreenUpdates: true) }
    }

    /// The colour of a point (in points) of a picture.
    private func colour(of image: UIImage, at point: CGPoint) throws -> (red: Int, green: Int, blue: Int) {
        let cg = try XCTUnwrap(image.cgImage)
        let cropped = try XCTUnwrap(cg.cropping(to: CGRect(x: point.x * image.scale, y: point.y * image.scale, width: 1, height: 1)))
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
    }

    /// How many different colours a few thousand points of the picture have: a blank or a black picture has one.
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
        XCTAssertGreaterThan(try colours(in: image), 12, "\(name) drew (almost) nothing", file: file, line: line)
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let language = Bundle.main.preferredLocalizations.first ?? "xx"
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "start-\(name)-\(language).png"))
    }

    /// The page is not the white of a web view: at the edge of the page, between the tiles and the screen's edge, the colours of the space show.
    private func assertTinted(_ image: UIImage, _ size: CGSize, file: StaticString = #filePath, line: UInt = #line) throws {
        let probe = try colour(of: image, at: CGPoint(x: 4, y: size.height * 0.3))
        XCTAssertTrue(probe.red < 250 || probe.green < 250 || probe.blue < 250, "the start page lies on the colours of the space, not on a white ground (\(probe))", file: file, line: line)
    }

    func testTheStartPageOnAPhoneAndOnAnIPadInBothSchemes() async throws {
        let model = await model(favorites: 6)
        XCTAssertTrue(model.activeTab?.isBlank == true)
        for (device, size, regular) in [("iphone", Self.phone, false), ("ipad", Self.padPortrait, true)] {
            let light = try await draw(BrowserScreen(model: model), size: size, regular: regular)
            try check("\(device)-light", light)
            try assertTinted(light, size)
            try check("\(device)-dark", try await draw(BrowserScreen(model: model), size: size, regular: regular, scheme: .dark))
        }
    }

    /// An iPad held in landscape draws the page on its card beside the sidebar, which lists the same favourites.
    func testTheStartPageOnTheCardOfTheIPadInLandscape() async throws {
        let model = await model(favorites: 6)
        try check("ipad-landscape", try await draw(BrowserScreen(model: model), size: Self.padLandscape, regular: true))
    }

    func testTheStartPageWithTheLargestTextAndWithNoFavourite() async throws {
        let withFavorites = await model(favorites: 6)
        try check("iphone-large-text", try await draw(BrowserScreen(model: withFavorites), size: Self.phone, regular: false, textSize: .accessibility3))
        let none = await model(favorites: 0)
        XCTAssertEqual(none.startPage, .noFavorites)
        try check("iphone-no-favourite", try await draw(BrowserScreen(model: none), size: Self.phone, regular: false))
        try check("iphone-no-favourite-dark", try await draw(BrowserScreen(model: none), size: Self.phone, regular: false, scheme: .dark))
    }

    func testTheStartPageOfAPrivateTab() async throws {
        let model = await model(favorites: 6, isPrivate: true)
        XCTAssertEqual(model.startPage, .privateTab)
        try check("iphone-private", try await draw(BrowserScreen(model: model), size: Self.phone, regular: false))
    }
}
