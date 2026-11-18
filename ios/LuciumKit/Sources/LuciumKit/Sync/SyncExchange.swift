import Foundation

/// What the body of a session needs of the phone (docs/synchronisation.md §8): its state, what is locked, the one place the state is written, and where the result
/// of a session is told. The application's model implements it on the main actor; the tests give a state in memory.
public protocol SyncExchangeHost: Sendable {
    /// The state as it is now: the session freezes it at the start and never reads it again until it writes.
    func currentState() async -> BrowserState
    /// The spaces that are locked and not open: a session sets them aside (§18 [Q4]).
    func lockedSpaceIDs() async -> Set<String>
    func isAppLocked() async -> Bool
    /// This phone has never been changed by its person (§11.8 [Q3]): it sends an empty snapshot and adopts the state of the Mac.
    func isNeverModified() async -> Bool
    /// Writes the patch into the state (`SyncApply`), and the file of the state with it. Called only when the two merged results were found equal.
    func apply(_ patch: SyncPatch) async -> SyncApply.Outcome
    /// A session went through: what it settled, refused and wrote.
    func exchanged(_ summary: SyncExchangeSummary) async
    /// "Rétablir" on a line of « Conflit réglé » (§13.4): the version that lost is written back as an ordinary change (`SyncApply.restore`). False when nothing was
    /// written (the entity or the list is no longer there, or the person changed it since).
    func restore(_ change: SyncChange) async -> Bool
}

/// What a session that went through tells the application (the journal of the conflicts, "up to date", the log).
public struct SyncExchangeSummary: Equatable, Sendable {
    public var at: Int
    public var conflicts: [SettledConflict]
    /// What the phone would not send, and what it would not take (an address that is not a web page, a private tab…), counted and logged, never fatal (§8.5).
    public var refusedSent: [SyncInbound.Refused]
    public var refusedReceived: [SyncInbound.Refused]
    /// What the patch asked and the state did not take (a value that is not one this version keeps).
    public var rejectedByApply: [String]
    public var applied: Bool
    /// This phone adopted the state of the Mac instead of adding its own (§11.8).
    public var adoptedTheMacState: Bool
    /// The spaces set aside because they are locked here or on the Mac, whose content did not go (§18).
    public var spacesSetAside: Int
    /// The Mac's open tabs, when "Open tabs" is common: kept in memory by the caller, never written (§10.4).
    public var openTabs: [SyncOpenTab]?
}

/// The part of a session after `hello` (docs/synchronisation.md §8.2 to §8.5), the phone's side. The same flow as the Mac's (`src/main/sync/session.ts`: both run the
/// same steps with their own state), written for a phone:
///
///   freeze    the book of marks is brought up to the state and a snapshot is frozen (the categories both ticked; the spaces set aside left out);
///   send      the snapshot goes in parts, then `open-tabs` if that category is common, then `snapshot.end` with its count and its digest;
///   check     what comes in is checked for its count and its digest (`truncated`), its form (`SyncSnapshot.read`), then entity by entity (`SyncInbound`);
///   merge     `SyncMerge.merge(base, local, remote, withheld)`: the same function with the same inputs on both sides;
///   result    the digests of the merged snapshots are compared; different: `divergence`, NOTHING is written on either side;
///   apply     the patch between the frozen snapshot and the merged one is written (`SyncApply`); the marks and the base follow; `commit`.
///
/// Nothing is written before the digests agree; a connection that drops before then leaves the state and the base as they were.
public struct SyncExchangeBody: SyncSessionBody {
    public let host: any SyncExchangeHost
    public let marks: SyncMarkKeeper
    public let bases: SyncBaseStore
    public let now: @Sendable () -> Int
    /// How long the phone waits for the next message of the Mac (§7.5: 60 s of silence ends the session).
    public let idleTimeout: Duration
    public let log: @Sendable (String) -> Void

