import Foundation
import Testing
@testable import LuciumKit

/// The phone's half of the pairing played against a Mac written in the test (`SyncFakeMac`), over memory. What is proved here is the order, the checks, and what is
/// left unwritten when a check fails; the bytes of the proofs are proved by the shared vectors (`SyncPairingContractTests`).
@Suite("Synchronisation pairing: the phone's half")
struct SyncPairingFlowTests {
    /// What the fake Mac read last, written from another task.
    private final class Received: @unchecked Sendable {
        private let lock = NSLock()
        private var value: [String: Any]?
        func set(_ fields: [String: Any]) { lock.withLock { value = fields } }
        var fields: [String: Any]? { lock.withLock { value } }
    }

    private let secret = SyncContract.hex("6a1f0c2b9d4e7a35c81b2f0e5d7a9c43")
    private let macFingerprint = SyncContract.hex("d1e9cc4016253cbcc57d90fa77640b06d550223a14fd582c1c3bf31426e8519f")
    private let phoneFingerprint = SyncContract.hex("6a1e82e7f597e6b178278d395e619acfebe48f27bffe86d854a48104cdf406d3")
    private let macNonce = Data((0..<16).map { UInt8($0) })
    private let phoneNonce = Data((0..<16).map { UInt8(255 - $0) })
    private let phone = SyncDeviceInfo(id: "vector-phone-000000002", name: "iPhone de test", platform: .ios)

    private var code: SyncPairingCode { SyncPairingCode(fingerprint: macFingerprint, secret: secret, port: 49213, hosts: ["mac-de-test.local"]) }

    private func macInputs(phoneId: String = "vector-phone-000000002", secret: Data? = nil, fingerprintMac: Data? = nil) -> SyncProofInputs {
        SyncProofInputs(secret: secret ?? self.secret, fingerprintMac: fingerprintMac ?? macFingerprint, fingerprintPhone: phoneFingerprint, nonceMac: macNonce, noncePhone: phoneNonce,
                        idMac: "vector-mac-0000000001", idPhone: phoneId)
    }

    private func macDevice() -> [String: Any] { ["id": "vector-mac-0000000001", "name": "MacBook de test", "platform": "mac"] }

