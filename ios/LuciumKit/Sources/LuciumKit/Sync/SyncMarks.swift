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

/// What a session set aside, as `SyncMarkBook.adopt` is told: whether an entity, or a list, belongs to a space that was not exchanged. The twin of `Aside` in `src/main/sync/marks.ts`.
public struct SyncAside: Sendable {
    public let entity: @Sendable (_ kind: String, _ id: String) -> Bool
    public let list: @Sendable (_ key: String) -> Bool

    public static let nothing = SyncAside(entity: { _, _ in false }, list: { _ in false })

    /// The entities of the spaces that were set aside (the space itself, and what holds its identifier as `spaceId`), and the lists that order what is in one
    /// (`folders:<space>:<parent>` and `tabs:<space>:<folder>`).
    public static func of(_ view: SyncTrackedView, spaces: Set<String>) -> SyncAside {
        if spaces.isEmpty { return .nothing }
        return SyncAside(
            entity: { kind, id in
                if kind == "space" { return spaces.contains(id) }
                if case .string(let spaceId)? = view.entities[kind]?[id]?["spaceId"] { return spaces.contains(spaceId) }
                return false
            },
            list: { key in
                let parts = key.split(separator: ":", omittingEmptySubsequences: false)
                return parts.count >= 2 && (parts[0] == "folders" || parts[0] == "tabs") && spaces.contains(String(parts[1]))
            })
    }
}

public struct SyncMarkBook: Equatable, Sendable {
    /// 2: the book also holds the ids of the Today tabs admitted to the shared set (§27.3). A book of version 1 is read as one with none admitted; an application that only knows
    /// version 1 starts its book again from a file of version 2, which is a base lost for the marks and never a loss of data (§11.8).
    public static let version = 2
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
    /// The Today tabs of the shared set (§27.3): the admission is sticky, so it is kept here, by device, and not recomputed from the state.
    public private(set) var admitted: Set<String>

    public init(device: String) {
        self.device = device
        clock = SyncClock()
        entities = [:]
        tombstones = [:]
        orders = [:]
        admitted = []
    }

    // MARK: The clock

    private func format(_ clock: SyncClock) -> String {
        String(format: "%013ld-%04lx-", clock.milliseconds, clock.counter) + device
    }

    /// The largest time thirteen digits hold: a mark with more digits is not a mark (§9.2).
    static let maxMilliseconds = 9_999_999_999_999
    /// A mark more than seven days ahead of the time of day is refused by every other device (§9.3).
    static let futureMilliseconds = 604_800_000

