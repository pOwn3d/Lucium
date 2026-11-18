import Foundation

/// A colour as the Mac writes it in a space's theme: `#rrggbb`. The iPhone never writes a colour of its own: what it shows is read from the
/// state (a theme the Mac made, or one `SpaceTheme.make` derives from a hue the person picked).
public struct HexColor: Equatable, Sendable {
    public var red: Int
    public var green: Int
    public var blue: Int

    public init(red: Int, green: Int, blue: Int) {
        self.red = min(max(red, 0), 255); self.green = min(max(green, 0), 255); self.blue = min(max(blue, 0), 255)
    }

    /// `#rrggbb`, any case. Anything else (a name, three digits, an alpha channel) is refused: the Mac's `isHex` accepts nothing else.
    public init?(_ text: String) {
        let digits = Array(text.utf8)
        guard digits.count == 7, digits[0] == UInt8(ascii: "#"), let value = Int(text.dropFirst(), radix: 16), text.dropFirst().allSatisfy(\.isHexDigit) else { return nil }
        self.init(red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255)
    }

    public var text: String {
        func part(_ value: Int) -> String { (value < 16 ? "0" : "") + String(value, radix: 16) }
        return "#" + part(red) + part(green) + part(blue)
    }
}

/// The theme of a space, in the shape the Mac keeps in `Space.theme` (`src/shared/theme.ts`). The iPhone shows one colour or two of it (the
/// first two of `baseColors`) and writes a new theme only from a hue, the way the Mac's `themeFromHue` does: the arithmetic is the same, and
/// `Contracts/theme-vectors.json` holds the two implementations together.
public enum SpaceTheme {
    /// The hues of the swatches the person picks from (a colour wheel does not fit a phone's sheet): spread round the wheel, the Mac's default first.
    public static let huePresets: [Double] = [250, 215, 175, 130, 55, 30, 345, 295]

    /// The theme `themeFromHue(hue, saturation)` of the Mac makes, as the JSON the state holds.
    public static func make(hue: Double, saturation: Double = 0.55) -> JSONValue {
        let colors = baseColors(hue: hue, saturation: saturation)
        return .object([
            "baseColors": .array(colors.map { .string($0.text) }),
            "harmony": .string("complementary"),
            "angle": .number(155),
            "intensity": .number(1),
            "overlay": .string("grain"),
            "noise": .number(0),
            "translucency": .string("light"),
            "vibrant": .bool(true),
            "appearance": .string("auto"),
        ])
    }

    /// The primary colour and its complement: `harmonize(primary, "complementary", 2)` on the Mac.
    public static func baseColors(hue: Double, saturation: Double = 0.55) -> [HexColor] {
        let primary = hex(from: HSL(h: positive(hue), s: clamp(saturation, 0.1, 0.95), l: 0.5))
        let hsl = HSL(of: primary)
        return [primary, hex(from: HSL(h: hsl.h + 180, s: hsl.s, l: clamp(hsl.l, 0.08, 0.92)))]
    }

    /// The colour of the swatch of a hue (the primary colour of the theme it makes).
    public static func swatch(hue: Double) -> HexColor { baseColors(hue: hue)[0] }

    /// The hue of the first colour of a theme, rounded as the Mac's `themeHue` does: what the editor selects.
    public static func hue(of space: Space) -> Double? {
        space.tint.map { (HSL(of: $0).h).rounded() }
    }

    /// `((hue % 360) + 360) % 360`: a hue of -30 is 330, as on the Mac.
    private static func positive(_ degrees: Double) -> Double { (degrees.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) }
    private static func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double { min(max(value, low), high) }

    // MARK: Colour arithmetic (theme.ts: rgbToHsl, hslToRgb, rgbToHex)

    struct HSL: Equatable {
        var h: Double  // 0..360
        var s: Double  // 0..1
        var l: Double  // 0..1

        init(h: Double, s: Double, l: Double) { self.h = h; self.s = s; self.l = l }

        init(of color: HexColor) {
            let (r, g, b) = (Double(color.red) / 255, Double(color.green) / 255, Double(color.blue) / 255)
            let maximum = max(r, g, b), minimum = min(r, g, b)
            let lightness = (maximum + minimum) / 2
            let delta = maximum - minimum
            if delta == 0 { self.init(h: 0, s: 0, l: lightness); return }
            let saturation = delta / (1 - abs(2 * lightness - 1))
            let sector = maximum == r ? ((g - b) / delta).truncatingRemainder(dividingBy: 6) : maximum == g ? (b - r) / delta + 2 : (r - g) / delta + 4
            self.init(h: (sector * 60 + 360).truncatingRemainder(dividingBy: 360), s: saturation, l: lightness)
        }
    }

    static func hex(from hsl: HSL) -> HexColor {
        let c = (1 - abs(2 * hsl.l - 1)) * hsl.s
        let degrees = hsl.h.truncatingRemainder(dividingBy: 360)
        let sector = ((degrees + 360).truncatingRemainder(dividingBy: 360)) / 60
        let x = c * (1 - abs(sector.truncatingRemainder(dividingBy: 2) - 1))
        let (r1, g1, b1): (Double, Double, Double) =
            sector < 1 ? (c, x, 0) : sector < 2 ? (x, c, 0) : sector < 3 ? (0, c, x) : sector < 4 ? (0, x, c) : sector < 5 ? (x, 0, c) : (c, 0, x)
        let m = hsl.l - c / 2
        // JavaScript's Math.round rounds halves up, so the same floor(x + 0.5).
        func channel(_ value: Double) -> Int { Int(((value + m) * 255 + 0.5).rounded(.down)) }
        return HexColor(red: channel(r1), green: channel(g1), blue: channel(b1))
    }
}

extension Space {
    /// The colours of the theme, as hexadecimal texts the Mac wrote: up to three, the ones that are valid.
    public var themeColors: [HexColor] {
        guard case .object(let theme)? = rest["theme"], case .array(let colors)? = theme["baseColors"] else { return [] }
        return colors.prefix(3).compactMap { if case .string(let text) = $0 { HexColor(text) } else { nil } }
    }

    /// The first colour of the theme: the one the pastille of the space is made from. `nil` for a space whose theme the Mac never wrote.
    public var tint: HexColor? { themeColors.first }
}
