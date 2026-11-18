import Foundation

/// One of the two devices, as it says who it is in `hello`, `pair.request` and `pair.accept` (docs/synchronisation.md §3.2).
public struct SyncDeviceInfo: Equatable, Sendable {
    public enum Platform: String, Sendable { case mac, ios }

    /// 1 to 64 characters of `[A-Za-z0-9_-]`: 16 random bytes in base64url, made on the device and bound to its certificate at the pairing.
    public let id: String
    /// What the person sees ("MacBook Pro de …"). Shown, never used to recognise a device.
    public let name: String
    public let platform: Platform

    public init(id: String, name: String, platform: Platform) {
        self.id = id
        self.name = name
        self.platform = platform
    }

    static func isValidId(_ id: String) -> Bool {
        (1...SyncLimits.maxDeviceIdCharacters).contains(id.utf8.count) && id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f || $0 == 0x2d }
    }
}

/// The first message of a session, in both directions (§7.3).
public struct SyncHello: Equatable, Sendable {
    public let device: SyncDeviceInfo
    /// 16 random bytes: made for this connection.
    public let nonce: Data
    /// The categories this device agrees to exchange (§10.1); the session carries those both have. Unknown names are kept and ignored by the reader.
    public let categories: [String]
    /// The hash of the last merged snapshot this device holds for the other one, or nil when it has none (§8.2).
    public let baseHash: String?
    public let stateVersion: Int
    public let appVersion: String
    /// The device's clock, in milliseconds since 1970: only to warn of a drift of more than five minutes (§9.3).
    public let now: Int
    /// The Mac's current addresses and `.local` name, at most four (§5). Nil from the phone.
    public let hosts: [String]?

    public init(device: SyncDeviceInfo, nonce: Data, categories: [String], baseHash: String?, stateVersion: Int, appVersion: String, now: Int, hosts: [String]? = nil) {
        self.device = device
        self.nonce = nonce
        self.categories = categories
        self.baseHash = baseHash
        self.stateVersion = stateVersion
        self.appVersion = appVersion
        self.now = now
        self.hosts = hosts
    }
}

/// A message of the protocol, after it has been read and found to be well formed (§7.3). The parts of a snapshot and the list of open tabs are checked
/// for their form here and kept as they are: what they mean is the business of the session's body (§8), not of the transport.
public enum SyncMessage: Equatable, Sendable {
    case hello(SyncHello)
    case pairChallenge(nonce: Data)
    case pairRequest(device: SyncDeviceInfo, nonce: Data, proof: Data)
    case pairAccept(device: SyncDeviceInfo, proof: Data, hosts: [String])
    case snapshotPart(JSONValue)
    case snapshotEnd(entityCount: Int, digest: String)
    case openTabs(JSONValue)
    case result(digest: String)
    case commit(digest: String)
    case unpair
    case error(code: SyncErrorCode, fatal: Bool, supported: [Int]?, detail: String?)
    case bye

    /// The `t` of the envelope.
    public var type: String {
        switch self {
        case .hello: "hello"
        case .pairChallenge: "pair.challenge"
        case .pairRequest: "pair.request"
        case .pairAccept: "pair.accept"
        case .snapshotPart: "snapshot.part"
        case .snapshotEnd: "snapshot.end"
        case .openTabs: "open-tabs"
        case .result: "result"
        case .commit: "commit"
        case .unpair: "unpair"
        case .error: "error"
        case .bye: "bye"
        }
    }
}

/// A message with its number: the sender's count, from 1, one more each time (§7.1).
public struct SyncEnvelope: Equatable, Sendable {
    public let number: Int
    public let message: SyncMessage
}

/// Which message may come after the ones already received (§7.4). `error` and `bye` may always come.
public enum SyncPhase: Sendable { case pairing, session }
public enum SyncRole: Sendable { case mac, ios }

public enum SyncTransitions {
    public static func allows(_ type: String, after history: [String], receiver: SyncRole, phase: SyncPhase) -> Bool {
        if type == "error" || type == "bye" { return true }
        let seen = { (kind: String) in history.contains(kind) }
        switch phase {
        case .pairing:
            if receiver == .mac { return type == "pair.request" && !seen("pair.request") }
            if history.isEmpty { return type == "pair.challenge" }
            return history == ["pair.challenge"] && type == "pair.accept"
        case .session:
            switch type {
            case "hello": return !seen("hello")
            case "snapshot.part", "open-tabs": return seen("hello") && !seen("snapshot.end")
            case "snapshot.end": return seen("snapshot.part") && !seen("snapshot.end")
            case "result": return seen("snapshot.end") && !seen("result")
            case "commit": return seen("result") && !seen("commit")
            case "unpair": return seen("hello")
            default: return false
            }
        }
    }
}

