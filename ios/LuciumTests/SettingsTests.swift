import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// An owner that says yes: the lock is turned on by a test, and nothing asks a person.
private final class YesOwner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}

/// What the settings screen does to the model (docs/ios.md, "Les réglages"). The rules of the sections and of the engine are proved in `LuciumKit`
/// (`swift test`); this is the part that keeps the state, tells the screen and answers the lock.
@MainActor
final class SettingsModelTests: BrowserCoreTestCase {
    private static let brave = "https://search.brave.com/search?q=%s"

    func testTheEngineChosenIsWhatTheProfileSearchesWithAndOnlyThatProfile() async throws {
        let model = await makeModel()
        XCTAssertEqual(model.searchChoice, .inherited, "a profile the person never chose an engine for follows the default one")
        XCTAssertEqual(model.request(for: "hello world")?.url?.host(), "duckduckgo.com")

        model.chooseSearchEngine(.engine(Self.brave))
        XCTAssertEqual(model.searchChoice, .engine(Self.brave))
        XCTAssertEqual(model.searchEngineName, "Brave Search", "the command bar names the engine in force")
        XCTAssertEqual(model.request(for: "hello world")?.url?.absoluteString, "https://search.brave.com/search?q=hello%20world")
        model.selectSpace("home")
        XCTAssertEqual(model.request(for: "hello world")?.url?.host(), "duckduckgo.com", "another profile keeps its own engine")
        model.selectSpace("work")

        model.chooseSearchEngine(.inherited)
        XCTAssertEqual(model.searchChoice, .inherited)
        XCTAssertEqual(model.request(for: "hello world")?.url?.host(), "duckduckgo.com")
    }

    func testTheChoiceIsWrittenInTheStateFileAndComesBackAfterARestart() async throws {
        let model = await makeModel()
        model.chooseSearchEngine(.engine(Self.brave))
        // No flush: the change is written by the model's own delayed save, which is what a person's choice relies on.
        let file = directory.appending(path: StateFile.fileName)
        try await eventually("the choice is written to the state file") {
            (try? String(contentsOf: file, encoding: .utf8))?.contains("search.brave.com") == true
        }
        XCTAssertNil(model.problem(.state))

        let restarted = await makeModel()
        XCTAssertEqual(restarted.searchChoice, .engine(Self.brave))
        XCTAssertEqual(restarted.request(for: "hello")?.url?.host(), "search.brave.com")
        // The Mac reads it where it keeps a profile's engine: the profile's entry in `settings.profiles`.
        guard case .object(let settings)? = restarted.state.rest["settings"], case .object(let profiles)? = settings["profiles"], case .object(let own)? = profiles["work"] else {
            return XCTFail("the choice is not in settings.profiles.work")
        }
        XCTAssertEqual(own["searchUrlTemplate"], .string(Self.brave))
        XCTAssertEqual(restarted.privacySettings, model.privacySettings, "choosing an engine does not touch the privacy rules")
    }

    func testAnEngineThatIsNotInTheMacsListChangesNothing() async throws {
        let model = await makeModel()
        let before = model.state
        model.chooseSearchEngine(.engine("https://evil.example/?q=%s"))
        model.chooseSearchEngine(.engine("javascript:alert(%s)"))
        XCTAssertEqual(model.state, before)
        XCTAssertEqual(model.searchChoice, .inherited)
    }

    func testTheGearOpensTheListAndAPageIsOpenedByNamingIt() async throws {
        let model = await makeModel()
        model.openSettings()
        XCTAssertTrue(model.settingsShown)
        XCTAssertNil(model.settingsStart)
        model.settingsShown = false
        model.openSettings(on: .privacy)
        XCTAssertTrue(model.settingsShown)
        XCTAssertEqual(model.settingsStart, .privacy)
    }

    func testTheSettingsCloseWhenTheApplicationLocksSoTheyNeverStayOverTheLockScreen() async throws {
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: YesOwner(), file: file)
        let model = BrowserModel.launch(directory: directory, lock: lock, embeddedLists: { nil })
        await model.prepare()
        let on = await lock.setLockApp(true)
        XCTAssertTrue(on)
        XCTAssertFalse(lock.appLocked, "switching the lock on does not lock the screen in use")

        model.openSettings()
        XCTAssertTrue(model.settingsShown)
        lock.lockAll()
        XCTAssertTrue(lock.appLocked)
        XCTAssertFalse(model.settingsShown, "the settings hold the switches of the lock and the list of the spaces: they leave with the screen")
    }
}

/// The settings screen, its pages and the two bars that open it, drawn off screen in the test host (no window is shown: the simulator runs in the
/// background) at the size of a phone and of an iPad, in both schemes and both languages, and with the largest text. They prove each page builds, lays
/// out and draws something; with `LUCIUM_SCREENSHOTS_DIR` set (give it as `TEST_RUNNER_LUCIUM_SCREENSHOTS_DIR` to `xcodebuild`) each drawing is also
/// written as a PNG, to be read (docs/ios.md, "Les réglages"). The accessibility tree is not published in a process nobody listens to, so what is read
/// is the picture.
@MainActor
final class SettingsScreenshotTests: BrowserCoreTestCase {
    static let phone = CGSize(width: 393, height: 852)  // iPhone 17 Pro
    static let padPortrait = CGSize(width: 820, height: 1180)  // iPad Air 11-inch
    static let padLandscape = CGSize(width: 1180, height: 820)

