import CryptoKit
import Foundation
import Security
import Testing

/// The shared vectors of the synchronisation (`ios/Contracts/sync-*.json`, docs/synchronisation.md §19). The Mac's TypeScript plays them in
/// `src/shared/ios-sync-contract.test.ts` and `ios-sync-merge-contract.test.ts` against a reference written in the tests.
///
/// The pairing and the messages are not written in LuciumKit yet (card 445), so this suite does what needs none: it reads the same files,
/// checks their form, and recomputes with the system's own primitives what the specification fixes byte for byte: the pairing proofs (CryptoKit's
/// HMAC), the SHA-256 of the canonical texts, the order of the marks (Swift's string order), and the certificate profile (Security.framework reads the
/// sample certificate and finds the same fingerprint and the same key). The merge, the canonical form and the reading of a snapshot are played in
/// `SyncMergeTests.swift` (card 446).
private enum SyncVectors {
    static func load(_ name: String) throws -> [String: Any] {
        // …/ios/LuciumKit/Tests/LuciumKitTests/SyncVectorTests.swift → …/ios/Contracts/<name>
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/\(name)")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        guard let dictionary = object as? [String: Any] else { throw VectorError.notAnObject(name) }
        return dictionary
    }

    enum VectorError: Error { case notAnObject(String), missing(String) }

    static func array(_ root: [String: Any], _ key: String) throws -> [[String: Any]] {
        guard let items = root[key] as? [[String: Any]] else { throw VectorError.missing(key) }
        return items
    }

    static func data(hex: String) -> Data {
        var bytes = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0)
            index = next
        }
        return bytes
    }

    static func hex(_ bytes: some Sequence<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// §4.4: every field is written after its length on two bytes, big-endian.
    static func lengthPrefixed(_ field: Data) -> Data { Data([UInt8(field.count >> 8), UInt8(field.count & 255)]) + field }

    static func transcription(_ label: String, _ fields: [Data]) -> Data {
        ([Data(label.utf8)] + fields).reduce(Data()) { $0 + lengthPrefixed($1) }
    }

    static func tag(secret: Data, _ transcription: Data) -> String {
        base64url(Data(HMAC<SHA256>.authenticationCode(for: transcription, using: SymmetricKey(data: secret))))
    }

    struct Proof {
        var secret: Data, fpMac: Data, fpPhone: Data, nonceMac: Data, noncePhone: Data
        var idMac: String, idPhone: String

        init(_ vector: [String: Any]) {
            secret = SyncVectors.data(hex: vector["secret"] as? String ?? "")
            fpMac = SyncVectors.data(hex: vector["fpMac"] as? String ?? "")
            fpPhone = SyncVectors.data(hex: vector["fpPhone"] as? String ?? "")
            nonceMac = SyncVectors.data(hex: vector["nonceMac"] as? String ?? "")
            noncePhone = SyncVectors.data(hex: vector["noncePhone"] as? String ?? "")
            idMac = vector["idMac"] as? String ?? ""
            idPhone = vector["idPhone"] as? String ?? ""
        }

        var requestTag: String {
            SyncVectors.tag(secret: secret, SyncVectors.transcription("lucium-sync/1 pair-request", [fpMac, fpPhone, nonceMac, noncePhone, Data(idPhone.utf8)]))
        }

        var acceptTag: String {
            SyncVectors.tag(secret: secret, SyncVectors.transcription("lucium-sync/1 pair-accept", [fpMac, fpPhone, nonceMac, noncePhone, Data(idMac.utf8), Data(idPhone.utf8)]))
        }
    }
}

@Suite("Synchronisation vectors shared with the Mac")
struct SyncVectorTests {
    @Test func theThreeFilesAreNotEmpty() throws {
        let pairing = try SyncVectors.load("sync-pairing-vectors.json")
        let messages = try SyncVectors.load("sync-message-vectors.json")
        let merge = try SyncVectors.load("sync-merge-vectors.json")
        #expect(try SyncVectors.array(pairing, "proof").count >= 2)
        #expect((pairing["qr"] as? [String: Any]).map { ($0["valid"] as? [Any])?.count ?? 0 } ?? 0 >= 5)
        #expect(try SyncVectors.array(pairing, "secretLifecycle").count >= 12)
        #expect(try SyncVectors.array(pairing, "addressPolicy").count > 40)
        #expect(try SyncVectors.array(messages, "messages").count >= 60)
        #expect(try SyncVectors.array(messages, "stamps").count >= 10)
        #expect(try SyncVectors.array(messages, "canonical").count >= 10)
        #expect(try SyncVectors.array(merge, "cases").count >= 30)
    }

