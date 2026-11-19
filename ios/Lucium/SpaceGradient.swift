import LuciumKit
import SwiftUI

/// The pale colours of a space laid behind text (the sidebar, the sheet of tabs, the start page, the command bar, the chip of a space). How much of them is laid
/// is decided in LuciumKit (`TintContrast`): 35 % normally, nothing when the person asked for more contrast or less transparency, so that the text is on the
/// plain ground of the system then.
struct SpaceGradient: View {
    let colors: [Color]
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let opacity = TintContrast.opacity(dark: scheme == .dark, increasedContrast: contrast == .increased, reduceTransparency: reduceTransparency)
        LinearGradient(colors: colors.map { $0.opacity(opacity) }, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
