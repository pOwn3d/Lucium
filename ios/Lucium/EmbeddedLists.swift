import LuciumKit
import WebKit

/// The filter lists the application carries: converted when the build is prepared (`scripts/ios-filter-lists.mjs`), read from the bundle,
/// compiled once by WebKit and kept in its store under a name that carries the SHA-256 of the file. Nothing is downloaded: the lists change
/// with the application only (docs/ios.md, "Licences des listes embarquées").
/// A compiled list and what it is, so that a switch of the person's can attach it or take it away.
struct BlockerList {
    let list: WKContentRuleList
    let part: BlockerPlan.Part
}

@MainActor
struct EmbeddedLists {
    /// A list that did not compile, or whose file is missing. The others still work.
    struct Failure {
        let file: String
        let error: Error
    }

    struct Outcome {
        var lists: [WKContentRuleList] = []
        /// The same lists with what each one is (`BlockerPlan` attaches them by it), in the same order.
        var parts: [BlockerList] = []
        var failures: [Failure] = []
    }

    static let registryResource = "filter-lists-registry"

    let registry: FilterListRegistry
    private let readRules: @MainActor (FilterListFile) throws -> String

    init(registry: FilterListRegistry, readRules: @escaping @MainActor (FilterListFile) throws -> String) {
        self.registry = registry
        self.readRules = readRules
    }

    /// The lists of a bundle, or nil when this copy of the application has none (a checkout where the build step was not run). A registry that
    /// cannot be read, or that does not say where a list comes from, is an error: the application does not carry a list it cannot credit.
    static func load(in bundle: Bundle = .main) throws -> EmbeddedLists? {
        guard let url = bundle.url(forResource: registryResource, withExtension: "json") else { return nil }
        let registry = try FilterListRegistry.decode(Data(contentsOf: url))
        return EmbeddedLists(registry: registry) { file in
            guard let url = bundle.url(forResource: file.name, withExtension: nil) else { throw ContentBlocker.BlockerError.missingResource }
            return try String(contentsOf: url, encoding: .utf8)
        }
    }

    /// Every file of every list, compiled or found already compiled under its name. Several are compiled at a time (WebKit does the work on
    /// its own threads); a file that fails is reported and does not stop the others. Lists of an older copy that the registry no longer names
    /// are removed from the store.
    func compile(in store: WKContentRuleListStore = .default(), mode: BlockMode = .strict) async -> Outcome {
        // The scriptlet tables are not rules: WebKit never sees them (`scriptletTable()`). Each file knows the list it belongs to, for its category.
        let entries = registry.lists.flatMap { entry in entry.files.filter { $0.kind.isWebKitRules }.map { (entry, $0) } }
        let files = entries.map(\.1)
        let collector = Collector()
        // One task per file, all started before any is waited for: while one awaits WebKit, the next one starts.
        let tasks = files.map { file in
            Task { @MainActor in
                do {
                    collector.lists[file.name] = try await list(for: file, mode: mode, in: store)
                } catch {
                    print("[blocker] list \(file.name) not compiled, its rules are missing: \(error)")
                    collector.failures.append(Failure(file: file.name, error: error))
                }
            }
        }
        for task in tasks { await task.value }
        // The other mode's copy of the network lists goes too: the store holds what is used, and a switch of mode compiles the other again.
        await removeStaleLists(in: store, keeping: Set(files.map { $0.storeIdentifier(for: mode) }))
        // In the order of the registry, whatever order the compilations finished in: exceptions of a list never depend on a race.
        let parts = entries.compactMap { entry, file in collector.lists[file.name].map { BlockerList(list: $0, part: BlockerPlan.Part(source: .catalogue(entry.category), kind: file.kind)) } }
        return Outcome(lists: parts.map(\.list), parts: parts, failures: collector.failures.sorted { $0.file < $1.file })
    }

    /// The calls the lists name for sites, merged, each with the category of its list (the page guard asks the ads lists and the cookie lists apart).
    /// A table that cannot be read is an error: the page guard would run with calls nobody can account for, or without any, and say nothing.
    func scriptletTable() throws -> ScriptletTable {
        var table = ScriptletTable()
        for list in registry.lists {
            for file in list.files where file.kind == .scriptlets {
                try table.merge(Data(readRules(file).utf8), category: list.category)
            }
        }
        return table
    }

    @MainActor private final class Collector {
        var lists: [String: WKContentRuleList] = [:]
        var failures: [Failure] = []
    }

    private func list(for file: FilterListFile, mode: BlockMode, in store: WKContentRuleListStore) async throws -> WKContentRuleList {
        let identifier = file.storeIdentifier(for: mode)
        do {
            if let found = try await store.contentRuleList(forIdentifier: identifier) { return found }
        } catch let error as NSError where error.domain == WKErrorDomain && error.code == WKError.contentRuleListStoreLookUpFailed.rawValue {
            // Not compiled yet under this name: compile it below.
        }
        var rules = try readRules(file)
        // « Standard » is the same network rules with the party the Mac gives them (`StandardModeRules`): written off the main actor, the big lists are megabytes.
        if mode == .standard, file.kind == .network {
            let text = rules
            rules = try await Task.detached { try StandardModeRules.transform(text) }.value
        }
        guard let list = try await store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: rules) else {
            throw ContentBlocker.BlockerError.missingResource
        }
        return list
    }

    private func removeStaleLists(in store: WKContentRuleListStore, keeping current: Set<String>) async {
        for identifier in await store.availableIdentifiers() ?? [] where identifier.hasPrefix(FilterListRegistry.identifierPrefix) && !current.contains(identifier) {
            do {
                try await store.removeContentRuleList(forIdentifier: identifier)
            } catch {
                print("[blocker] stale list \(identifier) not removed: \(error)")
            }
        }
    }
}
