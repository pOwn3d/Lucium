import CryptoKit
import Foundation
import Security
import Testing
@testable import LuciumKit

/// The pairing vectors (`sync-pairing-vectors.json`, docs/synchronisation.md §4, §6.2, §6.3) played against the code the phone really runs. The same file is
/// played by the Mac's TypeScript; the two sides can only drift apart by failing one of the two suites.
@Suite("Synchronisation pairing: the vectors against the real code")
struct SyncPairingContractTests {
    private let pairing: [String: Any]

    init() throws { pairing = try SyncContract.load("sync-pairing-vectors.json") }

    // MARK: Addresses

    @Test func theAddressFilterGivesTheAnswerOfEveryVector() throws {
        let vectors = try SyncContract.array(pairing, "addressPolicy")
        #expect(vectors.count > 40)
        for vector in vectors {
            let host = vector["host"] as? String ?? ""
            #expect(SyncAddress.isLocal(host) == (vector["allowed"] as? Bool), "isLocal(\(host.debugDescription))")
        }
    }

    @Test func theFilterHasBothAnswersForEveryFamilySoAFilterThatAlwaysSaysYesFails() throws {
        let vectors = try SyncContract.array(pairing, "addressPolicy")
        let hosts = vectors.compactMap { $0["host"] as? String }
        for family in [{ (h: String) in SyncAddress.ipv4(h) != nil }, { (h: String) in h.contains(":") }, { (h: String) in h.hasSuffix(".local") }] {
            let group = vectors.filter { family($0["host"] as? String ?? "") }
            #expect(group.contains { $0["allowed"] as? Bool == true })
            #expect(group.contains { $0["allowed"] as? Bool == false })
        }
        #expect(!hosts.isEmpty)
    }

    @Test func anAddressWithAZoneIsNotAnAddressHere() {
        #expect(!SyncAddress.isLocal("fe80::1%en0"))
        // A zero byte ends a C string: `inet_pton` read `fd00::1` in each of these.
        for host in ["fd00::1\u{0}.evil.com", "fd00::1\u{0}", "\u{0}fd00::1", "fd00::1 ", "fd00::1\n", "mac.local\u{0}.evil.com", "192.168.1.1\u{0}"] {
            #expect(!SyncAddress.isLocal(host), "\(host.debugDescription)")
        }
        #expect(!SyncAddress.isLocal("[fe80::1]"))
    }

    @Test func aNameInCapitalsIsNotALocalNameBecauseTheMacWritesItInLowerCase() {
        #expect(SyncAddress.isLocal("mac-de-test.local"))
        #expect(!SyncAddress.isLocal("Mac-de-Test.local"))
        #expect(!SyncAddress.isLocal("MAC.LOCAL"))
    }

    @Test func aQRWhoseLastCharacterHasBitsLeftOverIsAnotherWritingOfTheSameBytesAndIsRefused() throws {
        let qr = try #require(pairing["qr"] as? [String: Any])
        let first = try #require(try SyncContract.array(qr, "valid").first)
        let text = first["text"] as? String ?? ""
        // The secret ends in "w" (the 4 bits it does not need are zero); "x" would be the same 16 bytes written differently.
        #expect(text.contains("/ah8MK51OejXIGy8OXXqcQw/"))
        let other = text.replacingOccurrences(of: "XXqcQw/", with: "XXqcQx/")
        if case .success = SyncPairingCode.parse(qr: other) { Issue.record("another writing of the same secret was read") }
        #expect({ if case .success = SyncPairingCode.parse(qr: text) { true } else { false } }())
    }

    @Test func aMappedAddressFollowsTheIPv4RuleWhicheverWayItIsWritten() {
        #expect(SyncAddress.isLocal("::ffff:192.168.1.5"))
        #expect(SyncAddress.isLocal("::ffff:c0a8:105"))
        #expect(!SyncAddress.isLocal("::ffff:8.8.8.8"))
        #expect(!SyncAddress.isLocal("::ffff:808:808"))
    }

    // MARK: QR and typed code

