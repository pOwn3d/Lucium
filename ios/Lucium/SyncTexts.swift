import LuciumKit
import SwiftUI

/// What the synchronisation says (docs/synchronisation.md §13.3). Every key is written out where it is read, so that the catalogue is checked against the code
/// (`ios-contract.test.ts`): a text nobody reads, or a code with no text, fails there. French and English are in `Localizable.xcstrings`.
enum SyncTexts {
    /// The sentence for a code of the protocol: what happened and what to do. It never shows a secret, an address or a fingerprint (§13.3).
    static func error(_ code: SyncErrorCode) -> LocalizedStringKey {
        switch code {
        case .badFrame, .tooLarge, .badMessage, .unknownType, .badSequence: "sync.error.protocol"
        case .unsupportedVersion: "sync.error.unsupported-version"
        case .invalidCode: "sync.error.invalid-code"
        case .notPaired: "sync.error.not-paired"
        case .fingerprintMismatch: "sync.error.fingerprint-mismatch"
        case .badProof: "sync.error.bad-proof"
        case .pairingExpired: "sync.error.pairing-expired"
        case .pairingUsed: "sync.error.pairing-used"
        case .pairingLocked: "sync.error.pairing-locked"
        case .pairingClosed: "sync.error.pairing-closed"
        case .pairingRefused: "sync.error.pairing-refused"
        case .rateLimited: "sync.error.rate-limited"
        case .timeout: "sync.error.timeout"
        case .busy: "sync.error.busy"
        case .locked: "sync.error.locked"
        case .stateTooNew: "sync.error.state-too-new"
        case .truncated: "sync.error.truncated"
        case .divergence: "sync.error.divergence"
        case .clockSkew: "sync.state.clock-skew"
        case .internal: "sync.error.internal"
        }
    }

    /// Why a pairing did not happen, in the words of the person; nil when there is nothing to say (the person cancelled).
    static func pairing(_ failure: SyncController.PairingFailure) -> LocalizedStringKey? {
        switch failure {
        case .code(let code): error(code)
        case .reach(.refused): "sync.state.waiting"
        case .reach(.unreachable): "sync.pairing.unreachable"
        case .reach(.localNetworkDenied): "sync.state.local-network-denied"
        case .reach(.fingerprintMismatch): "sync.error.fingerprint-mismatch"
        case .identity: "sync.error.identity"
        case .notConfirmed: "sync.pairing.not-confirmed"
        case .cancelled: nil
        }
    }

    /// The line of the state. A time is written by the system's own relative format, in the language of the interface.
    static func status(_ status: SyncStatus, now: Date = Date(), locale: Locale = .current) -> Text {
        func ago(_ milliseconds: Int) -> String {
            let formatter = RelativeDateTimeFormatter()
            formatter.locale = locale
            formatter.unitsStyle = .short
            return formatter.localizedString(for: Date(timeIntervalSince1970: Double(milliseconds) / 1000), relativeTo: now)
        }
        switch status {
        case .off: return Text("sync.state.off")
        case .noDevice: return Text("sync.state.no-device")
        case .idle: return Text("sync.state.idle")
        case .waiting: return Text("sync.state.waiting")
        case .unreachable: return Text("sync.state.unreachable")
        case .running: return Text("sync.state.running")
        case .macAnswered(let at):
            let when = ago(at)
            return Text("sync.state.mac-answered \(when)")
        case .upToDate(let at):
            let when = ago(at)
            return Text("sync.state.up-to-date \(when)")
        case .interrupted: return Text("sync.state.interrupted")
        case .localNetworkDenied: return Text("sync.state.local-network-denied")
        case .clockSkew: return Text("sync.state.clock-skew")
        case .failed(let code): return Text(error(code))
        case .identityLost: return Text("sync.state.identity-lost")
        }
    }

    /// The name of a category, as the list of the page writes it.
    static func categoryName(_ category: SyncCategory) -> String {
        switch category {
        case .structure: String(localized: "sync.category.structure")
        case .settings: String(localized: "sync.category.settings")
        case .archive: String(localized: "sync.category.archive")
        case .openTabs: String(localized: "sync.category.open-tabs")
        // The name of the category is a text of the interface change that follows (with its row and the box at pairing); the page does not list it yet, so no one reads this.
        case .todayTabs: category.rawValue
        }
    }

    /// One line of « Dernier échange » (the lines are worked out in LuciumKit, `SyncLastExchange`).
    static func lastExchange(_ line: SyncLastExchange.Line) -> Text {
        func names(_ categories: [SyncCategory]) -> String { categories.map(categoryName).joined(separator: ", ") }
        switch line {
        case .exchanged(let categories):
            if categories.isEmpty { return Text("sync.last.exchanged.none") }
            let list = names(categories)
            return Text("sync.last.exchanged \(list)")
        case .notExchanged(let categories):
            let list = names(categories)
            return Text("sync.last.not-exchanged \(list)")
        case .received(let count): return Text("sync.last.received \(count)")
        case .nothingNew: return Text("sync.last.nothing-new")
        case .leftAside(let count): return Text("sync.last.left-aside \(count)")
        }
    }
}
