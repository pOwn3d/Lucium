import CryptoKit
import Foundation
import Security

/// The self-signed certificate of a device (docs/synchronisation.md §6.3), written by hand: neither Node nor the APIs of Apple make an X.509 certificate,
/// and a dependency for 60 lines of DER would be a licence and an install script to examine for nothing. The confidence in a peer comes from its pinned
/// fingerprint, never from the certificate, so a certificate that is badly formed makes a pairing fail; it cannot make one weaker.
///
/// One profile, on both sides: X.509 version 3, a 16-byte positive serial, `ecdsa-with-SHA256` without parameters, the name `CN=lucium-sync` for issuer and
/// subject, valid from 1970 to 9999 (the dates mean nothing), a P-256 key, no extension. The bytes to sign of an example are fixed in
/// `sync-pairing-vectors.json` (`certificate`): the Mac builds the same bytes, and a change of profile on one side fails the other side's test.
public enum SyncCertificate {
    /// The header of a `SubjectPublicKeyInfo` for an uncompressed P-256 point (`id-ecPublicKey`, `prime256v1`, then a BIT STRING of 66 bytes).
    private static let spkiHeader = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
    /// `ecdsa-with-SHA256`, with no parameters.
    private static let algorithm = der(0x30, der(0x06, Data([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])))
    /// `CN=lucium-sync`, as a UTF8String. No name of a person or of a device.
    private static let name = der(0x30, der(0x31, der(0x30, der(0x06, Data([0x55, 0x04, 0x03])), der(0x0c, Data("lucium-sync".utf8)))))
    private static let validity = der(0x30, der(0x17, Data("700101000000Z".utf8)), der(0x18, Data("99991231235959Z".utf8)))

    private static func derLength(_ count: Int) -> Data {
        if count < 128 { return Data([UInt8(count)]) }
        var bytes: [UInt8] = []
        var rest = count
        while rest > 0 {
            bytes.insert(UInt8(rest & 0xff), at: 0)
            rest >>= 8
        }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }

    private static func der(_ tag: UInt8, _ parts: Data...) -> Data {
        let body = parts.reduce(Data(), +)
        return Data([tag]) + derLength(body.count) + body
    }

    /// The `SubjectPublicKeyInfo` of an uncompressed P-256 point (`04 || X || Y`, 65 bytes), or nil when it is not one.
    public static func subjectPublicKeyInfo(x963Point point: Data) -> Data? {
        guard point.count == 65, point.first == 0x04 else { return nil }
        return spkiHeader + point
    }

    /// The part of the certificate that is signed. The serial is 16 bytes whose first byte is between `0x01` and `0x7f`, so that it is a positive integer
    /// in its shortest DER form.
    public static func toBeSigned(subjectPublicKeyInfo spki: Data, serial: Data) -> Data? {
        guard serial.count == 16, let first = serial.first, (0x01...0x7f).contains(first), spki.count == 91 else { return nil }
        return der(0x30, Data([0xa0, 0x03, 0x02, 0x01, 0x02]), der(0x02, serial), algorithm, name, validity, name, spki)
    }

    /// The certificate: the signed part, the algorithm, and the signature (a DER `ECDSA-Sig-Value`, which is what Security.framework and Node both write) in a BIT STRING.
    public static func assemble(toBeSigned: Data, signature: Data) -> Data {
        der(0x30, toBeSigned, algorithm, der(0x03, Data([0x00]), signature))
    }

    /// The fingerprint a device is pinned by: the SHA-256 of the certificate in DER.
    public static func fingerprint(of certificate: Data) -> Data { Data(SHA256.hash(data: certificate)) }

    public enum MakeError: Error, Equatable { case noPublicKey, notP256, signature(String), badSerial }

    /// The certificate of a P-256 private key held by Security.framework (the key itself never leaves it: it only signs). The serial is given so that a test can
    /// fix it; the application draws 16 random bytes and clears the top bit of the first.
    public static func make(privateKey: SecKey, serial: Data) throws -> Data {
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else { throw MakeError.noPublicKey }
        var failure: Unmanaged<CFError>?
        guard let point = SecKeyCopyExternalRepresentation(publicKey, &failure) as Data? else { throw MakeError.signature(failure?.takeRetainedValue().localizedDescription ?? "no public key bytes") }
        guard let spki = subjectPublicKeyInfo(x963Point: point) else { throw MakeError.notP256 }
        guard let tbs = toBeSigned(subjectPublicKeyInfo: spki, serial: serial) else { throw MakeError.badSerial }
        guard let signature = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256, tbs as CFData, &failure) as Data? else {
            throw MakeError.signature(failure?.takeRetainedValue().localizedDescription ?? "no signature")
        }
        return assemble(toBeSigned: tbs, signature: signature)
    }

    /// A serial from 16 random bytes: the first byte is brought into `0x01…0x7f` (`& 0x7f`, and 1 if that leaves 0).
    public static func serial(fromRandom bytes: Data) -> Data? {
        guard bytes.count == 16 else { return nil }
        var serial = bytes
        serial[serial.startIndex] &= 0x7f
        if serial[serial.startIndex] == 0 { serial[serial.startIndex] = 1 }
        return serial
    }
}
