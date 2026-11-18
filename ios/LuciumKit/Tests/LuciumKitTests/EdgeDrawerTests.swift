import Testing
@testable import LuciumKit

@Suite("The sidebar that slides out from the left edge of an iPhone")
struct EdgeDrawerTests {
    // MARK: Width

    @Test func itTakesAboutEightyFivePercentOfAPhoneHeldUpright() {
        #expect(abs(EdgeDrawer.width(screenWidth: 393) - 334.05) < 0.01, "iPhone 17 Pro")
        #expect(abs(EdgeDrawer.width(screenWidth: 375) - 318.75) < 0.01, "iPhone SE")
        #expect(abs(EdgeDrawer.width(screenWidth: 440) - 374) < 0.01, "iPhone 17 Pro Max")
    }

    @Test func itLeavesAPageBesideItOnAPhoneHeldSideways() {
        #expect(EdgeDrawer.width(screenWidth: 852) == EdgeDrawer.maxWidth, "85 % of a landscape iPhone would be 724 points")
        #expect(EdgeDrawer.width(screenWidth: 932) == EdgeDrawer.maxWidth)
    }

    @Test func theLargestTextGetsMoreRoomButStillLeavesAStripToTapOn() {
        let normal = EdgeDrawer.width(screenWidth: 393)
        let large = EdgeDrawer.width(screenWidth: 393, largeText: true)
        #expect(large > normal, "a line of that size needs room")
        #expect(393 - large >= EdgeDrawer.largeTextMargin - 0.001, "the strip of page that is left is a target of 44 points")
        #expect(EdgeDrawer.width(screenWidth: 852, largeText: true) == EdgeDrawer.largeTextMaxWidth, "never the whole of a landscape screen")
        #expect(EdgeDrawer.width(screenWidth: 0) == 0, "no screen, no sidebar")
    }

    // MARK: Where it exists

    @Test func onlyAnIPhoneHasIt() {
        #expect(EdgeDrawer.isAvailable(layout: .bottomBar, isPhone: true))
        #expect(!EdgeDrawer.isAvailable(layout: .bottomBar, isPhone: false), "an iPad held upright, or in a narrow window, keeps the bar as it was")
        #expect(!EdgeDrawer.isAvailable(layout: .sidebar, isPhone: false), "the iPad's own sidebar is permanent")
        #expect(!EdgeDrawer.isAvailable(layout: .sidebar, isPhone: true), "no sidebar over a sidebar")
    }

    @Test func webKitsBackGestureIsOffOnAPhoneAndKeptOnAnIPad() {
        #expect(!EdgeDrawer.allowsWebKitBackGesture(isPhone: true), "the left edge is the sidebar's")
        #expect(EdgeDrawer.allowsWebKitBackGesture(isPhone: false))
    }

    // MARK: A drag

    @Test func theSidebarFollowsTheFingerAndStopsAtTheEnds() {
        #expect(EdgeDrawer.progress(wasOpen: false, translation: 0, width: 300) == 0)
        #expect(EdgeDrawer.progress(wasOpen: false, translation: 150, width: 300) == 0.5)
        #expect(EdgeDrawer.progress(wasOpen: false, translation: 900, width: 300) == 1, "dragged past the end")
        #expect(EdgeDrawer.progress(wasOpen: false, translation: -40, width: 300) == 0, "dragged the wrong way from the edge")
        #expect(EdgeDrawer.progress(wasOpen: true, translation: 0, width: 300) == 1)
        #expect(EdgeDrawer.progress(wasOpen: true, translation: -75, width: 300) == 0.75)
        #expect(EdgeDrawer.progress(wasOpen: true, translation: -900, width: 300) == 0)
        #expect(EdgeDrawer.progress(wasOpen: true, translation: 60, width: 300) == 1, "pushed further out than it goes")
        #expect(EdgeDrawer.progress(wasOpen: true, translation: -10, width: 0) == 0, "no width, nothing to drag")
    }