    /// The kind a list key orders (`spaces`, `folders:<space>:<parent>`, `tabs:<space>:<folder>`, `favorites:<profile>`), or nil for a key of no kind this version knows.
    static func listKind(of key: String) -> String? {
        switch key.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) {
        case "spaces": "space"
        case "folders": "folder"
        case "tabs": "tab"
        case "favorites": "favorite"
        case "today": SyncToday.kind
        default: nil
        }
    }

    /// The next mark: the time of day, or one tick after the last mark made or seen when the time of day is not ahead of it. A clock more than a week ahead of the time of day,
    /// or at the end of what thirteen digits hold, was wrong (the time of day was put right since, or the file was spoilt): every other device refuses marks that far ahead, so
    /// staying on them would shut this device out of the synchronisation for ever. It starts over from the time of day (review n° 18).
    public mutating func next(now: Int) -> String {
        if clock.milliseconds > now + Self.futureMilliseconds || clock.milliseconds >= Self.maxMilliseconds { clock = SyncClock() }
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
        // A mark more than a week ahead of the time of day was made while the clock was wrong (review n° 18): no other device accepts it, so the thing it marks would never leave
        // this one. It is marked again, as a change of now.
        let limit = now + Self.futureMilliseconds
        func tooFar(_ stamp: String) -> Bool { (SyncClock.parse(stamp)?.milliseconds ?? 0) > limit }
        for (kind, byID) in view.entities {
            var known = entities[kind] ?? [:]
            for (id, fields) in byID {
                var record = known[id] ?? [:]
                tombstones[kind]?[id] = nil
                for (name, value) in fields {
                    let hash = Self.hash(of: value)
                    if record[name]?.hash != hash || tooFar(record[name]?.stamp ?? SyncStamp.zero) { record[name] = FieldMark(hash: hash, stamp: next(now: now)) }
                }
                for (name, mark) in record where fields[name] == nil && (mark.hash != nil || tooFar(mark.stamp)) { record[name] = FieldMark(hash: nil, stamp: next(now: now)) }
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
            if orders[key]?.hash != hash || tooFar(orders[key]?.stamp ?? SyncStamp.zero) { orders[key] = OrderMark(hash: hash, stamp: next(now: now)) }
        }
        for key in orders.keys where view.order[key] == nil { orders[key] = nil }
        for (kind, byID) in tombstones {
            var remade = byID
            for (id, stamp) in byID.sorted(by: { SyncCanonical.compare($0.key, $1.key) < 0 }) where tooFar(stamp) { remade[id] = next(now: now) }
            tombstones[kind] = remade
        }
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
    ///
    /// What the session did not exchange (a category that was not ticked on both devices) is not in the merged snapshot, and is not forgotten with it: `exchanged` says which kinds
    /// the session carried, and the marks, tombstones and lists of the others stay as they were, or their fields would take a mark of the moment at the next look and their
    /// deletions could come back (review n° 17).
    ///
    /// Nor is what the session set aside (the spaces that are locked: nothing of them was sent or taken): `aside` says which entities and lists belong to such a space, and their
    /// marks stay too, or the changes the other device made meanwhile would win over the ones made here once the space opens, or the reverse.
    public mutating func adopt(_ merged: SyncSnapshot, exchanged: (String) -> Bool = { _ in true }, aside: SyncAside = .nothing) {
        var adopted: [String: [String: [String: FieldMark]]] = [:]
        for (kind, byID) in entities where !exchanged(kind) { adopted[kind] = byID }
        for (kind, byID) in entities where exchanged(kind) {
            for (id, record) in byID where aside.entity(kind, id) && merged.entities[kind]?[id] == nil { adopted[kind, default: [:]][id] = record }
        }
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
        var kept = merged.tombstones
        for (kind, byID) in tombstones where !exchanged(kind) { kept[kind] = byID }
        tombstones = kept
        for byID in merged.tombstones.values { for stamp in byID.values { observe(stamp) } }
        var lists: [String: OrderMark] = [:]
        for (key, order) in orders {
            if let kind = Self.listKind(of: key), !exchanged(kind) { lists[key] = order } else if aside.list(key), merged.order[key] == nil { lists[key] = order }
        }
        for (key, ids) in merged.order {
            lists[key] = OrderMark(hash: Self.hash(of: .array(ids.map { .string($0) })), stamp: merged.orderStamps[key] ?? SyncStamp.zero)
        }
        orders = lists
        for stamp in merged.orderStamps.values { observe(stamp) }
        // A Today tab that came from the other device is in the shared set from now on: without it the next look would see it as absent from the view and mark it deleted (§27.3).
        if exchanged(SyncToday.kind) { admitted.formUnion(merged.entities[SyncToday.kind]?.keys.map { $0 } ?? []) }
    }

    /// The shared set of Today tabs, as `SyncToday.admit` gave it at the end of a freeze.
    public mutating func admit(_ ids: Set<String>) { admitted = ids }

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
            "admitted": .array(admitted.sorted { SyncCanonical.compare($0, $1) < 0 }.map { .string($0) }),
        ])
    }

    /// A book from a file's JSON, or nil when it is not one of this version's. A file is hostile: every part is checked for its kind, and every mark for its form.
    static func read(_ value: JSONValue, device: String) -> SyncMarkBook? {
        guard case .object(let root) = value, case .number(let version)? = root["version"], version == 1 || version == Double(Self.version), case .object(let clock)? = root["clock"],
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
        switch root["admitted"] {
        case nil: if version != 1 { return nil }  // only a book of version 1 has no list of admitted Today tabs
        case .array(let ids)?:
            for id in ids {
                guard case .string(let text) = id, (1...128).contains(text.utf16.count) else { return nil }
                book.admitted.insert(text)
            }
        default: return nil
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
