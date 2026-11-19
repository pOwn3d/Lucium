import Foundation

/// The contrast of the text over the pale colour of a space (card 668). The Mac measures its design tokens with `src/shared/contrast.ts` (WCAG 2.x, 4.5:1 for
/// text); this is the same arithmetic, so that the pale gradient laid behind the lists of the iPhone is held to the same threshold. The colours of a theme
/// are the person's (or the Mac's): the application cannot choose them, so it chooses how much of them it lays on the ground.
public enum TintContrast {
    /// WCAG 2.2 AA for text (`AA_TEXT` of `contrast.ts`).
    public static let aaText = 4.5
    /// How much of a colour of the theme is laid on the ground when nothing forbids it: the 35 % the sidebar, the sheets and the start page have always used.
    public static let paleOpacity = 0.35

    /// The relative luminance of WCAG 2.x, with the 0.03928 knee `relativeLuminance` of `a11y-audit.ts` uses.
    public static func luminance(_ color: HexColor) -> Double {
        func linear(_ value: Int) -> Double {
            let channel = Double(value) / 255
            return channel <= 0.03928 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }

    /// The contrast ratio of two opaque colours, 1 to 21, whichever is the text.
    public static func ratio(_ first: HexColor, _ second: HexColor) -> Double {
        let (a, b) = (luminance(first), luminance(second))
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// `tint` laid over `ground` at `opacity` (the "over" operator, channels rounded as `composite` does).
    public static func blend(_ tint: HexColor, over ground: HexColor, opacity: Double) -> HexColor {
        func mix(_ top: Int, _ bottom: Int) -> Int { Int((Double(top) * opacity + Double(bottom) * (1 - opacity)).rounded()) }
        return HexColor(red: mix(tint.red, ground.red), green: mix(tint.green, ground.green), blue: mix(tint.blue, ground.blue))
    }

    /// The ground and the text iOS draws on it: white and black in the light scheme, black and white in the dark one (`systemBackground` and `label`).
    public static func ground(dark: Bool) -> HexColor { dark ? HexColor(red: 0, green: 0, blue: 0) : HexColor(red: 255, green: 255, blue: 255) }
    public static func text(dark: Bool) -> HexColor { ground(dark: !dark) }

    /// The ratio of the text of the scheme over a colour of a theme laid on its ground at `opacity`.
    public static func textRatio(tint: HexColor, opacity: Double, dark: Bool) -> Double {
        ratio(text(dark: dark), blend(tint, over: ground(dark: dark), opacity: opacity))
    }

    /// How much of `tint` is laid on the ground: nothing when the person asked for more contrast or less transparency (the ground stays flat: a colour
    /// behind the text is what those two settings take away), the pale 35 % otherwise. That 35 % keeps the text at 4.5:1 for every colour, in both schemes
    /// (measured by `TintContrastTests` over the whole wheel; the text is on a ground that is already the lightest or the darkest there is, and a pale
    /// colour only moves it towards the middle). A test, not a clamp, holds the number: raise it and the test names the colour that fails.
    public static func opacity(dark: Bool, increasedContrast: Bool, reduceTransparency: Bool) -> Double {
        increasedContrast || reduceTransparency ? 0 : paleOpacity
    }
}