    @Test func aSlowDragFromTheEdgeOpensPastAThirdOfTheWidth() {
        #expect(!EdgeDrawer.settlesOpen(wasOpen: false, translation: 90, velocity: 50, width: 300), "30 % is not enough")
        #expect(EdgeDrawer.settlesOpen(wasOpen: false, translation: 105, velocity: 50, width: 300), "35 % is")
        #expect(EdgeDrawer.settlesOpen(wasOpen: false, translation: 250, velocity: 0, width: 300))
        #expect(!EdgeDrawer.settlesOpen(wasOpen: false, translation: 0, velocity: 0, width: 300), "a touch of the edge that did not move")
    }

    @Test func aSlowDragFromTheOpenSidebarClosesPastAQuarterOfTheWidth() {
        #expect(EdgeDrawer.settlesOpen(wasOpen: true, translation: -60, velocity: -50, width: 300), "20 % back: it springs out again")
        #expect(!EdgeDrawer.settlesOpen(wasOpen: true, translation: -80, velocity: -50, width: 300), "27 % back: it goes")
        #expect(EdgeDrawer.settlesOpen(wasOpen: true, translation: 0, velocity: 0, width: 300), "a touch that did not move leaves it where it is")
    }

    @Test func aFlickDecidesByItsDirectionWhateverTheDistance() {
        #expect(EdgeDrawer.settlesOpen(wasOpen: false, translation: 20, velocity: 900, width: 300), "a short, quick pull from the edge opens")
        #expect(!EdgeDrawer.settlesOpen(wasOpen: true, translation: -20, velocity: -900, width: 300), "a short, quick push to the left closes")
        #expect(!EdgeDrawer.settlesOpen(wasOpen: false, translation: 200, velocity: -900, width: 300), "pulled far, then flicked back: closed")
        #expect(EdgeDrawer.settlesOpen(wasOpen: true, translation: -200, velocity: 900, width: 300), "pushed far, then flicked back out: open")
        #expect(!EdgeDrawer.settlesOpen(wasOpen: false, translation: 20, velocity: EdgeDrawer.flickVelocity - 1, width: 300), "just under a flick: the distance decides")
        #expect(EdgeDrawer.settlesOpen(wasOpen: false, translation: 20, velocity: EdgeDrawer.flickVelocity, width: 300), "a flick starts at its threshold")
    }

    // MARK: What opens and closes it

    @Test func thePersonOpensItByDraggingOrByTheButton() {
        #expect(EdgeDrawer.isOpen(after: .pulledOpen, wasOpen: false))
        #expect(EdgeDrawer.isOpen(after: .openedByButton, wasOpen: false), "VoiceOver, Switch Control and Voice Control cannot drag from an edge")
    }

    @Test func aTapOnThePageADragToTheLeftAndTheEscapeActionCloseIt() {
        #expect(!EdgeDrawer.isOpen(after: .tappedPage, wasOpen: true))
        #expect(!EdgeDrawer.isOpen(after: .pushedClosed, wasOpen: true))
        #expect(!EdgeDrawer.isOpen(after: .dismissed, wasOpen: true), "the escape action of VoiceOver, and the button that hides it")
    }

    @Test func showingAPageClosesIt() {
        #expect(!EdgeDrawer.isOpen(after: .pageShown, wasOpen: true), "a tab, a favourite, an archived page or a new tab: the page is the point")
    }

    @Test func choosingASpaceLeavesItOut() {
        #expect(EdgeDrawer.isOpen(after: .spaceChosen, wasOpen: true), "the sidebar lists the tabs of the space that was chosen")
        #expect(!EdgeDrawer.isOpen(after: .spaceChosen, wasOpen: false), "and choosing a space never opens it")
    }

    @Test func theLockClosesIt() {
        #expect(!EdgeDrawer.isOpen(after: .applicationLocked, wasOpen: true), "it names tabs and sites: nothing stays over the lock screen")
    }
}
