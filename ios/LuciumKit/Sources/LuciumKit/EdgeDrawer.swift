import Foundation

/// What can happen to the sidebar that slides out from the left edge of an iPhone (decision of the project lead, 18 November 2026). Each case says
/// what the person did, never what the screen should do: `EdgeDrawer.isOpen(after:wasOpen:)` is the one place that knows what closes the sidebar.
public enum EdgeDrawerEvent: Equatable, Sendable {
    /// A drag from the left edge ended far enough (or fast enough) to keep the sidebar out.
    case pulledOpen
    /// The accessible button, for a person who cannot drag from the edge (VoiceOver, Switch Control, Voice Control).
    case openedByButton
    /// A drag to the left ended far enough (or fast enough) to put the sidebar away.
    case pushedClosed
    /// A tap on the page that is dimmed behind the sidebar.
    case tappedPage
    /// The "escape" action of VoiceOver (the two-finger scrub), or the button that hides the sidebar.
    case dismissed
    /// A page is on screen: a tab, a favourite or an archived page was opened, or a new tab was made. The sidebar has done its work.
    case pageShown
    /// Another space was chosen in the sidebar: it stays out, and lists that space's tabs, so that the tab to open can be chosen in it. (A folder opened,
    /// a tab pinned, archived or closed are not events either: they leave the sidebar as it is.)
    case spaceChosen
    /// The application locked: nothing may stay over the lock screen.
    case applicationLocked
}

/// The sidebar that slides out from the left edge of an iPhone, above the page. It holds what the iPad's sidebar holds (the same views); this is the
/// part that has no view: how wide it is, where it is while a finger drags it, where it settles, and what closes it.
public enum EdgeDrawer {
    /// The share of the screen's width the sidebar takes: the rest is the page, dimmed, that a tap puts the sidebar away from.
    public static let widthFraction = 0.85
    /// No sidebar is wider than this, so that an iPhone held sideways keeps a page beside it.
    public static let maxWidth = 420.0
    /// With the largest sizes of text (the accessibility ones) a line needs room: the sidebar takes the screen but a strip this wide, which is still
    /// a target for a finger (44 points, what Apple asks for).
    public static let largeTextMargin = 44.0
    /// A sidebar for the largest sizes of text is wider, but a landscape iPhone is not given the whole screen either.
    public static let largeTextMaxWidth = 640.0

    /// A drag from the closed state keeps the sidebar out once it pulled out this much of it.
    public static let openFraction = 0.35
    /// A drag from the open state puts the sidebar away once it pushed back this much of it (it is easier to close than to open: the page is under
    /// the thumb and the sidebar is in the way).
    public static let closeFraction = 0.25
    /// A drag faster than this, in points per second, decides by its direction whatever the distance (a flick).
    public static let flickVelocity = 450.0

    /// The width of the sidebar on a screen `screenWidth` points wide.
    public static func width(screenWidth: Double, largeText: Bool = false) -> Double {
        guard screenWidth > 0 else { return 0 }
        if largeText { return min(max(screenWidth * widthFraction, screenWidth - largeTextMargin), largeTextMaxWidth) }
        return min(screenWidth * widthFraction, maxWidth)
    }

    /// Only an iPhone has this sidebar: the iPad has the permanent one in landscape (`NavigationLayout.sidebar`) and its bottom bar elsewhere, as it
    /// did before. The window must also be the one that has the bottom bar, which every iPhone window is.
    public static func isAvailable(layout: NavigationLayout, isPhone: Bool) -> Bool {
        isPhone && layout == .bottomBar
    }

    /// WebKit's own swipe back and forward, from the left edge, is turned off on the iPhone (the same edge is this sidebar's; going back is the
    /// button of the bottom bar). The iPad keeps it.
    public static func allowsWebKitBackGesture(isPhone: Bool) -> Bool { !isPhone }

    /// How far out the sidebar is, from 0 (away) to 1 (all out), while a finger has dragged `translation` points to the right (negative: to the left)
    /// since the drag began, from the state it was in then.
    public static func progress(wasOpen: Bool, translation: Double, width: Double) -> Double {
        guard width > 0 else { return 0 }
        let start = wasOpen ? 1.0 : 0.0
        return min(1, max(0, start + translation / width))
    }

    /// Where the sidebar settles when the finger lifts: out (true) or away (false). A flick decides by its direction; a slower drag by how far the
    /// sidebar was dragged (`openFraction`, `closeFraction`).
    public static func settlesOpen(wasOpen: Bool, translation: Double, velocity: Double, width: Double) -> Bool {
        if abs(velocity) >= flickVelocity { return velocity > 0 }
        let reached = progress(wasOpen: wasOpen, translation: translation, width: width)
        return wasOpen ? reached > 1 - closeFraction : reached >= openFraction
    }

    /// What the visible sidebar button of the bottom bar does (card 664): it brings the sidebar out when it is away and puts it away when it is out, so
    /// that a person who does not think of the edge drag, or on whose page the drag does not work (a carousel takes it), has the same sidebar.
    public static func buttonEvent(wasOpen: Bool) -> EdgeDrawerEvent {
        wasOpen ? .dismissed : .openedByButton
    }

    /// Whether the sidebar is out after `event`. The sidebar goes away when a page is shown, when the person puts it away, and when it has no place
    /// any more (the application locks); it stays while the person is only choosing (another space).
    public static func isOpen(after event: EdgeDrawerEvent, wasOpen: Bool) -> Bool {
        switch event {
        case .pulledOpen, .openedByButton:
            return true
        case .pushedClosed, .tappedPage, .dismissed, .pageShown, .applicationLocked:
            return false
        case .spaceChosen:
            return wasOpen
        }
    }
}
