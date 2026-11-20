import Foundation

/// A ready theme: the colours of a well-known palette (Dracula, Nord, Solarized…) as the theme of a space, the twenty of the "Thèmes" row of the Mac's
/// theme editor (`READY_THEMES`, `src/shared/theme-presets.ts`). The iPhone writes the same `theme` the Mac writes for it, so the Mac reads the space
/// back as this ready theme (`readyThemeOf`) and the synchronisation carries nothing new. `Contracts/ready-theme-vectors.json` holds the two lists
/// together: a theme added, moved or recoloured on one side fails the other side's tests. The name is the palette's own, with the word of its variant
/// which the application says in the language of the person; the colours are data, not styling.
public struct ReadyTheme: Equatable, Identifiable, Sendable {
    /// Stable, whatever the language: the Mac's `ReadyTheme.id`.
    public let id: String
    /// The name of the palette, a proper name that is the same in every language (« Dracula », « Rosé Pine Dawn »).
    public let palette: String
    /// The word that follows the palette's name when it has a dark and a light variant (« Solarized sombre », "Solarized Dark"): the application says it
    /// in the language of the person. `nil` for a palette whose name says it all.
    public let variant: Variant?
    public enum Variant: String, Sendable { case dark, light }
    /// The base colour the theme is made from: the one `theme.baseColors` holds, and the one the pastille of the space and its accent hue follow.
    public let base: HexColor
    /// The colour of the window with this theme: the palette's own background, shown in the preview.
    public let background: HexColor
    /// The palette's signature colour, shown beside the background in the preview.
    public let accent: HexColor
    /// `dark` or `light` (never `auto`): a ready theme is one or the other.
    public let appearance: InterfaceAppearance

    init(id: String, palette: String, variant: Variant?, base: String, background: String, accent: String, appearance: InterfaceAppearance) {
        self.id = id
        self.palette = palette
        self.variant = variant
        self.base = HexColor(base)!
        self.background = HexColor(background)!
        self.accent = HexColor(accent)!
        self.appearance = appearance
    }

    /// The theme as the state holds it: what `cleanTheme` makes of the Mac's ready theme (one base colour, the `custom` harmony, the full intensity,
    /// no colour boost, no texture, and the translucency of its appearance).
    public var theme: JSONValue {
        .object([
            "baseColors": .array([.string(base.text)]),
            "harmony": .string("custom"),
            "angle": .number(155),
            "intensity": .number(1),
            "overlay": .string("grain"),
            "noise": .number(0),
            "translucency": .string(appearance.rawValue),
            "vibrant": .bool(false),
            "appearance": .string(appearance.rawValue),
        ])
    }