/// Reads and writes the JSON of a message. What arrives is hostile until it has passed every rule of §7.1: an object, at most 32 levels deep, no key called
/// `__proto__` at any depth, finite numbers that JavaScript and Swift write the same way, no string over 64 KiB, and for each type the fields it is made of.
/// A field that is not known is ignored; a field that is missing or of the wrong kind is `bad-message`.
public enum SyncMessageCodec {
    public static let version = 1

    // MARK: Reading

    public static func decode(_ content: Data) -> Result<SyncEnvelope, SyncFailure> {
        var unlimited = Int.max
        return decode(content, valuesLeft: &unlimited)
    }

    /// Whether the JSON text holds a `\uD800` to `\uDFFF` escape that is not half of a pair: a text with a lone UTF-16 surrogate. A Swift string cannot hold one, so
    /// the phone refuses it (`bad-message`), on purpose and not because of what a decoder happens to do: a decoder that put the replacement character in its place would
    /// make the digest of the phone differ from the Mac's, which writes the surrogate as it was (docs/synchronisation.md §7.1; review n° 15).
    static func hasLoneSurrogate(_ content: Data) -> Bool {
        let bytes = [UInt8](content)
        func hex(at start: Int) -> Int? {
            guard start + 4 <= bytes.count else { return nil }
            var value = 0
            for index in start..<(start + 4) {
                let byte = bytes[index]
                let digit: Int
                switch byte {
                case 0x30...0x39: digit = Int(byte) - 0x30
                case 0x41...0x46: digit = Int(byte) - 0x41 + 10
                case 0x61...0x66: digit = Int(byte) - 0x61 + 10
                default: return nil
                }
                value = value * 16 + digit
            }
            return value
        }
        var index = 0
        while index < bytes.count {
            guard bytes[index] == 0x5C else { index += 1; continue }  // a backslash
            guard index + 1 < bytes.count else { return false }
            if bytes[index + 1] != 0x75 {  // `\\`, `\"`, `\n`…: the escape is two bytes, and the next one is not the start of another
                index += 2
                continue
            }
            guard let unit = hex(at: index + 2) else { return false }
            index += 6
            if (0xD800...0xDBFF).contains(unit) {
                // A high half must be followed at once by a low half.
                guard index + 5 < bytes.count, bytes[index] == 0x5C, bytes[index + 1] == 0x75, let next = hex(at: index + 2), (0xDC00...0xDFFF).contains(next) else { return true }
                index += 6
            } else if (0xDC00...0xDFFF).contains(unit) {
                return true
            }
        }
        return false
    }

