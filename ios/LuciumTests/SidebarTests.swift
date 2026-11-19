import LuciumKit
import SwiftUI
import UIKit
import XCTest
@testable import Lucium

/// An owner that says yes to everything: the lock is turned on by a test, and nothing asks a person.
private final class YesOwner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}

/// The permanent sidebar of the iPad in landscape (mockup `iPad · paysage`), drawn off screen in the test host (no window is shown: the simulator
/// runs in the background). The host is told how much room the window has and what its size classes are, which is what the real screen is told by
/// the system. The accessibility tree is not published in a process nobody listens to, so what is read here is the picture (which navigation was
/// drawn, found by the colour of a strip of the screen) and the content the sidebar lists (`SidebarContent`, which is where the lock is applied).
/// With `LUCIUM_SCREENSHOTS_DIR` set, each drawing is also written as a PNG, to be read beside the mockup.
@MainActor
final class SidebarTests: BrowserCoreTestCase {
    static let landscape = CGSize(width: 1180, height: 820)  // iPad Air 11-inch, the mockup's own size
    static let portrait = CGSize(width: 820, height: 1180)

    /// A space with what the mockup shows: favourites, pinned tabs, two folders with tabs in them, Today, an archive.
    private func seededModel(lock: LockController? = nil, isPhone: Bool = false) async -> BrowserModel {
        let now = 1_790_000_000_000.0
        var state = BrowserModel.defaultState()
        func open(_ id: String, _ title: String, _ host: String, at: Double) {
            state.openTab(id: id, in: "work", url: "https://\(host)/", title: title, now: at)
        }
        open("mosaic", "Mosaïque — Tableau", "projet.example", at: now - 9)
        open("notebook", "Carnet de notes", "carnet.example", at: now - 8)
        open("meeting1", "Réunion du lundi", "reunions.example", at: now - 7)
        open("meeting2", "Compte rendu", "notes.example", at: now - 6)
        open("docs1", "Référence du projet", "docs.example", at: now - 5)
        open("weather", "Météo de la semaine", "meteo.example", at: now - 3)
        open("files", "Bien nommer ses fichiers", "lecture.example", at: now - 2)
        for id in ["mosaic", "notebook"] { state.pin(tabId: id) }
        if let meetings = state.createFolder(id: "f-meetings", name: "Réunions", fallbackName: "?", in: "work"),
           let docs = state.createFolder(id: "f-docs", name: "Documentation", fallbackName: "?", in: "work") {
            for id in ["meeting1", "meeting2"] { state.move(tabId: id, toFolder: meetings.id) }
            state.move(tabId: "docs1", toFolder: docs.id)
        }
        for (index, entry) in [("Agenda de la semaine", "agenda.example"), ("Guide de style", "guide.example"), ("Bibliothèque", "biblio.example"), ("Musée", "musee.example")].enumerated() {
            state.addFavorite(id: "fav\(index)", url: "https://\(entry.1)/", title: entry.0, in: "work")
        }
        open("old1", "Recettes de saison", "recettes.example", at: now - 30 * 3_600_000)
        state.archive(tabIds: ["old1"], source: .auto, now: now)
        state.show(tabId: "notebook", now: now)
        let model = BrowserModel(state: state, clock: { now }, isPhone: isPhone)
        if let lock { model.attach(lock) }
        await model.prepare()
        return model
    }

