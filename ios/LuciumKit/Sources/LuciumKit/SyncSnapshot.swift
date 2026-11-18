import Foundation

/// The Swift twin of `src/shared/sync-snapshot.ts`: the snapshot a device freezes at the start of a synchronisation session, the marks it carries
/// (docs/synchronisation.md §8.3 and §9.2) and the door a received one goes through. Checked by the same vectors as the Mac
/// (`ios/Contracts/sync-snapshot-vectors.json`, `sync-message-vectors.json`): change one side and the other fails.
///
/// The content of an entity (which fields a kind may carry, which settings may travel, which address is safe) is another gate, applied to the entities that
/// come in: this file reads the *form* only.

/// One entity: its fields (the synchronised ones and every field this version does not know) and one mark per field, removed fields included.
public struct SyncEntity: Equatable, Sendable {
    public var fields: [String: JSONValue]
    public var stamps: [String: String]

    public init(fields: [String: JSONValue] = [:], stamps: [String: String] = [:]) {
        self.fields = fields
        self.stamps = stamps
    }
}

public struct SyncSnapshot: Equatable, Sendable {
    /// kind → id → entity. A kind this version does not know goes through.
    public var entities: [String: [String: SyncEntity]]
    /// kind → id → the mark of the deletion.
    public var tombstones: [String: [String: String]]
    /// list key → the ids in display order (`spaces`, `folders:<space>:<parent or ->`, `tabs:<space>:<folder or ->`, `favorites:<profile>`).
    public var order: [String: [String]]
    /// list key → the mark of the last reorder.
    public var orderStamps: [String: String]

    public init(entities: [String: [String: SyncEntity]] = [:], tombstones: [String: [String: String]] = [:], order: [String: [String]] = [:], orderStamps: [String: String] = [:]) {
        self.entities = entities
        self.tombstones = tombstones
        self.order = order
        self.orderStamps = orderStamps
    }

    public static let empty = SyncSnapshot()

    /// The snapshot as the JSON value that is sent and hashed (§8.3, §8.4).
    public var json: JSONValue {
        var entityObject: [String: JSONValue] = [:]
        for (kind, byID) in entities {
            var kindObject: [String: JSONValue] = [:]
            for (id, entity) in byID {
                kindObject[id] = .object(["fields": .object(entity.fields), "stamps": .object(entity.stamps.mapValues { .string($0) })])
            }
            entityObject[kind] = .object(kindObject)
        }
        return .object([
            "entities": .object(entityObject),
            "tombstones": .object(tombstones.mapValues { .object($0.mapValues { .string($0) }) }),
            "order": .object(order.mapValues { .array($0.map { .string($0) }) }),
            "orderStamps": .object(orderStamps.mapValues { .string($0) }),
        ])
    }

    /// The digest both devices compare (§8.4): the SHA-256 of the canonical form.
    public var digest: String { SyncCanonical.digest(of: json) ?? "" }
}

/// The marks of §9.2: `<ms on 13 digits>-<counter on 4 lower-case hexadecimal digits>-<device id>`, or `"0"`, the mark of a field that was never stamped.
public enum SyncStamp {
    public static let zero = "0"

    public static func isValid(_ value: String) -> Bool {
        if value == zero { return true }
        let bytes = Array(value.utf8)
        // 13 digits, "-", 4 hexadecimal digits, "-", then 1 to 64 characters of [A-Za-z0-9_-].
        guard bytes.count >= 13 + 1 + 4 + 1 + 1, bytes.count <= 13 + 1 + 4 + 1 + 64 else { return false }
        for index in 0..<13 where !(0x30...0x39).contains(bytes[index]) { return false }
        guard bytes[13] == 0x2D, bytes[18] == 0x2D else { return false }
        for index in 14..<18 where !((0x30...0x39).contains(bytes[index]) || (0x61...0x66).contains(bytes[index])) { return false }
        for byte in bytes[19...] where !((0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || byte == 0x5F || byte == 0x2D) { return false }
        return true
    }

    /// Marks are compared as text, byte for byte (§9.2): they are ASCII, so this is the order of the UTF-16 code units. `"0"` is below every other mark.
    public static func compare(_ a: String, _ b: String) -> Int { SyncCanonical.compare(a, b) }

    public static func max(_ stamps: String...) -> String { max(of: stamps) }

    public static func max(of stamps: [String]) -> String {
        stamps.reduce(zero) { compare($0, $1) >= 0 ? $0 : $1 }
    }

    public static func min(of stamps: [String]) -> String {
        guard let first = stamps.first else { return zero }
        return stamps.dropFirst().reduce(first) { compare($0, $1) <= 0 ? $0 : $1 }
    }
}

public struct SyncSnapshotProblem: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
    init(_ message: String) { self.message = message }
}

