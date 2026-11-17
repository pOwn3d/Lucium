import Foundation

/// The Swift twin of `stripTrackingParams` in `src/shared/privacy.ts` (the Mac): the same fixed list, the same rules, checked by the same
/// vectors (`ios/Contracts/privacy-vectors.json`). Change one side, and the vectors fail on the other.
///
/// Only whole `name=value` pieces of the query leave the address; the other pieces keep their order and their exact spelling, and so does
/// everything outside the query (the host, the path, the fragment). Nothing outside the list is ever removed: a parameter that picks the page,
/// the language or the item shown is not on it.
public enum TrackingParams {
    /// Parameters that identify a click, a campaign or a recipient and mean nothing to the page itself. Matched on the whole name, any case.
    private static let names: Set<String> = [
        "fbclid", "fb_action_ids", "fb_action_types", "fb_ref", "fb_source",
        "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "_gl",
        "msclkid", "yclid", "_openstat", "twclid", "ttclid", "li_fat_id",
        "igshid", "igsh",
        "mc_eid", "mc_cid",
        "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking",
        "mkt_tok",
        "vero_id", "vero_conv", "oly_enc_id", "oly_anon_id", "wickedid", "rb_clickid", "_bta_c", "_bta_tid",
        "trk_contact", "trk_msg", "trk_module", "trk_sid",
        // Matomo's campaign parameters, one by one: a bare `pk_` prefix would also catch an unrelated `pk_live` key that a page needs.
        "pk_campaign", "pk_kwd", "pk_keyword", "pk_source", "pk_medium", "pk_content", "pk_cid", "pk_vid",
    ]

    /// Families of parameters: every name that starts with one of these (`utm_source`, `utm_medium`…). Only `utm_` is open-ended.
    private static let prefixes = ["utm_"]

    public static func isTracking(_ name: String) -> Bool {
        let lower = name.lowercased()
        return names.contains(lower) || prefixes.contains { lower.hasPrefix($0) }
    }

    /// The fixed list, for the documentation and the settings text: the exact names, then the families (`utm_*`).
    public static var list: [String] { names.sorted() + prefixes.map { "\($0)*" } }

    /// The address without its tracking parameters, or nil when there is nothing to remove (or it is not a web address).
    public static func strip(_ address: String) -> String? {
        guard let parts = WebAddress(address), let query = parts.query else { return nil }
        let pieces = query.split(separator: "&", omittingEmptySubsequences: false)
        let kept = pieces.filter { !isTracking(decodedName(of: $0)) }
        if kept.count == pieces.count { return nil }
        return parts.replacingQuery(kept.isEmpty ? nil : kept.joined(separator: "&"))
    }

    /// The name of a `name=value` piece, decoded like the Mac does (`+` is a space, `%XX` is a byte; a name that does not decode stays as it is).
    private static func decodedName(of piece: Substring) -> String {
        let raw = piece.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? raw
    }
}

/// An `http` or `https` address cut where the rules need it: what comes before the query, the query, the fragment. The text is never rebuilt
/// from a parsed form, so what the rules do not touch comes out as it went in.
struct WebAddress {
    let scheme: String
    let before: String
    let query: String?
    let fragment: String?

    /// Nil unless `address` is a web address the way the Mac's `URL.canParse` understands one: http or https, with a host.
    init?(_ address: String) {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(percentEncoded: false), !host.isEmpty else { return nil }
        self.scheme = scheme
        var rest = Substring(address)
        if let hash = rest.firstIndex(of: "#") {
            fragment = String(rest[rest.index(after: hash)...])
            rest = rest[..<hash]
        } else {
            fragment = nil
        }
        if let mark = rest.firstIndex(of: "?") {
            let text = String(rest[rest.index(after: mark)...])
            // An empty query ("page?") has nothing in it to remove, like `URL.search` on the Mac, which is "" for it.
            query = text.isEmpty ? nil : text
            before = String(rest[..<mark])
        } else {
            query = nil
            before = String(rest)
        }
    }

    func replacingQuery(_ query: String?) -> String {
        before + (query.map { "?" + $0 } ?? "") + (fragment.map { "#" + $0 } ?? "")
    }
}
