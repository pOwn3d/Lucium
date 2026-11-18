import Foundation

/// Which addresses are on a local network (docs/synchronisation.md §6.2): a network, not the Internet. The phone applies it to every host of a QR, of a
/// typed code and of the `hosts` a Mac sends; the Mac applies the same list to the address of a connection that comes in. Both read the same vectors
/// (`addressPolicy` of `sync-pairing-vectors.json`).
public enum SyncAddress {
    /// A local address: private IPv4 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`), the shared range of mesh VPNs (`100.64/10`), unique-local
    /// and link-local IPv6 (`fc00::/7`, `fe80::/10`), an IPv4 address written as IPv6 (`::ffff:a.b.c.d`, which follows the IPv4 rule), or a name that ends in
    /// `.local` with at least one label before it. Everything else is refused: a public address, the loopback (`127.0.0.0/8`, `::1`), `0.0.0.0`, a
    /// broadcast or multicast address, and any other name (a DNS name can designate any machine). An address with a zone (`fe80::1%en0`) is not an address
    /// here: the zone is the phone's own and never travels.
    public static func isLocal(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        // Visible ASCII only. `inet_pton` reads a C string and stops at a zero byte: `fd00::1\0.evil.com` is read as `fd00::1`, and two readers (this one, the name resolver)
        // would not read the same address in it.
        guard host.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7f }) else { return false }
        if let octets = ipv4(host) { return isLocalIPv4(octets) }
        if host.contains(":") {
            // Darwin's `inet_pton` reads a zone (`fe80::1%en0`); here a zone is refused, whatever the system says.
            guard !host.contains("%"), let bytes = ipv6(host) else { return false }
            let mapped = bytes[0..<10].allSatisfy { $0 == 0 } && bytes[10] == 0xff && bytes[11] == 0xff
            if mapped { return isLocalIPv4(Array(bytes[12..<16])) }
            return isLocalIPv6(bytes)
        }
        return isLocalName(host)
    }

    /// Four decimal numbers, each of one to three digits with no leading zero (`192.168.01.1` is not an address: two readers disagree on what it means).
    static func ipv4(_ host: String) -> [UInt8]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [UInt8] = []
        for part in parts {
            guard (1...3).contains(part.count), part.allSatisfy({ $0.isASCII && $0.isNumber }), part == "0" || !part.hasPrefix("0"), let value = UInt8(part) else { return nil }
            octets.append(value)
        }
        return octets
    }

    /// The system's own parser: strict (no zone, no brackets), it reads the compressed forms and an IPv4 tail.
    static func ipv6(_ host: String) -> [UInt8]? {
        var address = in6_addr()
        guard inet_pton(AF_INET6, host, &address) == 1 else { return nil }
        return withUnsafeBytes(of: &address) { Array($0) }
    }

    private static func isLocalIPv4(_ o: [UInt8]) -> Bool {
        switch (o[0], o[1]) {
        case (10, _): true
        case (172, 16...31): true
        case (192, 168): true
        case (169, 254): true
        case (100, 64...127): true
        default: false
        }
    }

    private static func isLocalIPv6(_ b: [UInt8]) -> Bool {
        (b[0] & 0xfe) == 0xfc || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80)
    }

    /// Lower-case labels of letters, digits and hyphens (1 to 63 characters, none starting or ending with a hyphen), then `local`. The Mac writes its name in
    /// lower case; a name in capitals is refused rather than compared without regard to case on one side only.
    private static func isLocalName(_ host: String) -> Bool {
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.last == "local" else { return false }
        return labels.dropLast().allSatisfy { isLabel($0) }
    }

    private static func isLabel(_ label: Substring) -> Bool {
        guard (1...63).contains(label.utf8.count), let first = label.first, let last = label.last else { return false }
        func alphanumeric(_ c: Character) -> Bool { c.isASCII && (c.isLowercase || c.isNumber) }
        return alphanumeric(first) && alphanumeric(last) && label.allSatisfy { alphanumeric($0) || $0 == "-" }
    }
}
