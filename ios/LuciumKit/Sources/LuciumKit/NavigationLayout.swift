import Foundation

/// Which navigation the screen has: the bar at the bottom (approach C of the mockups, `C1`) or the permanent sidebar of the iPad in landscape
/// (the `iPad · paysage` mockup). The choice follows the room the window has, not the device, so a window of the iPad that is narrowed (Split View,
/// Slide Over, a small Stage Manager window) goes back to the bar by itself and comes back to the sidebar when it grows.
public enum NavigationLayout: Equatable, Sendable {
    case bottomBar
    case sidebar

    /// The width of the sidebar, in points (the mockup's).
    public static let sidebarWidth = 320.0
    /// The narrowest window that gets the sidebar: it leaves the page at least 380 points next to the 320 of the sidebar.
    public static let minimumWidth = 700.0

    /// The sidebar needs the room of an iPad held in landscape: a window that is wide in both the horizontal and the vertical size class (an
    /// iPhone in landscape is short, a half of Split View is narrow, so both keep the bar) and that is wider than it is tall (portrait keeps the
    /// bar, as the docs say: the sidebar is for landscape). The largest sizes of text (the accessibility ones) keep the bar too: 320 points hold
    /// a line of such text for a word or two, where the full-screen sheet of tabs, drawn for them, holds it whole.
    public static func choose(width: Double, height: Double, regularWidth: Bool, regularHeight: Bool, largeText: Bool = false) -> NavigationLayout {
        guard regularWidth, regularHeight, !largeText, width > height, width >= minimumWidth else { return .bottomBar }
        return .sidebar
    }
}
