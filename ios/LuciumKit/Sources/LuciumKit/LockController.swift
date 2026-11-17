import Foundation
import Observation

/// Why the owner is asked. The system prompt says it in the person's language (the application's authenticator turns it into a text).
public enum LockPurpose: Equatable, Sendable {
    case unlockApp
    case unlockSpace
    case turnOn
    case turnOff
}

/// Why the owner was not confirmed.
public enum LockRefusal: Equatable, Sendable {
    /// The person (or the system, or a call) cancelled the prompt.
    case cancelled
    /// The owner was not recognised: wrong face, finger or passcode.
    case failed
    /// The device cannot ask right now (no passcode, nothing to ask with).
    case unavailable
}

public enum LockOutcome: Equatable, Sendable {
    case granted
    case refused(LockRefusal)
}

/// What asks the owner: Face ID, Touch ID or the passcode of the device (`LocalAuthentication`, in the application). Behind a protocol so that
/// the rules below are proved here, on the Mac, with an owner that agrees and one that refuses.
public protocol LockAuthenticating: Sendable {
    /// Whether this device can check the owner at all: false when it has no passcode. A lock on a device nobody has to unlock protects nothing.
    func canCheckOwner() -> Bool
    func authenticate(purpose: LockPurpose) async -> LockOutcome
}

/// What the screen tells the person after the last attempt.
public enum LockNotice: Equatable, Sendable {
    case refused(LockRefusal)
    /// The lock cannot be turned on: the device has no passcode.
    case noPasscode
    /// A change was not made because it could not be kept (the file could not be written).
    case saveFailed
    /// The settings could not be read: the application is locked until the person has opened it.
    case settingsUnreadable
    /// The device lost its passcode: the lock was turned off.
    case switchedOffNoPasscode
}

/// The lock of the interface: which of the application and its spaces are covered, and the only ways to open or change that. Opening asks the
/// owner; so does turning a lock on or off (the owner proves the lock can be opened before it is on, and a thief of the unlocked phone cannot
/// quietly turn it off). A refusal changes nothing. The web views are not here: `onChange` tells the browser, which puts the pages that are
/// covered to sleep.
@MainActor @Observable
public final class LockController {
    public private(set) var session: LockSession
    public private(set) var notice: LockNotice?
    /// A prompt is on screen: another is not asked for.
    public private(set) var isAuthenticating = false
    /// The application was locked and has not been asked about since: the screen opens the prompt once when it comes back (not each time it comes
    /// back from a prompt the person cancelled).
    public private(set) var promptPending: Bool

    @ObservationIgnored private let authenticator: any LockAuthenticating
    @ObservationIgnored private let file: LockSettingsFile?
    /// Counts the times Lucium was left. A prompt that was answered after that is not honoured: it was asked of a screen that is gone.
    @ObservationIgnored private var generation = 0
    /// Called after every change of what is locked.
    @ObservationIgnored public var onChange: (@MainActor () -> Void)?

    /// - `file`: where the choices are kept; none keeps them in memory only (tests).
    /// - `spaceIds`: the spaces that exist; a guarded space that does not any more is dropped.
    public init(authenticator: any LockAuthenticating, file: LockSettingsFile? = nil, spaceIds: Set<String>? = nil) {
        self.authenticator = authenticator
        self.file = file
        var settings = LockSettings()
        var first: LockNotice?
        if let file {
            switch file.load() {
            case .none: break
            case .loaded(let loaded): settings = loaded.cleaned(spaceIds: spaceIds)
            case .unreadable:
                // A lock whose settings are unreadable must not fail open: the application is locked, and the person opens it with the device.
                settings = LockSettings(lockApp: true)
                first = .settingsUnreadable
            }
        } else if let spaceIds {
            settings = settings.cleaned(spaceIds: spaceIds)
        }
        let launch = LockSession(settings: settings)
        session = launch
        notice = first
        promptPending = launch.appLocked
        recheckDevice()
    }

    // MARK: Reading

    public var appLocked: Bool { session.appLocked }
    public func covers(space id: String) -> Bool { session.covers(space: id) }
    public func isSpaceLocked(_ id: String) -> Bool { session.isSpaceLocked(id) }
    public func isGuarded(_ id: String) -> Bool { session.settings.lockedSpaces.contains(id) }
    public var lockApp: Bool { session.settings.lockApp }
    public var isActive: Bool { session.settings.isActive }
    public func coversScreen(sceneActive: Bool) -> Bool { session.coversScreen(sceneActive: sceneActive) }

