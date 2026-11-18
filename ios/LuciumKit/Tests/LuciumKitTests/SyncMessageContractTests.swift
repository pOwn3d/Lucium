import Foundation
import Testing
@testable import LuciumKit

/// The message vectors (`sync-message-vectors.json`, docs/synchronisation.md §7) played against the code the phone really runs: frames, the rules a hostile
/// message must pass, the order of the types and the numbering.
@Suite("Synchronisation messages: the vectors against the real code")
struct SyncMessageContractTests {
    private let messages: [String: Any]

    init() throws { messages = try SyncContract.load("sync-message-vectors.json") }

    /// The catalogue of §7.6, as the Mac's test lists it.
    private static let catalogue = ["bad-frame", "too-large", "bad-message", "unknown-type", "bad-sequence", "unsupported-version", "invalid-code", "not-paired", "fingerprint-mismatch", "bad-proof",
                                    "pairing-expired", "pairing-used", "pairing-locked", "pairing-closed", "pairing-refused", "rate-limited", "timeout", "busy", "locked", "state-too-new",
                                    "truncated", "divergence", "clock-skew", "internal"]

    @Test func theCodesAreTheCatalogueOfTheSpecificationAndOnlyClockSkewIsNotFatal() {
        #expect(SyncErrorCode.allCases.map(\.rawValue) == Self.catalogue)
        #expect(SyncErrorCode.allCases.filter { !$0.isFatal } == [.clockSkew])
    }

    @Test func theLimitsAreTheOnesOfTheVectors() throws {
        let limits = try #require(messages["limits"] as? [String: Int])
        #expect(limits["maxFrameBytes"] == SyncLimits.maxFrameBytes)
        #expect(limits["maxSnapshotBytes"] == SyncLimits.maxSnapshotBytes)
        #expect(limits["maxEntities"] == SyncLimits.maxEntities)
        #expect(limits["maxEntitiesPerPart"] == SyncLimits.maxEntitiesPerPart)
        #expect(limits["maxParts"] == SyncLimits.maxParts)
        #expect(limits["maxJsonDepth"] == SyncLimits.maxJSONDepth)
        #expect(limits["maxStringBytes"] == SyncLimits.maxStringBytes)
        #expect(limits["maxDeviceNameChars"] == SyncLimits.maxDeviceNameCharacters)
        #expect(limits["maxDeviceIdChars"] == SyncLimits.maxDeviceIdCharacters)
        #expect(limits["maxCategories"] == SyncLimits.maxCategories)
        #expect(limits["maxHosts"] == SyncLimits.maxHosts)
        #expect(limits["maxOpenTabs"] == SyncLimits.maxOpenTabs)
        #expect(limits["maxOpenTabUrlBytes"] == SyncLimits.maxOpenTabURLBytes)
        #expect(limits["maxOpenTabTitleBytes"] == SyncLimits.maxOpenTabTitleBytes)
        #expect(limits["handshakeTimeoutMs"] == 10_000 && limits["idleTimeoutMs"] == 60_000 && limits["sessionMaxMs"] == 600_000)
        #expect(limits["minAutoIntervalMs"] == 15_000 && limits["clockSkewWarnMs"] == SyncLimits.clockSkewWarningMilliseconds)
    }

    // MARK: Frames

    @Test func aHeaderIsJudgedFromItsFourBytesAlone() throws {
        for vector in try SyncContract.array(messages, "frames") {
            let length = UInt32(vector["length"] as? Int ?? 0)
            let expected = vector["expect"] as? [String: Any]
            let failure = SyncFrame.check(announced: length)
            if expected?["ok"] as? Bool == true {
                #expect(failure == nil, "length \(length)")
            } else {
                #expect(failure?.code.rawValue == expected?["code"] as? String, "length \(length)")
            }
        }
    }