    /// `valuesLeft` is what a connection may still hold in values (`SyncLimits.maxSessionValues`): each message read spends its own, and one that goes over what is
    /// left, or over a frame's bound, is `too-large` (nothing is spent for it).
    public static func decode(_ content: Data, valuesLeft: inout Int) -> Result<SyncEnvelope, SyncFailure> {
        let bad = { (why: String) in Result<SyncEnvelope, SyncFailure>.failure(SyncFailure(.badMessage, why)) }
        guard !hasLoneSurrogate(content) else { return bad("a text with a lone UTF-16 surrogate") }
        // The first of two equal keys wins here and the last in JavaScript: the same text would be two messages (docs/synchronisation.md §7.1, review n° 20).
        guard !SyncDuplicateKeys.has(in: content) else { return bad("a key written twice in one object") }
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: content) else { return bad("not JSON") }
        guard case .object(let fields) = value, !hasProblem(value, depth: 1) else { return bad("not an object, or a value the rules refuse") }
        let count = valueCount(value, stopAbove: min(SyncLimits.maxFrameValues, valuesLeft))
        guard count <= min(SyncLimits.maxFrameValues, valuesLeft) else { return .failure(SyncFailure(.tooLarge, "a message that holds more values than a frame or a connection may")) }
        guard let number = integer(fields["n"], minimum: 1), case .string(let type)? = fields["t"], let sentVersion = integer(fields["v"], minimum: Int.min) else {
            return bad("no number, no type, or no version")
        }
        guard sentVersion == version else { return .failure(SyncFailure(.unsupportedVersion, "version \(sentVersion)")) }
        guard knownTypes.contains(type) else { return .failure(SyncFailure(.unknownType, "type \(type.prefix(40))")) }
        guard let message = parse(type: type, fields: fields, whole: value) else { return bad("the fields of \(type)") }
        valuesLeft -= count
        return .success(SyncEnvelope(number: number, message: message))
    }

    /// How many values a JSON value holds (each one counted once, the keys of an object not at all): `{"v":1,"t":"bye","n":1}` holds four. The count stops as soon as it is
    /// over `stopAbove`: nothing past it is looked at.
    static func valueCount(_ value: JSONValue, stopAbove limit: Int) -> Int {
        var count = 0
        var stack = [value]
        while let next = stack.popLast() {
            count += 1
            if count > limit { return count }
            switch next {
            case .array(let items): stack.append(contentsOf: items)
            case .object(let members): stack.append(contentsOf: members.values)
            default: break
            }
        }
        return count
    }

    private static let knownTypes: Set<String> = ["hello", "pair.challenge", "pair.request", "pair.accept", "snapshot.part", "snapshot.end", "open-tabs", "result", "commit", "unpair", "error", "bye"]

    /// A string over 64 KiB, a number that is not finite or that JavaScript would write with an exponent, a nesting beyond 32 levels, a `__proto__` key.
    static func hasProblem(_ value: JSONValue, depth: Int) -> Bool {
        switch value {
        case .string(let text): return text.utf8.count > SyncLimits.maxStringBytes
        case .number(let number): return !number.isFinite || abs(number) >= 1e21 || (number != 0 && abs(number) < 1e-6)
        case .null, .bool: return false
        case .array(let items): return depth > SyncLimits.maxJSONDepth || items.contains { hasProblem($0, depth: depth + 1) }
        case .object(let members):
            return depth > SyncLimits.maxJSONDepth || members.keys.contains("__proto__") || members.values.contains { hasProblem($0, depth: depth + 1) }
        }
    }

    private static func integer(_ value: JSONValue?, minimum: Int) -> Int? {
        guard case .number(let number)? = value, number.isFinite, number == number.rounded(), abs(number) < 9_007_199_254_740_992, Int(number) >= minimum else { return nil }
        return Int(number)
    }

    private static func text(_ value: JSONValue?, maxBytes: Int = SyncLimits.maxStringBytes) -> String? {
        guard case .string(let text)? = value, text.utf8.count <= maxBytes else { return nil }
        return text
    }

    private static func texts(_ value: JSONValue?, max: Int, maxCharacters: Int) -> [String]? {
        guard case .array(let items)? = value, items.count <= max else { return nil }
        var out: [String] = []
        for item in items {
            guard case .string(let text) = item, text.utf16.count <= maxCharacters else { return nil }
            out.append(text)
        }
        return out
    }

    private static func object(_ value: JSONValue?) -> [String: JSONValue]? {
        if case .object(let members)? = value { return members }
        return nil
    }

    private static func device(_ value: JSONValue?) -> SyncDeviceInfo? {
        guard let members = object(value), case .string(let id)? = members["id"], SyncDeviceInfo.isValidId(id), case .string(let name)? = members["name"], !name.isEmpty,
              name.unicodeScalars.count <= SyncLimits.maxDeviceNameCharacters, case .string(let platform)? = members["platform"], let kind = SyncDeviceInfo.Platform(rawValue: platform) else { return nil }
        return SyncDeviceInfo(id: id, name: name, platform: kind)
    }

    /// 22 characters of base64url: 16 bytes of nonce. Only the canonical writing is read (no padding, no bits left over), stricter than the Mac's check of the
    /// alphabet: a nonce goes into a proof, and two writings of the same bytes would be two nonces.
    private static func nonce(_ value: JSONValue?) -> Data? {
        guard case .string(let text)? = value else { return nil }
        return SyncEncoding.base64urlDecode(text, characters: 22)
    }

    /// 43 characters of base64url: 32 bytes of proof.
    private static func proof(_ value: JSONValue?) -> Data? {
        guard case .string(let text)? = value else { return nil }
        return SyncEncoding.base64urlDecode(text, characters: 43)
    }

    private static func digest(_ value: JSONValue?) -> String? {
        guard case .string(let text)? = value, text.utf8.count == 64, text.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) else { return nil }
        return text
    }

    private static func parse(type: String, fields: [String: JSONValue], whole: JSONValue) -> SyncMessage? {
        switch type {
        case "hello":
            guard let device = device(fields["device"]), let nonce = nonce(fields["nonce"]),
                  let categories = texts(fields["categories"], max: SyncLimits.maxCategories, maxCharacters: 32),
                  let stateVersion = integer(fields["stateVersion"], minimum: 1), let appVersion = text(fields["appVersion"], maxBytes: 32), let now = integer(fields["now"], minimum: 0) else { return nil }
            var baseHash: String?
            switch fields["baseHash"] {
            case .null?: baseHash = nil
            case let value?: guard let hash = digest(value) else { return nil }; baseHash = hash
            case nil: return nil
            }
            var hosts: [String]?
            if let raw = fields["hosts"] {
                guard let list = texts(raw, max: SyncLimits.maxHosts, maxCharacters: 253) else { return nil }
                hosts = list
            }
            return .hello(SyncHello(device: device, nonce: nonce, categories: categories, baseHash: baseHash, stateVersion: stateVersion, appVersion: appVersion, now: now, hosts: hosts))
        case "pair.challenge":
            return nonce(fields["nonce"]).map { .pairChallenge(nonce: $0) }
        case "pair.request":
            guard let device = device(fields["device"]), let nonce = nonce(fields["nonce"]), let proof = proof(fields["proof"]) else { return nil }
            return .pairRequest(device: device, nonce: nonce, proof: proof)
        case "pair.accept":
            guard let device = device(fields["device"]), let proof = proof(fields["proof"]), let hosts = texts(fields["hosts"], max: SyncLimits.maxHosts, maxCharacters: 253) else { return nil }
            return .pairAccept(device: device, proof: proof, hosts: hosts)
        case "snapshot.part":
            return snapshotPartIsWellFormed(fields) ? .snapshotPart(whole) : nil
        case "snapshot.end":
            guard let count = integer(fields["entityCount"], minimum: 0), let digest = digest(fields["digest"]) else { return nil }
            return .snapshotEnd(entityCount: count, digest: digest)
        case "open-tabs":
            return openTabsAreWellFormed(fields) ? .openTabs(whole) : nil
        case "result": return digest(fields["digest"]).map { .result(digest: $0) }
        case "commit": return digest(fields["digest"]).map { .commit(digest: $0) }
        case "unpair": return .unpair
        case "bye": return .bye
        case "error":
            guard case .string(let raw)? = fields["code"], let code = SyncErrorCode(rawValue: raw), case .bool(let fatal)? = fields["fatal"] else { return nil }
            var supported: [Int]?
            if let list = fields["supported"] {
                guard case .array(let items) = list else { return nil }
                var numbers: [Int] = []
                for item in items { guard let number = integer(item, minimum: 0) else { return nil }; numbers.append(number) }
                supported = numbers
            }
            var detail: String?
            if let raw = fields["detail"] {
                guard let text = text(raw, maxBytes: 200) else { return nil }
                detail = text
            }
            return .error(code: code, fatal: fatal, supported: supported, detail: detail)
        default: return nil
        }
    }

    private static func isEntity(_ value: JSONValue) -> Bool {
        guard let members = object(value), case .string(let kind)? = members["kind"], (1...64).contains(kind.utf16.count), case .string(let id)? = members["id"], (1...128).contains(id.utf16.count),
              object(members["fields"]) != nil, let stamps = object(members["stamps"]) else { return false }
        return stamps.values.allSatisfy { if case .string = $0 { true } else { false } }
    }

    private static func snapshotPartIsWellFormed(_ fields: [String: JSONValue]) -> Bool {
        guard let part = integer(fields["part"], minimum: 0), let parts = integer(fields["parts"], minimum: 1), parts <= SyncLimits.maxParts, part < parts,
              case .array(let entities)? = fields["entities"], entities.count <= SyncLimits.maxEntitiesPerPart, entities.allSatisfy(isEntity) else { return false }
        if let raw = fields["tombstones"] {
            guard case .array(let items) = raw else { return false }
            for item in items {
                guard let members = object(item), case .string? = members["kind"], case .string? = members["id"], case .string? = members["stamp"] else { return false }
            }
        }
        if let raw = fields["order"] {
            guard let lists = object(raw), lists.values.allSatisfy({ texts($0, max: 100_000, maxCharacters: 128) != nil }) else { return false }
        }
        if let raw = fields["orderStamps"] {
            guard let stamps = object(raw), stamps.values.allSatisfy({ if case .string = $0 { true } else { false } }) else { return false }
        }
        if let raw = fields["withheld"], texts(raw, max: 10_000, maxCharacters: 128) == nil { return false }
        return true
    }

    private static func openTabsAreWellFormed(_ fields: [String: JSONValue]) -> Bool {
        guard case .array(let items)? = fields["items"], items.count <= SyncLimits.maxOpenTabs else { return false }
        for item in items {
            guard let members = object(item), case .string? = members["id"], case .string? = members["spaceId"], text(members["url"], maxBytes: SyncLimits.maxOpenTabURLBytes) != nil,
                  text(members["title"], maxBytes: SyncLimits.maxOpenTabTitleBytes) != nil, integer(members["lastActiveAt"], minimum: 0) != nil else { return false }
        }
        return true
    }

    // MARK: Writing

    /// The JSON of a message, with the number it carries. Only what the phone sends is written: the rest is the other device's business.
    public static func encode(_ message: SyncMessage, number: Int) throws -> Data {
        var members: [String: JSONValue] = ["v": .number(Double(version)), "t": .string(message.type), "n": .number(Double(number))]
        switch message {
        case .hello(let hello):
            members["device"] = deviceValue(hello.device)
            members["nonce"] = .string(SyncEncoding.base64url(hello.nonce))
            members["categories"] = .array(hello.categories.map { .string($0) })
            members["baseHash"] = hello.baseHash.map { .string($0) } ?? .null
            members["stateVersion"] = .number(Double(hello.stateVersion))
            members["appVersion"] = .string(hello.appVersion)
            members["now"] = .number(Double(hello.now))
            if let hosts = hello.hosts { members["hosts"] = .array(hosts.map { .string($0) }) }
        case .pairRequest(let device, let nonce, let proof):
            members["device"] = deviceValue(device)
            members["nonce"] = .string(SyncEncoding.base64url(nonce))
            members["proof"] = .string(SyncEncoding.base64url(proof))
        case .unpair, .bye:
            break
        case .error(let code, let fatal, let supported, let detail):
            members["code"] = .string(code.rawValue)
            members["fatal"] = .bool(fatal)
            if let supported { members["supported"] = .array(supported.map { .number(Double($0)) }) }
            if let detail { members["detail"] = .string(detail) }
        case .snapshotPart(let body), .openTabs(let body):
            // The fields of the part (or of the list) as the session built them; the envelope is the codec's and overwrites whatever the body says of it.
            guard case .object(let fields) = body else { throw SyncFailure(.internal, "the body of \(message.type) is not an object") }
            members.merge(fields) { _, new in new }
            members["v"] = .number(Double(version))
            members["t"] = .string(message.type)
            members["n"] = .number(Double(number))
        case .snapshotEnd(let entityCount, let digest):
            members["entityCount"] = .number(Double(entityCount))
            members["digest"] = .string(digest)
        case .result(let digest), .commit(let digest):
            members["digest"] = .string(digest)
        case .pairChallenge, .pairAccept:
            throw SyncFailure(.internal, "the phone does not write \(message.type)")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(JSONValue.object(members))
    }

    private static func deviceValue(_ device: SyncDeviceInfo) -> JSONValue {
        .object(["id": .string(device.id), "name": .string(device.name), "platform": .string(device.platform.rawValue)])
    }
}

/// The number each message of one direction carries: from 1, one more each time (§7.1). A gap, a repeat or a wrong start is `bad-sequence`, and fatal.
public struct SyncSequence: Equatable, Sendable {
    private(set) var last = 0

    public init() {}

    public mutating func accept(_ number: Int) throws {
        guard number == last + 1 else { throw SyncFailure(.badSequence, "message \(number) after \(last)") }
        last = number
    }

    public mutating func next() -> Int {
        last += 1
        return last
    }
}
