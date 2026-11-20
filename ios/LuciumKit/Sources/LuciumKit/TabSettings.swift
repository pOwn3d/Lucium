import Foundation

/// What the archive delay setting of a profile says: the delay of its own, or, for a profile other than the default one, the default profile's
/// (the Mac's "Comme le profil par défaut": the profile has no override).
public enum ArchiveChoice: Equatable, Sendable {
    case inherited
    /// Hours of idleness before a Today tab is archived; 0 = never.
    case hours(Double)
}

/// The tab settings the iPhone offers, written where the Mac reads them (`autoArchiveHours`, per profile or general; `sleepAwakeMax`, general).
extension BrowserState {
    /// The delays the settings screen offers, those of the Mac's guide (`settings-guide.ts`, "archivage"): 12 hours, 1 day, 7 days, never. A delay the
    /// Mac wrote that is not one of these is shown as it is and kept until another is chosen.
    public static let archiveDelayPresets: [Double] = [12, 24, 168, 0]

    /// The delay a profile archives with, or that it follows the default profile's. The default profile always has one (the general delay, else 12).
    public func archiveChoice(forProfile profileId: String) -> ArchiveChoice {
        if let own = Self.hours(ownSettings(of: profileId)["autoArchiveHours"]) { return .hours(own) }
        guard profileId == Self.defaultProfileId else { return .inherited }
        return .hours(Self.hours(generalSettings["autoArchiveHours"]) ?? Self.defaultAutoArchiveHours)
    }

    /// Chooses the archive delay of a profile, as the Mac does: the default profile's delay is the general `settings.autoArchiveHours` (its own override,
    /// which the Mac reads first, is removed), any other profile's is `settings.profiles[id].autoArchiveHours`, and going back to the default profile's
    /// removes that override (and the profile's entry once nothing is left in it). The other keys of a profile's entry go back out as they came in.
    /// Answers whether the state changed: a profile that does not exist, a delay that is not offered, the default profile "inheriting" and a choice
    /// that is already in force all leave it as it was.
    @discardableResult
    public mutating func chooseArchiveDelay(_ choice: ArchiveChoice, forProfile profileId: String) -> Bool {
        guard profileIds.contains(profileId), choice != archiveChoice(forProfile: profileId) else { return false }
        var value: JSONValue?
        switch choice {
        case .hours(let hours):
            guard Self.archiveDelayPresets.contains(hours) else { return false }
            value = .number(hours)
        case .inherited:
            guard profileId != Self.defaultProfileId else { return false }
        }
        writeProfileSetting("autoArchiveHours", value, forProfile: profileId)
        return true
    }

    /// How many tabs keep a live web view at once, from `settings.sleepAwakeMax` (the Mac's "Onglets éveillés en arrière-plan au plus"): nil when the state
    /// says nothing (the application's own default then applies), 0 when there is no limit.
    public var awakeTabLimit: Int? {
        guard case .number(let value)? = generalSettings["sleepAwakeMax"], value.isFinite, value >= 0, value <= Self.awakeLimitMax, value == value.rounded() else { return nil }
        return Int(value)
    }

    /// The limits the settings screen offers; 0 is "no limit". A number the Mac wrote is shown as it is and kept until another is chosen.
    public static let awakeLimitPresets: [Int] = [2, 4, 8, 0]
    /// The Mac's bound (`SLEEP_AWAKE_MAX_LIMIT`).
    static let awakeLimitMax = 500.0

    /// Chooses how many tabs stay awake. Answers whether the state changed.
    @discardableResult
    public mutating func chooseAwakeTabLimit(_ limit: Int) -> Bool {
        guard Self.awakeLimitPresets.contains(limit), limit != awakeTabLimit ?? SleepPlanner.defaultCap else { return false }
        writeProfileSetting("sleepAwakeMax", .number(Double(limit)), forProfile: nil)
        return true
    }

    // MARK: History

    /// Whether the profile keeps the pages it visits: the Mac's `profileRecordsHistory` (a profile's own `historyOff` first, else the general one; nothing
    /// written means it keeps them).
    public func recordsHistory(forProfile profileId: String) -> Bool {
        if case .bool(let off)? = ownSettings(of: profileId)["historyOff"] { return !off }
        if case .bool(let off)? = generalSettings["historyOff"] { return !off }
        return true
    }

    /// Chooses whether a profile keeps its history, written where the Mac reads it (`historyOff`). Answers whether the state changed.
    @discardableResult
    public mutating func chooseRecordsHistory(_ records: Bool, forProfile profileId: String) -> Bool {
        guard profileIds.contains(profileId), records != recordsHistory(forProfile: profileId) else { return false }
        writeProfileSetting("historyOff", .bool(!records), forProfile: profileId)
        return true
    }

    // MARK: Writing

    private static func hours(_ value: JSONValue?) -> Double? {
        if case .number(let number)? = value, number.isFinite, number >= 0 { return number }
        return nil
    }

    private var generalSettings: [String: JSONValue] {
        if case .object(let settings)? = rest["settings"] { return settings }
        return [:]
    }

    private func ownSettings(of profileId: String) -> [String: JSONValue] {
        if case .object(let profiles)? = generalSettings["profiles"], case .object(let own)? = profiles[profileId] { return own }
        return [:]
    }

    /// Sets (or removes, for nil) one key: the general one for the default profile or when no profile is named, the profile's own entry otherwise.
    private mutating func writeProfileSetting(_ key: String, _ value: JSONValue?, forProfile profileId: String?) {
        // A state with no settings at all is a new profile for the privacy rules: a `settings` that only held this key would turn it into an earlier
        // one (the five keys of `PrivacySettings.newProfile` are written first, as `chooseSearchEngine` does).
        if rest["settings"] == nil { PrivacySettings.newProfile.write(into: &self) }
        var settings = generalSettings
        guard let profileId else {
            settings[key] = value
            rest["settings"] = .object(settings)
            return
        }
        var profiles: [String: JSONValue] = [:]
        if case .object(let current)? = settings["profiles"] { profiles = current }
        var own = ownSettings(of: profileId)
        var touchesProfiles = profileId != Self.defaultProfileId
        if profileId == Self.defaultProfileId {
            if let value { settings[key] = value }
            // The Mac reads a profile's own override before the general value, even for the default profile: one left in the file would hide the choice.
            touchesProfiles = own.removeValue(forKey: key) != nil
        } else if let value {
            own[key] = value
        } else {
            own.removeValue(forKey: key)
        }
        if touchesProfiles {
            if own.isEmpty { profiles.removeValue(forKey: profileId) } else { profiles[profileId] = .object(own) }
            settings["profiles"] = .object(profiles)
        }
        rest["settings"] = .object(settings)
    }
}