    @Test func everyValidQRIsReadAsTheVectorSays() throws {
        let qr = try #require(pairing["qr"] as? [String: Any])
        let valid = try SyncContract.array(qr, "valid")
        #expect(valid.count >= 5)
        for vector in valid {
            let text = vector["text"] as? String ?? ""
            let expected = try #require(vector["expect"] as? [String: Any])
            guard case .success(let code) = SyncPairingCode.parse(qr: text) else {
                Issue.record("not read: \(vector["name"] ?? "?")")
                continue
            }
            #expect(code.fingerprint.map { SyncEncoding.hex($0) } == expected["fingerprintHex"] as? String, "\(vector["name"] ?? "?")")
            #expect(SyncEncoding.hex(code.secret) == expected["secretHex"] as? String)
            #expect(Int(code.port) == expected["port"] as? Int)
            #expect(code.hosts == expected["hosts"] as? [String])
            #expect(text.utf16.count <= SyncPairingCode.maxCharacters)
        }
    }

    @Test func everyRefusedQRIsRefusedWithTheCodeOfTheVector() throws {
        let qr = try #require(pairing["qr"] as? [String: Any])
        let invalid = try SyncContract.array(qr, "invalid")
        #expect(invalid.count >= 20)
        for vector in invalid {
            let text = vector["text"] as? String ?? ""
            let expected = (vector["expect"] as? [String: Any])?["code"] as? String
            switch SyncPairingCode.parse(qr: text) {
            case .success: Issue.record("read, but it must be refused: \(vector["name"] ?? "?")")
            case .failure(let failure): #expect(failure.code.rawValue == expected, "\(vector["name"] ?? "?")")
            }
        }
    }

    // MARK: The commitment and the code to compare (§4.6, §4.7)

    @Test func theCommitmentIsTheOneTheVectorsGiveForTheFingerprintAndTheNonce() throws {
        let vectors = try SyncContract.array(pairing, "commitments")
        #expect(vectors.count >= 4)
        for vector in vectors {
            let phone = SyncContract.hex(vector["fpPhone"] as? String ?? "")
            let nonce = SyncContract.hex(vector["nonceCodePhone"] as? String ?? "")
            let commit = SyncPairingCommit.commitment(fingerprintPhone: phone, nonce: nonce)
            #expect(commit.map { SyncEncoding.base64url($0) } == vector["commit"] as? String, "\(vector["name"] ?? "?")")
        }
        let constants = try #require(pairing["constants"] as? [String: Any])
        #expect(constants["commitBytes"] as? Int == SyncPairingCommit.commitBytes)
        #expect(constants["codeNonceBytes"] as? Int == SyncPairingCommit.codeNonceBytes)
    }

    @Test func aCommitmentIsMadeOnlyOfAFingerprintOf32BytesAndANonceOf16() {
        let phone = Data(repeating: 0x22, count: 32), nonce = Data(repeating: 0x44, count: 16)
        #expect(SyncPairingCommit.commitment(fingerprintPhone: phone, nonce: nonce)?.count == 32)
        #expect(SyncPairingCommit.commitment(fingerprintPhone: Data(count: 31), nonce: nonce) == nil)
        #expect(SyncPairingCommit.commitment(fingerprintPhone: phone, nonce: Data(count: 17)) == nil)
        var other = nonce
        other[0] ^= 1
        #expect(SyncPairingCommit.commitment(fingerprintPhone: phone, nonce: other) != SyncPairingCommit.commitment(fingerprintPhone: phone, nonce: nonce))
    }

    @Test func theCodeToCompareIsTheOneTheVectorsGiveForTheFingerprintsAndTheNonces() throws {
        let vectors = try SyncContract.array(pairing, "comparisonCode")
        #expect(vectors.count >= 8)
        for vector in vectors {
            let mac = SyncContract.hex(vector["fpMac"] as? String ?? "")
            let phone = SyncContract.hex(vector["fpPhone"] as? String ?? "")
            let macNonce = SyncContract.hex(vector["nonceCodeMac"] as? String ?? "")
            let phoneNonce = SyncContract.hex(vector["nonceCodePhone"] as? String ?? "")
            #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: macNonce, noncePhone: phoneNonce) == vector["code"] as? String, "\(vector["name"] ?? "?")")
        }
        let constants = try #require(pairing["constants"] as? [String: Any])
        #expect(constants["comparisonCodeChars"] as? Int == SyncPairingCompare.codeCharacters)
    }

