import LuciumKit
import SwiftUI

/// « Conflit réglé » (docs/synchronisation.md §13.4, the mockup « Conflit »): « Deux changements se croisaient », and for each conflict what each device did
/// and what is in force. Never a question that blocks: the merge has settled, « D'accord » only closes the screen. « Comparer » shows the two versions, with
/// the possibility to put back the one that lost; a deletion that lost has no two versions to show and offers « Le supprimer partout » instead.
///
/// The screen changes nothing itself: it takes the lines of the journal (`SyncConflicts.lastSession`) and `onRestore` as parameters, and the page
/// « Synchronisation » of the settings presents it as a sheet. « Rétablir » is an ordinary change of the state, which goes out at the next session like any
/// other; the host takes the line out of the journal.
struct SyncConflictScreen: View {
    let entries: [SettledConflict]
    /// The time of the screen, to say « 9 h 15 » for today and the date for another day.
    let now: Date
    let onClose: () -> Void
    let onRestore: (SyncChange, String) -> Void
    @State private var comparing: String?
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var typeSize

    /// `initialComparing` is the line open on « Comparer » when the screen opens (the tests open it so).
    init(entries: [SettledConflict], now: Date = .now, initialComparing: String? = nil, onClose: @escaping () -> Void, onRestore: @escaping (SyncChange, String) -> Void) {
        self.entries = entries
        self.now = now
        self.onClose = onClose
        self.onRestore = onRestore
        _comparing = State(initialValue: initialComparing)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: word("sync-conflict.title")).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text(verbatim: word("sync-conflict.subtitle")).font(.subheadline).foregroundStyle(.secondary)
                    Text("conflict.count \(entries.count)").font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.bottom, 4)
                ForEach(entries, id: \.id) { entry in card(entry) }
                Button(action: onClose) {
                    Text(verbatim: word("sync-conflict.ok")).font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            }
            .padding(16)
        }
    }

    private func word(_ key: String) -> String { SyncConflictTexts.string(key, locale: locale) }
    private func say(_ text: SyncText) -> String { SyncConflictTexts.string(text, locale: locale) }

    /// A value as the person reads it: what they typed, « oui » or « non », or a word that says there is nothing to show.
    private func valueText(_ value: SyncShown) -> String {
        switch value {
        case .text(let text): return text
        case .bool(let flag): return word(flag ? "sync-conflict.value-yes" : "sync-conflict.value-no")
        case .absent: return word("sync-conflict.value-none")
        case .complex: return word("sync-conflict.value-other")
        }
    }

    /// What the person typed, in the quotes of the language of the screen (as the Mac's `quoted`): « like this » in French, “like this” in English.
    private func quoted(_ text: String) -> String {
        locale.language.languageCode?.identifier == "en" ? "“\(text)”" : "«\u{00A0}\(text)\u{00A0}»"
    }

    private func when(_ at: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(at) / 1000)
        if Calendar.current.isDate(date, inSameDayAs: now) { return date.formatted(.dateTime.hour().minute().locale(locale)) }
        return date.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(locale))
    }

    private func card(_ entry: SettledConflict) -> some View {
        let view = SyncConflicts.view(of: entry)
        let open = comparing == view.id
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: say(view.title)).font(.subheadline).foregroundStyle(.secondary)
                if let label = view.label { Text(verbatim: quoted(label)).font(.headline).lineLimit(typeSize.isAccessibilitySize ? 3 : 1) }
            }
            .accessibilityElement(children: .combine)
            ForEach(view.rows, id: \.platform) { row in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: SyncConflictTexts.deviceName(row.platform))
                        .font(.caption.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1).background(Color(.tertiarySystemFill), in: Capsule())
                    Text(verbatim: say(row.text)).font(.subheadline).foregroundStyle(row.kept ? .primary : .secondary)
                    Spacer(minLength: 4)
                    if let at = row.at { Text(verbatim: when(at)).font(.caption).foregroundStyle(.secondary).monospacedDigit() }
                }
                .accessibilityElement(children: .combine)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                IconView(.check, size: 14).foregroundStyle(.green).accessibilityHidden(true)
                Text(verbatim: say(view.outcome)).font(.subheadline.weight(.semibold))
            }
            if view.compare {
                Button { comparing = open ? nil : view.id } label: {
                    Text(verbatim: word(open ? "sync-conflict.hide-compare" : "sync-conflict.compare")).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityAddTraits(open ? [.isSelected] : [])
            } else if let restore = view.restore {
                Button { onRestore(restore, view.id) } label: {
                    Text(verbatim: word("sync-conflict.delete-everywhere")).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
            }
            if open { compare(entry, view) }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func compare(_ entry: SettledConflict, _ view: ConflictView) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            version("sync-conflict.kept-version", valueText(entry.kept))
            version("sync-conflict.other-version", valueText(entry.lost))
            if let restore = view.restore {
                Button { onRestore(restore, view.id) } label: {
                    Text(verbatim: word("sync-conflict.restore")).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
            }
            Text(verbatim: word("sync-conflict.explain-restore")).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.top, 4)
    }

    private func version(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: word(title)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(verbatim: value).font(.body)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}