    /// What the person of the phone was shown, in order (the proposal of §4.6).
    private final class Shown: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [SyncPairingProposal] = []
        func add(_ item: SyncPairingProposal) { lock.withLock { items.append(item) } }
        var all: [SyncPairingProposal] { lock.withLock { items } }
    }

    private func pair(_ code: SyncPairingCode, mac script: @escaping @Sendable (SyncFakeMac) async throws -> Void, presented: Data? = nil,
                      confirmation: Duration = .seconds(2), comparison: Duration = .seconds(2), shown: Shown = Shown(),
                      person: @escaping @Sendable (SyncPairingProposal) async -> Bool = { _ in true }) async throws -> (SyncPairingOutcome, SyncLoopbackEnd) {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let task = Task { try await script(fake) }
        defer { task.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: presented ?? macFingerprint)
        let outcome = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phoneFingerprint, device: phone, nonce: phoneNonce,
                                                       handshakeTimeout: .seconds(2), confirmationTimeout: confirmation, comparisonTimeout: comparison,
                                                       confirm: { proposal in shown.add(proposal); return await person(proposal) })
        _ = try? await task.value
        return (outcome, ends.phone)
    }

    /// A Mac that behaves: challenge, reads the request, checks the phone's proof, accepts with its own.
    private func goodMac(hosts: [String] = ["mac-de-test.local", "192.168.1.20"], acceptProofSecret: Data? = nil, acceptFingerprintMac: Data? = nil) -> @Sendable (SyncFakeMac) async throws -> Void {
        { mac in
            try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
            let request = try await mac.read()
            #expect(request.fields["t"] as? String == "pair.request")
            #expect(request.n == 1)
            let proof = try #require(request.fields["proof"] as? String)
            #expect(proof == SyncProof.requestTag(macInputs()).map(SyncEncoding.base64url), "the phone's proof is the one the Mac computes")
            let accept = SyncProof.acceptTag(macInputs(secret: acceptProofSecret, fingerprintMac: acceptFingerprintMac)).map(SyncEncoding.base64url) ?? ""
            try await mac.write("pair.accept", ["device": macDevice(), "proof": accept, "hosts": hosts])
            // The phone's person compares the code and says yes (a bye); the Mac keeps the phone and answers with its own bye (§4.6).
            let word = try await mac.read()
            #expect(word.fields["t"] as? String == "bye")
            try await mac.write("bye")
        }
    }

    @Test func aPairingWithAQRRegistersTheMacItProvedAndOnlyItsLocalAddresses() async throws {
        let (outcome, _) = try await pair(code, mac: goodMac(hosts: ["mac-de-test.local", "192.168.1.20", "8.8.8.8", "example.com"]))
        #expect(outcome.mac.id == "vector-mac-0000000001")
        #expect(outcome.mac.name == "MacBook de test")
        #expect(outcome.fingerprint == macFingerprint)
        #expect(outcome.hosts == ["mac-de-test.local", "192.168.1.20"], "a public address or a DNS name given by a Mac is not kept")
    }

    @Test func aPairingWithATypedCodeLearnsTheFingerprintAndTheProofCoversIt() async throws {
        let typed = SyncPairingCode(fingerprint: nil, secret: secret, port: 49213, hosts: ["mac-de-test.local"])
        let (outcome, _) = try await pair(typed, mac: goodMac())
        #expect(outcome.fingerprint == macFingerprint, "what the connection showed is what is registered")
    }

    @Test func aManInTheMiddleWhoShowsHisOwnCertificateToATypedCodeCannotMakeTheProof() async throws {
        // He shows the phone his certificate (so the phone's inputs name his fingerprint), but the Mac's real proof was made for the Mac's.
        let typed = SyncPairingCode(fingerprint: nil, secret: secret, port: 49213, hosts: ["mac-de-test.local"])
        let intruder = Data(repeating: 0xee, count: 32)
        await #expect(throws: SyncFailure.self) {
            _ = try await pair(typed, mac: { mac in
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                _ = try await mac.read()
                let forged = SyncProof.acceptTag(macInputs())  // computed over the Mac's fingerprint, not over the intruder's
                try await mac.write("pair.accept", ["device": macDevice(), "proof": forged.map(SyncEncoding.base64url) ?? "", "hosts": []])
            }, presented: intruder)
        }
    }

    @Test func aWrongProofRegistersNothingAndSaysSo() async throws {
        do {
            _ = try await pair(code, mac: goodMac(acceptProofSecret: Data(repeating: 1, count: 16)))
            Issue.record("a Mac that does not know the secret was accepted")
        } catch let failure as SyncFailure {
            #expect(failure.code == .badProof)
        }
    }

    @Test func aCertificateThatIsNotTheQRsIsRefusedBeforeAnyByteIsSent() async throws {
        let ends = syncLoopback()
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: Data(repeating: 0x11, count: 32))
        do {
            _ = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phoneFingerprint, device: phone, nonce: phoneNonce, confirm: { _ in true })
            Issue.record("a certificate that is not the code's was accepted")
        } catch let failure as SyncFailure {
            #expect(failure.code == .fingerprintMismatch)
        }
        #expect(ends.phone.sent == 0, "nothing was written to a device that is not the one of the QR")
        #expect(ends.phone.closed)
    }

    @Test func theMacsRefusalsAreTheirOwnCodes() async throws {
        for refusal in [SyncErrorCode.pairingUsed, .pairingExpired, .pairingLocked, .pairingRefused, .badProof] {
            do {
                _ = try await pair(code, mac: { mac in
                    try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                    _ = try await mac.read()
                    try await mac.write("error", ["code": refusal.rawValue, "fatal": true])
                })
                Issue.record("\(refusal) was not reported")
            } catch let failure as SyncFailure {
                #expect(failure.code == refusal)
            }
        }
    }

    // MARK: The code to compare (docs/synchronisation.md §4.6, review n° 9)

    @Test func theProofOfTheMacIsFollowedByTheQuestionToItsPersonWithTheNameOfTheMacAndTheCodeBothComputeFromTheFingerprints() async throws {
        let shown = Shown()
        let (outcome, _) = try await pair(code, mac: goodMac(), shown: shown)
        #expect(shown.all == [SyncPairingProposal(macName: "MacBook de test", code: try #require(SyncPairingCompare.code(fingerprintMac: macFingerprint, fingerprintPhone: phoneFingerprint)))])
        #expect(outcome.mac.id == "vector-mac-0000000001")
    }

    @Test func nothingIsSentToTheMacBeforeThePersonHasAnsweredAndNothingIsKeptWhenTheyRefuse() async throws {
        // The person of the phone says no: the Mac gets an error with the code of a refusal, no bye, and the pairing throws instead of returning a Mac to keep.
        let received = Received()
        do {
            _ = try await pair(code, mac: { mac in
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                _ = try await mac.read()
                let accept = SyncProof.acceptTag(macInputs()).map(SyncEncoding.base64url) ?? ""
                try await mac.write("pair.accept", ["device": macDevice(), "proof": accept, "hosts": []])
                let word = try await mac.read()
                received.set(word.fields)
            }, person: { _ in false })
            Issue.record("a pairing the person refused was kept")
        } catch let failure as SyncFailure {
            #expect(failure.code == .pairingRefused)
        }
        try await Task.sleep(for: .milliseconds(100))
        let word = try #require(received.fields)
        #expect(word["t"] as? String == "error")
        #expect(word["code"] as? String == "pairing-refused")
    }

    @Test func aPersonWhoDoesNotAnswerInTimeIsARefusalAndTheConnectionIsClosed() async throws {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let task = Task {
            try await fake.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
            _ = try await fake.read()
            try await fake.write("pair.accept", ["device": macDevice(), "proof": SyncProof.acceptTag(macInputs()).map(SyncEncoding.base64url) ?? "", "hosts": []])
        }
        defer { task.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        do {
            _ = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phoneFingerprint, device: phone, nonce: phoneNonce,
                                                 handshakeTimeout: .seconds(2), confirmationTimeout: .seconds(2), comparisonTimeout: .milliseconds(150),
                                                 confirm: { _ in
                                                     try? await Task.sleep(for: .seconds(30))
                                                     return true
                                                 })
            Issue.record("a person who said nothing was taken for a yes")
        } catch let failure as SyncFailure {
            #expect(failure.code == .pairingRefused)
        }
        #expect(ends.phone.closed)
    }

    @Test func aMacThatCannotKeepThePhoneAnswersAnErrorInPlaceOfItsByeAndThePhoneKeepsNothing() async throws {
        do {
            _ = try await pair(code, mac: { mac in
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                _ = try await mac.read()
                try await mac.write("pair.accept", ["device": macDevice(), "proof": SyncProof.acceptTag(macInputs()).map(SyncEncoding.base64url) ?? "", "hosts": []])
                _ = try await mac.read()
                try await mac.write("error", ["code": "internal", "fatal": true])
            })
            Issue.record("a pairing the Mac could not keep was kept")
        } catch let failure as SyncFailure {
            #expect(failure.code == .internal)
        }
    }

    @Test func aMacThatSaysNothingAfterTheByeIsATimeoutAndTheConnectionIsClosed() async throws {
        let ends = syncLoopback()
        let fake = SyncFakeMac(ends.mac)
        let task = Task {
            try await fake.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
            _ = try await fake.read()
            try await fake.write("pair.accept", ["device": macDevice(), "proof": SyncProof.acceptTag(macInputs()).map(SyncEncoding.base64url) ?? "", "hosts": []])
            _ = try await fake.read()
            try await Task.sleep(for: .seconds(5))
        }
        defer { task.cancel() }
        let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
        do {
            _ = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phoneFingerprint, device: phone, nonce: phoneNonce,
                                                 handshakeTimeout: .milliseconds(200), confirmationTimeout: .seconds(2), confirm: { _ in true })
            Issue.record("a Mac that never confirmed that it kept the phone was believed")
        } catch let failure as SyncFailure {
            #expect(failure.code == .timeout)
        }
        #expect(ends.phone.closed)
    }

    @Test func aWrongProofIsRefusedBeforeThePersonIsAskedAnything() async throws {
        let shown = Shown()
        do {
            _ = try await pair(code, mac: goodMac(acceptProofSecret: Data(repeating: 1, count: 16)), shown: shown)
            Issue.record("a Mac that does not know the secret was accepted")
        } catch let failure as SyncFailure {
            #expect(failure.code == .badProof)
        }
        #expect(shown.all.isEmpty, "the person is not asked to compare a code with a Mac that has not proved anything")
    }

    @Test func theNameOfTheMacIsShownAsTextWithoutWhatTurnsItRoundOrBreaksTheLine() {
        let proposal = SyncPairingProposal(macName: "MacBook\u{202E}gpj.exe\n de test\u{0007}", code: "ABC234")
        #expect(proposal.macName == "MacBook gpj.exe  de test")
    }

    @Test func aMacThatStaysSilentIsATimeoutAndNotAHang() async throws {
        do {
            _ = try await pair(code, mac: { mac in try await Task.sleep(for: .seconds(5)); _ = mac }, confirmation: .milliseconds(200))
            Issue.record("a silent Mac was waited for")
        } catch let failure as SyncFailure {
            #expect(failure.code == .timeout)
        }
    }

    @Test func aMacThatDoesNotAnswerAfterTheRequestIsATimeoutToo() async throws {
        do {
            _ = try await pair(code, mac: { mac in
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                _ = try await mac.read()
                try await Task.sleep(for: .seconds(5))
            }, confirmation: .milliseconds(200))
            Issue.record("a Mac that never confirms was waited for")
        } catch let failure as SyncFailure {
            #expect(failure.code == .timeout)
        }
    }

    @Test func whatTheMacSendsOutOfOrderOrBrokenClosesTheConnection() async throws {
        let attempts: [(String, @Sendable (SyncFakeMac) async throws -> Void, SyncErrorCode)] = [
            ("an accept before any challenge", { mac in try await mac.write("pair.accept", ["device": macDevice(), "proof": String(repeating: "A", count: 43), "hosts": []]) }, .badMessage),
            ("a hello in a pairing", { mac in try await mac.write("unpair") }, .badMessage),
            ("a frame of length 0", { mac in try await mac.writeRaw(Data([0, 0, 0, 0])) }, .badFrame),
            ("a frame announced at 2 MiB", { mac in try await mac.writeRaw(Data([0, 0x20, 0, 0])) }, .tooLarge),
            ("a message that is not JSON", { mac in try await mac.writeRaw(try SyncFrame.encode(Data("not json".utf8))) }, .badMessage),
            ("a challenge numbered 2", { mac in try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)], number: 2) }, .badSequence),
            ("another version", { mac in try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)], version: 2) }, .unsupportedVersion),
        ]
        for (name, script, code) in attempts {
            do {
                _ = try await pair(self.code, mac: script)
                Issue.record("\(name) was accepted")
            } catch let failure as SyncFailure {
                #expect(failure.code == code, "\(name)")
            }
        }
    }

    @Test func everyFailureLeavesTheConnectionClosed() async throws {
        let attempts: [(String, @Sendable (SyncFakeMac) async throws -> Void, SyncErrorCode)] = [
            ("a bye in place of the challenge", { mac in try await mac.write("bye") }, .badMessage),
            ("a Mac that stays silent", { mac in try await Task.sleep(for: .seconds(5)); _ = mac }, .timeout),
            ("a bye in place of the accept", { mac in
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                _ = try await mac.read()
                try await mac.write("bye")
            }, .badMessage),
        ]
        for (name, script, expected) in attempts {
            let ends = syncLoopback()
            let fake = SyncFakeMac(ends.mac)
            let task = Task { try? await script(fake) }
            defer { task.cancel() }
            let connection = SyncConnection(transport: ends.phone, presentedFingerprint: macFingerprint)
            do {
                _ = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: phoneFingerprint, device: phone, nonce: phoneNonce,
                                                     handshakeTimeout: .milliseconds(300), confirmationTimeout: .milliseconds(300), confirm: { _ in true })
                Issue.record("\(name) was accepted")
            } catch let failure as SyncFailure {
                #expect(failure.code == expected, "\(name)")
            }
            #expect(ends.phone.closed, "\(name): the connection is still open")
        }
    }

    @Test func theAnswerOfADeviceThatIsNotAMacIsRefused() async throws {
        do {
            _ = try await pair(code, mac: { mac in
                try await mac.write("pair.challenge", ["nonce": SyncEncoding.base64url(macNonce)])
                _ = try await mac.read()
                let proof = SyncProof.acceptTag(macInputs()).map(SyncEncoding.base64url) ?? ""
                try await mac.write("pair.accept", ["device": ["id": "vector-mac-0000000001", "name": "Not a Mac", "platform": "ios"], "proof": proof, "hosts": []])
            })
            Issue.record("a phone answered as a Mac")
        } catch let failure as SyncFailure {
            #expect(failure.code == .badMessage)
        }
    }
}
