import Foundation

/// One call of a scriptlet of the library the page guard runs: a name and its arguments. A list only ever NAMES a scriptlet; the code is ours
/// (`scripts/ios-guard.mjs` writes it from the Mac's `guard-world.ts`) and the page-side library checks every call again before it runs one.
public struct ScriptletCall: Equatable, Hashable, Sendable, Codable {
    public let id: String
    public let args: [String]

    public init(id: String, args: [String]) { self.id = id; self.args = args }
}

/// The scriptlet calls the embedded lists name for sites (docs/ios.md, section 6.4): site → calls, with the list category each one comes from.
/// `scripts/ios-filter-lists.mjs` writes one file per list (`<id>.scriptlets.json`, the calls the Mac's library accepts, nothing else); this reads
/// them and answers, for a page's host, which calls apply. WebKit never sees this table: it is looked up when a page starts.
public struct ScriptletTable: Sendable {
    public static let supportedSchema = 1
    /// The calls one page may run: lists name a handful per site, and a hostile one must not fill a page with them (the Mac's `SCRIPTLET_CALLS_MAX`).
    public static let callsMax = 24

    struct Entry: Sendable {
        let call: ScriptletCall
        /// Sites this call does not apply to although it covers their parent (an exception for a subdomain).
        let unless: [String]
        let category: FilterListEntry.Category
    }

    public enum TableError: Error, Equatable {
        case unsupportedSchema(Int)
    }

    private var sites: [String: [Entry]] = [:]

    public init() {}

    /// Sites in the table.
    public var siteCount: Int { sites.count }
    /// Calls in the table (a call named for two sites counts twice).
    public var callCount: Int { sites.values.reduce(0) { $0 + $1.count } }

    /// Adds the file of one list. The calls keep the category of that list: the Mac asks the ads lists and the cookie lists separately, by switch.
    public mutating func merge(_ data: Data, category: FilterListEntry.Category) throws {
        let file = try JSONDecoder().decode(File.self, from: data)
        if file.schema != Self.supportedSchema { throw TableError.unsupportedSchema(file.schema) }
        for (site, entries) in file.domains {
            sites[site, default: []].append(contentsOf: entries.map { Entry(call: $0.call, unless: $0.unless, category: category) })
        }
    }

    /// The calls that apply to a page of `host`, for the categories that are on: those of the site and of each parent domain (a list's
    /// `example.com` covers `www.example.com`), the most specific first, each call once, at most `callsMax`.
    public func calls(forHost host: String, categories: Set<FilterListEntry.Category>) -> [ScriptletCall] {
        let name = Self.normalized(host)
        guard !name.isEmpty, !categories.isEmpty else { return [] }
        var calls: [ScriptletCall] = []
        var seen = Set<ScriptletCall>()
        var labels = name.split(separator: ".", omittingEmptySubsequences: false)
        while !labels.isEmpty {
            for entry in sites[labels.joined(separator: ".")] ?? [] where categories.contains(entry.category) && !entry.unless.contains(where: { Self.covers($0, name) }) {
                guard seen.insert(entry.call).inserted else { continue }
                calls.append(entry.call)
                if calls.count == Self.callsMax { return calls }
            }
            labels.removeFirst()
        }
        return calls
    }

    /// A host as the lists write it: lower case, without the dot that ends a fully qualified name.
    static func normalized(_ host: String) -> String {
        var name = host.lowercased()
        while name.hasSuffix(".") { name.removeLast() }
        return name
    }

    /// Whether `host` is `site` or one of its subdomains.
    static func covers(_ site: String, _ host: String) -> Bool {
        host == site || host.hasSuffix(".\(site)")
    }

    // MARK: The file

    private struct File: Decodable {
        let schema: Int
        let domains: [String: [Raw]]
    }

    /// `[id, args]` or `[id, args, unless]`: the compact shape the build step writes (a file of tens of thousands of calls stays small).
    private struct Raw: Decodable {
        let call: ScriptletCall
        let unless: [String]

        init(from decoder: Decoder) throws {
            var container = try decoder.unkeyedContainer()
            let id = try container.decode(String.self)
            let args = try container.decode([String].self)
            unless = container.isAtEnd ? [] : try container.decode([String].self)
            call = ScriptletCall(id: id, args: args)
        }
    }
}
