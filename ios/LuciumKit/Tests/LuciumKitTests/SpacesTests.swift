import Foundation
import Testing
@testable import LuciumKit

private func twoSpaces() -> BrowserState {
    var state = BrowserState(revision: 2,
                             spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work"), Space(id: "s2", name: "Home", emoji: "🏠", profileId: "home")],
                             activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil])
    state.setProfileName("Travail", for: "work")
    return state
}

@Suite("Spaces and profiles in the state")
struct SpacesTests {
    // MARK: Spaces

    @Test func aNewSpaceHasItsNameItsEmojiItsProfileAndAThemeInTheMacsShape() throws {
        var state = twoSpaces()
        let space = try state.addSpace(id: "s3", name: "  Projets  ", emoji: "🧩", profileId: "home", hue: 175)
        #expect(space.name == "Projets" && space.emoji == "🧩" && space.profileId == "home")
        #expect(state.spaces.map(\.id) == ["s1", "s2", "s3"])
        #expect(state.activeSpaceId == "s1", "adding a space does not move to it")
        #expect(state.activeTab(in: "s3") == nil)
        let json = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        #expect(json.contains("\"s3\":null"), "the new space shows no tab yet, written as null: \(json)")
        let theme = try #require(space.rest["theme"])
        guard case .object(let fields) = theme, case .array(let colors)? = fields["baseColors"] else { Issue.record("no theme: \(theme)"); return }
        #expect(colors.count == 2 && fields["harmony"] == .string("complementary") && fields["appearance"] == .string("auto"))
        #expect(space.tint == SpaceTheme.swatch(hue: 175))
    }

