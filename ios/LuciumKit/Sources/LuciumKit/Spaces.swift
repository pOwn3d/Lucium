import Foundation

/// Spaces and profiles in the state. Pure, so that `swift test` proves them on the Mac. The shape is the Mac's: a space has an `id`, a `name`, an
/// `emoji`, a `theme` and a `profileId`; the name of a profile lives in `settings.profileNames`, which the iPhone does not type and keeps in
/// `rest` like the rest of the settings.
///
/// A profile is a name for a set of cookies and site data. It exists while a space uses it, or while it has a name of its own: deleting the last
/// space of a profile never deletes the profile (and never its cookies), the way the Mac keeps a profile that no space uses until the person
/// removes it. Removing a profile is its own step (`removeProfile`), and the application then erases its data.
extension BrowserState {
    /// The profile the Mac gives a space nobody named a profile for.
    public static let defaultProfileId = "default"
    /// What a person may type as the name of a space or of a profile. The Mac keeps names up to 200 and 40 characters; a phone's sheet is narrower.
    public static let spaceNameMax = 40
    public static let profileNameMax = 40
    /// The profile of the Mac's private window: a profile made here may not take it (`newProfileId` skips it).
    public static let reservedProfileId = "private"

    public enum SpaceError: Error, Equatable, Sendable {
        case emptyName
        case notOneEmoji
        case unknownSpace
        case lastSpace
        case idTaken
        case unknownProfile
        case profileNameTaken
        case profileInUse
    }

    // MARK: Checks

