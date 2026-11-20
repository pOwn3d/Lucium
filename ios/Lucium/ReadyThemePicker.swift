import LuciumKit
import SwiftUI

/// The ready themes of the Mac (Dracula, Nord, Solarized…) to pick from in the form of a space: a swatch with the palette's background and its signature
/// colour, and the name under it. The grid adapts to the width (an iPhone, an iPad, a large Dynamic Type size), and a name may take several lines.
/// Picking one tells the form (`onPick`) so that the hue it held is let go.
struct ReadyThemePicker: View {
    @Binding var selection: ReadyTheme?
    let onPick: () -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: Gap.s)], spacing: Gap.m) {
            ForEach(ReadyTheme.all) { theme in
                let selected = theme == selection
                Button {
                    selection = theme
                    onPick()
                } label: {
                    VStack(spacing: Gap.xs) {
                        ReadyThemeSwatch(theme: theme, selected: selected)
                        ReadyThemeName(theme: theme)
                            .font(.caption)
                            // A weight as well as a ring: the choice is not told by a colour alone.
                            .fontWeight(selected ? .semibold : .regular)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }
}

/// The preview of a ready theme: its background, with its accent in the lower corner (the Mac's `readyThemePreview`).
struct ReadyThemeSwatch: View {
    let theme: ReadyTheme
    let selected: Bool

    var body: some View {
        let background = Color(theme.background), accent = Color(theme.accent)
        RoundedRectangle(cornerRadius: Radius.m)
            .fill(LinearGradient(stops: [.init(color: background, location: 0), .init(color: background, location: 0.58),
                                         .init(color: accent, location: 0.58), .init(color: accent, location: 1)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            // A light palette on a light page needs its edge.
            .overlay { RoundedRectangle(cornerRadius: Radius.m).strokeBorder(Color.secondary.opacity(0.5), lineWidth: Stroke.hairline) }
            .overlay { if selected { RoundedRectangle(cornerRadius: Radius.l).strokeBorder(.accentFill, lineWidth: Stroke.ring).padding(-3) } }
            .frame(height: 44)
            .padding(.horizontal, Gap.xs)
    }
}

/// The name of a ready theme: the palette's own name, and the word of its variant in the language of the person.
struct ReadyThemeName: View {
    let theme: ReadyTheme

    var body: some View {
        switch theme.variant {
        case .dark?: Text("spaces.form.ready.dark \(theme.palette)")
        case .light?: Text("spaces.form.ready.light \(theme.palette)")
        case nil: Text(verbatim: theme.palette)
        }
    }
}
