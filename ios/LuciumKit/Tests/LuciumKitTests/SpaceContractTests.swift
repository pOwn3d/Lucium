import Foundation
import Testing
@testable import LuciumKit

/// The shared vectors (`ios/Contracts/theme-vectors.json`), also run against the Mac's TypeScript by `src/shared/ios-contract.test.ts`.
struct SpaceVectors: Decodable {
    struct Theme: Decodable { let hue: Double; let saturation: Double?; let baseColors: [String]; let themeHue: Double }
    struct NewProfileId: Decodable { let name: String; let existing: [String]; let expect: String }
    struct ProfileId: Decodable { let id: String; let valid: Bool }
    let theme: [Theme]
    let newProfileId: [NewProfileId]
    let profileId: [ProfileId]

    static func load() throws -> SpaceVectors {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/theme-vectors.json")
        return try JSONDecoder().decode(SpaceVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("Space and profile vectors shared with the Mac")
struct SpaceContractTests {
    @Test func vectorsAreNotEmpty() throws {
        let vectors = try SpaceVectors.load()
        #expect(vectors.theme.count > 10 && vectors.newProfileId.count > 5 && vectors.profileId.count > 5)
    }

    @Test func aThemeFromAHueHasTheColoursTheMacMakes() throws {
        for vector in try SpaceVectors.load().theme {
            let colors = SpaceTheme.baseColors(hue: vector.hue, saturation: vector.saturation ?? 0.55).map(\.text)
            #expect(colors == vector.baseColors, "themeFromHue(\(vector.hue), \(String(describing: vector.saturation)))")
        }
    }

    @Test func theHueOfAThemeIsTheOneTheMacReads() throws {
        for vector in try SpaceVectors.load().theme where vector.saturation == nil {
            let space = Space(id: "s", name: "S", emoji: "🏠", profileId: "p", rest: ["theme": SpaceTheme.make(hue: vector.hue)])
            #expect(SpaceTheme.hue(of: space) == vector.themeHue, "themeHue of the theme of \(vector.hue)")
        }
    }

    @Test func aNewProfileIdIsTheOneTheMacMakes() throws {
        for vector in try SpaceVectors.load().newProfileId {
            #expect(BrowserState.newProfileId(from: vector.name, existing: vector.existing) == vector.expect, "newProfileId(\(vector.name.debugDescription), \(vector.existing))")
        }
    }

    @Test func aProfileIdIsValidWhenTheMacSaysSo() throws {
        for vector in try SpaceVectors.load().profileId {
            #expect(BrowserState.isProfileId(vector.id) == vector.valid, "isProfileId(\(vector.id.debugDescription))")
        }
    }
}
