import LuciumKit
import SwiftUI

/// The accent of the space on screen (card 672): the colours `SpaceAccent` works out from its hue, as styles that read the hue and the scheme from the
/// environment, so that a view says "accent" and gets the one of the space it is in, light or dark. The hue is set once, at the root of the screen
/// (`spaceAccent(of:)`); sheets and full-screen covers inherit it from the view that presents them.
private struct SpaceHueKey: EnvironmentKey { static let defaultValue = SpaceAccent.defaultHue }

extension EnvironmentValues {
    var spaceHue: Double {
        get { self[SpaceHueKey.self] }
        set { self[SpaceHueKey.self] = newValue }
    }
}

/// `--accent` of the Mac: the fill of a control, the ring of a selection, a switch.
struct AccentFill: ShapeStyle {
    func resolve(in environment: EnvironmentValues) -> Color {
        Color(SpaceAccent.accent(hue: environment.spaceHue, dark: environment.colorScheme == .dark))
    }
}

/// `--accent-text`: the accent as a tick, a link or an icon on the plain ground.
struct AccentText: ShapeStyle {
    func resolve(in environment: EnvironmentValues) -> Color {
        Color(SpaceAccent.text(hue: environment.spaceHue, dark: environment.colorScheme == .dark))
    }
}

/// `--on-accent`: the ink of a label laid on an `AccentFill`.
struct OnAccent: ShapeStyle {
    func resolve(in environment: EnvironmentValues) -> Color {
        Color(SpaceAccent.onAccent(dark: environment.colorScheme == .dark))
    }
}

extension ShapeStyle where Self == AccentFill { static var accentFill: AccentFill { AccentFill() } }
extension ShapeStyle where Self == AccentText { static var accentText: AccentText { AccentText() } }
extension ShapeStyle where Self == OnAccent { static var onAccent: OnAccent { OnAccent() } }

extension View {
    /// Gives the view and everything it presents the accent of `space`: the system's own controls (switches, pickers, links, buttons) take it as their tint.
    func spaceAccent(of space: Space) -> some View { modifier(SpaceAccentModifier(hue: SpaceAccent.hue(of: space))) }
}

private struct SpaceAccentModifier: ViewModifier {
    let hue: Double
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .environment(\.spaceHue, hue)
            .tint(Color(SpaceAccent.accent(hue: hue, dark: scheme == .dark)))
    }
}
