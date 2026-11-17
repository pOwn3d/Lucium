import SwiftUI
import UIKit

/// A window of its own above everything, drawn while the scene is not active and something is set to be locked. iOS takes the picture shown in
/// the app switcher when the scene stops being active: this keeps that picture, and a look over the shoulder during a system alert, from showing a
/// page. It is a window (not a view of the screen) because a sheet is presented above the views of the screen and would stay visible.
@MainActor
final class PrivacyCover {
    private var window: UIWindow?

    var isShown: Bool { window?.isHidden == false }

    func set(shown: Bool) {
        if shown {
            if window == nil { window = Self.makeWindow() }
            window?.isHidden = false
        } else {
            window?.isHidden = true
        }
    }

    private static func makeWindow() -> UIWindow? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            print("[lock] no window scene: the privacy cover cannot be made")
            return nil
        }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.rootViewController = UIHostingController(rootView: CoverView())
        return window
    }

    private struct CoverView: View {
        var body: some View {
            ZStack {
                Color(.systemBackground).ignoresSafeArea()
                LockGlyph()
                    .stroke(.secondary, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    .frame(width: 56, height: 56)
            }
            .accessibilityHidden(true)
        }
    }
}
