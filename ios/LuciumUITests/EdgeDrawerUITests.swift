import XCTest

/// The iPhone's sidebar, driven the way a person does: a real drag that starts at the left edge of the screen, a tap on the dimmed page, a drag to the left.
/// The accessibility tree is read here too (the tests hosted in the application cannot: nobody listens to it there).
final class EdgeDrawerUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(language: String = "en") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "fr" ? "fr_FR" : "en_US"]
        app.launch()
        return app
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// A point of the window: `x` points from the left edge, `fraction` of the way down.
    private func point(_ app: XCUIApplication, x: CGFloat, down fraction: CGFloat) -> XCUICoordinate {
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: fraction)).withOffset(CGVector(dx: x, dy: 0))
    }

    /// The finger touches the screen 3 points from its left edge, as a thumb does, and goes to the right. Quick: a flick, which opens the sidebar whatever the
    /// distance. Slow, and held a moment where it stops: the distance decides.
    private func dragFromTheEdge(_ app: XCUIApplication, to x: CGFloat, slowly: Bool = false) {
        let start = point(app, x: 3, down: 0.45)
        let end = point(app, x: x, down: 0.45)
        if slowly {
            start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.4)
        } else {
            start.press(forDuration: 0.1, thenDragTo: end)
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testADragFromTheLeftEdgeBringsTheSidebarOutAndATapOnThePageClosesIt() {
        let app = launch()
        XCTAssertFalse(element(app, "edge-drawer").waitForExistence(timeout: 2), "the sidebar is away at launch")
        dragFromTheEdge(app, to: 260)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3), "a drag from the left edge brings the sidebar out")
        attach(app, "sidebar-out")
        // The page that is left, at the right of the screen, is dimmed and is a tap away from closing the sidebar.
        point(app, x: app.windows.firstMatch.frame.width - 12, down: 0.45).tap()
        XCTAssertTrue(waitForGone(element(app, "edge-drawer")), "a tap on the dimmed page puts the sidebar away")
    }

    func testASlowDragThatStopsShortLeavesTheSidebarAwayAndAFarOneKeepsItOut() {
        let app = launch()
        dragFromTheEdge(app, to: 50, slowly: true)
        XCTAssertFalse(element(app, "edge-drawer").waitForExistence(timeout: 2), "a slow drag that stops at 50 points (of 334) does not open it")
        dragFromTheEdge(app, to: 220, slowly: true)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3), "a slow drag that goes past a third of the width keeps it out")
    }

    func testAQuickShortFlickOpensTheSidebarToo() {
        let app = launch()
        dragFromTheEdge(app, to: 60)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3), "a flick opens it whatever the distance")
    }

    func testADragToTheLeftOnTheSidebarPutsItAway() {
        let app = launch()
        dragFromTheEdge(app, to: 300)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3))
        // An empty part of the sidebar, below its lists: a row would keep its own swipe.
        point(app, x: 250, down: 0.78).press(forDuration: 0.1, thenDragTo: point(app, x: 20, down: 0.78))
        XCTAssertTrue(waitForGone(element(app, "edge-drawer")), "a drag to the left on the sidebar puts it away")
    }

    /// The row of a tab keeps its own swipe (pin, archive, close): a drag to the left that starts on it does not put the sidebar away.
    func testASwipeToTheLeftThatStartsOnARowKeepsTheRowsSwipeAndTheSidebarOut() {
        let app = launch()
        dragFromTheEdge(app, to: 300)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3))
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Start page'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 3), "the blank tab is a row of the list")
        let frame = row.frame
        point(app, x: frame.midX + 60, down: frame.midY / app.windows.firstMatch.frame.height)
            .press(forDuration: 0.1, thenDragTo: point(app, x: frame.midX - 120, down: frame.midY / app.windows.firstMatch.frame.height))
        sleep(1)
        XCTAssertTrue(element(app, "edge-drawer").exists, "a swipe on a row is the row's: the sidebar stays")
        attach(app, "row-swiped")
    }

    func testHidingTheSidebarAndOpeningANewTabPutItAway() {
        let app = launch()
        dragFromTheEdge(app, to: 300)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3))
        app.buttons["Hide the sidebar"].firstMatch.tap()
        XCTAssertTrue(waitForGone(element(app, "edge-drawer")), "the button of the sidebar that hides it")

        dragFromTheEdge(app, to: 300)
        XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3))
        app.buttons["New tab"].firstMatch.tap()
        XCTAssertTrue(waitForGone(element(app, "edge-drawer")), "opening a page (a new tab) puts the sidebar away")
    }

    func testTheAccessibilityTreeOffersAButtonToOpenItAndTheSidebarIsAModalGroup() {
        let app = launch()
        let opener = element(app, "edge-drawer-open")
        XCTAssertTrue(opener.waitForExistence(timeout: 3), "a person who cannot drag from the edge finds a button")
        XCTAssertEqual(opener.label, "Show the sidebar")
        dragFromTheEdge(app, to: 300)
        let drawer = element(app, "edge-drawer")
        XCTAssertTrue(drawer.waitForExistence(timeout: 3))
        XCTAssertEqual(drawer.label, "Sidebar")
        XCTAssertFalse(opener.exists, "the button is for the closed sidebar: with it out, the page is not read")
    }

    func testTheSidebarIsInFrenchToo() {
        let app = launch(language: "fr")
        dragFromTheEdge(app, to: 300)
        let drawer = element(app, "edge-drawer")
        XCTAssertTrue(drawer.waitForExistence(timeout: 3))
        XCTAssertEqual(drawer.label, "Barre latérale")
        XCTAssertTrue(app.buttons["Masquer la barre latérale"].firstMatch.exists)
    }

    private func waitForGone(_ element: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter.wait(for: [gone], timeout: timeout) == .completed
    }

    /// The sidebar as the simulator really draws it, in both languages: the pictures are attached to the result, to be read. The scheme is the simulator's
    /// (`xcrun simctl ui <device> appearance dark`); `TEST_RUNNER_LUCIUM_UI_SCHEME` (`xcodebuild`) says which it was set to, for the pictures' names.
    func testPicturesOfTheSidebarInBothLanguages() {
        let scheme = ProcessInfo.processInfo.environment["LUCIUM_UI_SCHEME"] ?? "light"
        for language in ["en", "fr"] {
            let app = launch(language: language)
            dragFromTheEdge(app, to: 300)
            XCTAssertTrue(element(app, "edge-drawer").waitForExistence(timeout: 3), "\(language), \(scheme)")
            sleep(1)
            attach(app, "sidebar-\(language)-\(scheme)")
            app.terminate()
        }
    }
}
