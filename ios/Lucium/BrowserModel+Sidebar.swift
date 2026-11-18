import LuciumKit
import SwiftUI

/// What the iPad's sidebar lists, read in one place and only through the model's readers, which are the ones that say nothing for a space that is
/// locked (`BrowserModel+Library.swift`): a favourite, a pinned tab, a folder or a Today tab of a locked space is never in it, whatever the sidebar
/// draws. Reading `state` directly here would walk around the lock; a test plays a locked space against this.
struct SidebarContent {
    /// The favourites of the profile of the space on screen, as tiles.
    let favorites: [Favorite]
    /// The pinned tabs and the folders, as one column where the folders in `expanded` are open.
    let outline: [OutlineRow]
    /// The Today tabs of the space on screen.
    let today: [TabItem]
    /// The space on screen is locked: the lists above are empty because of it, and the sidebar says so.
    let isCovered: Bool
}

extension BrowserModel {
    func sidebarContent(expanded: Set<String>) -> SidebarContent {
        SidebarContent(favorites: favorites,
                       outline: SidebarOutline.rows(children: { pinnedRows(inside: $0) }, expanded: expanded),
                       today: todayTabs,
                       isCovered: activeSpaceCovered)
    }
}
