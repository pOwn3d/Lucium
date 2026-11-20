import Foundation
import Testing
@testable import LuciumKit

/// The shared vectors (`ios/Contracts/ready-theme-vectors.json`), also run against the Mac's `READY_THEMES` by `src/shared/ios-contract.test.ts`.
private struct ReadyVectors: Decodable {
    struct Entry: Decodable {
        let id: String
        let palette: String
        let variant: String?
        let background: String
        let accent: String
        let theme: JSONValue
    }
    let ready: [Entry]

    static func load() throws -> ReadyVectors {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/ready-theme-vectors.json")
        return try JSONDecoder().decode(ReadyVectors.self, from: Data(contentsOf: url))
    }
}

private func space(theme: JSONValue? = nil) -> Space {
    Space(id: "s", name: "S", emoji: "🏠", profileId: "default", rest: theme.map { ["theme": $0] } ?? [:])
}

private func dracula() throws -> ReadyTheme { try #require(ReadyTheme.all.first { $0.id == "dracula" }) }
private func alucard() throws -> ReadyTheme { try #require(ReadyTheme.all.first { $0.id == "dracula-alucard" }) }

@Suite("Ready themes shared with the Mac")
struct ReadyThemeTests {
    // MARK: Contract

    @Test func theTwentyThemesAreTheMacsInTheMacsOrderWithTheThemeTheMacWrites() throws {
        let vectors = try ReadyVectors.load().ready
        #expect(vectors.count == 20, "an empty or short file would pass for nothing")
        #expect(ReadyTheme.all.map(\.id) == vectors.map(\.id))
        for (theme, vector) in zip(ReadyTheme.all, vectors) {
            #expect(theme.theme == vector.theme, "theme of \(vector.id)")
            #expect(theme.palette == vector.palette && theme.variant?.rawValue == vector.variant, "name of \(vector.id)")
            #expect(theme.background.text == vector.background && theme.accent.text == vector.accent, "preview of \(vector.id)")
        }
    }

    @Test func aReadyThemeIsDarkOrLightNeverAutomaticAndItsVariantSaysWhich() {
        for theme in ReadyTheme.all {
            #expect(theme.appearance != .auto, Comment(rawValue: theme.id))
            if let variant = theme.variant { #expect(variant.rawValue == theme.appearance.rawValue, Comment(rawValue: theme.id)) }
        }
    }

    // MARK: Reading

    @Test func aSpaceThatWearsAReadyThemeIsRecognisedAndNoOtherIs() throws {
        for theme in ReadyTheme.all { #expect(ReadyTheme.of(space(theme: theme.theme)) == theme, Comment(rawValue: theme.id)) }
        #expect(ReadyTheme.of(space()) == nil, "a space the Mac never themed")
        #expect(ReadyTheme.of(space(theme: SpaceTheme.make(hue: 250))) == nil, "a theme made from a hue")
        guard case .object(var tuned) = try dracula().theme else { Issue.record("not an object"); return }
        tuned["intensity"] = .number(0.5)
        #expect(ReadyTheme.of(space(theme: .object(tuned))) == nil, "a ready theme the Mac tuned is a theme of its own")
    }

    // MARK: Writing

    @Test func aPickedReadyThemeIsWrittenAsTheMacWritesIt() throws {
        var state = BrowserState(spaces: [space()], activeSpaceId: "s")
        try state.updateSpace("s", ready: try dracula())
        #expect(state.spaces[0].rest["theme"] == (try dracula()).theme)
        #expect(state.spaces[0].tint == (try dracula()).base, "the pastille and the accent hue follow the base colour, as on the Mac")
    }

    @Test func aReadyThemeWinsOverAHueAndALoneHueStillMakesTheTwoColourTheme() throws {
        var state = BrowserState(spaces: [space()], activeSpaceId: "s")
        try state.updateSpace("s", hue: 175, ready: try dracula())
        #expect(state.spaces[0].rest["theme"] == (try dracula()).theme)
        try state.updateSpace("s", hue: 175)
        #expect(state.spaces[0].rest["theme"] == SpaceTheme.make(hue: 175))
    }

    @Test func aNewSpaceCanBeBornWithAReadyTheme() throws {
        var state = BrowserState(spaces: [space()], activeSpaceId: "s")
        let added = try state.addSpace(id: "n", name: "Nuit", emoji: "🌙", profileId: "default", hue: 250, ready: try dracula())
        #expect(added.rest["theme"] == (try dracula()).theme)
        #expect(ReadyTheme.of(added) == (try dracula()))
    }

    @Test func leavingTheColourAloneKeepsTheThemeAndPickingAnotherChangesIt() throws {
        let wearing = space(theme: try dracula().theme)
        #expect(SpaceColorEdit.patch(of: wearing, hue: nil, ready: try dracula()) == (nil, nil), "the ready theme the space wears is not written again")
        #expect(SpaceColorEdit.patch(of: wearing, hue: nil, ready: try alucard()) == (nil, try alucard()))
        // A hue picked on a space that wears a ready theme changes it, even when it is the hue of the base colour.
        let baseHue = try #require(SpaceTheme.hue(of: wearing))
        #expect(SpaceColorEdit.patch(of: wearing, hue: baseHue, ready: nil) == (baseHue, nil))

        let hued = space(theme: SpaceTheme.make(hue: 175))
        #expect(SpaceColorEdit.patch(of: hued, hue: 175, ready: nil) == (nil, nil), "the hue it has is left alone")
        #expect(SpaceColorEdit.patch(of: hued, hue: 30, ready: nil) == (30, nil))
        #expect(SpaceColorEdit.patch(of: hued, hue: nil, ready: nil) == (nil, nil))
        #expect(SpaceColorEdit.patch(of: hued, hue: nil, ready: try dracula()) == (nil, try dracula()))
    }

    // MARK: On screen

    @Test func aDarkReadyThemeDrawsTheScreenDarkAndALightOneLightUnlessThePersonChoseAnAppearance() throws {
        var state = BrowserState(spaces: [space(theme: try dracula().theme), Space(id: "l", name: "L", emoji: "☀️", profileId: "default", rest: ["theme": try alucard().theme])],
                                 activeSpaceId: "s")
        #expect(state.forcedAppearance(forSpace: "s") == .dark)
        #expect(state.forcedAppearance(forSpace: "l") == .light)
        state.chooseInterfaceAppearance(.dark)
        #expect(state.forcedAppearance(forSpace: "l") == .dark, "the appearance of the whole application wins")
    }
}
