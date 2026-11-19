import Foundation

/// The "pull the bar" gesture of the bottom bar (`C1 · Navigation`, card 679): a drag that starts on the bar and goes up brings out the tabs of the
/// space, as a swipe up on Safari's address bar does. This is the part that has no view: which drags count. The button of the tabs stays, for a person
/// who cannot drag (VoiceOver, Switch Control, Voice Control).
public enum BarPull {
    /// A drag must go up this far, in points, to open the tabs: less is a finger that slipped while tapping a button.
    public static let minimumDistance = 40.0
    /// A drag faster than this, in points per second, opens the tabs from a shorter distance (a flick).
    public static let flickVelocity = 450.0
    /// A flick still has to go up this far, so that a tap that wobbles is not one.
    public static let flickMinimumDistance = 14.0
    /// The drag must be this many times longer up than sideways: a sideways drag is the page's or a row's, not the bar's.
    public static let verticalRatio = 1.5

    /// Whether a drag that moved `dx` to the right and `dy` down (negative: up) points, with `velocityY` points per second (negative: up), opens the tabs.
    public static func opensTabs(dx: Double, dy: Double, velocityY: Double) -> Bool {
        let up = -dy
        guard up > 0, up >= abs(dx) * verticalRatio else { return false }
        if up >= minimumDistance { return true }
        return -velocityY >= flickVelocity && up >= flickMinimumDistance
    }
}
