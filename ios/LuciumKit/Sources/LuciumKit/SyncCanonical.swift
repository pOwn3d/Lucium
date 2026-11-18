import CryptoKit
import Foundation

/// The Swift twin of `src/shared/sync-canonical.ts`: the canonical form of a JSON value (docs/synchronisation.md §8.4, RFC 8785), the text whose SHA-256 the two
/// devices compare after a merge, and the exact comparison of strings the merge relies on. Checked by the same vectors as the Mac
/// (`canonical` in `ios/Contracts/sync-message-vectors.json`): change one side and the other fails.
///
/// Swift's `String` is not JavaScript's: `==` treats two canonically equivalent strings ("é" in one scalar and in two) as equal, a dictionary does the same
/// with its keys, and `<` is not the order of the UTF-16 code units. The specification fixes the JavaScript behaviour, so every comparison of the merge goes
/// through the functions below, and the door a snapshot comes in by refuses a key that is not in normalization form C (`SyncSnapshot.read`), so that two keys
/// of a dictionary can never be told apart by the Mac and not by the iPhone.
public enum SyncCanonical {
    /// The strings are the same, scalar for scalar (not "canonically equivalent": that is what `==` of `String` says).
    public static func identical(_ a: String, _ b: String) -> Bool {
        a.utf8.elementsEqual(b.utf8)
    }

    /// The order of the UTF-16 code units: the order of JavaScript's `<` and of the keys of RFC 8785. A character outside the Basic Multilingual Plane (a
    /// surrogate pair, D800–DFFF) comes before U+E000–U+FFFF, which is not the order of the UTF-8 bytes.
    public static func compare(_ a: String, _ b: String) -> Int {
        var left = a.utf16.makeIterator()
        var right = b.utf16.makeIterator()
        while true {
            switch (left.next(), right.next()) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case let (x?, y?): if x != y { return x < y ? -1 : 1 }
            }
        }
    }

    /// The RFC 8785 text of a value: no space, object keys sorted by UTF-16 code unit, strings written as `JSON.stringify` writes them, numbers as
    /// JavaScript writes them. A number that is not finite has no JSON text: `nil`.
    public static func text(_ value: JSONValue) -> String? {
        var out = ""
        return append(value, to: &out) ? out : nil
    }

    /// The SHA-256 of the canonical text, in lower-case hexadecimal: the `digest` of a snapshot.
    public static func digest(of value: JSONValue) -> String? {
        guard let text = text(value) else { return nil }
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func append(_ value: JSONValue, to out: inout String) -> Bool {
        switch value {
        case .null: out += "null"
        case .bool(let flag): out += flag ? "true" : "false"
        case .number(let number):
            guard number.isFinite else { return false }
            out += numberText(number)
        case .string(let string): appendString(string, to: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                if !append(item, to: &out) { return false }
            }
            out += "]"
        case .object(let members):
            out += "{"
            var first = true
            for key in members.keys.sorted(by: { compare($0, $1) < 0 }) {
                if !first { out += "," }
                first = false
                appendString(key, to: &out)
                out += ":"
                if !append(members[key] ?? .null, to: &out) { return false }
            }
            out += "}"
        }
        return true
    }

    /// `JSON.stringify` of a string: `"` `\` and the control characters are escaped (`\b \f \n \r \t`, the others as `\u00xx` in lower case); U+007F,
    /// U+2028 and U+2029 are written as they are. A Swift string holds no lone surrogate, which `JSON.stringify` would write as `\udxxx`.
    private static func appendString(_ string: String, to out: inout String) {
        out += "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        out += "\""
    }

    /// A finite number as ECMAScript's `Number::toString` writes it (and so `JSON.stringify`): the shortest digits that read back the same, no exponent
    /// between 1e-6 and 1e21 (the bounds the message layer keeps every number inside, §7.1), `-0` as `0`. Swift's `description` gives the same digits
    /// but another layout (`1e-06`, `100.0`), so the digits and the exponent are taken from it and laid out again.
    public static func numberText(_ value: Double) -> String {
        if value == 0 { return "0" }
        if value < 0 { return "-" + numberText(-value) }
        var description = "\(value)"
        var exponent = 0
        if let marker = description.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exponent = Int(description[description.index(after: marker)...]) ?? 0
            description = String(description[..<marker])
        }
        let parts = description.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0])
        var digits = whole + (parts.count > 1 ? String(parts[1]) : "")
        // value = 0.<digits> × 10^point
        var point = whole.count + exponent
        while digits.count > 1, digits.hasPrefix("0") {
            digits.removeFirst()
            point -= 1
        }
        while digits.count > 1, digits.hasSuffix("0") { digits.removeLast() }
        let count = digits.count
        if count <= point, point <= 21 { return digits + String(repeating: "0", count: point - count) }
        if 0 < point, point <= 21 {
            let split = digits.index(digits.startIndex, offsetBy: point)
            return String(digits[..<split]) + "." + String(digits[split...])
        }
        if -6 < point, point <= 0 { return "0." + String(repeating: "0", count: -point) + digits }
        let sign = point - 1 < 0 ? "-" : "+"
        let magnitude = abs(point - 1)
        if count == 1 { return "\(digits)e\(sign)\(magnitude)" }
        let split = digits.index(after: digits.startIndex)
        return String(digits[..<split]) + "." + String(digits[split...]) + "e\(sign)\(magnitude)"
    }

    /// Whether two values are the same for the merge: the same canonical text, so the order of the keys of an object does not matter and a list is
    /// compared in order. A value that is absent (`nil`) is equal to another absent value and to nothing else.
    public static func same(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (nil, _), (_, nil): return false
        case let (.string(x)?, .string(y)?): return identical(x, y)
        case let (.number(x)?, .number(y)?): return x == y
        case let (.bool(x)?, .bool(y)?): return x == y
        case (.null?, .null?): return true
        case let (x?, y?):
            guard let left = text(x), let right = text(y) else { return false }
            return identical(left, right)
        }
    }
}
