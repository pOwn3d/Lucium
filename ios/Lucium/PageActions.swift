import LuciumKit
import SwiftUI
import WebKit

/// What the person does with the page in front of them: share its address, save it as a PDF, open the downloads.
extension BrowserModel {
    /// The address that can be shared: a web page's, never the start page or a local file.
    var shareURL: URL? { PageShare.shareableURL(webView?.url?.absoluteString) }

    var pageTitle: String { webView?.title ?? "" }

    var canSavePDF: Bool { shareURL != nil }

    /// Searching in the page needs a page: the start page is drawn by SwiftUI, there is no text of the web to search.
    var canFindInPage: Bool { shareURL != nil && webView?.findInteraction != nil }

    /// Opens the system's find bar on the page in front of the person.
    func findInPage() {
        guard canFindInPage, let interaction = webView?.findInteraction else { return }
        presentFind(interaction)
    }

    /// The page as a PDF in the folder of the downloads. The whole page is drawn, not only what is on screen (`WKPDFConfiguration` with no rectangle).
    func savePageAsPDF() async {
        guard let view = webView, canSavePDF else { return }
        let page = host
        let space = state.activeSpaceId
        do {
            let data = try await view.pdf(configuration: WKPDFConfiguration())
            downloads.save(pdf: data, title: view.title, host: page, spaceId: space)
        } catch {
            downloads.failPDF(host: page, error: error, spaceId: space)
        }
    }
}

/// The button of the page's actions, in the bottom bar: share, save as PDF, downloads. A menu of words; the project's own icon (`Icon.more`) is on the button.
struct PageActionsMenu: View {
    @Bindable var model: BrowserModel

    var body: some View {
        Menu {
            if let url = model.shareURL {
                ShareLink(item: url, subject: Text(verbatim: model.pageTitle)) { Text("page.share") }
            } else {
                Button("page.share") {}.disabled(true)
            }
            Button("page.find") { model.findInPage() }.disabled(!model.canFindInPage)
            Button("page.save-pdf") { Task { await model.savePageAsPDF() } }.disabled(!model.canSavePDF)
            Divider()
            // The text size is changed step by step: these stay open so that a few taps reach the size wanted (the menu closes on the others).
            Button("page.zoom.in") { model.zoomPageIn() }
                .disabled(!model.canChangeDisplay || !model.activeDisplay.canZoomIn)
                .menuActionDismissBehavior(.disabled)
            Button("page.zoom.out") { model.zoomPageOut() }
                .disabled(!model.canChangeDisplay || !model.activeDisplay.canZoomOut)
                .menuActionDismissBehavior(.disabled)
            Button("page.zoom.reset \(model.activeDisplay.zoomPercent)") { model.resetPageZoom() }
                .disabled(!model.canChangeDisplay || !model.activeDisplay.isZoomed)
                .menuActionDismissBehavior(.disabled)
            if model.offersDesktopVersion {
                Toggle("page.desktop", isOn: Binding(get: { model.activeDisplay.desktop }, set: { model.setDesktopVersion($0) }))
                    .disabled(!model.canChangeDisplay)
            }
            Divider()
            Button(model.activePageIsBookmarked ? "kept.menu.unbookmark" : "kept.menu.bookmark") { model.toggleBookmark() }
                .disabled(model.keepableTab == nil)
            Button("kept.menu.later") { model.readLater() }.disabled(model.keepableTab == nil)
            Button("kept.menu.open") { model.showKept(model.keptList) }
            Divider()
            Button("page.downloads") { model.downloads.sheetShown = true }
        } label: {
            IconView(.more).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(Color.primary)
        .accessibilityLabel(Text("page.more"))
    }
}