public extension SyncSnapshot {
    /// The names a JavaScript object already answers to (`name in Object.prototype`, and `prototype`): the Mac refuses a kind, an id, a list name or a list id that is one
    /// (a part that names `"kind": "__proto__"` would write the next entity into the prototype of every object of its process). A dictionary has no such thing, so this
    /// side reads them; but a phone that sent one would end every session with `bad-message`, so it leaves its own entity, tombstone or list out (`SyncExchangeBody`).
    static let namesOfAnObject: Set<String> = ["prototype", "constructor", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "hasOwnProperty",
                                               "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf"]

    /// The bounds of §7.5 that apply to the form (the sizes of the frames are the message layer's).
    enum Limits {
        public static let maxEntities = 100_000
        public static let maxIDChars = 128
        public static let maxKindChars = 64
        public static let maxFieldNameChars = 128
        public static let maxListKeyChars = 400
        public static let maxListLength = 100_000
        public static let maxJSONDepth = 32
        public static let maxStringChars = 65_536
    }

    /// Reads a snapshot from what was received (or read from a file): the form of §8.3 or a reason. A member the form does not name is left out (a newer
    /// version may add one: §7.1). `-0` is read as `0`. Refused, as on the Mac: an entity that is not `{fields, stamps}` or whose marks are not in the form of
    /// §9.2; a name that is empty, too long, `__proto__`, made of control characters, or **not in normalization form C** (two keys that differ only by their
    /// normalization are one key for a Swift dictionary and two for JavaScript's: refusing them keeps the two devices on the same entities); a `__proto__`
    /// key at any depth; a depth over 32; a number the two languages do not write alike; more than 100 000 entities.
    static func read(_ input: JSONValue) -> Result<SyncSnapshot, SyncSnapshotProblem> {
        guard case .object(let root) = input else { return .failure(.init("the snapshot is not an object")) }
        var snapshot = SyncSnapshot()
        var count = 0
        var tombstoneCount = 0

        guard case .object(let entities) = root["entities"] ?? .object([:]) else { return .failure(.init("entities: not an object")) }
        for (kind, raw) in entities {
            guard isKeyName(kind, Limits.maxKindChars) else { return .failure(.init("entities: a kind with a bad name")) }
            guard case .object(let byID) = raw else { return .failure(.init("entities.\(kind): not an object")) }
            var into: [String: SyncEntity] = [:]
            for (id, rawEntity) in byID {
                guard isKeyName(id, Limits.maxIDChars) else { return .failure(.init("entities.\(kind): an id with a bad name")) }
                count += 1
                if count > Limits.maxEntities { return .failure(.init("too many entities")) }
                guard case .object(let members) = rawEntity else { return .failure(.init("entities.\(kind).\(id): not an object")) }
                guard case .object(let fields)? = members["fields"], case .object(let stamps)? = members["stamps"] else {
                    return .failure(.init("entities.\(kind).\(id): fields and stamps must be objects"))
                }
                var entity = SyncEntity()
                for (name, value) in fields {
                    guard isKeyName(name, Limits.maxFieldNameChars) else { return .failure(.init("entities.\(kind).\(id): a field with a bad name")) }
                    if let problem = jsonProblem(value, depth: 1, path: "entities.\(kind).\(id).\(name)") { return .failure(.init(problem)) }
                    entity.fields[name] = withoutNegativeZero(value)
                }
                for (name, mark) in stamps {
                    guard isKeyName(name, Limits.maxFieldNameChars) else { return .failure(.init("entities.\(kind).\(id): a mark with a bad name")) }
                    guard case .string(let text) = mark, SyncStamp.isValid(text) else {
                        return .failure(.init("entities.\(kind).\(id).\(name): a mark in a form that is not the specification's"))
                    }
                    entity.stamps[name] = text
                }
                into[id] = entity
            }
            if !into.isEmpty { snapshot.entities[kind] = into }
        }

        guard case .object(let tombstones) = root["tombstones"] ?? .object([:]) else { return .failure(.init("tombstones: not an object")) }
        for (kind, raw) in tombstones {
            guard isKeyName(kind, Limits.maxKindChars) else { return .failure(.init("tombstones: a kind with a bad name")) }
            guard case .object(let byID) = raw else { return .failure(.init("tombstones.\(kind): not an object")) }
            var into: [String: String] = [:]
            for (id, mark) in byID {
                guard isKeyName(id, Limits.maxIDChars) else { return .failure(.init("tombstones.\(kind): an id with a bad name")) }
                guard case .string(let text) = mark, SyncStamp.isValid(text) else {
                    return .failure(.init("tombstones.\(kind).\(id): a mark in a form that is not the specification's"))
                }
                tombstoneCount += 1
                if tombstoneCount > Limits.maxEntities { return .failure(.init("too many tombstones")) }
                into[id] = text
            }
            if !into.isEmpty { snapshot.tombstones[kind] = into }
        }

        guard case .object(let order) = root["order"] ?? .object([:]) else { return .failure(.init("order: not an object")) }
        for (key, raw) in order {
            guard isKeyName(key, Limits.maxListKeyChars) else { return .failure(.init("order: a list with a bad key")) }
            guard case .array(let ids) = raw, ids.count <= Limits.maxListLength else { return .failure(.init("order.\(key): not a list, or too long")) }
            var list: [String] = []
            for id in ids {
                guard case .string(let text) = id, isKeyName(text, Limits.maxIDChars) else { return .failure(.init("order.\(key): an id with a bad name")) }
                list.append(text)
            }
            snapshot.order[key] = list
        }

        guard case .object(let orderStamps) = root["orderStamps"] ?? .object([:]) else { return .failure(.init("orderStamps: not an object")) }
        for (key, mark) in orderStamps {
            guard isKeyName(key, Limits.maxListKeyChars) else { return .failure(.init("orderStamps: a list with a bad key")) }
            guard case .string(let text) = mark, SyncStamp.isValid(text) else {
                return .failure(.init("orderStamps.\(key): a mark in a form that is not the specification's"))
            }
            snapshot.orderStamps[key] = text
        }
        return .success(snapshot)
    }

