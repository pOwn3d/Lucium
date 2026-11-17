import LocalAuthentication
import LuciumKit

/// Asks the owner of the phone with what the system has: Face ID or Touch ID, then the passcode of the device (`deviceOwnerAuthentication`). Lucium
/// keeps no secret of its own: there is no phrase to forget, and what the system checks never reaches the application.
struct SystemAuthenticator: LockAuthenticating {
    /// False makes the system refuse at once instead of showing its prompt: what the tests use to ask the real system without a person.
    var interactive = true

    func canCheckOwner() -> Bool {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) { return true }
        // Without a passcode nothing can ask the owner. Any other reason (the screen is off, a lock-out) is a passing state: the prompt itself says it.
        return !Self.isNoPasscode(error)
    }

    func authenticate(purpose: LockPurpose) async -> LockOutcome {
        do {
            let context = LAContext()
            context.interactionNotAllowed = !interactive
            let confirmed = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: Self.reason(for: purpose))
            return Self.outcome(confirmed: confirmed)
        } catch {
            let outcome = Self.outcome(for: error)
            print("[lock] the owner was not confirmed: \(error) (\(outcome))")
            return outcome
        }
    }

    /// What the system prompt says, in the language of the interface (it is read once, at the moment of the prompt).
    static func reason(for purpose: LockPurpose, bundle: Bundle = .main) -> String {
        switch purpose {
        case .unlockApp: String(localized: "lock.reason.unlock-app", bundle: bundle)
        case .unlockSpace: String(localized: "lock.reason.unlock-space", bundle: bundle)
        case .turnOn: String(localized: "lock.reason.turn-on", bundle: bundle)
        case .turnOff: String(localized: "lock.reason.turn-off", bundle: bundle)
        }
    }

    /// The system says it only returns true or throws; a false that comes back anyway is not an opening.
    static func outcome(confirmed: Bool) -> LockOutcome { confirmed ? .granted : .refused(.failed) }

    /// What an error of the system means for the lock. Only a recognised cancellation is a cancellation, and only a missing passcode or a device that
    /// cannot ask is "unavailable": anything else, an unknown error included, is a refusal. Nothing but a confirmation opens.
    static func outcome(for error: Error) -> LockOutcome {
        guard let code = (error as? LAError)?.code else { return .refused(.failed) }
        switch code {
        case .userCancel, .systemCancel, .appCancel, .userFallback: return .refused(.cancelled)
        case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .notInteractive: return .refused(.unavailable)
        default: return .refused(.failed)
        }
    }

    private static func isNoPasscode(_ error: NSError?) -> Bool {
        error?.domain == LAError.errorDomain && error?.code == LAError.Code.passcodeNotSet.rawValue
    }
}
