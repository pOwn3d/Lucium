import CryptoKit
import Foundation

/// The marks of the synchronisation (docs/synchronisation.md §9.2, §11.5): one mark per field, made by a hybrid logical clock the moment the device sees the
/// field change. The Swift twin of `src/main/sync/marks.ts`. A mark is `<ms on 13 digits>-<counter on 4 lower-case hexadecimal digits>-<device id>`, compared as
/// text. The clock never goes back and never falls behind a mark it has seen: `observe` is told every mark that comes in, so that what the person does next is
/// later than what the other device did before.
///
/// The book keeps, for each field of each entity, the hash of the value it last saw and the mark it gave. `update` compares the state as it is with the book: a
/// field whose hash changed gets a new mark, a field that went gets one too (a removed field has a mark), an entity that went leaves a tombstone, a list whose
/// order changed gets a new mark. What the book holds is only hashes and marks: no address, no title, nothing the person wrote.
public struct SyncClock: Equatable, Sendable {
    public var milliseconds: Int
    public var counter: Int

    public init(milliseconds: Int = 0, counter: Int = 0) {
        self.milliseconds = milliseconds
        self.counter = counter
    }

    /// The clock inside a mark, or nil for a text that is not one.
    static func parse(_ stamp: String) -> SyncClock? {
        let bytes = Array(stamp.utf8)
        guard bytes.count >= 19, bytes[13] == 0x2D, bytes[18] == 0x2D else { return nil }
        guard let ms = Int(String(decoding: bytes[0..<13], as: UTF8.self)), let counter = Int(String(decoding: bytes[14..<18], as: UTF8.self), radix: 16) else { return nil }
        return SyncClock(milliseconds: ms, counter: counter)
    }
}

public struct SyncMarkBook: Equatable, Sendable {
    public static let version = 1
    /// A deletion is kept thirty days (§11.5).
    public static let tombstoneMilliseconds = 30 * 24 * 60 * 60 * 1000

    /// What is known of one field: the hash of its value, or nil when it is gone (its mark stays: a removal is a change).
    struct FieldMark: Equatable, Sendable {
        var hash: String?
        var stamp: String
    }

    struct OrderMark: Equatable, Sendable {
        var hash: String
        var stamp: String
    }

    public let device: String
    public private(set) var clock: SyncClock
    private(set) var entities: [String: [String: [String: FieldMark]]]
    private(set) var tombstones: [String: [String: String]]
    private(set) var orders: [String: OrderMark]

    public init(device: String) {
        self.device = device
        clock = SyncClock()
        entities = [:]
        tombstones = [:]
        orders = [:]
    }

    // MARK: The clock

    private func format(_ clock: SyncClock) -> String {
        String(format: "%013ld-%04lx-", clock.milliseconds, clock.counter) + device
    }

    /// The next mark: the time of day, or one tick after the last mark made or seen when the time of day is not ahead of it.
    public mutating func next(now: Int) -> String {
        if now > clock.milliseconds {
            clock = SyncClock(milliseconds: now, counter: 0)
        } else if clock.counter >= 0xFFFF {
            clock = SyncClock(milliseconds: clock.milliseconds + 1, counter: 0)
        } else {
            clock.counter += 1
        }
        return format(clock)
    }

    /// A mark that came in: the clock is never behind it.
    public mutating func observe(_ stamp: String) {
        guard let seen = SyncClock.parse(stamp) else { return }
        if seen.milliseconds > clock.milliseconds || (seen.milliseconds == clock.milliseconds && seen.counter > clock.counter) { clock = seen }
    }

    // MARK: Following the state

