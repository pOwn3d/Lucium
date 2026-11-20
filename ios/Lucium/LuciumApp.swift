import SwiftUI

@main
struct LuciumApp: App {
    /// The state file is read once, here: what it cannot read is put aside and told to the person (`BrowserScreen`).
    @State private var model = BrowserModel.launchWithLock()

    var body: some Scene {
        WindowGroup {
            BrowserScreen(model: model)
                // A link from another application (the default-browser requirement, docs/ios.md §9.4): cold start and running application alike.
                .onOpenURL { model.receive($0) }
        }
        // The hardware keyboard of an iPad: the Mac's shortcuts (docs/ios.md §3.5).
        .commands { KeyboardCommands(model: model) }
    }
}