    @Test func theDecoderRefusesAnAnnouncedLengthBeforeTheContentHasArrived() {
        for (header, code) in [([0, 0, 0, 0], SyncErrorCode.badFrame), ([0, 0x10, 0, 1], .tooLarge), ([0xff, 0xff, 0xff, 0xff], .tooLarge)] as [([UInt8], SyncErrorCode)] {
            var decoder = SyncFrameDecoder()
            decoder.append(Data(header))
            #expect(throws: SyncFailure.self, "header \(header)") { _ = try decoder.next() }
            var again = SyncFrameDecoder()
            again.append(Data(header))
            do { _ = try again.next() } catch let failure as SyncFailure { #expect(failure.code == code) } catch { Issue.record("\(error)") }
        }
    }

    @Test func theDecoderWaitsForAWholeFrameAndCutsTwoFramesSentTogether() throws {
        let first = try SyncFrame.encode(Data("{\"a\":1}".utf8))
        let second = try SyncFrame.encode(Data("{\"b\":2}".utf8))
        var decoder = SyncFrameDecoder()
        decoder.append(first.prefix(2))
        #expect(try decoder.next() == nil, "half a header")
        decoder.append(first.dropFirst(2).prefix(3))
        #expect(try decoder.next() == nil, "a header and part of the content")
        decoder.append(first.dropFirst(5) + second)
        #expect(try decoder.next() == Data("{\"a\":1}".utf8))
        #expect(try decoder.next() == Data("{\"b\":2}".utf8))
        #expect(try decoder.next() == nil)
        #expect(decoder.pending == 0)
    }

    @Test func aFrameOfTheMaximumCanBeWrittenAndOneByteMoreCannot() throws {
        let biggest = try SyncFrame.encode(Data(repeating: 0x20, count: SyncLimits.maxFrameBytes))
        #expect(biggest.count == 4 + SyncLimits.maxFrameBytes)
        #expect(throws: SyncFailure(.tooLarge, "a message of 1048577 bytes")) { try SyncFrame.encode(Data(repeating: 0x20, count: SyncLimits.maxFrameBytes + 1)) }
        #expect(throws: SyncFailure(.badFrame, "an empty message")) { try SyncFrame.encode(Data()) }
    }

    @Test func theSnapshotBoundIsTheOneOfTheVectors() throws {
        for vector in try SyncContract.array(messages, "snapshotBytes") {
            let total = vector["total"] as? Int ?? 0
            #expect((total <= SyncLimits.maxSnapshotBytes) == ((vector["expect"] as? [String: Any])?["ok"] as? Bool), "\(total)")
        }
    }

    // MARK: Numbers

    @Test func theNumbersAreCountedFromOneAndAnythingElseIsRefusedAtTheRightPlace() throws {
        for vector in try SyncContract.array(messages, "sequences") {
            var sequence = SyncSequence()
            var refusedAt: Int?
            for (index, n) in (vector["ns"] as? [Int] ?? []).enumerated() where refusedAt == nil {
                do { try sequence.accept(n) } catch let failure as SyncFailure {
                    #expect(failure.code == .badSequence)
                    refusedAt = index
                } catch { Issue.record("\(error)") }
            }
            let expected = vector["expect"] as? [String: Any]
            #expect(refusedAt == expected?["at"] as? Int, "\(vector["name"] ?? "?")")
            #expect((refusedAt == nil) == (expected?["ok"] as? Bool), "\(vector["name"] ?? "?")")
        }
    }

    @Test func theNumbersTheSenderWritesAreTheSameCount() {
        var sequence = SyncSequence()
        let counted: [Int] = [sequence.next(), sequence.next(), sequence.next()]
        #expect(counted == [1, 2, 3])
    }

    // MARK: Messages

    /// The text of a vector: the message as it is, a text written out, or the message with a value repeated to a length (a limit is tried at the byte).
    private func text(of vector: [String: Any]) throws -> Data {
        if let raw = vector["raw"] as? String { return Data(raw.utf8) }
        var message = try #require(vector["message"] as? [String: Any])
        if let fill = vector["fill"] as? [String: Any] {
            let path = fill["path"] as? [Any] ?? []
            let times = fill["times"] as? Int ?? 0
            let value: Any = (fill["repeat"] as? String).map { String(repeating: $0, count: times) } ?? Array(repeating: fill["copy"] as Any, count: times)
            message = try #require(Self.set(value, at: path[...], in: message) as? [String: Any])
        }
        return try JSONSerialization.data(withJSONObject: message)
    }

    private static func set(_ value: Any, at path: ArraySlice<Any>, in container: Any) -> Any {
        guard let step = path.first else { return value }
        if let key = step as? String, var object = container as? [String: Any] {
            object[key] = set(value, at: path.dropFirst(), in: object[key] as Any)
            return object
        }
        if let index = step as? Int, var array = container as? [Any] {
            array[index] = set(value, at: path.dropFirst(), in: array[index])
            return array
        }
        return container
    }

    @Test func everyMessageVectorIsReadOrRefusedAsTheVectorSays() throws {
        let vectors = try SyncContract.array(messages, "messages")
        #expect(vectors.count >= 60)
        for vector in vectors {
            let name = vector["name"] as? String ?? "?"
            let content = try text(of: vector)
            #expect(content.count <= SyncLimits.maxFrameBytes, "\(name): a refused message must fit in a frame, or the frame is what refuses it")
            let expected = try #require(vector["expect"] as? [String: Any])
            switch SyncMessageCodec.decode(content) {
            case .success(let envelope):
                #expect(expected["ok"] as? Bool == true, "read, but it must be refused: \(name) (\(envelope.message.type))")
            case .failure(let failure):
                #expect(expected["ok"] as? Bool == false, "refused (\(failure.code.rawValue), \(failure.detail)): \(name)")
                #expect(failure.code.rawValue == expected["code"] as? String, "\(name)")
            }
        }
    }

    @Test func everyTypeOfTheSpecificationIsReadAtLeastOnce() throws {
        var seen = Set<String>()
        for vector in try SyncContract.array(messages, "messages") where (vector["expect"] as? [String: Any])?["ok"] as? Bool == true {
            if case .success(let envelope) = SyncMessageCodec.decode(try text(of: vector)) { seen.insert(envelope.message.type) }
        }
        #expect(seen == ["hello", "pair.challenge", "pair.request", "pair.accept", "snapshot.part", "snapshot.end", "open-tabs", "result", "commit", "unpair", "error", "bye"])
    }

    @Test func aHelloIsReadFieldByField() throws {
        let vectors = try SyncContract.array(messages, "messages")
        let mac = try #require(vectors.first { $0["name"] as? String == "a hello from a Mac, with its addresses" })
        guard case .success(let envelope) = SyncMessageCodec.decode(try text(of: mac)), case .hello(let hello) = envelope.message else {
            Issue.record("not a hello")
            return
        }
        #expect(envelope.number == 1)
        #expect(hello.device.platform == .mac)
        #expect(hello.nonce.count == 16)
        #expect(hello.hosts?.isEmpty == false)
        #expect(hello.stateVersion >= 1)
    }

    @Test func whatThePhoneWritesIsReadBackByItsOwnReader() throws {
        let device = SyncDeviceInfo(id: "phone-0001", name: "iPhone", platform: .ios)
        let nonce = Data((0..<16).map { UInt8($0) })
        let hello = SyncHello(device: device, nonce: nonce, categories: ["structure"], baseHash: nil, stateVersion: 1, appVersion: "0.1.0", now: 1_790_000_000_000)
        let sent: [SyncMessage] = [.hello(hello), .pairRequest(device: device, nonce: nonce, proof: Data(repeating: 7, count: 32)), .unpair, .bye,
                                   .error(code: .stateTooNew, fatal: true, supported: [1], detail: "state version 9"), .error(code: .clockSkew, fatal: false, supported: nil, detail: nil)]
        for (index, message) in sent.enumerated() {
            let data = try SyncMessageCodec.encode(message, number: index + 1)
            guard case .success(let envelope) = SyncMessageCodec.decode(data) else { Issue.record("not read back: \(message.type)"); continue }
            #expect(envelope == SyncEnvelope(number: index + 1, message: message), "\(message.type)")
        }
        // What only the Mac writes is not written by the phone (the messages of an exchange are written, and read back, in SyncPartsAndApplyTests).
        #expect(throws: SyncFailure.self) { try SyncMessageCodec.encode(.pairChallenge(nonce: nonce), number: 1) }
    }

    @Test func aNonceOrAProofThatIsAnotherWritingOfTheSameBytesIsRefused() throws {
        // 22 characters for 16 bytes leave 4 bits over: they must be zero, or the same nonce has two writings (and a proof two transcriptions).
        let device = ["id": "phone-0001", "name": "iPhone", "platform": "ios"]
        func request(nonce: String, proof: String) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["v": 1, "t": "pair.request", "n": 1, "device": device, "nonce": nonce, "proof": proof])
        }
        let proof = String(repeating: "A", count: 43)
        if case .failure = SyncMessageCodec.decode(try request(nonce: "ABEiM0RVZneImaq7zN3u_w", proof: proof)) { Issue.record("a canonical nonce was refused") }
        if case .success = SyncMessageCodec.decode(try request(nonce: "ABEiM0RVZneImaq7zN3u_x", proof: proof)) { Issue.record("a nonce with bits left over was read") }
        if case .success = SyncMessageCodec.decode(try request(nonce: "ABEiM0RVZneImaq7zN3u_w", proof: String(repeating: "A", count: 42) + "B")) { Issue.record("a proof with bits left over was read") }
    }

    // MARK: Order

    @Test func theOrderOfTheTypesIsTheOneOfTheVectors() throws {
        let vectors = try SyncContract.array(messages, "transitions")
        #expect(vectors.count >= 20)
        for vector in vectors {
            let receiver: SyncRole = vector["receiver"] as? String == "mac" ? .mac : .ios
            let phase: SyncPhase = vector["phase"] as? String == "pairing" ? .pairing : .session
            let allowed = SyncTransitions.allows(vector["type"] as? String ?? "", after: vector["history"] as? [String] ?? [], receiver: receiver, phase: phase)
            #expect(allowed == ((vector["expect"] as? [String: Any])?["ok"] as? Bool), "\(vector["name"] ?? "?")")
        }
    }
}