    /// A model with a lock, a favourite, an engine of its own for the profile on screen and a page open, as a person who has used the application.
    private func model() async -> BrowserModel {
        let now = 1_790_000_000_000.0
        var state = BrowserModel.defaultState()
        state.openTab(id: "a", in: "work", url: "https://journal.example/lire", title: "Bien nommer ses fichiers", now: now - 2)
        for (index, entry) in [("Agenda de la semaine", "agenda.example"), ("Guide de style", "guide.example"), ("Bibliothèque", "biblio.example")].enumerated() {
            state.addFavorite(id: "fav\(index)", url: "https://\(entry.1)/", title: entry.0, in: "work")
        }
        state.show(tabId: "a", now: now)
        let model = BrowserModel(state: state, clock: { now })
        model.attach(LockController(authenticator: YesOwner(), file: LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))))
        model.chooseSearchEngine(.engine("https://search.brave.com/search?q=%s"))
        await model.prepare()
        return model
    }

    private func draw<V: View>(_ view: V, size: CGSize, regular: Bool, scheme: ColorScheme, language: String, textSize: DynamicTypeSize = .large) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let framed = view
            .environment(\.horizontalSizeClass, regular ? .regular : .compact)
            .environment(\.verticalSizeClass, size.height > size.width || regular ? .regular : .compact)
            .environment(\.dynamicTypeSize, textSize)
            .environment(\.locale, Locale(identifier: language))
            .preferredColorScheme(scheme)
        window.rootViewController = UIHostingController(rootView: framed)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(900))
        let bounds = CGRect(origin: .zero, size: size)
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in window.drawHierarchy(in: bounds, afterScreenUpdates: true) }
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
        XCTAssertGreaterThan(try colours(in: image), 8, "\(name) drew (almost) nothing", file: file, line: line)
        guard let folder = ProcessInfo.processInfo.environment["LUCIUM_SCREENSHOTS_DIR"], !folder.isEmpty else { return }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "settings-\(name).png"))
    }

    /// The list and every page, on a phone, in light, in both languages.
    func testEveryPageOfTheSettingsDrawsOnAPhone() async throws {
        let model = await model()
        let pages: [(String, SettingsRow?)] = [("list", nil), ("search", .searchEngine), ("privacy", .privacy), ("passwords", .passwords), ("lock", .lock), ("spaces", .spaces), ("licenses", .licenses)]
        for language in ["fr", "en"] {
            for (name, row) in pages {
                model.settingsStart = row
                let image = try await draw(SettingsScreen(model: model), size: Self.phone, regular: false, scheme: .light, language: language)
                try check("\(name)-phone-light-\(language)", image)
            }
        }
    }

    /// The list and the engine page in dark, on both devices, and the list with the largest text: the rows wrap under their names.
    func testTheListAndTheEngineDrawInDarkOnBothDevicesAndWithTheLargestText() async throws {
        let model = await model()
        for language in ["fr", "en"] {
            for (device, size, regular) in [("phone", Self.phone, false), ("pad", Self.padPortrait, true)] {
                for (name, row) in [("list", SettingsRow?.none), ("search", .searchEngine)] {
                    model.settingsStart = row
                    try check("\(name)-\(device)-dark-\(language)", try await draw(SettingsScreen(model: model), size: size, regular: regular, scheme: .dark, language: language))
                    if device == "pad" { try check("\(name)-\(device)-light-\(language)", try await draw(SettingsScreen(model: model), size: size, regular: regular, scheme: .light, language: language)) }
                }
            }
            model.settingsStart = nil
            try check("list-phone-largest-text-\(language)", try await draw(SettingsScreen(model: model), size: Self.phone, regular: false, scheme: .light, language: language, textSize: .accessibility3))
            model.settingsStart = .searchEngine
            try check("search-phone-largest-text-\(language)", try await draw(SettingsScreen(model: model), size: Self.phone, regular: false, scheme: .light, language: language, textSize: .accessibility3))
        }
    }

    /// The gear is where the decision puts it: beside the address pill of the bottom bar, and in the sidebar of the iPad where "More" was.
    func testTheGearIsInTheBottomBarAndInTheIpadSidebar() async throws {
        let model = await model()
        for language in ["fr", "en"] {
            for scheme in [ColorScheme.light, .dark] {
                let label = scheme == .light ? "light" : "dark"
                let phone = try await draw(BrowserScreen(model: model), size: Self.phone, regular: false, scheme: scheme, language: language)
                try check("bar-phone-\(label)-\(language)", phone)
                let pad = try await draw(BrowserScreen(model: model), size: Self.padLandscape, regular: true, scheme: scheme, language: language)
                try check("bar-pad-landscape-\(label)-\(language)", pad)
            }
            let largest = try await draw(BrowserScreen(model: model), size: Self.phone, regular: false, scheme: .light, language: language, textSize: .accessibility3)
            try check("bar-phone-largest-text-\(language)", largest)
        }
    }
}
