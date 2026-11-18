import Foundation

/// The search engines the Mac offers (`SEARCH_ENGINES` of `src/shared/model-defaults.ts`): the name the command bar shows for the engine in use.
public enum SearchEngine {
    public static let presets: [(name: String, url: String)] = [
        ("DuckDuckGo", "https://duckduckgo.com/?q=%s"),
        ("Google", "https://www.google.com/search?q=%s"),
        ("Bing", "https://www.bing.com/search?q=%s"),
        ("Brave Search", "https://search.brave.com/search?q=%s"),
        ("Qwant", "https://www.qwant.com/?q=%s"),
        ("Ecosia", "https://www.ecosia.org/search?q=%s"),
    ]

    /// The name of the engine a template stands for: a preset's name, else the host of the template ("example.org").
    public static func name(forTemplate template: String) -> String {
        if let preset = presets.first(where: { $0.url == template }) { return preset.name }
        let host = AddressResolver.host(of: template.replacingOccurrences(of: "%s", with: "q"))
        return host.isEmpty ? template : host
    }

    /// A template a search can use: a web address with `%s` where the words go.
    public static func isUsable(_ template: String) -> Bool {
        template.contains("%s") && Library.isLoadable(template.replacingOccurrences(of: "%s", with: "q"))
    }

    /// One of the engines the Mac offers in its list. The settings screen offers these and no other: an engine of one's own is typed on the Mac, where
    /// the address can be checked, and a state that carries one keeps it until another is chosen.
    public static func isPreset(_ template: String) -> Bool { presets.contains { $0.url == template } }
}

/// What the search engine setting of a profile says: the engine of its own, or, for a profile other than the default one, the default profile's
/// (the Mac's "Comme le profil par défaut": the profile has no override).
public enum SearchChoice: Equatable, Sendable {
    case inherited
    case engine(String)
}

extension BrowserState {
    /// The search template of a space's profile: its own, else the general one the Mac wrote, else DuckDuckGo (`profileSearch`). One that is not a
    /// web address with `%s` is ignored: a search must never load something else.
    public func searchTemplate(forSpace spaceId: String) -> String {
        guard let profile = spaces.first(where: { $0.id == spaceId })?.profileId else { return generalSearchTemplate }
        return searchTemplate(forProfile: profile)
    }

    /// The search template a profile searches with: its own override, else the general one, else DuckDuckGo.
    public func searchTemplate(forProfile profileId: String) -> String { ownSearchTemplate(of: profileId) ?? generalSearchTemplate }

    private var generalSearchTemplate: String {
        guard case .object(let settings)? = rest["settings"], let general = settings.string("searchUrlTemplate"), SearchEngine.isUsable(general) else {
            return AddressResolver.defaultSearchTemplate
        }
        return general
    }

    /// The engine a profile chose for itself, when the override is one a search can use (`settings.profiles[id].searchUrlTemplate`).
    private func ownSearchTemplate(of profileId: String) -> String? {
        guard case .object(let settings)? = rest["settings"], case .object(let profiles)? = settings["profiles"],
              case .object(let own)? = profiles[profileId], let template = own.string("searchUrlTemplate"), SearchEngine.isUsable(template) else { return nil }
        return template
    }

    /// What the settings screen shows for a profile: its engine, or that it has none of its own. The default profile is the one the others fall back
    /// on, so it always has an engine (the general one, which is where the Mac keeps it).
    public func searchChoice(forProfile profileId: String) -> SearchChoice {
        if let own = ownSearchTemplate(of: profileId) { return .engine(own) }
        return profileId == Self.defaultProfileId ? .engine(generalSearchTemplate) : .inherited
    }

    /// Chooses the search engine of a profile, writing it where the Mac does (`profileEditor` of `CurrentProfileSettings.tsx`): the default profile's
    /// engine is the general `settings.searchUrlTemplate`, any other profile's is `settings.profiles[id].searchUrlTemplate`, and going back to the
    /// default profile's engine removes that override (and the profile's entry once nothing is left in it). Nothing else of the state is touched: the
    /// other keys of a profile's entry (its download folder, its extensions) go back out as they came in. Only an engine of the Mac's list is accepted.
    /// Answers whether the state changed: a profile that does not exist, an engine that is not in the list, the default profile "inheriting", and a choice
    /// that is already the profile's all leave it as it was.
    @discardableResult
    public mutating func chooseSearchEngine(_ choice: SearchChoice, forProfile profileId: String) -> Bool {
        guard profileIds.contains(profileId), choice != searchChoice(forProfile: profileId) else { return false }
        let isDefault = profileId == Self.defaultProfileId
        switch choice {
        case .engine(let template): guard SearchEngine.isPreset(template) else { return false }
        case .inherited: guard !isDefault else { return false }
        }
        // A state with no settings at all is a new profile for the privacy rules: a `settings` that only held an engine would turn it into an earlier
        // one (the five keys of `PrivacySettings.newProfile` are written first, as `setProfileName` does).
        if rest["settings"] == nil { PrivacySettings.newProfile.write(into: &self) }
        var settings: [String: JSONValue] = [:]
        if case .object(let current)? = rest["settings"] { settings = current }
        var profiles: [String: JSONValue] = [:]
        if case .object(let current)? = settings["profiles"] { profiles = current }
        var own: [String: JSONValue] = [:]
        if case .object(let current)? = profiles[profileId] { own = current }

        var touchesProfiles = !isDefault
        if isDefault {
            if case .engine(let template) = choice { settings["searchUrlTemplate"] = .string(template) }
            // The Mac reads a profile's own override before the general engine, even for the default profile: one left in the file would hide the choice.
            touchesProfiles = own.removeValue(forKey: "searchUrlTemplate") != nil
        } else if case .engine(let template) = choice {
            own["searchUrlTemplate"] = .string(template)
        } else {
            own.removeValue(forKey: "searchUrlTemplate")
        }
        if touchesProfiles {
            if own.isEmpty { profiles.removeValue(forKey: profileId) } else { profiles[profileId] = .object(own) }
            settings["profiles"] = .object(profiles)
        }
        rest["settings"] = .object(settings)
        return true
    }

    /// The name the person gave a profile (`profileNames`), or nil when it has none: the default profile and an unnamed one are told by the interface.
    public func profileName(_ profileId: String) -> String? {
        guard case .object(let settings)? = rest["settings"], case .object(let names)? = settings["profileNames"],
              let name = names.string(profileId)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }
}
