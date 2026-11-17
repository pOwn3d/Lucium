import Foundation

/// What the application knows about a tab that has a live web view, when it has to decide which ones to free.
public struct AwakeTab: Equatable, Sendable {
    public var id: String
    /// When the tab was last shown, in milliseconds (`lastActiveAt`).
    public var lastShownAt: Double
    public var isSelected: Bool
    public var isLoading: Bool
    /// A video or a sound is playing: freeing the page would cut it.
    public var isPlayingMedia: Bool
    /// The page holds the camera or the microphone: freeing it would end a call.
    public var isCapturing: Bool
    public var keepAwake: Bool

    public init(id: String, lastShownAt: Double, isSelected: Bool = false, isLoading: Bool = false, isPlayingMedia: Bool = false,
                isCapturing: Bool = false, keepAwake: Bool = false) {
        self.id = id; self.lastShownAt = lastShownAt; self.isSelected = isSelected; self.isLoading = isLoading
        self.isPlayingMedia = isPlayingMedia; self.isCapturing = isCapturing; self.keepAwake = keepAwake
    }
}

/// Which tabs lose their web view. A sleeping tab keeps its place, its title, a picture and the state of its page; only the live view (the
/// memory) goes. The rules are those of the Mac's `sleepVerdict` (`src/shared/sleep.ts`) that apply on a phone: the tab on screen and a tab
/// that is loading, playing, capturing or marked "never put to sleep" stay awake; the least recently shown goes first.
public enum SleepPlanner {
    /// How many web views live at once, the one on screen included. A first guess for a phone, to be measured on a real device (docs/ios.md).
    public static let defaultCap = 4
    /// What is left under memory pressure: only the tab on screen.
    public static let pressureCap = 1

    /// The ids to put to sleep, the least recently shown first. `cap` is the number of web views to keep; the tab on screen counts and is never
    /// chosen. Tabs that must stay awake count too, so the result can leave more than `cap` awake rather than cut a call or a video. Under
    /// `pressure` (iOS warned about memory) only the tab on screen is spared: a page that is freed can be loaded again, an application that is
    /// killed cannot.
    public static func tabsToSleep(_ awake: [AwakeTab], cap: Int = defaultCap, underPressure pressure: Bool = false) -> [String] {
        let limit = max(pressure ? min(cap, pressureCap) : cap, 1)
        var remaining = awake.count
        guard remaining > limit else { return [] }
        let candidates = awake
            .filter { !$0.isSelected && (pressure || !($0.isLoading || $0.isPlayingMedia || $0.isCapturing || $0.keepAwake)) }
            .sorted { ($0.lastShownAt, $0.id) < ($1.lastShownAt, $1.id) }
        var chosen: [String] = []
        for tab in candidates where remaining > limit {
            chosen.append(tab.id)
            remaining -= 1
        }
        return chosen
    }
}
