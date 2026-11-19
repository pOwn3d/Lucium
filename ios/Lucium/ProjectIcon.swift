import LuciumKit
import SwiftUI

/// The project's own icons (the strokes of the mockups on a 20 px grid), imported as vectors in the asset catalogue. They are templates: drawn in
/// the colour of the text around them. No icon of the system is used (docs/ios.md, decision of 17 November 2026).
struct ProjectIcon: View {
    enum Name: String {
        case plus = "IconPlus"
        case person = "IconPerson"
        case privateMask = "IconPrivate"
        case check = "IconCheck"
    }

    let name: Name
    var size: CGFloat = 20

    var body: some View {
        Image(name.rawValue)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)  // a picture next to a text: the text says it
    }
}

/// What stands for a space: its emoji on the colours of its theme (the Mac's), with a ring when it is the one on screen.
struct SpacePastille: View {
    let space: Space
    let colors: [Color]
    var size: CGFloat = 36
    var selected = false

    var body: some View {
        Text(space.emoji)
            .font(.system(size: size * 0.5))
            .frame(width: size, height: size)
            .background(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
            .overlay { if selected { Circle().strokeBorder(Color.accentColor, lineWidth: Stroke.ring).padding(-3) } }
            .accessibilityHidden(true)
    }
}

/// A swatch of the colour picker of a space: the colour of a hue.
func swatch(forHue hue: Double) -> Color {
    Color(SpaceTheme.swatch(hue: hue))
}