    public init(host: any SyncExchangeHost, marks: SyncMarkKeeper, bases: SyncBaseStore, now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
                idleTimeout: Duration = SyncLimits.idleTimeout, log: @escaping @Sendable (String) -> Void = { print("[sync] \($0)") }) {
        self.host = host
        self.marks = marks
        self.bases = bases
        self.now = now
        self.idleTimeout = idleTimeout
        self.log = log
    }

    /// The hash of the base this phone holds for the Mac, or nil: what `hello.baseHash` carries (§8.2). Read before the session opens. A phone that was never modified
    /// says it has none: it adopts the state of the Mac, and both devices must then merge from an empty base (§11.8).
    public func baseHash(forMac id: String) async -> String? {
        if await host.isNeverModified() { return nil }
        return bases.get(peerId: id, now: now())?.hash
    }

    // MARK: The messages of the Mac

    /// The next message that is not a warning: an `error` that says it is not fatal (the clocks differ, §9.3) is passed over and the wait goes on. A fatal one is the Mac
    /// ending the session with its code; an `unpair` is the Mac saying it forgot this phone.
    private func next(_ channel: SyncChannel) async throws -> SyncMessage {
        while true {
            let message = try await channel.receive(timeout: idleTimeout)
            switch message {
            case .error(let code, let fatal, _, let detail):
                if !fatal { log("the Mac warned: \(code.rawValue)"); continue }
                throw TheMacEndedIt(failure: SyncFailure(code, detail ?? "the Mac ended the session"))
            case .unpair:
                throw TheMacEndedIt(failure: SyncFailure(.notPaired, "the Mac forgot this phone"))
            case .bye:
                throw TheMacEndedIt(failure: SyncFailure(.badMessage, "the Mac ended the session before the exchange was over"))
            default:
                return message
            }
        }
    }

    private func receiveSnapshot(_ channel: SyncChannel, takeOpenTabs: Bool) async throws -> (SyncSnapshotParts.Assembled, [SyncOpenTab]?) {
        var assembler = SyncSnapshotParts.Assembler()
        var tabs: [SyncOpenTab]?
        while true {
            switch try await next(channel) {
            case .snapshotPart(let part): try assembler.add(part)
            case .openTabs(let list): if takeOpenTabs { tabs = Self.readOpenTabs(list) }
            case .snapshotEnd(let count, let digest): return (try assembler.finish(entityCount: count, digest: digest), tabs)
            case let other: throw SyncFailure(.badMessage, "a \(other.type) is not expected in a snapshot")
            }
        }
    }

    /// The tabs a Mac announced, as far as they read (the form was checked by the codec; an address that is not a web page is left out).
    static func readOpenTabs(_ message: JSONValue) -> [SyncOpenTab] {
        guard case .object(let fields) = message, case .array(let items)? = fields["items"] else { return [] }
        return items.compactMap { item in
            guard case .object(let tab) = item, case .string(let id)? = tab["id"], case .string(let spaceId)? = tab["spaceId"], case .string(let url)? = tab["url"], case .string(let title)? = tab["title"],
                  case .number(let last)? = tab["lastActiveAt"], let at = Int(exactly: last), SyncInbound.isWebAddress(.string(url)) else { return nil }
            return SyncOpenTab(id: id, spaceId: spaceId, url: url, title: title, lastActiveAt: at)
        }
    }

    // MARK: The session

    /// The Mac said it: an `error`, an `unpair`, an early `bye`. Its code is the session's, and nothing is sent back.
    private struct TheMacEndedIt: Error { let failure: SyncFailure }

