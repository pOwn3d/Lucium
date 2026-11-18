import CryptoKit
import Foundation

/// The rules of our own the page guard carries (`guard-rules.json`, written by `scripts/ios-guard.mjs` from the Mac's sources): the YouTube
/// player rules, and the style sheet of the consent walls. Nothing here comes from a list of someone else's.
public struct GuardRules: Sendable {
    public static let supportedSchema = 1
    /// The prefix of the name of the rules compiled for WebKit (`app.lucium.guard.<start of the SHA-256>`).
    public static let identifierPrefix = "app.lucium.guard."

    public struct YouTube: Sendable {
        /// The site the rules are for; its subdomains follow.
        public let domain: String
        public let scriptlets: [ScriptletCall]
        public let css: String
        /// The requests of the site that serve advertising, as the JSON array WebKit compiles.
        public let networkRules: String
    }

    public enum RulesError: Error, Equatable {
        case unsupportedSchema(Int)
    }

    public let youtube: YouTube
    /// Hides the known consent containers and gives the scrolling back (the Mac's `consentWallCss`).
    public let consentWallCSS: String

    public static func decode(_ data: Data) throws -> GuardRules {
        let file = try JSONDecoder().decode(File.self, from: data)
        if file.schema != supportedSchema { throw RulesError.unsupportedSchema(file.schema) }
        // The rules are handed to WebKit as text: written back compactly and in a fixed order, so that the name of the compiled list follows the content.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let rules = String(decoding: try encoder.encode(file.youtube.networkRules), as: UTF8.self)
        return GuardRules(
            youtube: YouTube(domain: file.youtube.domain, scriptlets: file.youtube.scriptlets.map(\.call), css: file.youtube.css, networkRules: rules),
            consentWallCSS: file.consentWalls.css)
    }

    /// The name the YouTube network rules are kept under in WebKit's store: it carries the start of their SHA-256, so that a new copy replaces the old.
    public var networkRulesIdentifier: String {
        Self.identifierPrefix + SHA256.hash(data: Data(youtube.networkRules.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    private struct File: Decodable {
        struct Pair: Decodable {
            let call: ScriptletCall
            init(from decoder: Decoder) throws {
                var container = try decoder.unkeyedContainer()
                call = ScriptletCall(id: try container.decode(String.self), args: try container.decode([String].self))
            }
        }
        struct YouTubeFile: Decodable {
            let domain: String
            let scriptlets: [Pair]
            let css: String
            let networkRules: [JSONValue]
        }
        struct Walls: Decodable { let css: String }
        let schema: Int
        let youtube: YouTubeFile
        let consentWalls: Walls
    }
}

/// What the person has switched on (the same switches as the Mac: ads and trackers, cookie banners, the extended rules). The settings screen
/// gives them; until then everything is on, as on the Mac.
public struct GuardSettings: Equatable, Sendable {
    public var blockAds: Bool
    public var blockCookieBanners: Bool
    /// The scriptlets the lists name (`block-scriptlets`: it needs one of the two above). The YouTube rules do not wait for it, as on the Mac.
    public var blockScriptlets: Bool
    /// Sites where nothing is done (the Mac's blocking exceptions): the site and its subdomains.
    public var exemptSites: [String]

    public init(blockAds: Bool = true, blockCookieBanners: Bool = true, blockScriptlets: Bool = true, exemptSites: [String] = []) {
        self.blockAds = blockAds
        self.blockCookieBanners = blockCookieBanners
        self.blockScriptlets = blockScriptlets
        self.exemptSites = exemptSites
    }
}

/// What a page is given when its document starts: the scriptlet calls to run and the style sheet to add. The page-side runtime
/// (`guard-runtime.js`) reads exactly this shape.
public struct PagePlan: Equatable, Encodable, Sendable {
    public var scriptlets: [ScriptletCall]
    public var css: String

    public static let empty = PagePlan(scriptlets: [], css: "")
    public var isEmpty: Bool { scriptlets.isEmpty && css.isEmpty }

    public init(scriptlets: [ScriptletCall], css: String) { self.scriptlets = scriptlets; self.css = css }
}

/// The Swift twin of what the Mac's blocking service decides for a page (`scriptletCalls` and `cosmeticCss` in `src/main/blocking/service.ts`),
/// for the rules that run in the page. The rules of the YouTube address are checked by the shared vectors (`ios/Contracts/guard-vectors.json`).
public enum PagePlanner {
    /// The host of a web address (http or https), in lower case, or nil for anything else: only a web page is given a plan.
    public static func webHost(of address: String?) -> String? {
        guard let address, let components = URLComponents(string: address), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return nil }
        return ScriptletTable.normalized(host)
    }

    /// A page of youtube.com or one of its subdomains (the Mac's `isYouTubePage`).
    public static func isYouTubePage(_ address: String?, domain: String = "youtube.com") -> Bool {
        guard let host = webHost(of: address) else { return false }
        return ScriptletTable.covers(domain, host)
    }

    public static func plan(for address: String?, settings: GuardSettings, table: ScriptletTable, rules: GuardRules?) -> PagePlan {
        guard let host = webHost(of: address) else { return .empty }
        if settings.exemptSites.contains(where: { ScriptletTable.covers(ScriptletTable.normalized($0), host) }) { return .empty }
        var calls: [ScriptletCall] = []
        var styles: [String] = []
        // The YouTube player rules are on with the ads switch, on a YouTube page: they do not wait for the extended rules.
        if settings.blockAds, let youtube = rules?.youtube, ScriptletTable.covers(youtube.domain, host) {
            calls += youtube.scriptlets
            styles.append(youtube.css)
        }
        // The consent containers stay hidden on top of the lists: many consent walls are answered with scriptlets the library does not have.
        if settings.blockCookieBanners, let walls = rules?.consentWallCSS { styles.append(walls) }
        if settings.blockScriptlets {
            var categories = Set<FilterListEntry.Category>()
            if settings.blockAds { categories.insert(.ads) }
            if settings.blockCookieBanners { categories.insert(.cookies) }
            calls += table.calls(forHost: host, categories: categories)
        }
        var seen = Set<ScriptletCall>()
        let unique = calls.filter { seen.insert($0).inserted }.prefix(ScriptletTable.callsMax)
        return PagePlan(scriptlets: Array(unique), css: styles.filter { !$0.isEmpty }.joined(separator: "\n\n"))
    }
}
