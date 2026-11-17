import Foundation

/// Which of the records of a web data store belong to a site, for "Clear this site's data". WebKit names a record by a display name. It is
/// assumed to be the registrable domain of the site that stored the data ("example.com" for "mail.example.com") and the host itself for an address
/// or `localhost` (only the second was seen, on a simulator: docs/ios.md, section 5.2), so the rule below is written for both namings: the data of
/// a page on `shop.example.com` is the record "shop.example.com" or a parent of it ("example.com", every subdomain of it), and the data of a site
/// chosen as "example.com" includes a record named for one of its subdomains.
public enum SiteData {
    /// The host of an address the application loads, lower case, only for a page of the web (`http`, `https`); `nil` for anything else.
    public static func host(of address: String) -> String? {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host(percentEncoded: false) else { return nil }
        let normal = normalize(host)
        return normal.isEmpty ? nil : normal
    }

    /// Whether the record `name` holds data of the site `host`.
    public static func recordMatches(_ name: String, host: String) -> Bool {
        let record = normalize(name), site = normalize(host)
        guard !record.isEmpty, !site.isEmpty else { return false }
        return record == site || site.hasSuffix("." + record) || record.hasSuffix("." + site)
    }

    /// Lower case, without the trailing dot of a fully qualified name.
    private static func normalize(_ host: String) -> String {
        var text = host.lowercased()
        while text.hasSuffix(".") { text.removeLast() }
        return text
    }
}
