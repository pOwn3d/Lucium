import Testing
@testable import LuciumKit

@Suite("The pull of the bottom bar")
struct BarPullTests {
    @Test func aSlowDragUpOpensTheTabsOnceItWentFarEnough() {
        #expect(BarPull.opensTabs(dx: 0, dy: -BarPull.minimumDistance, velocityY: -50))
        #expect(!BarPull.opensTabs(dx: 0, dy: -(BarPull.minimumDistance - 1), velocityY: -50), "a finger that slipped")
    }

    @Test func aFlickUpOpensThemFromAShorterDistance() {
        #expect(BarPull.opensTabs(dx: 0, dy: -20, velocityY: -BarPull.flickVelocity))
        #expect(!BarPull.opensTabs(dx: 0, dy: -5, velocityY: -2000), "a wobble is not a flick")
    }

    @Test func aDragDownOpensNothing() {
        #expect(!BarPull.opensTabs(dx: 0, dy: 80, velocityY: 900))
        #expect(!BarPull.opensTabs(dx: 0, dy: 0, velocityY: 0))
    }

    @Test func aSidewaysDragIsNotThePulls() {
        #expect(!BarPull.opensTabs(dx: 90, dy: -60, velocityY: -100), "mostly sideways")
        #expect(BarPull.opensTabs(dx: 20, dy: -60, velocityY: -100), "slightly slanted is still a pull")
    }
}
