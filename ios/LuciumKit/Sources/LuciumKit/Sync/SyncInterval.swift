import Foundation

/// How often the phone opens a session by itself while Lucium is on the screen (docs/synchronisation.md §8.1, card 505): the person chooses on the page
/// « Synchronisation ». One minute until they choose another.
public enum SyncInterval: Int, CaseIterable, Codable, Sendable, Identifiable {
    case seconds30 = 30
    case minute1 = 60
    case minutes5 = 300
    case minutes15 = 900

    public static let `default`: SyncInterval = .minute1

    public var id: Int { rawValue }
    public var duration: Duration { .seconds(rawValue) }
}

/// When the next automatic session is due (§8.1). Pure: the controller gives it the interval and how many sessions in a row have not gone through.
public enum SyncAutoSchedule {
    /// Failures in a row (the Mac off, on another network, locked, a session cut) before the phone slows down.
    public static let failuresBeforeBackoff = 3
    /// The longest wait the slowing down reaches: the longest interval the person can choose.
    public static let longestDelay: Duration = .seconds(900)

    /// The wait before the next automatic session. The chosen interval while sessions go through and for the first two failures; from the third failure it doubles at each
    /// failure more, up to `longestDelay`, and never below the chosen interval. A session that goes through, a return to the front and « Synchroniser maintenant » reset the count.
    public static func delay(interval: SyncInterval, consecutiveFailures: Int) -> Duration {
        guard consecutiveFailures >= failuresBeforeBackoff else { return interval.duration }
        let doublings = min(consecutiveFailures - failuresBeforeBackoff + 1, 10)
        let slowed = interval.duration * (1 << doublings)
        return max(interval.duration, min(slowed, longestDelay))
    }
}
