import Testing
@testable import LuciumKit

@Suite("The navigation of the iPad in landscape")
struct NavigationLayoutTests {
    private func layout(_ width: Double, _ height: Double, regularWidth: Bool = true, regularHeight: Bool = true, largeText: Bool = false) -> NavigationLayout {
        NavigationLayout.choose(width: width, height: height, regularWidth: regularWidth, regularHeight: regularHeight, largeText: largeText)
    }

    @Test func anIPadHeldInLandscapeGetsTheSidebar() {
        #expect(layout(1180, 820) == .sidebar, "iPad Air 11-inch")
        #expect(layout(1194, 834) == .sidebar, "iPad Pro 11-inch")
        #expect(layout(1366, 1024) == .sidebar, "iPad Pro 13-inch")
        #expect(layout(1133, 744) == .sidebar, "iPad mini")
    }

    @Test func portraitKeepsTheBottomBar() {
        #expect(layout(820, 1180) == .bottomBar)
        #expect(layout(1024, 1366) == .bottomBar)
        #expect(layout(800, 800) == .bottomBar, "a square window is not landscape")
    }

    @Test func aNarrowWindowOfTheIPadKeepsTheBottomBar() {
        // Split View, Slide Over: the horizontal size class is compact however wide the other half leaves the window.
        #expect(layout(597, 834, regularWidth: false) == .bottomBar)
        #expect(layout(780, 600, regularWidth: false) == .bottomBar)
        // A Stage Manager window that is regular but narrower than the sidebar and a usable page.
        #expect(layout(699, 500) == .bottomBar)
        #expect(layout(700, 500) == .sidebar)
    }

    @Test func theLargestTextKeepsTheBottomBarOnAnIPadInLandscapeToo() {
        #expect(layout(1180, 820, largeText: true) == .bottomBar, "the sidebar is 320 points: no room for text that large")
        #expect(layout(1366, 1024, largeText: true) == .bottomBar)
        #expect(layout(1180, 820, largeText: false) == .sidebar)
    }

    @Test func anIPhoneInLandscapeKeepsTheBottomBarEvenWhenItsWidthIsRegular() {
        // The largest iPhones are regular in width when held sideways, but short: 320 points of sidebar would leave a strip of page.
        #expect(layout(932, 430, regularWidth: true, regularHeight: false) == .bottomBar)
        #expect(layout(852, 393, regularWidth: false, regularHeight: false) == .bottomBar)
        #expect(layout(393, 852, regularWidth: false, regularHeight: true) == .bottomBar)
    }
}

@Suite("The pinned outline of the sidebar")
struct SidebarOutlineTests {
    private func tab(_ id: String) -> PinnedRow {
        .tab(TabItem(id: id, spaceId: "s", url: "https://\(id).example/", title: id))
    }

    private func folder(_ id: String, count: Int = 1) -> PinnedRow {
        .folder(Folder(id: id, spaceId: "s", name: id), tabCount: count)
    }

    /// A small tree: a loose tab, then two folders; "meetings" holds a folder ("old") and a tab.
    private var tree: [String?: [PinnedRow]] {
        [nil: [tab("notebook"), folder("meetings", count: 3), folder("docs")],
         "meetings": [folder("old"), tab("monday")],
         "old": [tab("archive")],
         "docs": [tab("style")]]
    }

    private func ids(_ rows: [OutlineRow]) -> [String] { rows.map { String(repeating: ">", count: $0.depth) + $0.id } }

    @Test func aClosedFolderShowsOnlyItself() {
        let rows = SidebarOutline.rows(children: { tree[$0] ?? [] }, expanded: [])
        #expect(ids(rows) == ["tab:notebook", "folder:meetings", "folder:docs"])
        #expect(rows.allSatisfy { !$0.isExpanded })
    }

    @Test func anOpenFolderShowsItsContentRightUnderItOneLevelDeeper() {
        let rows = SidebarOutline.rows(children: { tree[$0] ?? [] }, expanded: ["meetings"])
        #expect(ids(rows) == ["tab:notebook", "folder:meetings", ">folder:old", ">tab:monday", "folder:docs"])
        #expect(rows.first { $0.id == "folder:meetings" }?.isExpanded == true)
        #expect(rows.first { $0.id == "folder:old" }?.isExpanded == false, "a folder inside opens on its own")
    }

    @Test func foldersOpenInsideEachOther() {
        let rows = SidebarOutline.rows(children: { tree[$0] ?? [] }, expanded: ["meetings", "old", "docs"])
        #expect(ids(rows) == ["tab:notebook", "folder:meetings", ">folder:old", ">>tab:archive", ">tab:monday", "folder:docs", ">tab:style"])
    }

    @Test func aFolderThatIsOpenButNotReachedDrawsNothing() {
        // "old" is open, but its parent is closed: it is not on screen, so its content is not either.
        let rows = SidebarOutline.rows(children: { tree[$0] ?? [] }, expanded: ["old"])
        #expect(ids(rows) == ["tab:notebook", "folder:meetings", "folder:docs"])
    }

    @Test func aLoopInAHandEditedTreeOpensOnceAndEnds() {
        // "a" holds "b" and "b" holds "a": both open, neither may open again inside itself.
        let loop: [String?: [PinnedRow]] = [nil: [folder("a")], "a": [folder("b")], "b": [folder("a"), tab("t")]]
        let rows = SidebarOutline.rows(children: { loop[$0] ?? [] }, expanded: ["a", "b"])
        #expect(ids(rows) == ["folder:a", ">folder:b", ">>folder:a", ">>tab:t"])
        #expect(rows[2].isExpanded == false, "the second \"a\" does not open: it is its own ancestor")
    }

    @Test func nothingGoesDeeperThanTheMostLevelsAFolderCanHave() {
        var chain: [String?: [PinnedRow]] = [nil: [folder("f0")]]
        for level in 0..<8 { chain["f\(level)"] = [folder("f\(level + 1)")] }
        let rows = SidebarOutline.rows(children: { chain[$0] ?? [] }, expanded: Set((0..<9).map { "f\($0)" }))
        #expect(rows.map(\.depth).max() == Library.folderMaxDepth)
    }

    @Test func aReaderThatSaysNothingGivesAnEmptyOutline() {
        // What the model's reader gives for a locked space: the sidebar draws no row of it.
        #expect(SidebarOutline.rows(children: { _ in [] }, expanded: ["meetings"]).isEmpty)
    }
}
