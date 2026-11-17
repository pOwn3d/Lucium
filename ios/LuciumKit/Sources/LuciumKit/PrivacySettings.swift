import Foundation

/// The three rewrites of the privacy options (`PrivacyOptions` in `src/shared/privacy.ts`).
public struct PrivacyOptions: Equatable, Sendable {
    /// A main-frame navigation to `http://` goes to `https://` first, and falls back to `http://` when the site does not answer.
    public var httpsUpgrade: Bool
    /// Every navigation carries `Sec-GPC: 1` and the page can read `navigator.globalPrivacyControl`: the person does not consent to the sale or sharing of their data.
    public var globalPrivacyControl: Bool
    /// The known tracking parameters are removed from the address a main-frame navigation goes to.
    public var stripTrackingParams: Bool

    public init(httpsUpgrade: Bool, globalPrivacyControl: Bool, stripTrackingParams: Bool) {
        self.httpsUpgrade = httpsUpgrade; self.globalPrivacyControl = globalPrivacyControl; self.stripTrackingParams = stripTrackingParams
    }

    public static let none = PrivacyOptions(httpsUpgrade: false, globalPrivacyControl: false, stripTrackingParams: false)
}

/// What `PrivacyRules.rewriteNavigation` needs to know of a request.
public struct RewriteRequest: Equatable, Sendable {
    public var url: String
    public var method: String
    /// True for the document of a tab (not an image, a script or a frame).
    public var isMainFrame: Bool

    public init(url: String, method: String = "GET", isMainFrame: Bool = true) {
        self.url = url; self.method = method; self.isMainFrame = isMainFrame
    }
}

public enum PrivacyRules {
    /// Where a main-frame GET should go instead, per the options, or nil to leave it. The tracking parameters come off first, then the result is
    /// upgraded: one rewrite per request, and each round only ever removes parameters or moves from http to https, so a chain of redirects ends.
    /// `upgrade` is how the caller decides whether this http address may be upgraded now (it remembers the addresses it already tried, which is what
    /// stops a site that sends https visitors back to http from looping). The twin of `rewriteNavigation` on the Mac.
    public static func rewriteNavigation(_ request: RewriteRequest, options: PrivacyOptions, upgrade: (String) -> String?) -> String? {
        guard request.isMainFrame, request.method == "GET" else { return nil }
        var url = request.url
        var changed = false
        if options.stripTrackingParams, let stripped = TrackingParams.strip(url) {
            url = stripped
            changed = true
        }
        if options.httpsUpgrade, let upgraded = upgrade(url), upgraded != url { return upgraded }
        return changed ? url : nil
    }
}

/// How well protected a profile is, in the words of the Mac's protection levels (`presets.protection`): « Standard » sends no signal and keeps the
/// addresses as they are, « Renforcée » (enhanced) sends the signal and cleans the addresses opened and copied. The Mac has a third level, « Stricte »,
/// whose extras (the blocker's strict mode, the fingerprint noise) the iPhone does not have yet.
public enum ProtectionLevel: String, CaseIterable, Sendable {
    case standard, enhanced
}

/// The privacy settings of a profile, under the names and with the rules of the Mac's `Settings` (`httpsUpgrade`, `sendGpc`, `stripTrackingParams`,
/// `stripCopiedLinks`, `protectionBaseline`), read from and written to the `settings` of the state file: the file stays the Mac's, so a state that
/// goes from one device to the other (phase 2) carries them as they are.
public struct PrivacySettings: Equatable, Sendable {
    public var httpsUpgrade: Bool
    public var sendGpc: Bool
    public var stripTrackingParams: Bool
    public var stripCopiedLinks: Bool

    public init(httpsUpgrade: Bool, sendGpc: Bool, stripTrackingParams: Bool, stripCopiedLinks: Bool) {
        self.httpsUpgrade = httpsUpgrade; self.sendGpc = sendGpc; self.stripTrackingParams = stripTrackingParams; self.stripCopiedLinks = stripCopiedLinks
    }

    /// A new profile starts at « Renforcée » (`PROTECTION_OF_NEW_PROFILES`), with HTTPS first on.
    public static let newProfile = PrivacySettings(httpsUpgrade: true, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true)

    /// What a profile saved before « Renforcée » was the default has for the four settings it never chose (`PROTECTION_OF_EARLIER_PROFILES`).
    public static let earlierProfile = PrivacySettings(httpsUpgrade: true, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false)

    static let settingsKey = "settings"

    /// The settings a state holds. A state with no `settings` at all (the iPhone's own, before any choice) is a new profile. A state whose
    /// `settings` exist keeps the Mac's rules: a key that is missing, or is not a flag, is what an earlier profile had, so that a damaged value never
    /// switches a rewrite on (`cleanPrivacySettings`, `withProtectionRepaired`); `httpsUpgrade`, older than the others, stays on unless it says `false`.
    public init(reading state: BrowserState) {
        guard case .object(let settings)? = state.rest[Self.settingsKey] else {
            self = .newProfile
            return
        }
        func flag(_ key: String, _ fallback: Bool) -> Bool {
            if case .bool(let value)? = settings[key] { return value }
            return fallback
        }
        let earlier = Self.earlierProfile
        self.init(httpsUpgrade: flag("httpsUpgrade", earlier.httpsUpgrade), sendGpc: flag("sendGpc", earlier.sendGpc),
                  stripTrackingParams: flag("stripTrackingParams", earlier.stripTrackingParams), stripCopiedLinks: flag("stripCopiedLinks", earlier.stripCopiedLinks))
    }

    public var options: PrivacyOptions {
        PrivacyOptions(httpsUpgrade: httpsUpgrade, globalPrivacyControl: sendGpc, stripTrackingParams: stripTrackingParams)
    }

    /// The level the three signals add up to, or nil when they match neither (« Personnalisé »: the settings stay as chosen).
    public var level: ProtectionLevel? {
        switch (sendGpc, stripTrackingParams, stripCopiedLinks) {
        case (false, false, false): .standard
        case (true, true, true): .enhanced
        default: nil
        }
    }

    /// Chooses a level: the three settings it stands for are written together, and HTTPS first stays as it is (it belongs to no level on the Mac).
    public mutating func choose(_ level: ProtectionLevel) {
        let on = level == .enhanced
        sendGpc = on; stripTrackingParams = on; stripCopiedLinks = on
    }

    /// The address to put on the pasteboard or in a share sheet: without its tracking parameters when `stripCopiedLinks` is on, as the Mac does.
    public func copiedAddress(_ address: String) -> String {
        stripCopiedLinks ? (TrackingParams.strip(address) ?? address) : address
    }

    /// Writes these settings into the state. Only the keys of this struct change: the rest of `settings` goes back out as it came in. A state with no
    /// `settings` gets the five a new profile of the Mac starts with (`protectionBaseline` included), so the Mac reads the same profile.
    public func write(into state: inout BrowserState) {
        var settings: [String: JSONValue]
        if case .object(let existing)? = state.rest[Self.settingsKey] {
            settings = existing
        } else {
            settings = ["protectionBaseline": .string("renforcee")]
        }
        settings["httpsUpgrade"] = .bool(httpsUpgrade)
        settings["sendGpc"] = .bool(sendGpc)
        settings["stripTrackingParams"] = .bool(stripTrackingParams)
        settings["stripCopiedLinks"] = .bool(stripCopiedLinks)
        state.rest[Self.settingsKey] = .object(settings)
    }
}

public extension BrowserState {
    var privacy: PrivacySettings {
        get { PrivacySettings(reading: self) }
        set { newValue.write(into: &self) }
    }
}
