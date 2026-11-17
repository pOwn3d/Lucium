import SwiftUI

@main
struct LuciumApp: App {
    @State private var model = BrowserModel.makeDefault()

    var body: some Scene {
        WindowGroup {
            BrowserScreen(model: model)
        }
    }
}