    // MARK: Locking

    /// Lucium is left: everything set to be locked is locked, and a prompt that is still open is not honoured when it answers.
    public func lockAll() {
        generation += 1
        session.lockAll()
        promptPending = session.appLocked
        changed()
    }

    /// The device may have lost its passcode while Lucium was away. With nothing to ask the owner, the lock cannot be opened and protects
    /// nothing: it is turned off (the Mac does the same when its phrase file is gone), and the person is told.
    public func recheckDevice() {
        guard session.settings.isActive, !authenticator.canCheckOwner() else { return }
        let off = LockSettings()
        if !persist(off) { print("[lock] the lock was turned off in memory only: the file will be corrected at the next change") }
        session.apply(off)
        promptPending = false
        notice = .switchedOffNoPasscode
        changed()
    }

    /// The person has read the notice.
    public func dismissNotice() { notice = nil }

    // MARK: Opening

    /// Asks the owner for the application. True when it is open.
    @discardableResult
    public func unlockApp() async -> Bool {
        guard session.appLocked else { return true }
        guard await confirm(.unlockApp) else { return false }
        session.unlockApp()
        changed()
        return true
    }

    /// Asks the owner for one space. True when it is open. A space under a locked application is not opened: the application comes first.
    @discardableResult
    public func unlock(space id: String) async -> Bool {
        guard !session.appLocked else { return false }
        guard session.isSpaceLocked(id) else { return true }
        guard await confirm(.unlockSpace) else { return false }
        session.unlock(space: id)
        changed()
        return true
    }

    /// The screen is back and the application is locked: asks once (see `promptPending`).
    public func promptIfPending() async {
        guard promptPending else { return }
        promptPending = false
        await unlockApp()
    }

    // MARK: Changing

    /// Turns the lock of the application on or off, after the owner is confirmed. True when it is done.
    @discardableResult
    public func setLockApp(_ on: Bool) async -> Bool {
        guard on != session.settings.lockApp else { return true }
        var settings = session.settings
        settings.lockApp = on
        return await change(to: settings, turningOn: on)
    }

    /// Guards or releases one space, after the owner is confirmed. True when it is done.
    @discardableResult
    public func setSpace(_ id: String, guarded: Bool) async -> Bool {
        guard guarded != isGuarded(id) else { return true }
        var settings = session.settings
        if guarded {
            guard settings.lockedSpaces.count < LockSettings.maxSpaces else { return false }
            settings.lockedSpaces.append(id)
        } else {
            settings.lockedSpaces.removeAll { $0 == id }
        }
        return await change(to: settings, turningOn: guarded)
    }

    /// Drops the guarded spaces that do not exist any more (the spaces of the state, read after the controller).
    public func reconcile(spaceIds: Set<String>) {
        let cleaned = session.settings.cleaned(spaceIds: spaceIds)
        guard cleaned != session.settings else { return }
        if !persist(cleaned) { print("[lock] the guarded spaces that are gone were dropped in memory only") }
        session.apply(cleaned)
        changed()
    }

    // MARK: Inside

    private func change(to settings: LockSettings, turningOn: Bool) async -> Bool {
        if turningOn, !authenticator.canCheckOwner() {
            notice = .noPasscode
            return false
        }
        guard await confirm(turningOn ? .turnOn : .turnOff) else { return false }
        // The change counts only when it is kept: a lock that is on until the next launch and then gone, or off now and on later, is a lie.
        guard persist(settings) else {
            notice = .saveFailed
            return false
        }
        session.apply(settings)
        changed()
        return true
    }

    private func confirm(_ purpose: LockPurpose) async -> Bool {
        guard !isAuthenticating else { return false }
        isAuthenticating = true
        let before = generation
        let outcome = await authenticator.authenticate(purpose: purpose)
        isAuthenticating = false
        guard generation == before else {
            notice = .refused(.cancelled)
            return false
        }
        switch outcome {
        case .granted:
            notice = nil
            return true
        case .refused(let reason):
            notice = .refused(reason)
            return false
        }
    }

    /// Keeps the settings. False when they could not be kept; the reason is logged with the file.
    private func persist(_ settings: LockSettings) -> Bool {
        guard let file else { return true }
        do {
            try file.save(settings)
            return true
        } catch {
            print("[lock] \(file.url.path) was not written: \(error)")
            return false
        }
    }

    private func changed() { onChange?() }
}