    @Test func theCodeToCompareDependsOnBothFingerprintsAndBothNoncesAndOnWhichIsWhichAndRefusesAnInputOfAnotherSize() {
        let mac = Data(repeating: 0x11, count: 32), phone = Data(repeating: 0x22, count: 32)
        let macNonce = Data(repeating: 0x33, count: 16), phoneNonce = Data(repeating: 0x44, count: 16)
        let code = SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: macNonce, noncePhone: phoneNonce)
        #expect(code?.count == 6)
        #expect(SyncPairingCompare.code(fingerprintMac: phone, fingerprintPhone: mac, nonceMac: macNonce, noncePhone: phoneNonce) != code)
        #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: phoneNonce, noncePhone: macNonce) != code)
        var otherMac = mac
        otherMac[31] ^= 1
        #expect(SyncPairingCompare.code(fingerprintMac: otherMac, fingerprintPhone: phone, nonceMac: macNonce, noncePhone: phoneNonce) != code)
        var otherMacNonce = macNonce
        otherMacNonce[15] ^= 1
        #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: otherMacNonce, noncePhone: phoneNonce) != code, "the Mac's nonce is in the code (review n° 36)")
        var otherPhoneNonce = phoneNonce
        otherPhoneNonce[0] ^= 1
        #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: macNonce, noncePhone: otherPhoneNonce) != code, "the phone's nonce is in the code (review n° 36)")
        #expect(SyncPairingCompare.code(fingerprintMac: Data(count: 31), fingerprintPhone: phone, nonceMac: macNonce, noncePhone: phoneNonce) == nil)
        #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: Data(count: 33), nonceMac: macNonce, noncePhone: phoneNonce) == nil)
        #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: Data(count: 15), noncePhone: phoneNonce) == nil)
        #expect(SyncPairingCompare.code(fingerprintMac: mac, fingerprintPhone: phone, nonceMac: macNonce, noncePhone: Data(count: 17)) == nil)
    }

    @Test func everyValidTypedCodeGivesTheSecretOfTheVector() throws {
        let manual = try #require(pairing["manualCode"] as? [String: Any])
        for vector in try SyncContract.array(manual, "valid") {
            let secret = SyncPairingCode.parseSecret(typedCode: vector["input"] as? String ?? "")
            #expect(secret.map { SyncEncoding.hex($0) } == (vector["expect"] as? [String: Any])?["secretHex"] as? String, "\(vector["name"] ?? "?")")
        }
    }

    @Test func everyRefusedTypedCodeIsRefused() throws {
        let manual = try #require(pairing["manualCode"] as? [String: Any])
        let invalid = try SyncContract.array(manual, "invalid")
        #expect(invalid.count >= 6)
        for vector in invalid {
            #expect(SyncPairingCode.parseSecret(typedCode: vector["input"] as? String ?? "") == nil, "\(vector["name"] ?? "?")")
        }
    }

    @Test func theQRAndTheTypedCodeCarryTheSameSecret() throws {
        let qr = try #require(pairing["qr"] as? [String: Any])
        let first = try #require(try SyncContract.array(qr, "valid").first)
        guard case .success(let code) = SyncPairingCode.parse(qr: first["text"] as? String ?? "") else {
            Issue.record("not read")
            return
        }
        #expect(SyncEncoding.base32EncodeSecret(code.secret) == "NIPQY-K45JZ-5DLSA-3F4HF-26U4I-M")
        #expect(SyncPairingCode.parseSecret(typedCode: SyncEncoding.base32EncodeSecret(code.secret)) == code.secret)
    }

    @Test func aTypedCodeNeedsALocalHostAndAPort() {
        let code = "NIPQY-K45JZ-5DLSA-3F4HF-26U4I-M"
        if case .success(let read) = SyncPairingCode.parse(typedCode: code, host: " Mac-de-Test.local ", port: 49213) {
            #expect(read.hosts == ["mac-de-test.local"])
            #expect(read.fingerprint == nil, "a typed code does not know the fingerprint")
        } else { Issue.record("a good typed code and a local host were refused") }
        for (host, port) in [("example.com", 49213), ("8.8.8.8", 49213), ("192.168.1.5", 0), ("192.168.1.5", 65536)] {
            #expect({ if case .failure = SyncPairingCode.parse(typedCode: code, host: host, port: port) { true } else { false } }(), "\(host):\(port)")
        }
    }

    @Test func theAddressFieldTakesAHostAndAPortInOnePiece() throws {
        let one = try #require(SyncPairingCode.parse(address: "mac-de-test.local:49213"))
        #expect(one.host == "mac-de-test.local" && one.port == 49213)
        let v6 = try #require(SyncPairingCode.parse(address: "[fd12:3456:789a::1]:49213"))
        #expect(v6.host == "fd12:3456:789a::1" && v6.port == 49213)
        #expect(SyncPairingCode.parse(address: "fd12::1:49213") == nil, "an IPv6 address needs its brackets")
        #expect(SyncPairingCode.parse(address: "mac.local") == nil)
        #expect(SyncPairingCode.parse(address: "mac.local:port") == nil)
    }

    // MARK: Proofs

    private func inputs(_ vector: [String: Any]) -> SyncProofInputs {
        SyncProofInputs(secret: SyncContract.hex(vector["secret"] as? String ?? ""), fingerprintMac: SyncContract.hex(vector["fpMac"] as? String ?? ""),
                        fingerprintPhone: SyncContract.hex(vector["fpPhone"] as? String ?? ""), nonceMac: SyncContract.hex(vector["nonceMac"] as? String ?? ""),
                        noncePhone: SyncContract.hex(vector["noncePhone"] as? String ?? ""), idMac: vector["idMac"] as? String ?? "", idPhone: vector["idPhone"] as? String ?? "")
    }

    @Test func theProofsAreTheOnesOfTheVectors() throws {
        for vector in try SyncContract.array(pairing, "proof") {
            let i = inputs(vector)
            #expect(SyncProof.requestTag(i).map(SyncEncoding.base64url) == vector["requestTag"] as? String, "request of \(vector["name"] ?? "?")")
            #expect(SyncProof.acceptTag(i).map(SyncEncoding.base64url) == vector["acceptTag"] as? String, "accept of \(vector["name"] ?? "?")")
            #expect(SyncProof.requestTag(i) != SyncProof.acceptTag(i), "a request cannot stand for an accept")
        }
    }

    @Test func changingOneInputChangesTheProofsItTakesPartIn() throws {
        let mutations = try #require(pairing["mutations"] as? [String: Any])
        let reference = try #require(try SyncContract.array(pairing, "proof").first { $0["name"] as? String == mutations["of"] as? String })
        for mutation in try SyncContract.array(mutations, "cases") {
            let field = mutation["field"] as? String ?? ""
            var changed = reference
            changed[field] = mutation["value"] ?? mutation["valueHex"]
            let i = inputs(changed)
            #expect(SyncProof.requestTag(i).map(SyncEncoding.base64url) == mutation["requestTag"] as? String, "\(field)")
            #expect(SyncProof.acceptTag(i).map(SyncEncoding.base64url) == mutation["acceptTag"] as? String, "\(field)")
            #expect((mutation["requestTag"] as? String != reference["requestTag"] as? String) == (mutation["changesRequestTag"] as? Bool), "\(field)")
        }
    }

    @Test func theMacsProofIsCheckedAndAWrongOneIsNot() throws {
        let vector = try #require(try SyncContract.array(pairing, "proof").first)
        let i = inputs(vector)
        let good = try #require(SyncProof.acceptTag(i))
        #expect(SyncProof.isValidAccept(good, for: i))
        var flipped = good
        flipped[flipped.startIndex] ^= 1
        #expect(!SyncProof.isValidAccept(flipped, for: i), "one bit of difference")
        #expect(!SyncProof.isValidAccept(good.dropLast(), for: i), "a tag cut short")
        #expect(!SyncProof.isValidAccept(try #require(SyncProof.requestTag(i)), for: i), "the request's tag is not the accept's")
        var other = i
        other.fingerprintMac[other.fingerprintMac.startIndex] ^= 1
        #expect(!SyncProof.isValidAccept(good, for: other), "the proof is bound to the fingerprint of the Mac the phone is talking to")
    }

    // MARK: Certificate

    private func certificateVector() throws -> [String: Any] { try #require(pairing["certificate"] as? [String: Any]) }

    @Test func theBytesToSignAreTheOnesOfTheVector() throws {
        let c = try certificateVector()
        let spki = SyncContract.hex(c["spkiHex"] as? String ?? "")
        let tbs = SyncCertificate.toBeSigned(subjectPublicKeyInfo: spki, serial: SyncContract.hex(c["serialHex"] as? String ?? ""))
        #expect(tbs.map { SyncEncoding.hex($0) } == c["tbsHex"] as? String)
    }

    @Test func aSerialThatIsNotPositiveOrNotSixteenBytesIsRefused() throws {
        let spki = SyncContract.hex(try certificateVector()["spkiHex"] as? String ?? "")
        #expect(SyncCertificate.toBeSigned(subjectPublicKeyInfo: spki, serial: Data(repeating: 0x80, count: 16)) == nil)
        #expect(SyncCertificate.toBeSigned(subjectPublicKeyInfo: spki, serial: Data(repeating: 0x00, count: 16)) == nil)
        #expect(SyncCertificate.toBeSigned(subjectPublicKeyInfo: spki, serial: Data(repeating: 0x01, count: 15)) == nil)
        #expect(SyncCertificate.serial(fromRandom: Data(repeating: 0xff, count: 16))?.first == 0x7f)
        #expect(SyncCertificate.serial(fromRandom: Data(repeating: 0x00, count: 16))?.first == 0x01)
    }

    @Test func theFingerprintIsTheSha256OfTheDerAndSecurityFrameworkReadsTheSample() throws {
        let c = try certificateVector()
        let der = SyncContract.hex(c["certificateDerHex"] as? String ?? "")
        #expect(SyncEncoding.hex(SyncCertificate.fingerprint(of: der)) == c["fingerprintHex"] as? String)
        let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData), "Security.framework does not read the sample certificate")
        #expect(SecCertificateCopyData(certificate) as Data == der)
        let key = try #require(SecCertificateCopyKey(certificate))
        let attributes = try #require(SecKeyCopyAttributes(key) as? [String: Any])
        #expect(attributes[kSecAttrKeySizeInBits as String] as? Int == 256)
    }

    @Test func aCertificateMadeHereIsReadBySecurityAndSignedByItsKey() throws {
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256, kSecAttrIsPermanent as String: false]
        var failure: Unmanaged<CFError>?
        let privateKey = try #require(SecKeyCreateRandomKey(attributes as CFDictionary, &failure), "no key: \(String(describing: failure))")
        let serial = try #require(SyncCertificate.serial(fromRandom: Data((0..<16).map { UInt8(truncatingIfNeeded: $0 &* 17 &+ 3) })))
        let der = try SyncCertificate.make(privateKey: privateKey, serial: serial)
        let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData), "Security.framework does not read a certificate made here")
        #expect(SecCertificateCopySubjectSummary(certificate) as String? == "lucium-sync")
        // The certificate is signed by the key it carries: the signature is checked over the bytes the profile fixes.
        let publicKey = try #require(SecCertificateCopyKey(certificate))
        let point = try #require(SecKeyCopyExternalRepresentation(publicKey, &failure) as Data?)
        let spki = try #require(SyncCertificate.subjectPublicKeyInfo(x963Point: point))
        let tbs = try #require(SyncCertificate.toBeSigned(subjectPublicKeyInfo: spki, serial: serial))
        #expect(der.starts(with: Data([0x30, 0x82])) || der.starts(with: Data([0x30, 0x81])))
        #expect(der.range(of: tbs) != nil, "the signed part is inside the certificate")
        // The last bytes of the certificate are the DER signature in its BIT STRING (`03 len 00 <signature>`).
        let signatureStart = tbs.count + 4 + 12  // header of the sequence (4), the signed part, then the algorithm (12 bytes)
        let signatureDER = try #require(der.count > signatureStart + 3 ? Data(der[(signatureStart + 3)...]) : nil)
        #expect(SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, tbs as CFData, signatureDER as CFData, &failure), "the signature does not verify: \(String(describing: failure))")
    }
}