    @Test func theConstantsAreTheOnesOfTheSpecification() throws {
        let pairing = try SyncVectors.load("sync-pairing-vectors.json")
        let constants = try #require(pairing["constants"] as? [String: Int])
        #expect(constants == ["secretBytes": 16, "nonceBytes": 16, "fingerprintBytes": 32, "windowMs": 120000, "maxInvalidProofs": 5, "qrMaxChars": 300, "qrMaxHosts": 4])
        let limits = try #require(try SyncVectors.load("sync-message-vectors.json")["limits"] as? [String: Int])
        #expect(limits["maxFrameBytes"] == 1_048_576)
        #expect(limits["maxSnapshotBytes"] == 33_554_432)
        #expect(limits["maxJsonDepth"] == 32)
        #expect(limits["maxStringBytes"] == 65_536)
        #expect(limits["tombstoneDays"] == 30)
    }

    @Test func theProofsAreTheOnesCryptoKitComputes() throws {
        let pairing = try SyncVectors.load("sync-pairing-vectors.json")
        for vector in try SyncVectors.array(pairing, "proof") {
            let proof = SyncVectors.Proof(vector)
            #expect(proof.requestTag == vector["requestTag"] as? String, "request tag of \(vector["name"] ?? "?")")
            #expect(proof.acceptTag == vector["acceptTag"] as? String, "accept tag of \(vector["name"] ?? "?")")
            #expect(proof.requestTag != proof.acceptTag)
        }
    }