    private static func hash(of value: JSONValue) -> String {
        // The canonical text of a value that holds no number the two languages would write differently; a value that has none cannot be written, and is hashed as null.
        let text = SyncCanonical.text(value) ?? "null"
        return SHA256.hash(data: Data(text.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// Brings the book up to the state: a mark for what changed since it last looked, a tombstone for what went. Cheap when nothing changed.
    public mutating func update(_ view: SyncTrackedView, now: Int) {
        for (kind, byID) in view.entities {
            var known = entities[kind] ?? [:]
            for (id, fields) in byID {
                var record = known[id] ?? [:]
                tombstones[kind]?[id] = nil
                for (name, value) in fields {
                    let hash = Self.hash(of: value)
                    if record[name]?.hash != hash { record[name] = FieldMark(hash: hash, stamp: next(now: now)) }
                }
                for (name, mark) in record where mark.hash != nil && fields[name] == nil { record[name] = FieldMark(hash: nil, stamp: next(now: now)) }
                known[id] = record
            }
            for id in known.keys.sorted(by: { SyncCanonical.compare($0, $1) < 0 }) where byID[id] == nil {
                // The entity went: a tombstone, and nothing else of it is kept.
                if known[id]?.values.contains(where: { $0.hash != nil }) == true { tombstones[kind, default: [:]][id] = next(now: now) }
                known[id] = nil
            }
            // A kind with nothing in it is not kept, so that the book is the same before and after a trip through its file.
            entities[kind] = known.isEmpty ? nil : known
        }
        for kind in entities.keys where view.entities[kind] == nil { entities[kind] = nil }
        for (key, ids) in view.order.sorted(by: { SyncCanonical.compare($0.key, $1.key) < 0 }) {
            let hash = Self.hash(of: .array(ids.map { .string($0) }))
            if orders[key]?.hash != hash { orders[key] = OrderMark(hash: hash, stamp: next(now: now)) }
        }
        for key in orders.keys where view.order[key] == nil { orders[key] = nil }
        purge(now: now)
    }

    /// The tombstones older than thirty days are forgotten (§11.5): a device away for longer than that may see what it deleted come back.
    public mutating func purge(now: Int) {
        let limit = now - Self.tombstoneMilliseconds
        for (kind, byID) in tombstones {
            var kept = byID
            for (id, stamp) in byID where (SyncClock.parse(stamp)?.milliseconds ?? 0) < limit { kept[id] = nil }
            tombstones[kind] = kept.isEmpty ? nil : kept
        }
    }

    // MARK: What it says

    /// The marks of an entity, one per field it has or has lost.
    public func stamps(of kind: String, id: String) -> [String: String] {
        (entities[kind]?[id] ?? [:]).mapValues(\.stamp)
    }

    public func tombstonesOfAllKinds() -> [String: [String: String]] { tombstones }

    public func orderStamp(of key: String) -> String { orders[key]?.stamp ?? SyncStamp.zero }

    /// The state now holds what the merge decided: the book takes the marks of the merged snapshot, so that the next `update` sees nothing new in what came from
    /// the other device (it would otherwise mark it as this device's change, and send it back). Fields the book does not follow (seeds, local) are left out.
    public mutating func adopt(_ merged: SyncSnapshot) {
        var adopted: [String: [String: [String: FieldMark]]] = [:]
        for (kind, byID) in merged.entities {
            for (id, entity) in byID {
                var record: [String: FieldMark] = [:]
                for (name, stamp) in entity.stamps where SyncFieldClasses.follows(kind: kind, field: name) {
                    observe(stamp)
                    record[name] = FieldMark(hash: entity.fields[name].map(Self.hash(of:)), stamp: stamp)
                }
                for (name, value) in entity.fields where SyncFieldClasses.follows(kind: kind, field: name) && record[name] == nil {
                    record[name] = FieldMark(hash: Self.hash(of: value), stamp: SyncStamp.zero)
                }
                adopted[kind, default: [:]][id] = record
            }
        }
        entities = adopted
        tombstones = merged.tombstones
        for byID in merged.tombstones.values { for stamp in byID.values { observe(stamp) } }
        orders = merged.order.reduce(into: [:]) { result, list in
            result[list.key] = OrderMark(hash: Self.hash(of: .array(list.value.map { .string($0) })), stamp: merged.orderStamps[list.key] ?? SyncStamp.zero)
        }
        for stamp in merged.orderStamps.values { observe(stamp) }
    }

    // MARK: The file

    /// `sync-marks.json`, next to the state file and never inside it: hashes and marks, no address and no title.
    func json() -> JSONValue {
        var entityObject: [String: JSONValue] = [:]
        for (kind, byID) in entities {
            var kindObject: [String: JSONValue] = [:]
            for (id, record) in byID {
                kindObject[id] = .object(record.mapValues { mark in
                    .object(["hash": mark.hash.map { .string($0) } ?? .null, "stamp": .string(mark.stamp)])
                })
            }
            entityObject[kind] = .object(kindObject)
        }
        return .object([
            "version": .number(Double(Self.version)),
            "clock": .object(["ms": .number(Double(clock.milliseconds)), "counter": .number(Double(clock.counter))]),
            "entities": .object(entityObject),
            "tombstones": .object(tombstones.mapValues { .object($0.mapValues { .string($0) }) }),
            "orders": .object(orders.mapValues { .object(["hash": .string($0.hash), "stamp": .string($0.stamp)]) }),
        ])
    }

    /// A book from a file's JSON, or nil when it is not one of this version's. A file is hostile: every part is checked for its kind, and every mark for its form.
    static func read(_ value: JSONValue, device: String) -> SyncMarkBook? {
        guard case .object(let root) = value, case .number(let version)? = root["version"], version == Double(Self.version), case .object(let clock)? = root["clock"],
              case .number(let ms)? = clock["ms"], case .number(let counter)? = clock["counter"], ms.isFinite, counter.isFinite, ms >= 0, counter >= 0, ms < 1e15, counter <= 0xFFFF,
              case .object(let entityObject)? = root["entities"], case .object(let tombstoneObject)? = root["tombstones"], case .object(let orderObject)? = root["orders"] else { return nil }
        var book = SyncMarkBook(device: device)
        book.clock = SyncClock(milliseconds: Int(ms), counter: Int(counter))
        for (kind, rawKind) in entityObject {
            guard case .object(let byID) = rawKind else { return nil }
            for (id, rawEntity) in byID {
                guard case .object(let fields) = rawEntity else { return nil }
                var record: [String: FieldMark] = [:]
                for (name, rawMark) in fields {
                    guard case .object(let mark) = rawMark, case .string(let stamp)? = mark["stamp"], SyncStamp.isValid(stamp) else { return nil }
                    switch mark["hash"] {
                    case .null?: record[name] = FieldMark(hash: nil, stamp: stamp)
                    case .string(let hash)?: record[name] = FieldMark(hash: hash, stamp: stamp)
                    default: return nil
                    }
                }
                book.entities[kind, default: [:]][id] = record
            }
        }
        for (kind, rawKind) in tombstoneObject {
            guard case .object(let byID) = rawKind else { return nil }
            for (id, rawStamp) in byID {
                guard case .string(let stamp) = rawStamp, SyncStamp.isValid(stamp) else { return nil }
                book.tombstones[kind, default: [:]][id] = stamp
            }
        }
        for (key, rawOrder) in orderObject {
            guard case .object(let mark) = rawOrder, case .string(let hash)? = mark["hash"], case .string(let stamp)? = mark["stamp"], SyncStamp.isValid(stamp) else { return nil }
            book.orders[key] = OrderMark(hash: hash, stamp: stamp)
        }
        return book
    }
}

/// The file of the marks. A file that cannot be read is set aside by the caller and the book starts empty: every field then takes a mark of now, which is only
/// a loss of the order of old changes, never of data.
public struct SyncMarksFile: Sendable {
    public static let fileName = "sync-marks.json"
    static let maxBytes = 32 * 1024 * 1024

    public enum Load: Equatable, Sendable {
        case none
        case loaded(SyncMarkBook)
        case unreadable(String)
    }

    public let url: URL

    public init(url: URL) { self.url = url }

    public func load(device: String) -> Load {
        guard FileManager.default.fileExists(atPath: url.path) else { return .none }
        do {
            let data = try SyncFiles.readBounded(url, maxBytes: Self.maxBytes)
            guard let book = SyncMarkBook.read(try JSONDecoder().decode(JSONValue.self, from: data), device: device) else { return .unreadable("not a book of marks of this version") }
            return .loaded(book)
        } catch {
            print("[sync] \(url.lastPathComponent) cannot be read, the marks start again: \(error)")
            return .unreadable(String(describing: error))
        }
    }

    public func save(_ book: SyncMarkBook) throws {
        try SyncFiles.writeAtomically(try JSONEncoder().encode(book.json()), to: url)
    }
}
