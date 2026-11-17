import LuciumKit
import SwiftUI

/// The archive (docs/ios.md, §4.1): the tabs that were archived, by hand or by the delay of the profile, newest first and grouped by age. A tap
/// brings one back as a new tab, in its space, pinned again if it was pinned.
struct ArchiveScreen: View {
    @Bindable var model: BrowserModel
    @State private var confirmsClear = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let groups = model.archiveGroups
        List {
            if groups.isEmpty {
                Text("archive.empty").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.entries) { entry in row(entry) }
                } header: {
                    Text(title(of: group.bucket)).font(.caption.weight(.semibold)).tracking(0.6).textCase(.uppercase)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(Text("archive.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !groups.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Button { confirmsClear = true } label: { IconView(.trash).frame(width: 44, height: 44) }
                        .accessibilityLabel(Text("archive.clear"))
                }
            }
        }
        .confirmationDialog("archive.clear.title", isPresented: $confirmsClear, titleVisibility: .visible) {
            Button("archive.clear", role: .destructive) { model.clearArchive() }
        } message: {
            Text("archive.clear.message")
        }
    }

    private func row(_ entry: ArchivedTab) -> some View {
        Button { model.restore(entry) } label: {
            HStack(spacing: 12) {
                SiteTile(address: entry.url, size: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: entry.title.isEmpty ? AddressResolver.host(of: entry.url) : entry.title).font(.subheadline).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    Text(verbatim: AddressResolver.host(of: entry.url)).font(.caption).foregroundStyle(.secondary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                }
                Spacer(minLength: 8)
                if entry.pinned { IconView(.pin, size: 16).foregroundStyle(.secondary) }
                IconView(.restore, size: 18).foregroundStyle(.secondary)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("archive.restore"))
    }

    private func title(of bucket: ArchiveBucket) -> LocalizedStringKey {
        switch bucket {
        case .today: "archive.today"
        case .yesterday: "archive.yesterday"
        case .week: "archive.week"
        case .month: "archive.month"
        case .older: "archive.older"
        }
    }
}
