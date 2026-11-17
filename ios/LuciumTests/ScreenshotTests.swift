import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// The screens of the mockups, drawn off screen in the test host (no window is shown: the simulator runs in the background). They prove each screen
/// builds, lays out and draws something with real data; with `LUCIUM_SCREENSHOTS_DIR` set (give it as `TEST_RUNNER_LUCIUM_SCREENSHOTS_DIR` to
/// `xcodebuild`) each one is also written as a PNG, to be set beside the mockups.
@MainActor
final class ScreenshotTests: BrowserCoreTestCase {
    /// A space with what the mockups show: two favourites rows of tiles, pinned tabs and folders, Today, an archive.
    private func seededModel() async -> BrowserModel {
        let now = 1_790_000_000_000.0
        var state = BrowserModel.defaultState()
        func open(_ id: String, _ title: String, _ host: String, space: String = "work", at: Double) {
            state.openTab(id: id, in: space, url: "https://\(host)/", title: title, now: at)
        }
        open("mosaic", "Mosaïque — Tableau", "projet.example", at: now - 9)
        open("notebook", "Carnet de notes", "carnet.example", at: now - 8)
        open("meeting1", "Réunion du lundi", "reunions.example", at: now - 7)
        open("meeting2", "Compte rendu", "notes.example", at: now - 6)
        open("docs1", "Guide de style", "docs.example", at: now - 5)
        open("docs2", "Référence", "reference.example", at: now - 4)
        open("weather", "Météo de la semaine", "meteo.example", at: now - 3)
        open("files", "Bien nommer ses fichiers", "lecture.example", at: now - 2)
        for id in ["mosaic", "notebook"] { state.pin(tabId: id) }
        if let meetings = state.createFolder(id: "f-meetings", name: "Réunions", fallbackName: "?", in: "work"),
           let docs = state.createFolder(id: "f-docs", name: "Documentation", fallbackName: "?", in: "work") {
            for id in ["meeting1", "meeting2"] { state.move(tabId: id, toFolder: meetings.id) }
            for id in ["docs1", "docs2"] { state.move(tabId: id, toFolder: docs.id) }
        }
        for (index, entry) in [("Agenda de la semaine", "agenda.example"), ("Guide de style", "guide.example"), ("Bibliothèque", "biblio.example"), ("Musée", "musee.example")].enumerated() {
            state.addFavorite(id: "fav\(index)", url: "https://\(entry.1)/", title: entry.0, in: "work")
        }
        open("old1", "Recettes de saison", "recettes.example", at: now - 30 * 3_600_000)
        open("old2", "Calendrier des semis", "jardin.example", at: now - 60 * 3_600_000)
        open("old3", "Horaires du musée", "musee.example", at: now - 200 * 3_600_000)
        state.archive(tabIds: ["old1", "old2", "old3"], source: .auto, now: now)
        state.show(tabId: "notebook", now: now)
        let model = BrowserModel(state: state, clock: { now })
        await model.prepare()
        return model
    }

    /// The view in a window of the size of a phone, drawn after a moment (a `List` fills in after the first layout).
    private func draw<V: View>(_ view: V) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: view)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(900))
        return UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    }

    /// How many different colours a few thousand points of the picture have: a blank or a black picture has one.
    private func colours(in image: UIImage) throws -> Int {
        let cg = try XCTUnwrap(image.cgImage)
        let width = 40, height = 80
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.interpolationQuality = .none
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Set(stride(from: 0, to: pixels.count, by: 4).map { "\(pixels[$0] / 8),\(pixels[$0 + 1] / 8),\(pixels[$0 + 2] / 8)" }).count
    }

    private func check(_ name: String, _ image: UIImage, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertGreaterThan(try colours(in: image), 6, "\(name) drew (almost) nothing", file: file, line: line)
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "\(name).png"))
    }

    func testTheBarOfTheMockupC1() async throws {
        let model = await seededModel()
        try check("c1-bar", try await draw(BrowserScreen(model: model)))
    }

    func testTheSheetOfTheMockupC2() async throws {
        let model = await seededModel()
        try check("c2-tabs", try await draw(TabsSheet(model: model)))
    }

    /// The same screens in the dark scheme and with the largest sizes of text: a layout that holds only in one light and one size would be a layout
    /// that was drawn for the mockups and not for the people who use it.
    func testTheScreensInTheDarkSchemeAndWithTheLargestText() async throws {
        let model = await seededModel()
        try check("c2-dark", try await draw(TabsSheet(model: model).preferredColorScheme(.dark)))
        try check("commands-dark", try await draw(CommandBar(model: model, text: "sem").preferredColorScheme(.dark)))
        try check("c1-dark", try await draw(BrowserScreen(model: model).preferredColorScheme(.dark)))
        try check("c2-large-text", try await draw(TabsSheet(model: model).environment(\.dynamicTypeSize, .accessibility3)))
        try check("commands-large-text", try await draw(CommandBar(model: model, text: "sem").environment(\.dynamicTypeSize, .accessibility3)))
    }

    func testAFolderPageAndTheArchive() async throws {
        let model = await seededModel()
        try check("folder", try await draw(NavigationStack { FolderPage(model: model, folderId: "f-meetings", path: .constant([])) }))
        try check("archive", try await draw(NavigationStack { ArchiveScreen(model: model) }))
    }

    func testTheCommandBarOfTheMockup() async throws {
        let model = await seededModel()
        try check("commands-empty", try await draw(CommandBar(model: model)))
        try check("commands-sem", try await draw(CommandBar(model: model, text: "sem")))
        try check("commands-filter", try await draw(CommandBar(model: model, filter: .commands)))
    }
}
