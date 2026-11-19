import LuciumKit
import SwiftUI

/// The line above the page that says what keeping it did ("Added to bookmarks", "Saved to read later"), with a button to open the lists. It goes by
/// itself after a few seconds, or with the cross; nothing blocks. VoiceOver is told the same sentence when it appears (`BrowserModel.show`).
struct KeepBanner: View {
    @Bindable var model: BrowserModel
    /// How long the line stays when the person does nothing.
    static let seconds = 6

    var body: some View {
        if let notice = model.keepNotice {
            HStack(spacing: Gap.s) {
                Text(String(localized: notice.message)).font(.subheadline).lineLimit(3)
                Spacer(minLength: 0)
                if notice.offersList {
                    Button("kept.notice.see") { model.showKept(notice.list) }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                }
                Button { model.keepNotice = nil } label: {
                    IconView(.close, size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("kept.notice.dismiss"))
            }
            .padding(.leading, Gap.m)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityElement(children: .contain)
            .task(id: notice) {
                try? await Task.sleep(for: .seconds(Self.seconds))
                if !Task.isCancelled, model.keepNotice == notice { model.keepNotice = nil }
            }
        }
    }
}

/// The bookmarks and the pages put aside to read later (docs/ios.md, §5.4): two lists in one sheet, a search over the one shown, a tap that opens a page
/// in a new tab, a swipe that removes it. The lists are the device's own (the synchronisation does not carry them yet) and shared by every space.
struct KeptPagesScreen: View {
    @Bindable var model: BrowserModel
    @State private var query = ""
    @State private var tag: String?
    @State private var confirmsClear = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("kept.title", selection: $model.keptList) {
                    Text("kept.bookmarks").tag(KeptList.bookmarks)
                    Text("kept.later").tag(KeptList.readLater)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Gap.l)
                .padding(.vertical, Gap.s)
                list
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(Text("kept.title"))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: Text("kept.search"))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("tabs.done") { model.keptShown = false } }
                if model.keptList == .readLater, !model.readLaterPages.isEmpty {
                    ToolbarItem(placement: .secondaryAction) {
                        Button("kept.later.clear", role: .destructive) { confirmsClear = true }
                    }
                }
            }
            .confirmationDialog("kept.later.clear.title", isPresented: $confirmsClear, titleVisibility: .visible) {
                Button("kept.later.clear", role: .destructive) { model.clearReadLater() }
            } message: {
                Text("kept.later.clear.message")
            }
            .onChange(of: model.keptList) { tag = nil }
        }
    }

    @ViewBuilder private var list: some View {
        switch model.keptList {
        case .bookmarks: bookmarkList
        case .readLater: readLaterList
        }
    }

    // MARK: Bookmarks

    private var bookmarkList: some View {
        let all = model.bookmarks
        let shown = Keepsakes.filter(all, query: query, tags: tag.map { [$0] } ?? [])
        return List {
            if all.isEmpty {
                Text("kept.bookmarks.empty").font(.subheadline).foregroundStyle(.secondary)
            } else if shown.isEmpty {
                Text("kept.none").font(.subheadline).foregroundStyle(.secondary)
            }
            if !Keepsakes.tagCounts(all).isEmpty { tagRow(Keepsakes.tagCounts(all)) }
            ForEach(shown) { mark in
                row(address: mark.url, title: mark.title, detail: mark.tags.isEmpty ? nil : mark.tags.map { "#" + $0 }.joined(separator: " "), age: nil) {
                    Button(role: .destructive) { model.removeBookmark(mark) } label: { Label { Text("kept.remove") } icon: { IconView(.trash) } }
                        .tint(Color.danger)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func tagRow(_ tags: [(tag: String, count: Int)]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Gap.s) {
                ForEach(tags, id: \.tag) { entry in
                    let chosen = tag.map { Keepsakes.fold($0) == Keepsakes.fold(entry.tag) } ?? false
                    Button { tag = chosen ? nil : entry.tag } label: {
                        Text(verbatim: "#\(entry.tag) · \(entry.count)")
                            .font(.footnote.weight(chosen ? .semibold : .regular))
                            .padding(.horizontal, Gap.m)
                            .frame(minHeight: 44)
                            .background(chosen ? AnyShapeStyle(.accentFill.opacity(0.18)) : AnyShapeStyle(Color(.secondarySystemFill)), in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(chosen ? .isSelected : [])
                }
            }
        }
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
    }

    // MARK: Read later

    private var readLaterList: some View {
        let all = model.readLaterPages
        let shown = Keepsakes.filter(all, query: query)
        return List {
            if all.isEmpty {
                Text("kept.later.empty").font(.subheadline).foregroundStyle(.secondary)
            } else if shown.isEmpty {
                Text("kept.none").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(shown) { page in
                row(address: page.url, title: page.title, detail: nil, age: Date(timeIntervalSince1970: page.savedAt / 1000)) {
                    Button(role: .destructive) { model.removeReadLater(page) } label: { Label { Text("kept.remove") } icon: { IconView(.trash) } }
                        .tint(Color.danger)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: A row

    private func row<Actions: View>(address: String, title: String, detail: String?, age: Date?, @ViewBuilder actions: () -> Actions) -> some View {
        let lines = typeSize.isAccessibilitySize ? 3 : 1
        let host = AddressResolver.host(of: address)
        return Button { model.openKept(address: address) } label: {
            HStack(spacing: Gap.m) {
                SiteTile(address: address, size: 22)
                VStack(alignment: .leading, spacing: Gap.hair) {
                    Text(verbatim: title.isEmpty ? host : title).font(.subheadline).lineLimit(lines)
                    Text(verbatim: host).font(.caption).foregroundStyle(.secondary).lineLimit(lines)
                    if let detail { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(lines) }
                    if let age { Text(age, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 8)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("kept.open"))
        .swipeActions(edge: .trailing, allowsFullSwipe: true) { actions() }
    }
}