    /// The model with the space on screen locked, the way the owner's yes would leave it.
    private func lockedModel() async throws -> BrowserModel {
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: YesOwner(), file: file)
        let model = await seededModel(lock: lock)
        let locked = await lock.setSpace("work", guarded: true)
        XCTAssertTrue(locked)
        XCTAssertTrue(model.activeSpaceCovered)
        return model
    }

    // MARK: Drawing

    private func draw<V: View>(_ view: V, size: CGSize, regularWidth: Bool = true, regularHeight: Bool = true, scheme: ColorScheme = .light,
                               settle: Duration = .milliseconds(900)) async throws -> UIImage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let framed = view
            .environment(\.horizontalSizeClass, regularWidth ? .regular : .compact)
            .environment(\.verticalSizeClass, regularHeight ? .regular : .compact)
            .preferredColorScheme(scheme)
        window.rootViewController = UIHostingController(rootView: framed)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: settle)
        let bounds = CGRect(origin: .zero, size: size)
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in window.drawHierarchy(in: bounds, afterScreenUpdates: true) }
    }

    /// The colour of one point (in points, not pixels) of a picture.
    private func colour(of image: UIImage, at point: CGPoint) throws -> (red: Int, green: Int, blue: Int) {
        let cg = try XCTUnwrap(image.cgImage)
        let cropped = try XCTUnwrap(cg.cropping(to: CGRect(x: point.x * image.scale, y: point.y * image.scale, width: 1, height: 1)))
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
    }

    /// Whether the strip at the left edge of the window, half way down, is the white of a page (the bottom bar's layout: the page takes the whole
    /// width) or the tinted ground of the sidebar. The sidebar's rows have no ground of their own, so this point is the colours of the space.
    private func pageFillsTheLeftEdge(_ image: UIImage, _ size: CGSize) throws -> Bool {
        let probe = try colour(of: image, at: CGPoint(x: 6, y: size.height * 0.45))
        return probe.red >= 250 && probe.green >= 250 && probe.blue >= 250
    }

    /// How many different colours a few thousand points of the picture have: a blank or a black picture has one.
    private func colours(in image: UIImage) throws -> Int {
        let cg = try XCTUnwrap(image.cgImage)
        let width = 80, height = 56
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
        try XCTUnwrap(image.pngData(), file: file, line: line).write(to: directory.appending(path: "\(name).png"))
    }

    // MARK: Which navigation the screen has

    func testTheScreenHasTheSidebarOnAnIPadInLandscapeAndTheBarEverywhereElse() async throws {
        let model = await seededModel()

        let landscape = try await draw(BrowserScreen(model: model), size: Self.landscape)
        XCTAssertFalse(try pageFillsTheLeftEdge(landscape, Self.landscape), "the sidebar is at the left: the strip there is the colours of the space")
        try check("ipad-landscape", landscape)

        let portrait = try await draw(BrowserScreen(model: model), size: Self.portrait)
        XCTAssertTrue(try pageFillsTheLeftEdge(portrait, Self.portrait), "an iPad held upright keeps the bar: the page takes the whole width")

        let split = CGSize(width: 700, height: 820)
        let narrow = try await draw(BrowserScreen(model: model), size: split, regularWidth: false)
        XCTAssertTrue(try pageFillsTheLeftEdge(narrow, split), "half of a Split View is compact in width: the bar")

        let phoneSize = CGSize(width: 932, height: 430)
        let phone = try await draw(BrowserScreen(model: model), size: phoneSize, regularHeight: false)
        XCTAssertTrue(try pageFillsTheLeftEdge(phone, phoneSize), "an iPhone held sideways is short: the bar even when its width is regular")

        let large = try await draw(BrowserScreen(model: model).environment(\.dynamicTypeSize, .accessibility3), size: Self.landscape)
        XCTAssertTrue(try pageFillsTheLeftEdge(large, Self.landscape), "the largest text keeps the bar: 320 points cannot hold it")
        try check("ipad-landscape-large-text", large)
    }

    func testTheSidebarInTheDarkSchemeAndWithLargeText() async throws {
        let model = await seededModel()
        let dark = try await draw(BrowserScreen(model: model), size: Self.landscape, scheme: .dark)
        try check("ipad-landscape-dark", dark)
        XCTAssertFalse(try pageFillsTheLeftEdge(dark, Self.landscape), "the sidebar is there in the dark scheme too")
        // The largest sizes that still get the sidebar: a line of text must still be drawn whole in 320 points (read on the picture).
        let large = try await draw(BrowserScreen(model: model).environment(\.dynamicTypeSize, .xxxLarge), size: Self.landscape)
        XCTAssertFalse(try pageFillsTheLeftEdge(large, Self.landscape))
        try check("ipad-landscape-xxxlarge", large)
    }

    // MARK: What the sidebar lists

    func testTheSidebarListsTheFavouritesThePinnedTabsTheFoldersAndToday() async throws {
        let model = await seededModel()
        let content = model.sidebarContent(expanded: [])
        XCTAssertEqual(content.favorites.map(\.title), ["Agenda de la semaine", "Guide de style", "Bibliothèque", "Musée"])
        XCTAssertEqual(content.outline.map(\.id), ["tab:mosaic", "tab:notebook", "folder:f-meetings", "folder:f-docs"], "the loose pinned tabs, then the folders, closed")
        XCTAssertEqual(content.today.map(\.id), ["weather", "files"], "Today is what is open and not pinned: not the archived tab, not a pinned one")
        XCTAssertFalse(content.isCovered)
        let drawing = try await draw(SidebarLayout(model: model, sidebarShown: .constant(true), expandedFolders: .constant([])), size: Self.landscape)
        try check("ipad-landscape-sidebar", drawing)
    }

    func testAnOpenFolderShowsItsTabsInPlaceAndTheOtherStaysClosed() async throws {
        let model = await seededModel()
        let content = model.sidebarContent(expanded: ["f-meetings"])
        XCTAssertEqual(content.outline.map(\.id), ["tab:mosaic", "tab:notebook", "folder:f-meetings", "tab:meeting1", "tab:meeting2", "folder:f-docs"])
        XCTAssertEqual(content.outline.map(\.depth), [0, 0, 0, 1, 1, 0], "what is inside a folder is one level deeper")
        let drawing = try await draw(SidebarLayout(model: model, sidebarShown: .constant(true), expandedFolders: .constant(["f-meetings"])), size: Self.landscape)
        try check("ipad-landscape-folder-open", drawing)
    }

    func testHidingTheSidebarGivesThePageTheWholeWidth() async throws {
        let model = await seededModel()
        let shown = try await draw(SidebarLayout(model: model, sidebarShown: .constant(true), expandedFolders: .constant([])), size: Self.landscape)
        let hidden = try await draw(SidebarLayout(model: model, sidebarShown: .constant(false), expandedFolders: .constant([])), size: Self.landscape)
        // Half way down and 100 points from the left edge: the page when the sidebar is hidden, the rows of the sidebar (on the colours of the space) when it is shown.
        let hiddenStrip = try colour(of: hidden, at: CGPoint(x: 100, y: Self.landscape.height * 0.45))
        XCTAssertTrue(hiddenStrip.red >= 250 && hiddenStrip.green >= 250 && hiddenStrip.blue >= 250, "the page starts at the left when the sidebar is hidden")
        let shownStrip = try colour(of: shown, at: CGPoint(x: 100, y: Self.landscape.height * 0.45))
        XCTAssertFalse(shownStrip.red >= 250 && shownStrip.green >= 250 && shownStrip.blue >= 250, "and not when it is shown")
        try check("ipad-landscape-hidden", hidden)
    }

    // MARK: The lock

    func testALockedSpaceListsNothingOfItselfInTheSidebar() async throws {
        let model = try await lockedModel()
        for expanded: Set<String> in [[], ["f-meetings", "f-docs"]] {
            let content = model.sidebarContent(expanded: expanded)
            XCTAssertTrue(content.isCovered, "the sidebar knows why its lists are empty")
            XCTAssertTrue(content.favorites.isEmpty, "no favourite of a locked space")
            XCTAssertTrue(content.outline.isEmpty, "no pinned tab, no folder, whatever is open: \(content.outline.map(\.id))")
            XCTAssertTrue(content.today.isEmpty, "no Today tab")
        }
        XCTAssertEqual(model.archiveCount, 0, "and the archive button of the sidebar opens a list with none of its pages")
        let drawing = try await draw(SidebarLayout(model: model, sidebarShown: .constant(true), expandedFolders: .constant(["f-meetings", "f-docs"])), size: Self.landscape)
        try check("ipad-landscape-locked", drawing)
    }

    func testAnotherSpaceThatIsNotLockedStillListsItsOwn() async throws {
        let model = try await lockedModel()
        model.selectSpace("home")
        XCTAssertFalse(model.activeSpaceCovered)
        let content = model.sidebarContent(expanded: [])
        XCTAssertFalse(content.isCovered)
        XCTAssertEqual(content.outline.count, 0, "home has no pinned tab in this state: an empty list is not a locked one")
        XCTAssertEqual(content.today.count, 1, "home has the blank tab every space gets, and nothing of work")
        XCTAssertTrue(content.today.allSatisfy { $0.spaceId == "home" })
    }

    // MARK: The iPhone's sidebar, from the left edge (decision of 18 November 2026)

    static let phone = CGSize(width: 393, height: 852)  // iPhone 17 Pro

    /// Whether a point of `image` is the page of `away` (the same screen with the sidebar put away) dimmed: black laid at a third over what the page was. The
    /// sidebar is the colours of the space over the ground, which is not that.
    private func isDimmed(_ image: UIImage, over away: UIImage, at point: CGPoint) throws -> Bool {
        let now = try colour(of: image, at: point)
        let before = try colour(of: away, at: point)
        func near(_ now: Int, _ before: Int) -> Bool { abs(Double(now) - Double(before) * 0.68) <= 8 }
        return near(now.red, before.red) && near(now.green, before.green) && near(now.blue, before.blue)
    }

    private func drawPhone(_ model: BrowserModel, scheme: ColorScheme = .light, largeText: Bool = false) async throws -> UIImage {
        let screen = BrowserScreen(model: model).environment(\.dynamicTypeSize, largeText ? .accessibility3 : .large)
        return try await draw(screen, size: Self.phone, regularWidth: false, scheme: scheme)
    }

    func testTheIPhonesSidebarIsAwayUntilTheEdgeBringsItOutAndThenItCoversMostOfTheScreen() async throws {
        let model = await seededModel(isPhone: true)
        XCTAssertFalse(model.drawerShown)
        let away = try await drawPhone(model)
        XCTAssertTrue(try pageFillsTheLeftEdge(away, Self.phone), "the page takes the whole width while the sidebar is away")
        try check("iphone-sidebar-away", away)

        model.drawerEvent(.pulledOpen)
        XCTAssertTrue(model.drawerShown)
        let out = try await drawPhone(model)
        XCTAssertFalse(try pageFillsTheLeftEdge(out, Self.phone), "the sidebar is at the left: the colours of the space, not the page")
        XCTAssertTrue(try isDimmed(out, over: away, at: CGPoint(x: 380, y: Self.phone.height * 0.45)), "the page that is left of the screen, at the right, is dimmed")
        XCTAssertFalse(try isDimmed(out, over: away, at: CGPoint(x: 150, y: Self.phone.height * 0.45)), "and the sidebar is not")
        try check("iphone-sidebar-open", out)
    }

    func testTheIPhonesSidebarHoldsTheListsOfTheIPadsSidebar() async throws {
        let model = await seededModel(isPhone: true)
        // `Sidebar` is the one view both draw, and it reads `sidebarContent`: what the iPad lists is what the iPhone lists.
        let content = model.sidebarContent(expanded: [])
        XCTAssertEqual(content.favorites.map(\.title), ["Agenda de la semaine", "Guide de style", "Bibliothèque", "Musée"])
        XCTAssertEqual(content.outline.map(\.id), ["tab:mosaic", "tab:notebook", "folder:f-meetings", "folder:f-docs"])
        XCTAssertEqual(content.today.map(\.id), ["weather", "files"])
        model.drawerEvent(.pulledOpen)
        let dark = try await drawPhone(model, scheme: .dark)
        try check("iphone-sidebar-open-dark", dark)
        let large = try await drawPhone(model, largeText: true)
        model.drawerEvent(.dismissed)
        let away = try await drawPhone(model, largeText: true)
        XCTAssertTrue(try isDimmed(large, over: away, at: CGPoint(x: 385, y: Self.phone.height * 0.45)), "the largest text widens the sidebar but leaves a strip of page to tap on")
        XCTAssertFalse(try isDimmed(large, over: away, at: CGPoint(x: 345, y: Self.phone.height * 0.45)), "a sidebar wider than 85 % of the screen (334 points)")
        try check("iphone-sidebar-open-large-text", large)
    }

    func testTheBarButtonTogglesTheSidebarOnAPhoneOnly() async throws {
        let phone = await seededModel(isPhone: true)
        phone.toggleDrawer()
        XCTAssertTrue(phone.drawerShown, "the first tap brings the sidebar out")
        phone.toggleDrawer()
        XCTAssertFalse(phone.drawerShown, "the second puts it away")
        let pad = await seededModel(isPhone: false)
        pad.toggleDrawer()
        XCTAssertFalse(pad.drawerShown, "the iPad has no such sidebar")
    }

    func testShowingAPageClosesTheSidebarAndChoosingASpaceLeavesItOut() async throws {
        let model = await seededModel(isPhone: true)
        let weather = try XCTUnwrap(model.todayTabs.first { $0.id == "weather" })
        model.drawerEvent(.openedByButton)
        model.openTab(weather)
        XCTAssertFalse(model.drawerShown, "a tab of the list is opened: the page is what the person came for")
        XCTAssertEqual(model.activeTab?.id, "weather")

        model.drawerEvent(.openedByButton)
        model.openTab(weather)  // the tab that is on screen already
        XCTAssertFalse(model.drawerShown, "the sidebar closes on the tab that is shown too")

        model.drawerEvent(.openedByButton)
        let favorite = try XCTUnwrap(model.favorites.first)
        model.openFavorite(favorite)
        XCTAssertFalse(model.drawerShown, "a favourite")

        model.drawerEvent(.openedByButton)
        model.newTab()
        XCTAssertFalse(model.drawerShown, "\"New tab\", the blank tab being shown already or not")

        model.drawerEvent(.openedByButton)
        let archived = try XCTUnwrap(model.archiveGroups.first?.entries.first)
        model.restore(archived)
        XCTAssertFalse(model.drawerShown, "a page brought back from the archive")

        model.drawerEvent(.openedByButton)
        model.selectSpace("home")
        XCTAssertTrue(model.drawerShown, "another space is chosen to see its tabs: the sidebar stays and lists them")
        XCTAssertEqual(model.activeSpace.id, "home")
        let content = model.sidebarContent(expanded: [])
        XCTAssertTrue(content.outline.isEmpty, "and it lists the space that was chosen: nothing of work")
        XCTAssertTrue(content.today.allSatisfy { $0.spaceId == "home" })
    }

    func testTheIPhonesSidebarClosesWhenTheApplicationLocks() async throws {
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: YesOwner(), file: file)
        let model = await seededModel(lock: lock, isPhone: true)
        let turnedOn = await lock.setLockApp(true)
        XCTAssertTrue(turnedOn)
        model.drawerEvent(.openedByButton)
        XCTAssertTrue(model.drawerShown)
        model.lockOnLeaving()
        XCTAssertTrue(lock.appLocked)
        XCTAssertFalse(model.drawerShown, "the sidebar names tabs and sites: it does not stay over the lock screen")
    }

    func testALockedSpaceListsNothingInTheIPhonesSidebarEither() async throws {
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: YesOwner(), file: file)
        let model = await seededModel(lock: lock, isPhone: true)
        let locked = await lock.setSpace("work", guarded: true)
        XCTAssertTrue(locked)
        model.drawerEvent(.openedByButton)
        XCTAssertTrue(model.drawerShown, "a locked space does not close the sidebar: it is where the owner unlocks it")
        let content = model.sidebarContent(expanded: ["f-meetings", "f-docs"])
        XCTAssertTrue(content.isCovered)
        XCTAssertTrue(content.favorites.isEmpty && content.outline.isEmpty && content.today.isEmpty)
        try check("iphone-sidebar-locked", try await drawPhone(model))
    }

    func testOnlyAnIPhoneHasTheSidebarAndTheIPadKeepsItsOwn() async throws {
        let pad = await seededModel(isPhone: false)
        pad.drawerEvent(.pulledOpen)
        XCTAssertFalse(pad.drawerShown, "the iPad's permanent sidebar and its bar are as they were: nothing slides out from the edge")
        let portrait = try await draw(BrowserScreen(model: pad), size: Self.portrait)
        XCTAssertTrue(try pageFillsTheLeftEdge(portrait, Self.portrait), "an iPad held upright keeps the bottom bar and the whole width for the page")
    }

    func testWebKitsSwipeBackIsOffOnAnIPhoneAndKeptOnAnIPad() async throws {
        let phone = await seededModel(isPhone: true)
        let phoneView = try XCTUnwrap(phone.webView)
        XCTAssertFalse(phoneView.allowsBackForwardNavigationGestures, "the left edge is the sidebar's: going back is the button of the bottom bar")
        let pad = await seededModel(isPhone: false)
        let padView = try XCTUnwrap(pad.webView)
        XCTAssertTrue(padView.allowsBackForwardNavigationGestures, "the iPad keeps WebKit's swipe")
    }
}
