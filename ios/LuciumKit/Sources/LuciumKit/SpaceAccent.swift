import Foundation

/// The accent of the interface (buttons, ticks, switches, links), worked out from the hue of the space the way `tokens.css` of the Mac works out
/// `--accent`, `--accent-text` and `--on-accent` from `--hue`. The hue is the one of the first colour of the theme (`themeHue`); a space the Mac never
/// themed gets the default hue, 250. The lightness follows the hue because a yellow or a green is light by nature: the light scheme darkens them until
/// white text holds 4.5:1, and the dark scheme uses one light value that carries dark ink at every hue. `SpaceAccentTests` measures the whole wheel.
public enum SpaceAccent {
    /// `defaultTheme()` of the Mac is `themeFromHue(250)`.
    public static let defaultHue = 250.0

    /// The hue of a space, 0..359, the Mac's `themeHue`; the default one when the space has no valid colour.
    public static func hue(of space: Space) -> Double { SpaceTheme.hue(of: space).map(normalized) ?? defaultHue }

    /// `--accent-l`: `min(44, max(26.5, 51 - hue * 0.43) + max(0, hue - 180) * 0.4)` percent.
    static func lightness(hue: Double) -> Double {
        min(44, max(26.5, 51 - hue * 0.43) + max(0, hue - 180) * 0.4) / 100
    }

    /// `--accent`: the fill of a control and the colour of a tick or a switch.
    public static func accent(hue: Double, dark: Bool) -> HexColor {
        let h = normalized(hue)
        return SpaceTheme.hex(from: .init(h: h, s: dark ? 0.80 : 0.78, l: dark ? 0.70 : lightness(hue: h)))
    }

    /// `--accent-text`: the accent as a link or a small icon on the plain ground, lighter in the dark scheme and darker in the light one.
    public static func text(hue: Double, dark: Bool) -> HexColor {
        let h = normalized(hue)
        return SpaceTheme.hex(from: .init(h: h, s: 0.70, l: dark ? 0.78 : lightness(hue: h) - 0.14))
    }

    /// `--on-accent`: the ink on an accent fill, white in the light scheme and a near-black blue in the dark one.
    public static func onAccent(dark: Bool) -> HexColor { dark ? HexColor(red: 0x0c, green: 0x0f, blue: 0x1a) : HexColor(red: 255, green: 255, blue: 255) }

    private static func normalized(_ hue: Double) -> Double { ((hue.rounded().truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360) }
}
