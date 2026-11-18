import LuciumKit
import SwiftUI

/// The pastille of a space and its name on the colours of its theme: how a list says which space a tab is in.
struct SpaceChip: View {
    let space: Space
    let colors: [Color]

    var body: some View {
        HStack(spacing: 5) {
            SpacePastille(space: space, colors: colors, size: 18)
            Text(verbatim: space.name).font(.caption.weight(.semibold)).lineLimit(1)
        }
        .padding(.leading, 4)
        .padding(.trailing, 9)
        .frame(minHeight: 26)
        .background(LinearGradient(colors: colors.map { $0.opacity(0.35) }, startPoint: .topLeading, endPoint: .bottomTrailing), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// What « Reprise » and the source « Sur le Mac » say when there is no list to show, and how old a list is (docs/synchronisation.md §10.4).
enum ResumeTexts {
    /// The sentence for a reason: it says what to do when the person can do something about it.
    static func notice(_ availability: SyncResume.Availability, matching: Bool = false) -> LocalizedStringKey {
        switch availability {
        case .notPaired: "resume.notice.not-paired"
        case .disabledHere: "resume.notice.disabled-here"
        case .waiting: "resume.notice.waiting"
        case .disabledOnMac: "resume.notice.disabled-mac"
        case .empty: "resume.notice.empty"
        case .list: matching ? "resume.notice.no-match" : "resume.notice.empty"
        }
    }

    /// « Liste annoncée par le Mac il y a 5 minutes »: the time is written by the system's relative format, in the language of the interface.
    static func age(_ age: SyncResume.Age, locale: Locale = .current) -> LocalizedStringKey {
        func ago(_ components: DateComponents) -> String {
            let formatter = RelativeDateTimeFormatter()
            formatter.locale = locale
            formatter.unitsStyle = .full
            let now = Date()
            return formatter.localizedString(for: Calendar.current.date(byAdding: components, to: now) ?? now, relativeTo: now)
        }
        let when: String
        switch age {
        case .justNow: return "resume.age.now"
        case .minutes(let n): when = ago(DateComponents(minute: -n))
        case .hours(let n): when = ago(DateComponents(hour: -n))
        case .days(let n): when = ago(DateComponents(day: -n))
        }
        return "resume.age \(when)"
    }
}

/// « Reprendre un onglet du Mac » (the mockup « Reprise »): the pages the Mac announced at its last session, most recently read first, each with its space. A touch
/// opens the page in a new tab. The list is in memory only: it is not in the state and it goes with the lock (docs/synchronisation.md §10.4).
struct ResumeScreen: View {
    @Bindable var model: BrowserModel
    /// The time of the screen, to say how old the list is.
    var now: Date = .now
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.locale) private var locale

    var body: some View {
        let rows = model.resumeRows
        List {
            if rows.isEmpty {
                Section {
                    Text(ResumeTexts.notice(model.resumeAvailability))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                }
            } else {
                Section {
                    ForEach(rows) { row in line(row) }
                } header: {
                    if let at = model.sync?.macOpenTabsAt { Text(ResumeTexts.age(SyncResume.age(at: at, now: Int(now.timeIntervalSince1970 * 1000)), locale: locale)) }
                } footer: {
                    Text("resume.footer")
                }
            }
        }
        .navigationTitle("resume.title")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func line(_ row: SyncResume.Row) -> some View {
        let space = model.resumeSpaceShown(of: row)
        let large = typeSize.isAccessibilitySize
        return Button { model.resume(row) } label: {
            HStack(alignment: large ? .top : .center, spacing: 12) {
                SiteTile(address: row.url, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.title).font(.body).foregroundStyle(.primary).lineLimit(large ? 4 : 1)
                    Text(verbatim: row.host).font(.footnote).foregroundStyle(.secondary).lineLimit(large ? 3 : 1)
                    if large, let space { SpaceChip(space: space, colors: model.colors(of: space)).padding(.top, 4) }
                }
                Spacer(minLength: 8)
                if !large, let space { SpaceChip(space: space, colors: model.colors(of: space)) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