    @Test func changingOneInputChangesTheProofsAsTheVectorsSay() throws {
        let pairing = try SyncVectors.load("sync-pairing-vectors.json")
        let reference = SyncVectors.Proof(try #require(try SyncVectors.array(pairing, "proof").first))
        let mutations = try #require(pairing["mutations"] as? [String: Any])
        let cases = try #require(mutations["cases"] as? [[String: Any]])
        #expect(cases.count == 7)
        for mutation in cases {
            var proof = reference
            let field = try #require(mutation["field"] as? String)
            let bytes = (mutation["valueHex"] as? String).map { SyncVectors.data(hex: $0) }
            let text = mutation["value"] as? String
            switch field {
            case "secret": proof.secret = try #require(bytes)
            case "fpMac": proof.fpMac = try #require(bytes)
            case "fpPhone": proof.fpPhone = try #require(bytes)
            case "nonceMac": proof.nonceMac = try #require(bytes)
            case "noncePhone": proof.noncePhone = try #require(bytes)
            case "idMac": proof.idMac = try #require(text)
            case "idPhone": proof.idPhone = try #require(text)
            default: Issue.record("unknown mutated field \(field)")
            }
            #expect(proof.requestTag == mutation["requestTag"] as? String, "request tag when \(field) changes")
            #expect(proof.acceptTag == mutation["acceptTag"] as? String, "accept tag when \(field) changes")
            #expect((proof.requestTag != reference.requestTag) == (mutation["changesRequestTag"] as? Bool), "\(field) in the request")
            #expect((proof.acceptTag != reference.acceptTag) == (mutation["changesAcceptTag"] as? Bool), "\(field) in the accept")
        }
    }

    @Test func theQRAndTheTypedCodeVectorsAreWellFormed() throws {
        let pairing = try SyncVectors.load("sync-pairing-vectors.json")
        let qr = try #require(pairing["qr"] as? [String: Any])
        let valid = try #require(qr["valid"] as? [[String: Any]])
        let invalid = try #require(qr["invalid"] as? [[String: Any]])
        #expect(invalid.count >= 20)
        let proof = SyncVectors.Proof(try #require(try SyncVectors.array(pairing, "proof").first))
        for vector in valid {
            let text = try #require(vector["text"] as? String)
            let expected = try #require(vector["expect"] as? [String: Any])
            #expect(text.count <= 300)
            // The text carries the fingerprint and the secret of the reference exchange, in base64url, as the Mac's reader finds them.
            let parts = text.dropFirst("lucium-sync:1/".count).split(separator: "/", omittingEmptySubsequences: false)
            #expect(text.hasPrefix("lucium-sync:1/") && parts.count == 4)
            #expect(String(parts[0]) == SyncVectors.base64url(proof.fpMac))
            #expect(String(parts[1]) == SyncVectors.base64url(proof.secret))
            #expect(expected["fingerprintHex"] as? String == SyncVectors.hex(proof.fpMac))
            #expect(expected["secretHex"] as? String == SyncVectors.hex(proof.secret))
            #expect(expected["port"] as? Int == Int(parts[2]))
            #expect((expected["hosts"] as? [String])?.joined(separator: ",") == String(parts[3]))
        }
        let manual = try #require(pairing["manualCode"] as? [String: Any])
        for vector in try #require(manual["valid"] as? [[String: Any]]) {
            let expected = try #require(vector["expect"] as? [String: Any])
            #expect(expected["secretHex"] as? String == SyncVectors.hex(proof.secret))
        }
    }

    @Test func theMarksAreOrderedAsSwiftOrdersStrings() throws {
        // §9.2: marks are compared as text, byte by byte. Swift's `<` on ASCII strings is that order; a different one would settle conflicts differently.
        let messages = try SyncVectors.load("sync-message-vectors.json")
        for vector in try SyncVectors.array(messages, "stamps") {
            let a = try #require(vector["a"] as? String)
            let b = try #require(vector["b"] as? String)
            let expected = try #require(vector["expect"] as? Int)
            let order = a < b ? -1 : (a > b ? 1 : 0)
            #expect(order == expected, "\(a) ? \(b)")
        }
    }

    @Test func theCanonicalTextsHaveTheSHA256TheVectorsGive() throws {
        // The canonical *form* is written by the card 446; the hash of a given text is the system's.
        let messages = try SyncVectors.load("sync-message-vectors.json")
        for vector in try SyncVectors.array(messages, "canonical") {
            let text = try #require(vector["canonical"] as? String)
            #expect(SyncVectors.hex(SHA256.hash(data: Data(text.utf8))) == vector["sha256Hex"] as? String, "\(vector["name"] ?? "?")")
        }
    }

    @Test func theSampleCertificateIsReadByTheSystem() throws {
        let pairing = try SyncVectors.load("sync-pairing-vectors.json")
        let sample = try #require(pairing["certificate"] as? [String: String])
        let der = SyncVectors.data(hex: try #require(sample["certificateDerHex"]))
        let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData), "Security.framework refuses the certificate profile of §6.3")
        // The same bytes and the same fingerprint (the SHA-256 of the DER) as the Mac computes.
        #expect(SecCertificateCopyData(certificate) as Data == der)
        #expect(SyncVectors.hex(SHA256.hash(data: der)) == sample["fingerprintHex"])
        #expect(SecCertificateCopySubjectSummary(certificate) as String? == "lucium-sync")
        // The key is a P-256 key and the certificate holds the one the vector names (the point is the end of the SubjectPublicKeyInfo).
        let key = try #require(SecCertificateCopyKey(certificate))
        let attributes = try #require(SecKeyCopyAttributes(key) as? [String: Any])
        #expect(attributes[kSecAttrKeySizeInBits as String] as? Int == 256)
        let point = try #require(SecKeyCopyExternalRepresentation(key, nil) as Data?)
        #expect(point.count == 65 && point.first == 0x04)
        #expect(try #require(sample["spkiHex"]).hasSuffix(SyncVectors.hex(point)))
        // The bytes to sign are inside the certificate.
        #expect(der.range(of: SyncVectors.data(hex: try #require(sample["tbsHex"]))) != nil)
    }

    @Test func everyMergeMarkIsWellFormed() throws {
        let merge = try SyncVectors.load("sync-merge-vectors.json")
        let cases = try SyncVectors.array(merge, "cases")
        var marks: [String] = []
        func collect(_ value: Any) {
            if let object = value as? [String: Any] {
                if let stamps = object["stamps"] as? [String: String] { marks += stamps.values }
                if let tombstones = object["tombstones"] as? [String: [String: String]] { for byId in tombstones.values { marks += byId.values } }
                if let orderStamps = object["orderStamps"] as? [String: String] { marks += orderStamps.values }
                for (key, child) in object where key != "stamps" && key != "tombstones" && key != "orderStamps" { collect(child) }
            } else if let list = value as? [Any] {
                for child in list { collect(child) }
            }
        }
        for item in cases { collect(item) }
        #expect(marks.count > 100)
        let form = /^(0|[0-9]{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,64})$/
        for mark in marks { #expect(mark.wholeMatch(of: form) != nil, "\(mark)") }
        let names = cases.compactMap { $0["name"] as? String }
        #expect(Set(names).count == names.count && names.count == cases.count)
    }
}
