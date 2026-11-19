import LuciumKit
import SwiftUI

/// The pastille of a space and its name on the colours of its theme: how a list says which space a tab is in.
struct SpaceChip: View {
    let space: Space
    let colors: [Color]

    var body: some View {
        HStack(spacing: 5) {
            SpacePastille(space: space, colors: colors, size: 18)
            Text(verbatim: space.name).font(.caption.weight(.semibold)).lineLimit(1)
        }
        .padding(.leading, 4)
        .padding(.trailing, 9)
        .frame(minHeight: 26)
        .background { SpaceGradient(colors: colors).clipShape(Capsule()) }
        .accessibilityElement(children: .combine)
    }
}
