import Foundation

/// The search engines the Mac offers (`SEARCH_ENGINES` of `src/shared/model-defaults.ts`): the name the command bar shows for the engine in use.
public enum SearchEngine {
    public static let presets: [(name: String, url: String)] = [
        ("DuckDuckGo", "https://duckduckgo.com/?q=%s"),
        ("Google", "https://www.google.com/search?q=%s"),
        ("Bing", "https://www.bing.com/search?q=%s"),
        ("Brave Search", "https://search.brave.com/search?q=%s"),
        ("Qwant", "https://www.qwant.com/?q=%s"),
        ("Ecosia", "https://www.ecosia.org/search?q=%s"),
    ]

    /// The name of the engine a template stands for: a preset's name, else the host of the template ("example.org").
    public static func name(forTemplate template: String) -> String {
        if let preset = presets.first(where: { $0.url == template }) { return preset.name }
        let host = AddressResolver.host(of: template.replacingOccurrences(of: "%s", with: "q"))
        return host.isEmpty ? template : host
    }

    /// A template a search can use: a web address with `%s` where the words go.
    public static func isUsable(_ template: String) -> Bool {
        template.contains("%s") && Library.isLoadable(template.replacingOccurrences(of: "%s", with: "q"))
    }
}

extension BrowserState {
    /// The search template of a space's profile: its own, else the general one the Mac wrote, else DuckDuckGo (`profileSearch`). One that is not a
    /// web address with `%s` is ignored: a search must never load something else.
    public func searchTemplate(forSpace spaceId: String) -> String {
        guard case .object(let settings)? = rest["settings"] else { return AddressResolver.defaultSearchTemplate }
        if let profile = spaces.first(where: { $0.id == spaceId })?.profileId, case .object(let profiles)? = settings["profiles"],
           case .object(let own)? = profiles[profile], let template = own.string("searchUrlTemplate"), SearchEngine.isUsable(template) {
            return template
        }
        if let general = settings.string("searchUrlTemplate"), SearchEngine.isUsable(general) { return general }
        return AddressResolver.defaultSearchTemplate
    }

    /// The name the person gave a profile (`profileNames`), or nil when it has none: the default profile and an unnamed one are told by the interface.
    public func profileName(_ profileId: String) -> String? {
        guard case .object(let settings)? = rest["settings"], case .object(let names)? = settings["profileNames"],
              let name = names.string(profileId)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }
}
