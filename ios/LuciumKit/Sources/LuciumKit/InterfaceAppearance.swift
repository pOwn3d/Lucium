import Foundation

/// The appearance of the application: the Mac's `interfaceAppearance` setting (`auto`, `light`, `dark`), and the `appearance` of a space's theme
/// (the same three words, `src/shared/theme.ts`).
public enum InterfaceAppearance: String, CaseIterable, Identifiable, Sendable {
    case auto, light, dark

    public var id: String { rawValue }

    /// Anything the Mac would not write reads as automatic, as its `themeSourceOf` does.
    public init(reading text: String?) { self = text.flatMap(InterfaceAppearance.init(rawValue:)) ?? .auto }

    /// What the screen is asked to draw in: `nil` leaves the choice to the system. The appearance of the whole application wins; when it is left to
    /// the system, the space on screen may ask for its own (its theme's `appearance`), as the Mac's theme does for its sidebar.
    public static func forced(global: InterfaceAppearance, space: InterfaceAppearance) -> InterfaceAppearance? {
        if global != .auto { return global }
        return space == .auto ? nil : space
    }
}

extension BrowserState {
    /// `settings.interfaceAppearance`, where the Mac keeps it. A state with no such key, or one the Mac would not write, is automatic. It is a setting
    /// of this device and does not travel with the synchronisation (`SyncFieldClasses.settingKeys` does not list it).
    public var interfaceAppearance: InterfaceAppearance {
        guard case .object(let settings)? = rest["settings"] else { return .auto }
        return InterfaceAppearance(reading: settings.string("interfaceAppearance"))
    }

    /// Chooses the appearance of the application, touching nothing else of the state. A state with no `settings` is a new profile for the privacy
    /// rules, and a `settings` that held only this key would turn it into an earlier one: the five keys of a new profile are written first. Answers
    /// whether the state changed.
    @discardableResult
    public mutating func chooseInterfaceAppearance(_ appearance: InterfaceAppearance) -> Bool {
        guard appearance != interfaceAppearance else { return false }
        if rest["settings"] == nil { PrivacySettings.newProfile.write(into: &self) }
        var settings: [String: JSONValue] = [:]
        if case .object(let current)? = rest["settings"] { settings = current }
        settings["interfaceAppearance"] = .string(appearance.rawValue)
        rest["settings"] = .object(settings)
        return true
    }

    /// The appearance the screen is forced to for the space on screen, or nil to follow the system.
    public func forcedAppearance(forSpace spaceId: String) -> InterfaceAppearance? {
        let space = spaces.first { $0.id == spaceId }?.themeAppearance ?? .auto
        return InterfaceAppearance.forced(global: interfaceAppearance, space: space)
    }
}

extension Space {
    /// The `appearance` of the space's theme, which the Mac wrote (or `SpaceTheme.make`: automatic). A missing or unknown word is automatic.
    public var themeAppearance: InterfaceAppearance {
        guard case .object(let theme)? = rest["theme"] else { return .auto }
        return InterfaceAppearance(reading: theme.string("appearance"))
    }
}