    public func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
        do {
            return try await exchange(context, channel: channel)
        } catch let ended as TheMacEndedIt {
            throw ended.failure
        } catch let failure as SyncFailure {
            // A fault of ours (a bound, a check that failed, a result that differs) is told to the Mac. One the channel found (a frame, a number, a silence) has already
            // closed the connection: the attempt fails, and says so in the log.
            await channel.sendBestEffort(.error(code: failure.code, fatal: true, supported: nil, detail: String(failure.detail.prefix(200))), why: "the session ended on \(failure.code.rawValue)")
            throw failure
        }
    }

    private func exchange(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
        if await host.isAppLocked() { throw SyncFailure(.locked, "the application is locked") }
        let mac = context.mac.id
        let stored = bases.get(peerId: mac, now: now())
        // A phone that was never modified adopts the Mac's structure (§11.8 [Q3]). "Modified" is about what the person arranges (spaces, folders, pinned tabs,
        // favourites), so only the exchange of the structure is concerned: the settings and the archive go the ordinary way.
        let adopting = await host.isNeverModified() && context.categories.contains(.structure)
        // A base is used only when both devices hold the same one (§8.2); a phone that adopts the Mac's state has none to speak of.
        let base: SyncSnapshot? = (!adopting && stored != nil && context.local.baseHash == stored?.hash && context.remote.baseHash == stored?.hash) ? stored?.snapshot : nil

        // freeze
        let state = await host.currentState()
        let lockedHere = await host.lockedSpaceIDs()
        let locked = Set(SyncStateView.withheldSpaces(in: state, isLocked: lockedHere.contains))
        let frozen = marks.freeze(state, categories: context.categories, withheld: locked, base: base, now: now())
        // What this phone sends is what it would itself accept (the same gate as for what comes in, with the Mac's clock for the marks of the future): the two merges then
        // start from the same inputs. An entity that does not pass stays here, untouched, and is not sent; it is counted and logged.
        let sentClean = SyncInbound.clean(frozen, now: context.remote.now)
        let vetted = Self.vet(sentClean.snapshot, log: log)
        let real = vetted.snapshot
        let local = adopting ? real.withoutStructure() : real
        let refusedSent = sentClean.refused + vetted.refused
        if !refusedSent.isEmpty { log("not sent: \(refusedSent.count) entities (\(Dictionary(grouping: refusedSent, by: \.reason.rawValue).mapValues(\.count)))") }

        // send
        let parts = SyncSnapshotParts.parts(of: local, withheld: locked.sorted(by: { SyncCanonical.compare($0, $1) < 0 }))
        guard parts.count <= SyncLimits.maxParts else { throw SyncFailure(.tooLarge, "the snapshot needs more parts than the bound") }
        for part in parts { try await channel.send(.snapshotPart(.object(part))) }
        if context.categories.contains(.openTabs) {
            let tabs = SyncStateView.openTabs(of: state, isSpaceLocked: locked.contains)
            let items = tabs.map { JSONValue.object(["id": .string($0.id), "spaceId": .string($0.spaceId), "url": .string($0.url), "title": .string($0.title), "lastActiveAt": .number(Double($0.lastActiveAt))]) }
            try await channel.send(.openTabs(.object(["items": .array(items)])))
        }
        let entityCount = local.entities.values.reduce(0) { $0 + $1.count }
        try await channel.send(.snapshotEnd(entityCount: entityCount, digest: local.digest))

        // receive, check
        let (received, openTabs) = try await receiveSnapshot(channel, takeOpenTabs: context.categories.contains(.openTabs))
        let cleaned = SyncInbound.clean(received.snapshot, now: now())
        if !cleaned.refused.isEmpty { log("not taken: \(cleaned.refused.count) entities (\(Dictionary(grouping: cleaned.refused, by: \.reason.rawValue).mapValues(\.count)))") }

        // merge, compare
        let aside = locked.union(received.withheld)
        let merged = SyncMerge.merge(base: base, local: local, remote: cleaned.snapshot, withheld: aside.sorted(by: { SyncCanonical.compare($0, $1) < 0 }))
        let digest = merged.snapshot.digest
        try await channel.send(.result(digest: digest))
        guard case .result(let theirs) = try await next(channel) else { throw SyncFailure(.badMessage, "a result was expected") }
        guard theirs == digest else { throw SyncFailure(.divergence, "the two devices do not reach the same merged snapshot: nothing is written") }

        // apply
        if await host.isAppLocked() { throw SyncFailure(.locked, "the application locked before anything was written") }
        let patch = SyncPatch.build(frozen: real, merged: merged.snapshot, withheld: aside)
        var applied: SyncApply.Outcome?
        // From the write to the adoption of the merge the book does not look at the state: what the Mac wrote is not a change of the phone.
        marks.hold()
        if !patch.isEmpty { applied = await host.apply(patch) }
        do {
            try marks.adopt(merged.snapshot)
            try bases.save(peerId: mac, snapshot: SyncStateView.base(of: merged.snapshot), now: now())
        } catch {
            marks.release()
            log("the base or the marks could not be written after the state was: \(error)")
            throw SyncFailure(.internal, "the base could not be written")
        }
        try await channel.send(.commit(digest: digest))
        guard case .commit(let theirCommit) = try await next(channel), theirCommit == digest else { throw SyncFailure(.badMessage, "the commit of the Mac is not the one expected") }

        let at = now()
        let conflicts = SyncConflicts.settle(conflicts: merged.conflicts, local: local, remote: cleaned.snapshot, merged: merged.snapshot, now: at, peer: .mac)
        await host.exchanged(SyncExchangeSummary(at: at, conflicts: conflicts, refusedSent: refusedSent, refusedReceived: cleaned.refused, rejectedByApply: applied?.rejected ?? [], applied: applied?.changed ?? false,
                                                 adoptedTheMacState: adopting, spacesSetAside: aside.count, openTabs: openTabs))
        return .committed(at: at)
    }

    // MARK: Checking what this phone sends

    /// A snapshot that the Mac would read: every entity, tombstone and list that passes the form (`SyncSnapshot.read`: names in normalization form C, bounds, marks), the
    /// others left out and counted. The whole snapshot is tried first, which is the case almost always; only a failure goes entity by entity, so that one odd value in
    /// the state cannot end every session with `bad-message`.
    static func vet(_ snapshot: SyncSnapshot, log: (String) -> Void) -> (snapshot: SyncSnapshot, refused: [SyncInbound.Refused]) {
        if case .success = SyncSnapshot.read(snapshot.json) { return (snapshot, []) }
        var kept = SyncSnapshot()
        var refused: [SyncInbound.Refused] = []
        for (kind, byID) in snapshot.entities {
            for (id, entity) in byID {
                var one = SyncSnapshot()
                one.entities[kind] = [id: entity]
                if case .success = SyncSnapshot.read(one.json) { kept.entities[kind, default: [:]][id] = entity } else { refused.append(SyncInbound.Refused(kind: kind, id: id, reason: .invalidValue)) }
            }
        }
        for (kind, byID) in snapshot.tombstones {
            for (id, stamp) in byID {
                var one = SyncSnapshot()
                one.tombstones[kind] = [id: stamp]
                if case .success = SyncSnapshot.read(one.json) { kept.tombstones[kind, default: [:]][id] = stamp } else { log("a tombstone that the Mac would not read was left out: \(kind)") }
            }
        }
        for (key, ids) in snapshot.order {
            var one = SyncSnapshot()
            one.order[key] = ids
            one.orderStamps[key] = snapshot.orderStamps[key] ?? SyncStamp.zero
            if case .success = SyncSnapshot.read(one.json) {
                kept.order[key] = ids
                kept.orderStamps[key] = snapshot.orderStamps[key] ?? SyncStamp.zero
            } else {
                log("a list that the Mac would not read was left out: \(key)")
            }
        }
        refused.sort { a, b in
            let kind = SyncCanonical.compare(a.kind, b.kind)
            return kind != 0 ? kind < 0 : SyncCanonical.compare(a.id, b.id) < 0
        }
        return (kept, refused)
    }
}