    @Test func aSpaceNeedsANameAnEmojiAndAProfileThatExists() throws {
        var state = twoSpaces()
        #expect(throws: BrowserState.SpaceError.emptyName) { try state.addSpace(id: "x", name: " \n ", emoji: "🧩", profileId: "home", hue: 10) }
        #expect(throws: BrowserState.SpaceError.notOneEmoji) { try state.addSpace(id: "x", name: "X", emoji: "ab", profileId: "home", hue: 10) }
        #expect(throws: BrowserState.SpaceError.notOneEmoji) { try state.addSpace(id: "x", name: "X", emoji: "", profileId: "home", hue: 10) }
        #expect(throws: BrowserState.SpaceError.notOneEmoji) { try state.addSpace(id: "x", name: "X", emoji: "7", profileId: "home", hue: 10) }
        #expect(throws: BrowserState.SpaceError.unknownProfile) { try state.addSpace(id: "x", name: "X", emoji: "🧩", profileId: "nope", hue: 10) }
        #expect(throws: BrowserState.SpaceError.idTaken) { try state.addSpace(id: "s1", name: "X", emoji: "🧩", profileId: "home", hue: 10) }
        #expect(state.spaces.count == 2, "a refused space changes nothing")
        // One emoji is one character, however it is written: a flag, a keycap, a sequence joined by zero-width joiners, a skin tone.
        for emoji in ["🇫🇷", "1️⃣", "👩‍💻", "👍🏽", "✈️"] { #expect(BrowserState.isOneEmoji(emoji), "\(emoji)") }
    }

    @Test func aNameIsCutToTheLimitWithoutControlCharacters() throws {
        var state = twoSpaces()
        let long = String(repeating: "é", count: 80)
        let space = try state.addSpace(id: "s3", name: "A\u{0007}B" + long, emoji: "🧩", profileId: "home", hue: 10)
        #expect(space.name.count == BrowserState.spaceNameMax && space.name.hasPrefix("AB"))
    }

    @Test func updatingASpaceChangesOnlyWhatWasAskedAndKeepsTheRest() throws {
        var state = twoSpaces()
        state.spaces[0].rest["theme"] = .object(["baseColors": .array([.string("#123456")]), "harmony": .string("custom"), "angle": .number(10)])
        state.spaces[0].rest["hideHeader"] = .bool(true)
        try state.updateSpace("s1", name: "Bureau")
        #expect(state.spaces[0].name == "Bureau" && state.spaces[0].emoji == "💼")
        #expect(state.spaces[0].tint == HexColor("#123456"), "a theme the Mac made stays when only the name changes")
        #expect(state.spaces[0].rest["hideHeader"] == .bool(true))
        try state.updateSpace("s1", hue: 30)
        #expect(state.spaces[0].tint == SpaceTheme.swatch(hue: 30), "a colour picked here makes the Mac's two-colour theme")
        #expect(state.spaces[0].rest["hideHeader"] == .bool(true))
        #expect(throws: BrowserState.SpaceError.unknownSpace) { try state.updateSpace("nope", name: "X") }
        #expect(throws: BrowserState.SpaceError.emptyName) { try state.updateSpace("s1", name: "  ") }
        #expect(state.spaces[0].name == "Bureau", "a refused change changes nothing")
    }

    @Test func aNewEmojiShowsEvenOnASpaceTheMacDressedWithLetters() throws {
        var state = twoSpaces()
        state.spaces[0].rest["iconKind"] = .string("letter")
        state.spaces[0].rest["iconLetter"] = .string("TR")
        try state.updateSpace("s1", name: "Work")
        #expect(state.spaces[0].rest["iconKind"] == .string("letter"), "the name alone does not change the icon")
        try state.updateSpace("s1", emoji: "🏢")
        #expect(state.spaces[0].rest["iconKind"] == .string("emoji"))
        #expect(state.spaces[0].rest["iconLetter"] == .string("TR"), "what the Mac wrote is kept, the choice of icon is what changes")
    }

    @Test func deletingASpaceRemovesItsTabsAndAnswersTheirIdsAndMovesToANeighbour() throws {
        var state = twoSpaces()
        state.openTab(id: "a", in: "s1", now: 1)
        state.openTab(id: "b", in: "s1", now: 2)
        state.openTab(id: "c", in: "s2", now: 3)
        let removed = try state.deleteSpace("s1")
        #expect(removed.sorted() == ["a", "b"])
        #expect(state.tabs.map(\.id) == ["c"] && state.spaces.map(\.id) == ["s2"])
        #expect(state.activeSpaceId == "s2", "the space on screen was deleted: the neighbour shows")
        #expect(state.activeTabBySpace["s1"] == nil, "no pointer is left for a space that is gone")
        #expect(state.consistent() == state)
    }

    @Test func theLastSpaceCannotBeDeleted() throws {
        var state = twoSpaces()
        try state.deleteSpace("s2")
        #expect(throws: BrowserState.SpaceError.lastSpace) { try state.deleteSpace("s1") }
        #expect(throws: BrowserState.SpaceError.unknownSpace) { try state.deleteSpace("s2") }
        #expect(state.spaces.map(\.id) == ["s1"])
    }

    // MARK: Profiles

    @Test func aProfileHasANameAndSurvivesItsLastSpace() throws {
        var state = twoSpaces()
        #expect(state.profileIds == ["work", "home"])
        #expect(state.profileNames == ["work": "Travail"])
        try state.deleteSpace("s2")  // "home" has no name: it keeps the one of the space, so that it can still be found and erased
        #expect(state.profileIds == ["work", "home"], "the profile stays, with its cookies, when its last space goes")
        #expect(state.profileNames["home"] == "Home")
        #expect(!state.isProfileInUse("home") && state.isProfileInUse("work"))
    }

    @Test func aProfileMadeHereHasAnIdThatIsSafeAsAFolderAndANameThatIsNotTaken() throws {
        var state = twoSpaces()
        let id = try state.addProfile(named: "Café & Co")
        #expect(id == "cafe-co" && BrowserState.isProfileId(id))
        #expect(state.profileNames[id] == "Café & Co" && state.profileIds.contains(id))
        #expect(throws: BrowserState.SpaceError.profileNameTaken) { try state.addProfile(named: "café & co") }
        #expect(throws: BrowserState.SpaceError.emptyName) { try state.addProfile(named: "   ") }
        let second = try state.addProfile(named: "Cafe & Co!")
        #expect(second == "cafe-co-2", "the id of an existing profile is never taken, even for another name")
        #expect(try state.addProfile(named: "Private") == "private-2", "the Mac's private window keeps its profile id")
    }

    @Test func aSpaceCanUseAProfileThatHasNoSpaceYetAndSeveralSpacesCanShareOne() throws {
        var state = twoSpaces()
        let id = try state.addProfile(named: "Perso")
        try state.addSpace(id: "s3", name: "Lecture", emoji: "📚", profileId: id, hue: 55)
        try state.addSpace(id: "s4", name: "Jeux", emoji: "🎮", profileId: id, hue: 345)
        #expect(state.spaces(of: id).map(\.id) == ["s3", "s4"])
        #expect(state.profileIds == ["work", "home", id], "a profile is listed once, in the order of its first space")
    }

    @Test func aProfileInUseCannotBeRemovedAndOneThatIsNotGoesFromTheState() throws {
        var state = twoSpaces()
        let id = try state.addProfile(named: "Perso")
        #expect(throws: BrowserState.SpaceError.profileInUse) { try state.removeProfile("work") }
        #expect(throws: BrowserState.SpaceError.unknownProfile) { try state.removeProfile("nope") }
        try state.removeProfile(id)
        #expect(!state.profileIds.contains(id) && state.profileNames[id] == nil)
    }

    /// A state with no `settings` is a new profile for the privacy rules; one whose `settings` only names a profile would read as an earlier profile
    /// (the signal and the tracking parameters off). Found by the privacy tests of the application, which failed on a state made by `defaultState()`.
    @Test func namingAProfileOnAStateWithNoSettingsKeepsItANewProfileForPrivacy() throws {
        var state = twoSpaces()
        state.rest["settings"] = nil
        #expect(state.privacy == .newProfile)
        state.setProfileName("Travail", for: "work")
        #expect(state.profileNames == ["work": "Travail"])
        #expect(state.privacy == .newProfile, "naming a profile must not switch the privacy rules off")
        guard case .object(let settings)? = state.rest["settings"] else { Issue.record("no settings"); return }
        #expect(settings["protectionBaseline"] == .string("renforcee"), "the five keys a new profile of the Mac starts with")
        var none = twoSpaces()
        none.rest["settings"] = nil
        none.setProfileName(nil, for: "work")
        #expect(none.rest["settings"] == nil, "taking back a name that was never there writes nothing")
    }

    @Test func theNameOfAProfileIsWrittenWhereTheMacReadsItAndTheRestOfTheSettingsStays() throws {
        var state = twoSpaces()
        state.rest["settings"] = .object(["blockAds": .bool(true), "profileNames": .object(["work": .string("Travail")])])
        try state.addProfile(named: "Perso")
        guard case .object(let settings)? = state.rest["settings"], case .object(let names)? = settings["profileNames"] else { Issue.record("no settings"); return }
        #expect(settings["blockAds"] == .bool(true), "a setting the iPhone does not know is not lost")
        #expect(names == ["work": .string("Travail"), "perso": .string("Perso")])
        let again = try BrowserState.decode(try JSONEncoder().encode(state))
        #expect(again == state)
    }
}
