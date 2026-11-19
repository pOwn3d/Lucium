import Foundation

/// The « Standard » mode of the blocker, written for WebKit's rules. On the Mac the filter engine leaves alone a request that goes to the site of the page
/// that makes it, unless the rule that matched is written for first parties (`$first-party`, `$~third-party`): a site loading its own scripts or its own
/// video is not filtered, only third parties are (`namesFirstParty`, `isOwnSite`). WebKit has no such judgement to switch on, so the lists are
/// compiled twice over: as the converter wrote them (« Strict »: every rule applies to every request) and with this change (« Standard »).
public enum StandardModeRules {
    public enum Failure: Error, Equatable {
        /// The text is not the JSON array of rules WebKit reads.
        case notRules
    }

    /// The rules of a network list for « Standard »: a rule that blocks and says nothing about the party is limited to third parties, which is what the
    /// Mac does with it. A rule written for a party (`load-type`) keeps it, and so does every other kind of rule (an exception that cancels earlier
    /// rules, the hiding of an element): only what blocks changes. The order of the rules is the order of the input, which WebKit reads as an order.
    public static func transform(_ rules: String) throws -> String {
        guard let data = rules.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data), var list = parsed as? [[String: Any]] else { throw Failure.notRules }
        for index in list.indices {
            guard let action = list[index]["action"] as? [String: Any], let type = action["type"] as? String, type == "block" || type == "block-cookies",
                  var trigger = list[index]["trigger"] as? [String: Any], trigger["load-type"] == nil else { continue }
            trigger["load-type"] = ["third-party"]
            list[index]["trigger"] = trigger
        }
        let out = try JSONSerialization.data(withJSONObject: list, options: [.withoutEscapingSlashes])
        return String(decoding: out, as: UTF8.self)
    }
}