    /// In the order of the Mac's row: a palette and its variants side by side.
    public static let all: [ReadyTheme] = [
        ReadyTheme(id: "dracula", palette: "Dracula", variant: nil, base: "#6a6e8f", background: "#282a36", accent: "#bd93f9", appearance: .dark),
        ReadyTheme(id: "dracula-alucard", palette: "Dracula Alucard", variant: nil, base: "#fff4cb", background: "#fffbeb", accent: "#644ac9", appearance: .light),
        ReadyTheme(id: "nord", palette: "Nord", variant: nil, base: "#788aa8", background: "#2e3440", accent: "#88c0d0", appearance: .dark),
        ReadyTheme(id: "solarized-dark", palette: "Solarized", variant: .dark, base: "#01708f", background: "#002b36", accent: "#268bd2", appearance: .dark),
        ReadyTheme(id: "solarized-light", palette: "Solarized", variant: .light, base: "#f9e8b4", background: "#fdf6e3", accent: "#268bd2", appearance: .light),
        ReadyTheme(id: "gruvbox-dark", palette: "Gruvbox", variant: .dark, base: "#6a6968", background: "#282828", accent: "#fabd2f", appearance: .dark),
        ReadyTheme(id: "gruvbox-light", palette: "Gruvbox", variant: .light, base: "#f5d96c", background: "#fbf1c7", accent: "#d79921", appearance: .light),
        ReadyTheme(id: "tokyo-night", palette: "Tokyo Night", variant: nil, base: "#444863", background: "#1a1b26", accent: "#7aa2f7", appearance: .dark),
        ReadyTheme(id: "tokyo-night-storm", palette: "Tokyo Night Storm", variant: nil, base: "#5e6a9a", background: "#24283b", accent: "#7aa2f7", appearance: .dark),
        ReadyTheme(id: "catppuccin-mocha", palette: "Catppuccin Mocha", variant: nil, base: "#504e78", background: "#1e1e2e", accent: "#cba6f7", appearance: .dark),
        ReadyTheme(id: "catppuccin-macchiato", palette: "Catppuccin Macchiato", variant: nil, base: "#606699", background: "#24273a", accent: "#c6a0f6", appearance: .dark),
        ReadyTheme(id: "catppuccin-frappe", palette: "Catppuccin Frappé", variant: nil, base: "#7f88b9", background: "#303446", accent: "#ca9ee6", appearance: .dark),
        ReadyTheme(id: "catppuccin-latte", palette: "Catppuccin Latte", variant: nil, base: "#d6d9e5", background: "#eff1f5", accent: "#8839ef", appearance: .light),
        ReadyTheme(id: "one-dark", palette: "One Dark", variant: nil, base: "#687588", background: "#282c34", accent: "#61afef", appearance: .dark),
        ReadyTheme(id: "monokai", palette: "Monokai", variant: nil, base: "#676859", background: "#272822", accent: "#f92672", appearance: .dark),
        ReadyTheme(id: "rose-pine", palette: "Rosé Pine", variant: nil, base: "#433c5e", background: "#191724", accent: "#c4a7e7", appearance: .dark),
        ReadyTheme(id: "rose-pine-moon", palette: "Rosé Pine Moon", variant: nil, base: "#5d568d", background: "#232136", accent: "#c4a7e7", appearance: .dark),
        ReadyTheme(id: "rose-pine-dawn", palette: "Rosé Pine Dawn", variant: nil, base: "#f3e1d0", background: "#faf4ed", accent: "#907aa9", appearance: .light),
        ReadyTheme(id: "github-dark", palette: "GitHub", variant: .dark, base: "#232e3c", background: "#0d1117", accent: "#4493f8", appearance: .dark),
        ReadyTheme(id: "github-light", palette: "GitHub", variant: .light, base: "#fefeff", background: "#ffffff", accent: "#0969da", appearance: .light),
    ]

    /// The ready theme a space wears, or `nil` for any other theme (a hue the person picked, a theme the Mac made). The theme must be exactly the ready
    /// one, as the Mac compares them (`readyThemeOf`): a Mac that tuned a ready theme's intensity made a theme of its own.
    public static func of(_ space: Space) -> ReadyTheme? {
        guard let theme = space.rest["theme"] else { return nil }
        return all.first { $0.theme == theme }
    }
}

/// What the colour part of the space form changes. The form shows two ways to colour a space (a hue, a ready theme) and keeps what the person left alone:
/// a theme the Mac made stays as it is until something else is picked.
public enum SpaceColorEdit {
    /// The arguments for `updateSpace`: a ready theme that is not the one the space wears, else a hue that is not the one it has, else nothing. A hue picked
    /// on a space that wears a ready theme changes it even when the hue is the base colour's own: the theme is not the hue's theme.
    public static func patch(of space: Space, hue: Double?, ready: ReadyTheme?) -> (hue: Double?, ready: ReadyTheme?) {
        let wearing = ReadyTheme.of(space)
        if let ready { return (nil, ready == wearing ? nil : ready) }
        guard let hue else { return (nil, nil) }
        if wearing != nil { return (hue, nil) }
        return (hue == SpaceTheme.hue(of: space) ? nil : hue, nil)
    }
}
