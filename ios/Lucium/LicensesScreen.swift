import LuciumKit
import SwiftUI

/// What the application owes to the people whose work it carries: its own licence, and, for every filter list built into it, the title,
/// the author, the licence, the source and the date of the copy (docs/ios.md, "Licences des listes embarquées"). The entries come from the
/// registry the build step wrote next to the lists, so the screen has no copy written by hand. A page of the settings screen: it is pushed on its
/// navigation stack.
struct LicensesScreen: View {
    private let registry: FilterListRegistry?
    private let problem: Error?

    init(lists: EmbeddedLists? = nil) {
        if let lists {
            registry = lists.registry
            problem = nil
        } else {
            do {
                registry = try EmbeddedLists.load()?.registry
                problem = nil
            } catch {
                // A registry that cannot be read is told on the screen, not hidden: the person sees that the credits are missing.
                registry = nil
                problem = error
                print("[licenses] the registry of the filter lists cannot be read: \(error)")
            }
        }
    }

    var body: some View {
        List {
            Section("licenses.app.header") {
                Text("licenses.app.summary")
                ForEach(LicenseText.allCases) { text in
                    NavigationLink(text.title) { LicenseTextScreen(text: text) }
                }
            }
            Section {
                if let registry {
                    ForEach(registry.lists) { list in FilterListRow(list: list) }
                } else {
                    Text(problem == nil ? "licenses.lists.none" : "licenses.lists.unreadable")
                }
            } header: {
                Text("licenses.lists.header")
            } footer: {
                Text("licenses.lists.footer")
            }
        }
        .navigationTitle("licenses.title")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One list: its title, who wrote it, under what licence, where it comes from, and which copy this is.
private struct FilterListRow: View {
    let list: FilterListEntry
    @Environment(\.locale) private var locale

    var body: some View {
        let language = locale.language.languageCode?.identifier
        let author = list.author.text(forLanguageCode: language)
        let license = list.license.text(forLanguageCode: language)
        let copy = list.fetchedDate?.formatted(.dateTime.day().month(.abbreviated).year().locale(locale)) ?? list.fetchedAt
        let rules = list.rules.formatted(.number.locale(locale))
        VStack(alignment: .leading, spacing: Gap.xs) {
            Text(list.title.text(forLanguageCode: language)).font(.headline)
            Text("licenses.list.author \(author)")
            Text("licenses.list.license \(license)")
            Text("licenses.list.copy \(copy)")
            Text("licenses.list.rules \(rules)").foregroundStyle(.secondary)
            if let source = URL(string: list.sourceUrl) { Link("licenses.list.source", destination: source) }
            if let terms = URL(string: list.licenseUrl) { Link("licenses.list.terms", destination: terms) }
        }
        .font(.subheadline)
        .padding(.vertical, Gap.hair)
    }
}

/// The texts of the project's own licence, shown whole: the GPL, the notice, and the additional permission for the App Store. They are
/// copies of the files at the root of the repository, put in the bundle by `project.yml`.
enum LicenseText: CaseIterable, Identifiable {
    case license, notice, permission

    var id: Self { self }

    /// The name of the file in the bundle.
    var resource: String {
        switch self {
        case .license: "LICENSE"
        case .notice: "NOTICE"
        case .permission: "ADDITIONAL-PERMISSION-APP-STORE.txt"
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .license: "licenses.text.license"
        case .notice: "licenses.text.notice"
        case .permission: "licenses.text.permission"
        }
    }

    func contents(in bundle: Bundle = .main) -> String? {
        bundle.url(forResource: resource, withExtension: nil).flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }
}

private struct LicenseTextScreen: View {
    let text: LicenseText

    var body: some View {
        ScrollView {
            if let contents = text.contents() {
                Text(verbatim: contents).font(.footnote.monospaced()).padding().frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            } else {
                Text("licenses.text.missing").padding()
            }
        }
        .navigationTitle(text.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
