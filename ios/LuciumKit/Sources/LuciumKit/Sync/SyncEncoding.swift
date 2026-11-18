import Foundation

/// The few encodings the synchronisation writes by hand, the same ones as the Mac's (docs/synchronisation.md §4.2, §4.3, §4.4): base64url without padding,
/// lower-case hexadecimal and the base32 of the code that is typed.
public enum SyncEncoding {
    private static let base64urlAlphabet = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Reads exactly `characters` characters of base64url into bytes. Only the canonical writing is read: no padding, no other character, and the unused
    /// bits of the last character are zero, so that two texts are never the same bytes (a QR that reads one way on the Mac and another on the phone would
    /// be two different secrets).
    public static func base64urlDecode(_ text: String, characters: Int) -> Data? {
        guard text.utf16.count == characters, text.allSatisfy({ base64urlAlphabet.contains($0) }) else { return nil }
        let standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padded = standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)
        guard let data = Data(base64Encoded: padded), base64url(data) == text else { return nil }
        return data
    }

    public static func hex(_ data: some Sequence<UInt8>) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func data(hex text: String) -> Data? {
        guard text.utf8.count % 2 == 0 else { return nil }
        var bytes = Data()
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16), text[index..<next].allSatisfy({ $0.isASCII }) else { return nil }
            bytes.append(byte)
            index = next
        }
        return bytes
    }

    private static let base32Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    /// The 26 characters of the typed code (RFC 4648 alphabet) are 130 bits: the first 128 are the secret, the last 2 must be zero.
    public static func base32DecodeSecret(_ text: String) -> Data? {
        let characters = Array(text)
        guard characters.count == 26 else { return nil }
        var bits: [Bool] = []
        for character in characters {
            guard let value = base32Alphabet.firstIndex(of: character) else { return nil }
            for shift in stride(from: 4, through: 0, by: -1) { bits.append((value >> shift) & 1 == 1) }
        }
        guard !bits[128...].contains(true) else { return nil }
        var bytes = Data()
        for index in 0..<16 {
            var byte: UInt8 = 0
            for bit in 0..<8 { byte = (byte << 1) | (bits[index * 8 + bit] ? 1 : 0) }
            bytes.append(byte)
        }
        return bytes
    }

    /// The code the Mac shows: the secret in base32, by groups of five. Used by the tests to play the Mac, and by nothing else on the phone.
    public static func base32EncodeSecret(_ secret: Data) -> String {
        var bits: [Bool] = secret.flatMap { byte in (0..<8).map { (byte >> (7 - $0)) & 1 == 1 } }
        bits.append(contentsOf: [false, false])
        var text = ""
        for index in 0..<26 {
            var value = 0
            for bit in 0..<5 { value = (value << 1) | (bits[index * 5 + bit] ? 1 : 0) }
            text.append(base32Alphabet[value])
        }
        return stride(from: 0, to: 26, by: 5).map { String(text.dropFirst($0).prefix(5)) }.joined(separator: "-")
    }
}
