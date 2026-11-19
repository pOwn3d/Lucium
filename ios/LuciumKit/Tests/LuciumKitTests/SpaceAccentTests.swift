import XCTest
@testable import LuciumKit

/// Card 672: the accent follows the hue of the space, held to the Mac's threshold (4.5:1) in both schemes for every hue of the wheel.
final class SpaceAccentTests: XCTestCase {
    private func space(theme: JSONValue?) -> Space {
        Space(id: "s", name: "S", emoji: "✨", profileId: "default", rest: theme.map { ["theme": $0] } ?? [:])
    }

    func testEveryHueKeepsTheInkOnTheAccentAtFourPointFive() {
        for dark in [false, true] {
            for hue in 0..<360 {
                let ratio = TintContrast.ratio(SpaceAccent.onAccent(dark: dark), SpaceAccent.accent(hue: Double(hue), dark: dark))
                XCTAssertGreaterThanOrEqual(ratio, TintContrast.aaText, "ink on accent, hue \(hue), dark \(dark): \(ratio)")
            }
        }
    }

    func testEveryHueKeepsTheAccentTextOnThePlainGroundAtFourPointFive() {
        for dark in [false, true] {
            for hue in 0..<360 {
                let ratio = TintContrast.ratio(SpaceAccent.text(hue: Double(hue), dark: dark), TintContrast.ground(dark: dark))
                XCTAssertGreaterThanOrEqual(ratio, TintContrast.aaText, "accent text on ground, hue \(hue), dark \(dark): \(ratio)")
            }
        }
    }

    func testTheAccentIsTheMacsForAKnownHue() {
        // tokens.css: hue 250 -> --accent-l = min(44, max(26.5, 51 - 107.5) + 28) = 44 %; light hsl(250 78% 44%), dark hsl(250 80% 70%).
        XCTAssertEqual(SpaceAccent.lightness(hue: 250), 0.44, accuracy: 1e-9)
        XCTAssertEqual(SpaceAccent.accent(hue: 250, dark: false), SpaceTheme.hex(from: .init(h: 250, s: 0.78, l: 0.44)))
        XCTAssertEqual(SpaceAccent.accent(hue: 250, dark: true), SpaceTheme.hex(from: .init(h: 250, s: 0.80, l: 0.70)))
        XCTAssertEqual(SpaceAccent.lightness(hue: 100), 0.265, accuracy: 1e-9, "a green is darkened to the floor")
    }

    func testTwoHuesGiveTwoAccents() {
        XCTAssertNotEqual(SpaceAccent.accent(hue: 30, dark: false), SpaceAccent.accent(hue: 215, dark: false))
    }

    func testTheHueIsThatOfTheFirstColourAndTheDefaultWithoutTheme() {
        XCTAssertEqual(SpaceAccent.hue(of: space(theme: SpaceTheme.make(hue: 130))), 130)
        XCTAssertEqual(SpaceAccent.hue(of: space(theme: nil)), 250)
    }
}
