import Foundation
import Testing
@testable import LuciumKit

struct PageDisplayTests {
    @Test func theStandardDisplayChangesNothing() {
        let display = PageDisplay.standard
        #expect(display.isStandard && !display.desktop && display.zoomPercent == 100 && display.zoomFactor == 1 && !display.isZoomed)
    }

    @Test func zoomingMovesOneStepAndStopsAtTheMacBounds() {
        var display = PageDisplay()
        display.zoomIn()
        #expect(display.zoomPercent == 115 && display.isZoomed)
        display.zoomOut(); display.zoomOut()
        #expect(display.zoomPercent == 85)
        for _ in 0..<20 { display.zoomOut() }
        #expect(display.zoomPercent == 50 && !display.canZoomOut && display.canZoomIn)
        for _ in 0..<30 { display.zoomIn() }
        #expect(display.zoomPercent == 300 && !display.canZoomIn && display.canZoomOut, "the ends are the Mac's: 50 % and 300 %")
        display.resetZoom()
        #expect(display.zoomPercent == 100 && display.isStandard)
    }

    @Test func aPercentageThatIsNotAStepBecomesTheNearestStep() {
        #expect(PageDisplay(zoomPercent: 0).zoomPercent == 50)
        #expect(PageDisplay(zoomPercent: 9_999).zoomPercent == 300)
        #expect(PageDisplay(zoomPercent: 130).zoomPercent == 125)
        #expect(PageDisplay(zoomPercent: -40).zoomPercent == 50)
    }

    @Test func theChoiceSurvivesAWriteAndARead() throws {
        var display = PageDisplay(desktop: true)
        display.zoomIn(); display.zoomIn()
        let read = PageDisplay.read(try display.encoded())
        #expect(read.display == display && !read.unreadable)
        #expect(read.display.desktop && read.display.zoomPercent == 125)
    }

    @Test func nothingKeptIsTheStandardDisplayWithoutComplaint() {
        let read = PageDisplay.read(nil)
        #expect(read.display == .standard && !read.unreadable)
    }

    @Test func aFileThatDoesNotReadIsTheStandardDisplayAndIsReported() {
        let read = PageDisplay.read(Data("not json".utf8))
        #expect(read.display == .standard && read.unreadable, "damaged data must not hide: the caller logs it")
        // A zoom written by a hand or a newer version is brought back to a step instead of being refused.
        let edited = PageDisplay.read(Data(#"{"desktop":true,"zoomPercent":131}"#.utf8))
        #expect(edited.display == PageDisplay(desktop: true, zoomPercent: 125) && !edited.unreadable)
    }

    @Test func theDisplayLivesInTheTabsFolderAndGoesWithTheTab() throws {
        let store = TabSideStore(directory: FileManager.default.temporaryDirectory.appending(path: "lucium-display-\(UUID().uuidString)"))
        try store.write(try PageDisplay(desktop: true).encoded(), kind: .display, for: "tab-1")
        #expect(PageDisplay.read(store.read(.display, for: "tab-1")).display.desktop)
        store.remove(for: "tab-1")
        #expect(store.read(.display, for: "tab-1") == nil, "closing a tab takes its display with it")
        try store.write(try PageDisplay(desktop: true).encoded(), kind: .display, for: "gone")
        #expect(store.prune(keeping: ["other"]) == 1, "a display of a tab that no longer exists is pruned")
    }
}
