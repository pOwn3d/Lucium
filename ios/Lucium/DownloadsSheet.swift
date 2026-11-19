import LuciumKit
import QuickLook
import SwiftUI

/// The line above the bottom bar while a file comes in, and for a few seconds after it ends. A tap opens the list. No icon: the progress bar and
/// the words are enough.
struct DownloadStrip: View {
    let downloads: DownloadsModel

    var body: some View {
        if let strip = downloads.strip {
            Button { downloads.sheetShown = true } label: {
                VStack(alignment: .leading, spacing: Gap.xs) {
                    HStack(spacing: Gap.s) {
                        text(of: strip).font(.footnote).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                        if case .running(_, _, let more) = strip, more > 0 { Text(verbatim: "+\(more)").font(.footnote).foregroundStyle(.secondary) }
                    }
                    if case .running(_, let fraction, _) = strip {
                        if let fraction { ProgressView(value: fraction) } else { ProgressView().progressViewStyle(.linear) }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .frame(minHeight: 44)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: Radius.l))
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private func text(of strip: DownloadsModel.Strip) -> some View {
        switch strip {
        case .running(let name, _, _): Text("strip.running \(name)")
        case .saved(let name): Text("strip.saved \(name)")
        case .failed(let name): Text("strip.failed \(name)")
        }
    }
}

/// Every download of the session. A finished file opens in a preview, goes out through the share sheet, or is deleted; where it lives is said at the foot.
struct DownloadsSheet: View {
    let downloads: DownloadsModel
    @State private var preview: URL?

    var body: some View {
        NavigationStack {
            List {
                ForEach(downloads.visibleItems) { item in row(item) }
                Section { Text("downloads.where").font(.footnote).foregroundStyle(.secondary) }
            }
            .overlay {
                if downloads.visibleItems.isEmpty { Text("downloads.empty").foregroundStyle(.secondary) }
            }
            .navigationTitle("downloads.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("downloads.close") { downloads.sheetShown = false } }
                ToolbarItem(placement: .cancellationAction) {
                    Button("downloads.clear") { downloads.clearEnded() }.disabled(!downloads.hasEndedVisible)
                }
            }
            .quickLookPreview($preview)
            .alert("downloads.problem.title", isPresented: Binding(get: { downloads.problem != nil }, set: { if !$0 { downloads.dismissProblem() } })) {
                Button("downloads.close") {}
            } message: {
                Text(verbatim: downloads.problem ?? "")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ item: DownloadItem) -> some View {
        let file = downloads.fileURL(of: item)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                // The name of a file and the host it came from are data, not texts of the interface: never looked up in the catalogue.
                Text(verbatim: downloads.label(of: item)).fontWeight(.medium).lineLimit(2).truncationMode(.middle)
                Spacer(minLength: 8)
                if item.phase == .running {
                    Button("downloads.cancel", role: .cancel) { downloads.cancel(item.id) }.buttonStyle(.borderless)
                } else if item.phase == .failed, item.canResume {
                    Button("downloads.resume") { Task { await downloads.resume(item.id) } }.buttonStyle(.borderless)
                } else if let file {
                    ShareLink(item: file) { Text("downloads.share") }.buttonStyle(.borderless)
                }
            }
            if item.phase == .running {
                if let fraction = item.fraction { ProgressView(value: fraction) } else { ProgressView().progressViewStyle(.linear) }
            }
            status(item).font(.footnote).foregroundStyle(.secondary)
            if !item.source.isEmpty { Text("download.from \(item.source)").font(.footnote).foregroundStyle(.secondary) }
        }
        .contentShape(Rectangle())
        .onTapGesture { if let file { preview = file } }
        .swipeActions(edge: .trailing) {
            Button("downloads.delete", role: .destructive) { downloads.deleteFile(item.id) }
            Button("downloads.remove") { downloads.remove(item.id) }.tint(Color.neutralAction)
        }
    }

    @ViewBuilder private func status(_ item: DownloadItem) -> some View {
        let received = size(item.receivedBytes)
        let total = size(item.totalBytes)
        switch item.phase {
        case .running:
            if item.totalBytes > 0 {
                Text("download.size.of \(received) \(total)")
            } else if item.receivedBytes > 0 {
                Text("download.size.so-far \(received)")
            } else {
                Text("download.starting")
            }
        case .finished: Text("download.done \(received)")
        case .failed:
            VStack(alignment: .leading, spacing: Gap.hair) {
                Text("download.failed")
                if let failure = item.failure { Text(verbatim: failure) }
            }
        case .cancelled: Text("download.cancelled")
        }
    }

    private func size(_ bytes: Int64) -> String { bytes.formatted(.byteCount(style: .file)) }
}
