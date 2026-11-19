import LuciumKit
import SwiftUI
import UIKit

/// The iPhone's sidebar (decision of the project lead, 18 November 2026): a drag from the left edge of the screen brings out, above the page, the
/// sidebar of the iPad: the same view (`Sidebar`), not a copy. The page behind is dimmed; a tap on it, a drag to the left, "Hide the sidebar", or
/// opening a page puts the sidebar away. The numbers (its width, where a drag settles) and what closes it are in `LuciumKit` (`EdgeDrawer`), proved
/// there; this is the part that draws it and listens to the fingers.
///
/// A person who cannot drag from an edge has two other ways: the tabs button of the bottom bar, which opens the sheet of the same lists, and the
/// sidebar button of the bottom bar (card 664: visible, 44 points, found by VoiceOver, Switch Control and Voice Control; it replaces the invisible
/// one this view had). With VoiceOver the sidebar is a
/// modal group, the page behind it is not read, and the "escape" action puts it away.
struct EdgeDrawerHost<Page: View>: View {
    @Bindable var model: BrowserModel
    @Binding var expandedFolders: Set<String>
    /// The width of the screen: the sidebar's own is a share of it.
    let screenWidth: Double
    private let page: Page
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// While a finger drags the sidebar: from which state it started, and how far it went.
    @State private var drag: Drag?

    private struct Drag {
        var wasOpen: Bool
        var translation: Double
    }

    init(model: BrowserModel, expandedFolders: Binding<Set<String>>, screenWidth: Double, @ViewBuilder page: () -> Page) {
        self.model = model
        self._expandedFolders = expandedFolders
        self.screenWidth = screenWidth
        self.page = page()
    }

    private var width: Double { EdgeDrawer.width(screenWidth: screenWidth, largeText: typeSize.isAccessibilitySize) }

    /// How far out the sidebar is, 0 to 1: where the finger has dragged it, or where it rests.
    private var progress: Double {
        if let drag { return EdgeDrawer.progress(wasOpen: drag.wasOpen, translation: drag.translation, width: width) }
        return model.drawerShown ? 1 : 0
    }

    /// The sidebar settles, and moves when a tab is opened in it, with this; a person who asked for less motion gets none.
    private var settle: Animation? { reduceMotion ? nil : .snappy(duration: 0.3) }

    var body: some View {
        ZStack(alignment: .leading) {
            page
                // The page is not read while the sidebar is out: the sidebar is the modal group.
                .accessibilityHidden(model.drawerShown)
            if progress > 0 {
                ZStack(alignment: .leading) {
                    scrim
                    drawer
                }
                .gesture(closingPan)
            }
        }
        .gesture(edgePan)
        .animation(settle, value: model.drawerShown)
        // VoiceOver moves to the new screen: into the sidebar when it opens, back to the page when it closes.
        .onChange(of: model.drawerShown) { UIAccessibility.post(notification: .screenChanged, argument: nil) }
    }

    // MARK: Parts

    /// The page, dimmed: a tap on it puts the sidebar away. Nothing for VoiceOver (the "escape" action and the hide button do it).
    private var scrim: some View {
        Color.scrim.opacity(progress)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { put(.tappedPage) }
            .accessibilityHidden(true)
    }

    private var drawer: some View {
        Sidebar(model: model, sidebarShown: Binding(get: { true }, set: { if !$0 { put(.dismissed) } }), expandedFolders: $expandedFolders)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background { SidebarGround(model: model) }
            .overlay(alignment: .trailing) { Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1).ignoresSafeArea() }
            .shadow(color: Color.shadow.opacity(progress), radius: 14)
            // The shadow goes with it: nothing of the sidebar is left at the edge when it is away.
            .offset(x: -(1 - progress) * (width + 24))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("sidebar.title"))
            .accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { put(.dismissed) }
            .accessibilityIdentifier("edge-drawer")
    }

    // MARK: Fingers

    /// What a drag from the left edge of the screen does: the sidebar follows the finger, and settles where `EdgeDrawer` says when it lifts.
    private var edgePan: DrawerPan {
        DrawerPan(kind: .fromEdge, began: begin, changed: { drag?.translation = $0 }, ended: finish, cancelled: cancel)
    }

    /// A drag to the left on the sidebar or on the page dimmed behind it. It does not begin on a row of a list, which keeps its own swipe (pin,
    /// archive, close: the same gestures as in the sheet).
    private var closingPan: DrawerPan {
        DrawerPan(kind: .closing, began: begin, changed: { drag?.translation = $0 }, ended: finish, cancelled: cancel)
    }

    private func begin() { drag = Drag(wasOpen: model.drawerShown, translation: 0) }

    private func finish(translation: Double, velocity: Double) {
        let wasOpen = drag?.wasOpen ?? model.drawerShown
        let open = EdgeDrawer.settlesOpen(wasOpen: wasOpen, translation: translation, velocity: velocity, width: width)
        withAnimation(settle) {
            drag = nil
            model.drawerEvent(open ? .pulledOpen : .pushedClosed)
        }
    }

    private func cancel() {
        let wasOpen = drag?.wasOpen ?? model.drawerShown
        withAnimation(settle) {
            drag = nil
            model.drawerEvent(wasOpen ? .pulledOpen : .pushedClosed)
        }
    }

    private func put(_ event: EdgeDrawerEvent) {
        withAnimation(settle) { model.drawerEvent(event) }
    }
}

/// A one-finger pan, from the left edge of the screen (`UIScreenEdgePanGestureRecognizer`: the system decides where the edge is) or anywhere (to close),
/// handed to SwiftUI. SwiftUI's own drag cannot be told to come from the edge, and a drag laid over a list would take the horizontal swipe of its rows.
struct DrawerPan: UIGestureRecognizerRepresentable {
    enum Kind { case fromEdge, closing }

    let kind: Kind
    let began: () -> Void
    /// How far the finger is from where it touched, to the right (negative to the left), in points.
    let changed: (Double) -> Void
    /// The finger lifted: the distance and the speed (points per second) to the right.
    let ended: (Double, Double) -> Void
    let cancelled: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(kind: kind) }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer: UIPanGestureRecognizer
        switch kind {
        case .fromEdge:
            let edge = UIScreenEdgePanGestureRecognizer()
            edge.edges = .left
            recognizer = edge
        case .closing:
            recognizer = UIPanGestureRecognizer()
        }
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let translation = Double(recognizer.translation(in: recognizer.view).x)
        switch recognizer.state {
        case .began:
            began()
            changed(translation)
        case .changed:
            changed(translation)
        case .ended:
            ended(translation, Double(recognizer.velocity(in: recognizer.view).x))
        case .cancelled, .failed:
            cancelled()
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let kind: Kind
        init(kind: Kind) { self.kind = kind }

        /// A drag to close begins when it goes to the left, mostly sideways, and not on a row of a list (the row's own swipe is more specific); the drag
        /// from the edge always begins.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard kind == .closing, let pan = recognizer as? UIPanGestureRecognizer, let view = pan.view else { return true }
            let velocity = pan.velocity(in: view)
            guard velocity.x < 0, abs(velocity.x) > abs(velocity.y) else { return false }
            let location = pan.location(in: view)
            let moved = pan.translation(in: view)
            var hit = view.hitTest(CGPoint(x: location.x - moved.x, y: location.y - moved.y), with: nil)
            while let current = hit, current !== view {
                if current is UICollectionViewCell || current is UITableViewCell { return false }
                hit = current.superview
            }
            return true
        }
    }
}