    /// `PROFILE_ID` of `src/shared/profiles.ts`: 1 to 32 letters, digits, `_` or `-`. A profile id names a storage folder: nothing else goes in.
    public static func isProfileId(_ id: String) -> Bool {
        guard id != "__proto__", (1...32).contains(id.utf8.count) else { return false }
        return id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }
    }

    /// What a person typed as a name: trimmed, without control characters, cut to `max`, and `nil` when nothing is left.
    public static func cleanName(_ raw: String, max: Int) -> String? {
        let printable = String(String.UnicodeScalarView(raw.unicodeScalars.filter { $0.properties.generalCategory != .control }))
        let cut = String(printable.trimmingCharacters(in: .whitespacesAndNewlines).prefix(max)).trimmingCharacters(in: .whitespacesAndNewlines)
        return cut.isEmpty ? nil : cut
    }

    /// A space is worn by one emoji (a flag, a keycap, a sequence joined by zero-width joiners are one character): a line of text does not fit
    /// the box drawn for one glyph.
    public static func isOneEmoji(_ text: String) -> Bool {
        guard text.count == 1 else { return false }
        let scalars = text.unicodeScalars
        return scalars.contains { $0.properties.isEmojiPresentation } || scalars.contains { $0.properties.isEmoji && $0.value > 0x7F } || scalars.last?.value == 0x20E3
    }

    /// A storage-safe id for a new profile named by the person (`newProfileId` of the Mac): "Travail & Co" gives "travail-co", then "travail-co-2".
    public static func newProfileId(from name: String, existing: [String]) -> String {
        let folded = String(String.UnicodeScalarView(name.decomposedStringWithCanonicalMapping.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) })).lowercased()
        var base = ""
        var pendingDash = false
        for scalar in folded.unicodeScalars {
            if (scalar.value >= 0x61 && scalar.value <= 0x7A) || (scalar.value >= 0x30 && scalar.value <= 0x39) {
                if pendingDash && !base.isEmpty { base += "-" }
                pendingDash = false
                base.unicodeScalars.append(scalar)
            } else {
                pendingDash = true
            }
        }
        base = String(base.prefix(28))  // cut after the dashes are tidied, as the Mac does
        if base.isEmpty { base = "profil" }
        let taken = Set(existing + [reservedProfileId])
        var id = base
        var counter = 2
        while taken.contains(id) {
            id = "\(base)-\(counter)"
            counter += 1
        }
        return id
    }

    // MARK: Profiles

    /// The names people gave profiles (`settings.profileNames` on the Mac).
    public var profileNames: [String: String] {
        guard case .object(let settings)? = rest["settings"], case .object(let names)? = settings["profileNames"] else { return [:] }
        return names.compactMapValues { if case .string(let name) = $0 { name } else { nil } }
    }

    /// The profiles that exist: those the spaces use, in the order of the spaces, then the ones that only have a name (kept while no space uses them).
    public var profileIds: [String] {
        var seen = Set<String>()
        var ids: [String] = []
        for id in spaces.map(\.profileId) + profileNames.keys.sorted() where seen.insert(id).inserted { ids.append(id) }
        return ids
    }

    public func spaces(of profileId: String) -> [Space] { spaces.filter { $0.profileId == profileId } }

    public func isProfileInUse(_ profileId: String) -> Bool { spaces.contains { $0.profileId == profileId } }

    /// Gives a profile a name, or takes it back (`nil`). Written where the Mac reads it, and nothing else of the settings is touched.
    public mutating func setProfileName(_ name: String?, for profileId: String) {
        guard Self.isProfileId(profileId) else { return }
        var settings: [String: JSONValue] = [:]
        if case .object(let current)? = rest["settings"] { settings = current }
        var names: [String: JSONValue] = [:]
        if case .object(let current)? = settings["profileNames"] { names = current }
        names[profileId] = name.map(JSONValue.string)
        settings["profileNames"] = .object(names)
        rest["settings"] = .object(settings)
    }

    /// A new profile with a name and no space yet. Answers its id. Two profiles may not have the same name (the Mac says so too).
    @discardableResult
    public mutating func addProfile(named name: String) throws(SpaceError) -> String {
        guard let label = Self.cleanName(name, max: Self.profileNameMax) else { throw SpaceError.emptyName }
        guard !profileNames.values.contains(where: { $0.compare(label, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }) else {
            throw SpaceError.profileNameTaken
        }
        let id = Self.newProfileId(from: label, existing: profileIds)
        setProfileName(label, for: id)
        return id
    }

    /// Forgets a profile that no space uses. Its data is the application's to erase; this only takes it out of the state.
    public mutating func removeProfile(_ profileId: String) throws(SpaceError) {
        guard profileIds.contains(profileId) else { throw SpaceError.unknownProfile }
        guard !isProfileInUse(profileId) else { throw SpaceError.profileInUse }
        setProfileName(nil, for: profileId)
    }

    // MARK: Spaces

    /// Adds a space that uses a profile which exists (a new profile is made first, with `addProfile`), and gives it a theme from a hue.
    @discardableResult
    public mutating func addSpace(id: String, name: String, emoji: String, profileId: String, hue: Double) throws(SpaceError) -> Space {
        guard let label = Self.cleanName(name, max: Self.spaceNameMax) else { throw SpaceError.emptyName }
        guard Self.isOneEmoji(emoji) else { throw SpaceError.notOneEmoji }
        guard profileIds.contains(profileId) else { throw SpaceError.unknownProfile }
        guard !spaces.contains(where: { $0.id == id }) else { throw SpaceError.idTaken }
        let space = Space(id: id, name: label, emoji: emoji, profileId: profileId, rest: ["theme": SpaceTheme.make(hue: hue)])
        spaces.append(space)
        activeTabBySpace[id] = .some(nil)
        return space
    }

    /// Changes what a person can change of a space: its name, its emoji, its colour. A colour picked here makes a new two-colour theme (the Mac's
    /// `themeFromHue`); left alone, the theme the Mac made stays as it is. The profile never changes: its tabs would have to change data store.
    public mutating func updateSpace(_ id: String, name: String? = nil, emoji: String? = nil, hue: Double? = nil) throws(SpaceError) {
        guard let index = spaces.firstIndex(where: { $0.id == id }) else { throw SpaceError.unknownSpace }
        var space = spaces[index]
        if let name {
            guard let label = Self.cleanName(name, max: Self.spaceNameMax) else { throw SpaceError.emptyName }
            space.name = label
        }
        if let emoji {
            guard Self.isOneEmoji(emoji) else { throw SpaceError.notOneEmoji }
            if emoji != space.emoji {
                space.emoji = emoji
                // A space the Mac dresses with letters or a picture would keep showing them: the emoji just chosen has to be the one that shows.
                if space.rest["iconKind"] != nil { space.rest["iconKind"] = .string("emoji") }
            }
        }
        if let hue { space.rest["theme"] = SpaceTheme.make(hue: hue) }
        spaces[index] = space
    }

    /// Deletes a space and its tabs; answers the ids of those tabs so that the application frees their web views and files. The last space cannot
    /// go (a window with no space is not a state). Its profile stays, with a name, so that the data it holds can still be erased from the list.
    @discardableResult
    public mutating func deleteSpace(_ id: String) throws(SpaceError) -> [String] {
        guard let index = spaces.firstIndex(where: { $0.id == id }) else { throw SpaceError.unknownSpace }
        guard spaces.count > 1 else { throw SpaceError.lastSpace }
        let space = spaces[index]
        if !spaces.contains(where: { $0.id != id && $0.profileId == space.profileId }), profileNames[space.profileId] == nil {
            setProfileName(Self.cleanName(space.name, max: Self.profileNameMax), for: space.profileId)
        }
        let removed = tabs.filter { $0.spaceId == id }.map(\.id)
        tabs.removeAll { $0.spaceId == id }
        spaces.remove(at: index)
        activeTabBySpace[id] = nil
        if activeSpaceId == id { activeSpaceId = spaces[min(index, spaces.count - 1)].id }
        return removed
    }
}
