import Foundation
import Testing
@testable import LuciumKit

/// Card 668: the pale colour of a space behind the text keeps the 4.5:1 the Mac holds its tokens to, in both schemes, for every colour the person can pick.
@Suite("Contrast of the tint of a space")
struct TintContrastTests {
    private var everySwatch: [HexColor] { SpaceTheme.huePresets.flatMap { SpaceTheme.baseColors(hue: $0) } }
    /// The bright, saturated ends of the wheel and the extremes: the colours that push the text under 4.5:1.
    private var hard: [HexColor] { (stride(from: 0.0, to: 360, by: 5).flatMap { SpaceTheme.baseColors(hue: $0, saturation: 0.95) }) + [HexColor("#ffff00")!, HexColor("#00ffff")!, HexColor("#ffffff")!, HexColor("#000000")!] }

    @Test func blackAndWhiteAreTwentyOneToOne() {
        #expect(TintContrast.ratio(HexColor("#000000")!, HexColor("#ffffff")!) == 21)
    }

    @Test func theTextKeepsAAOverTheTintInBothSchemes() {
        for dark in [false, true] {
            let opacity = TintContrast.opacity(dark: dark, increasedContrast: false, reduceTransparency: false)
            #expect(opacity > 0)
            for tint in everySwatch + hard {
                #expect(TintContrast.textRatio(tint: tint, opacity: opacity, dark: dark) >= TintContrast.aaText, "\(tint.text), dark: \(dark)")
            }
        }
    }

    @Test func aFullColourWouldNotKeepIt() {
        // The reason for the pale tint: the same text on the colour itself fails (the check above is not vacuous).
        #expect(TintContrast.textRatio(tint: HexColor("#1a237e")!, opacity: 1, dark: false) < TintContrast.aaText)
        #expect(TintContrast.textRatio(tint: HexColor("#ffff00")!, opacity: 1, dark: true) < TintContrast.aaText)
    }

    @Test func increasedContrastOrReducedTransparencyLaysNothing() {
        let tint = HexColor("#3a5de8")!
        #expect(TintContrast.opacity(dark: false, increasedContrast: true, reduceTransparency: false) == 0)
        #expect(TintContrast.opacity(dark: true, increasedContrast: false, reduceTransparency: true) == 0)
    }
}
