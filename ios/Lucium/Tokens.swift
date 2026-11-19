import LuciumKit
import SwiftUI

/// The design tokens of Lucium on iOS: the roles that `src/renderer/tokens.css` gives the Mac (radius, rhythm, status colours, accent),
/// so that a view names a role and never a number or a colour of its own. `LuciumKitTests/DesignTokensTests.swift` refuses a
/// literal corner radius, a hex colour or a named system colour in any other file of this folder.
/// Colours come from the system (they follow light, dark and increased contrast) or from the asset catalogue (`AccentColor`).

/// Corner radii, from the smallest (a tag) to the largest (a card). Same names as `--r-s … --r-xl` of the Mac.
enum Radius {
    static let s: CGFloat = 8
    static let m: CGFloat = 10
    static let l: CGFloat = 12
    static let xl: CGFloat = 14
    /// A site tile scales its corner with its size (27 %), so that it stays the same shape at every size.
    static func tile(size: CGFloat) -> CGFloat { size * 0.27 }
}

/// The rhythm: the steps of the gaps and paddings (`--sp-1 … --sp-5` of the Mac, plus the 2 pt hairline gap of two stacked lines).
enum Gap {
    static let hair: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
}

/// The width of a line: a hairline border, and the ring of a selection.
enum Stroke {
    static let hairline: CGFloat = 1
    static let ring: CGFloat = 2
}

/// Roles of colour. The accent is the one of the app (`AccentColor`); the status colours are the system's, which adapt to the scheme.
extension Color {
    /// An error or a destructive action.
    static let danger = Color(.systemRed)
    /// A success (a conflict settled, a step done).
    static let success = Color(.systemGreen)
    /// A pinned tab.
    static let pinned = Color(.systemIndigo)
    /// An action that archives (put away, not deleted).
    static let archiving = Color(.systemOrange)
    /// A quiet action (remove from a list).
    static let neutralAction = Color(.systemGray)
    /// The letter on a site tile: the tile colours are the same in both schemes and are dark enough for white (checked in the Mac palette).
    static let onTile = Color.white
    /// The scrim that dims the page behind the sliding sidebar.
    static let scrim = Color.black.opacity(0.32)
    /// The shadow of a floating surface.
    static let shadow = Color.black.opacity(0.28)

    /// A colour that is data, read from the state (the theme of a space, written by the Mac): the only place where an RGB value becomes a colour.
    init(_ hex: HexColor) {
        self.init(.sRGB, red: Double(hex.red) / 255, green: Double(hex.green) / 255, blue: Double(hex.blue) / 255, opacity: 1)
    }
}
