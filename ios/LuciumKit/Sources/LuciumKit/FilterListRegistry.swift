import Foundation

/// A text in the two languages of the application, as `scripts/ios-filter-lists.mjs` writes it (the same mentions the Mac's settings print).
public struct LocalizedText: Codable, Equatable, Sendable {
    public let en: String
    public let fr: String

    public init(en: String, fr: String) { self.en = en; self.fr = fr }

    /// The text for a language code (`"fr"`, `"fr-CA"`…); English for any other.
    public func text(forLanguageCode code: String?) -> String {
        (code ?? "").lowercased().hasPrefix("fr") ? fr : en
    }
}

/// One file of rules of an embedded list.
public struct FilterListFile: Codable, Equatable, Sendable {
    /// `network` and `cosmetic` are files of WebKit rules; `scriptlets` is the table of calls the list names for sites (`ScriptletTable`), which
    /// WebKit never reads: its `rules` are calls.
    public enum Kind: String, Codable, Sendable {
        case network, cosmetic, scriptlets

        /// Whether the file is compiled by WebKit.
        public var isWebKitRules: Bool { self != .scriptlets }
    }

    public let name: String
    public let kind: Kind
    public let rules: Int
    /// SHA-256 of the file, hex.
    public let sha256: String

    public init(name: String, kind: Kind, rules: Int, sha256: String) { self.name = name; self.kind = kind; self.rules = rules; self.sha256 = sha256 }

    /// The name of the compiled list in WebKit's store. It carries the start of the SHA-256: a new copy of a list is another list, and the old
    /// one is removed (`EmbeddedLists`), so the store never serves rules the application no longer carries.
    public var storeIdentifier: String { "\(FilterListRegistry.identifierPrefix)\(name.replacingOccurrences(of: ".json", with: "")).\(sha256.prefix(12))" }
}

/// One embedded filter list: where it comes from and under what terms (what the licences screen shows), and its files.
public struct FilterListEntry: Codable, Equatable, Sendable, Identifiable {
    public enum Category: String, Codable, Sendable { case ads, cookies }

    public let id: String
    public let title: LocalizedText
    public let category: Category
    public let author: LocalizedText
    public let license: LocalizedText
    public let licenseUrl: String
    public let homepage: String
    public let sourceUrl: String
    /// When the copy was fetched (ISO 8601, UTC) and the version the list gives of itself, if it does.
    public let fetchedAt: String
    public let sourceVersion: String?
    public let sourceSha256: String
    /// The filters read, and, by reason, the ones the conversion left out.
    public let filters: Int
    public let dropped: [String: Int]
    public let files: [FilterListFile]

    /// The rules WebKit reads, and the scriptlet calls the page guard runs, apart.
    public var rules: Int { files.filter { $0.kind.isWebKitRules }.reduce(0) { $0 + $1.rules } }
    public var scriptletCalls: Int { files.filter { !$0.kind.isWebKitRules }.reduce(0) { $0 + $1.rules } }

    /// The date of the copy, or nil if the registry carries a text that is not a date.
    public var fetchedDate: Date? { ISO8601DateFormatter().date(from: fetchedAt) }
}

/// The registry written beside the embedded lists (`filter-lists-registry.json`).
public struct FilterListRegistry: Codable, Equatable, Sendable {
    public static let supportedSchema = 1
    public static let identifierPrefix = "app.lucium.list."
    /// The most rules one WebKit list takes (measured on the iOS simulator, docs/ios.md section 6.2).
    public static let ruleLimit = 150_000

    public let schema: Int
    public let generatedAt: String
    public let lists: [FilterListEntry]

    public enum RegistryError: Error, Equatable {
        case unsupportedSchema(Int)
        /// The registry is not complete: what is missing, in sentences (the build step refuses to write such a registry; this is the second look).
        case incomplete([String])
    }

    /// Reads a registry and refuses one that does not say where every list comes from.
    public static func decode(_ data: Data) throws -> FilterListRegistry {
        let registry = try JSONDecoder().decode(FilterListRegistry.self, from: data)
        if registry.schema != supportedSchema { throw RegistryError.unsupportedSchema(registry.schema) }
        let problems = registry.problems
        if !problems.isEmpty { throw RegistryError.incomplete(problems) }
        return registry
    }

    /// What is wrong with the registry, in sentences. The licences screen must never show a list without its licence and its source.
    public var problems: [String] {
        var found: [String] = []
        if lists.isEmpty { found.append("no list") }
        var seen = Set<String>()
        for list in lists {
            if !seen.insert(list.id).inserted { found.append("\(list.id): twice") }
            for (name, text) in [("title", list.title), ("author", list.author), ("license", list.license)] {
                if text.en.trimmingCharacters(in: .whitespaces).isEmpty || text.fr.trimmingCharacters(in: .whitespaces).isEmpty { found.append("\(list.id): no \(name)") }
            }
            for (name, address) in [("licenseUrl", list.licenseUrl), ("homepage", list.homepage), ("sourceUrl", list.sourceUrl)] {
                if !address.hasPrefix("https://") || URL(string: address) == nil { found.append("\(list.id): \(name) is not an https address") }
            }
            if list.files.isEmpty { found.append("\(list.id): no file") }
            for file in list.files where file.rules < 1 || file.rules > Self.ruleLimit {
                found.append("\(list.id): \(file.name) has \(file.rules) rules")
            }
        }
        return found
    }
}