    /// A name used as a key must be neither empty nor too long, nor the one JavaScript reads as the prototype, nor hold a control character, and it
    /// must be in normalization form C.
    private static func isKeyName(_ key: String, _ maximum: Int) -> Bool {
        let length = key.utf16.count
        guard length >= 1, length <= maximum, !SyncCanonical.identical(key, "__proto__") else { return false }
        for scalar in key.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7F { return false }
        return isNormalized(key)
    }

    private static func isNormalized(_ key: String) -> Bool {
        key.unicodeScalars.elementsEqual(key.precomposedStringWithCanonicalMapping.unicodeScalars)
    }

    private static func jsonProblem(_ value: JSONValue, depth: Int, path: String) -> String? {
        if depth > Limits.maxJSONDepth { return "\(path): too deep" }
        switch value {
        case .null, .bool: return nil
        case .number(let number):
            if !number.isFinite { return "\(path): a number that is not finite" }
            // §7.1: no exponent in the text of a number, so that Swift and JavaScript write the same digits.
            if abs(number) >= 1e21 || (number != 0 && abs(number) < 1e-6) { return "\(path): a number out of the range both languages write alike" }
            return nil
        case .string(let text): return text.utf16.count > Limits.maxStringChars ? "\(path): a string that is too long" : nil
        case .array(let items):
            for (index, item) in items.enumerated() {
                if let problem = jsonProblem(item, depth: depth + 1, path: "\(path)[\(index)]") { return problem }
            }
            return nil
        case .object(let members):
            for (key, member) in members {
                if SyncCanonical.identical(key, "__proto__") { return "\(path): a __proto__ key" }
                if !isNormalized(key) { return "\(path): a key that is not in normalization form C" }
                if let problem = jsonProblem(member, depth: depth + 1, path: "\(path).\(key)") { return problem }
            }
            return nil
        }
    }

    private static func withoutNegativeZero(_ value: JSONValue) -> JSONValue {
        switch value {
        case .number(let number): return .number(number == 0 ? 0 : number)
        case .array(let items): return .array(items.map(withoutNegativeZero))
        case .object(let members): return .object(members.mapValues(withoutNegativeZero))
        default: return value
        }
    }
}
