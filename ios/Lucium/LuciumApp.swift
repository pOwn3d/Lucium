import SwiftUI

@main
struct LuciumApp: App {
    /// The state file is read once, here: what it cannot read is put aside and told to the person (`BrowserScreen`).
    @State private var model = BrowserModel.launch()

    var body: some Scene {
        WindowGroup {
            BrowserScreen(model: model)
        }
    }
}
