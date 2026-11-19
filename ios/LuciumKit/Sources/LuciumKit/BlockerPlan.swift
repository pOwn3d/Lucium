import Foundation

/// What the blocker puts on a web view, as the person's switches and the page say (docs/ios.md, section 6.6). WebKit judges every request itself, from
/// the rule lists attached to the view; the application cannot switch a rule off, so a switch is a list that is attached or taken away. Pure, so that
/// `swift test` proves it: the application attaches what this says.
public enum BlockerPlan {
    /// One list attached to a web view: where it comes from and what its rules do.
    public struct Part: Equatable, Hashable, Sendable {
        public enum Source: Equatable, Hashable, Sendable {
            /// A list of the catalogue of the Mac, by its category.
            case catalogue(FilterListEntry.Category)
            /// The short built-in list of a copy that carries no embedded list: it does not say which category a rule belongs to.
            case builtin
            /// The rules of the YouTube advertising paths (`GuardRules.networkRules`): part of the ads blocking, on YouTube pages only.
            case youtube
        }

        public var source: Source
        /// Network rules block requests; cosmetic rules hide elements (`FilterListFile.Kind`).
        public var kind: FilterListFile.Kind

        public init(source: Source, kind: FilterListFile.Kind) { self.source = source; self.kind = kind }
    }

    /// Whether a list is attached to the web view of this page. Nothing is attached on a site of the list of exceptions; elsewhere the ads switch
    /// attaches the lists of the ads and the YouTube rules, the banners switch the lists of the cookie banners, and the hiding switch decides whether
    /// the element-hiding files come too. The short built-in list stands for the two categories, so it follows either switch.
    public static func wants(_ part: Part, settings: PrivacySettings, page: String?) -> Bool {
        if BlockerHost.isExempt(page, in: settings.blockExceptions) { return false }
        if part.kind == .cosmetic, !settings.blockCosmetic { return false }
        switch part.source {
        case .catalogue(.ads), .youtube: return settings.blockAds
        case .catalogue(.cookies): return settings.blockCookieBanners
        case .builtin: return settings.blockAds || settings.blockCookieBanners
        }
    }

    /// The parts to attach, in the order they were compiled.
    public static func attached(_ parts: [Part], settings: PrivacySettings, page: String?) -> [Part] {
        parts.filter { wants($0, settings: settings, page: page) }
    }
}

enum BlockerHost {
    static func isExempt(_ page: String?, in hosts: [String]) -> Bool { BlockHost.isExempt(page, in: hosts) }
}
