import Foundation

/// What the page "Synchronisation" says (docs/synchronisation.md §13.3). One value at a time; the screen maps each to a text, and an error to the text of its
/// code. A state is a statement of what happened, never of what is hoped: `.upToDate` is for the day a session has really merged and the Mac's `commit` has
/// been read (the session body, which is not written yet), and `.macAnswered` is what is said until then.
public enum SyncStatus: Equatable, Sendable {
    /// The switch is off.
    case off
    /// On, and no Mac is paired.
    case noDevice
    /// On, a Mac is paired, and there has been no session yet.
    case idle
    /// The Mac refused the connection: it is on this network but its synchronisation window is closed (or the Mac is locked). Not an error (§8.1).
    case waiting
    /// No address of the Mac answered.
    case unreachable
    /// A session is open.
    case running
    /// The Mac answered and agreed on what to exchange; the exchange of the data itself is not made. Said honestly, never as "up to date".
    case macAnswered(at: Int)
    /// The Mac's `commit` has been read: both devices hold the same merged state.
    case upToDate(at: Int)
    /// The connection dropped in the middle of a session (§8.5): nothing was applied, and the next session starts again.
    case interrupted
    /// iOS did not let Lucium reach the local network.
    case localNetworkDenied
    /// The clocks differ by more than five minutes (a warning: the session goes on).
    case clockSkew
    /// A session stopped for the reason the code gives.
    case failed(SyncErrorCode)
    /// The key was lost (a restore, a reinstall): the Mac is forgotten and has to be paired again (§3.3).
    case identityLost

    /// Whether another session may be started from the screen now.
    public var canStartSession: Bool {
        switch self {
        case .off, .noDevice, .running, .identityLost: false
        default: true
        }
    }
}

/// When a session may start by itself (§8.1). Pure: the controller gives it the facts and the time.
public enum SyncScheduler {
    public enum Trigger: Equatable, Sendable {
        case launch, foreground, localChange, manual
    }

    public enum Decision: Equatable, Sendable {
        /// Start after this delay (to group changes, §8.1).
        case start(after: Duration)
        case skip(Reason)
    }

    public enum Reason: Equatable, Sendable { case off, noMac, appLocked, alreadyRunning, tooSoon }

    /// - Parameter sinceLastStart: how long ago the last session started, or nil when none did in this run.
    public static func decide(_ trigger: Trigger, enabled: Bool, hasMac: Bool, appLocked: Bool, running: Bool, sinceLastStart: Duration?) -> Decision {
        guard enabled else { return .skip(.off) }
        guard hasMac else { return .skip(.noMac) }
        guard !appLocked else { return .skip(.appLocked) }
        guard !running else { return .skip(.alreadyRunning) }
        // The person's own request is never held back by the 15-second rule, only by the fact that a session is open.
        if trigger != .manual, let since = sinceLastStart, since < SyncLimits.minimumAutomaticInterval { return .skip(.tooSoon) }
        switch trigger {
        case .launch, .manual: return .start(after: .zero)
        case .foreground: return .start(after: .seconds(5))
        case .localChange: return .start(after: .seconds(30))
        }
    }
}
