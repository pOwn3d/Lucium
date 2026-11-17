import LuciumKit
import SwiftUI

/// The project's lock icon (the same drawing as the Mac's lock screen: a rounded body and a shackle on a 24-point grid), not a system symbol.
struct LockGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 24
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit) }
        var path = Path()
        path.addRoundedRect(in: CGRect(x: rect.minX + 5 * unit, y: rect.minY + 10.5 * unit, width: 14 * unit, height: 9.5 * unit),
                            cornerSize: CGSize(width: 2 * unit, height: 2 * unit))
        // The shackle: two quarter circles of radius 4 joined at the top, drawn with curves so that no angle convention is involved.
        path.move(to: point(8, 10.5))
        path.addLine(to: point(8, 8))
        path.addCurve(to: point(12, 4), control1: point(8, 5.791), control2: point(9.791, 4))
        path.addCurve(to: point(16, 8), control1: point(14.209, 4), control2: point(16, 5.791))
        path.addLine(to: point(16, 10.5))
        return path
    }
}

/// What replaces the page while the application or the space on screen is locked. It knows nothing of what is behind it: the model gives no tab,
/// no title and no address for a covered space, so there is nothing to uncover.
struct LockScreen: View {
    enum Kind: Equatable {
        case app
        case space(name: String)
    }

    let kind: Kind
    @Bindable var lock: LockController
    let unlock: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            LockGlyph()
                .stroke(.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
            title.font(.title2.weight(.semibold)).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
            Text("lock.screen.hint").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button(action: unlock) { Text("lock.screen.unlock").frame(minWidth: 160, minHeight: 44) }
                .buttonStyle(.borderedProminent)
                .disabled(lock.isAuthenticating)
            if let notice = lock.notice { Text(notice.text).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }

    @ViewBuilder private var title: some View {
        switch kind {
        case .app: Text("lock.screen.app.title")
        case .space(let name): Text("lock.screen.space.title \(name)")
        }
    }
}

extension LockNotice {
    /// What the screens say about the last attempt. A refusal that is only a cancellation says so in one short line.
    var text: LocalizedStringKey {
        switch self {
        case .refused(.cancelled): "lock.notice.cancelled"
        case .refused(.failed): "lock.notice.failed"
        case .refused(.unavailable): "lock.notice.unavailable"
        case .noPasscode: "lock.notice.no-passcode"
        case .saveFailed: "lock.notice.save-failed"
        case .settingsUnreadable: "lock.notice.unreadable"
        case .switchedOffNoPasscode: "lock.notice.switched-off"
        }
    }
}
