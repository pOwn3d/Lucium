import LuciumKit
import SwiftUI

/// « Fermé sur le Mac » (docs/synchronisation.md §27.5, [Q11]): the Mac closed the tab this phone was showing. The session already archived it and showed the neighbour; this
/// line says why the page changed, and « Rouvrir » brings the archived page back as a new tab. It goes by itself after a while, or with the cross: nothing blocks.
struct SyncClosedBanner: View {
    @Bindable var model: BrowserModel
    /// How long the line stays when the person does nothing.
    static let seconds = 12

    var body: some View {
        if let event = model.syncClosedShownTab {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("sync.closed-shown.title \(event.title)").font(.subheadline.weight(.semibold)).lineLimit(2)
                    Text("sync.closed-shown.detail").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if model.state.archive.contains(where: { $0.id == event.id }) {
                    Button("sync.closed-shown.reopen") { model.reopenSyncClosedShownTab() }
                        .frame(minHeight: 44)
                }
                Button { model.syncClosedShownTab = nil } label: {
                    IconView(.close, size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("sync.closed-shown.dismiss"))
            }
            .padding(.leading, 12)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityElement(children: .contain)
            .task(id: event) {
                try? await Task.sleep(for: .seconds(Self.seconds))
                if !Task.isCancelled, model.syncClosedShownTab == event { model.syncClosedShownTab = nil }
            }
        }
    }
}
