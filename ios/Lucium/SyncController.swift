import Foundation
import LuciumKit
import Observation
import Security
import UIKit

/// The synchronisation with the Mac, as the application lives it (docs/synchronisation.md §8, §12, §13): the settings, the state the page shows, a pairing
/// and a session. The rules are in `LuciumKit` (`Sync*`, proved there); this is the part that keeps the settings file, holds the identity, opens the
/// connection and tells the screen.
///
/// Off by default, and while it is off nothing runs: no identity is made, no connection is opened, nothing is asked of the system. Turning it on makes
/// the identity (the first time), and from then on a session starts only when the person asks for one, when Lucium is opened or comes back to the front, and
/// the rules of `SyncScheduler` allow it (not while the application is locked, not twice in 15 seconds, never two at once).
@MainActor @Observable
final class SyncController {
    /// Where a pairing is, for the sheet that shows it.
    enum PairingStep: Equatable {
        case idle
        /// Looking for the Mac at the addresses of the code.
        case connecting
        /// The request is sent: the person has to say yes on the Mac (it waits 60 seconds).
        case waitingForMac
        /// The Mac proved it holds the secret and nothing is kept yet: the person compares the code with the one on the Mac and says yes or no (§4.6).
        case comparing(SyncPairingProposal)
    }

    /// Why a pairing did not happen.
    enum PairingFailure: Error, Equatable {
        /// The Mac or the code said no, in the words of the protocol (`invalid-code`, `pairing-used`, `fingerprint-mismatch`…).
        case code(SyncErrorCode)
        case reach(SyncReachFailure)
        /// This phone could not make its identity (the keychain refused).
        case identity
        /// The person was shown the code and did not confirm it in time: nothing was kept.
        case notConfirmed
        case cancelled
    }

    private(set) var settings: SyncSettings
    private(set) var status: SyncStatus
    private(set) var pairingStep: PairingStep = .idle
    /// The settings file could not be read: the synchronisation stays off until the person turns it on again, which writes a new one.
    private(set) var settingsUnreadable = false
    /// The conflicts the sessions settled, kept 30 days for « Conflit réglé » (§11.7.3). Empty when no exchange is wired (a model with none).
    private(set) var conflictJournal: [SettledConflict] = []
    /// The Mac's open tabs, as its last session announced them: in memory only, never written (§10.4). The screen « Reprise » (card 447) reads them.
    private(set) var macOpenTabs: [SyncOpenTab] = []
    /// When the session that brought `macOpenTabs` ended (milliseconds). Nil while there is no list: none came yet, or it was forgotten.
    private(set) var macOpenTabsAt: Int?
    /// Whether the last session carried a list at all: a Mac that has not ticked « Open tabs » sends none, which « Reprise » tells apart from an empty one.
    private(set) var lastSessionCarriedOpenTabs = false
    /// What the last session did, for the page and the log.
    private(set) var lastExchange: SyncExchangeSummary?

    @ObservationIgnored private let file: SyncSettingsFile
    @ObservationIgnored private let identityStore: any SyncIdentityStoring
    @ObservationIgnored private let makeConnector: @Sendable (SyncIdentity) -> any SyncConnecting
    @ObservationIgnored private let body: any SyncSessionBody
    /// The model's side of an exchange of the data (`SyncModelHost`). Nil in a controller with none: the session then goes as far as `hello`, with `body`.
    @ObservationIgnored private let exchangeHost: (any SyncExchangeHost)?
    /// Where the files of the exchange live: the marks, the base of the Mac, the journal of the conflicts. Next to `sync.json`, never inside `state.json`.
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private var marks: SyncMarkKeeper?
    @ObservationIgnored private var journalTooNew = false
    @ObservationIgnored private let deviceName: String
    @ObservationIgnored private let appVersion: String
    @ObservationIgnored private let now: @Sendable () -> Int
    @ObservationIgnored private let isAppLocked: @MainActor () -> Bool
    @ObservationIgnored private var sessionTask: Task<Void, Never>?
    @ObservationIgnored private var pairingTask: Task<Result<Void, PairingFailure>, Never>?
    /// The answer the person gives to « Appairer avec « … » ? Code : … » (§4.6), while the sheet waits for it.
    @ObservationIgnored private var comparison: CheckedContinuation<Bool, Never>?
    /// What happened to the last comparison: the person said no (`declined`), or was shown it and did not answer in time (`shown` only).
    @ObservationIgnored private var comparisonShown = false
    @ObservationIgnored private var comparisonDeclined = false
    @ObservationIgnored private var lastStart: ContinuousClock.Instant?
    @ObservationIgnored private let clock = ContinuousClock()

    init(file: SyncSettingsFile, identityStore: any SyncIdentityStoring = KeychainSyncIdentityStore(),
         makeConnector: @escaping @Sendable (SyncIdentity) -> any SyncConnecting = { NetworkSyncConnector(identity: $0.identity) },
         body: any SyncSessionBody = SyncNoSessionBody(), exchangeHost: (any SyncExchangeHost)? = nil, deviceName: String = SyncController.defaultDeviceName(),
         appVersion: String = SyncController.defaultAppVersion(), now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         isAppLocked: @escaping @MainActor () -> Bool = { false }) {
        self.file = file
        self.exchangeHost = exchangeHost
        directory = file.url.deletingLastPathComponent()
        self.identityStore = identityStore
        self.makeConnector = makeConnector
        self.body = body
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.now = now
        self.isAppLocked = isAppLocked
        var loaded = SyncSettings()
        var lost = false
        switch file.load() {
        case .none: break
        case .loaded(let read):
            loaded = read
            // A restore that brought the file and not the key (§3.3): there is nothing to pair with any more. The keychain is only asked when a Mac is named.
            if read.mac != nil {
                let present: Bool
                do {
                    present = try identityStore.load() != nil
                } catch {
                    print("[sync] the identity could not be looked up, the Mac is kept: \(error)")
                    present = true
                }
                lost = loaded.reconcile(identityPresent: present)
            }
        case .unreadable:
            settingsUnreadable = true
        }
        settings = loaded
        status = Self.baseStatus(loaded)
        if exchangeHost != nil, loaded.mac != nil { loadJournal() }
        if lost {
            status = .identityLost
            save()
        }
    }

    /// The synchronisation is on and a Mac is paired: what the start page says of what leaves the device depends on it (decision of the project lead, 18 November 2026).
    /// On with no Mac paired, nothing can leave.
    var isSynchronizing: Bool { settings.enabled && settings.mac != nil }

    static func baseStatus(_ settings: SyncSettings) -> SyncStatus {
        guard settings.enabled else { return .off }
        return settings.mac == nil ? .noDevice : .idle
    }

    static func defaultDeviceName() -> String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let scalars = name.unicodeScalars.prefix(SyncLimits.maxDeviceNameCharacters)
        return scalars.isEmpty ? "iPhone" : String(String.UnicodeScalarView(scalars))
    }

    static func defaultAppVersion() -> String {
        String((Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0").prefix(32))
    }

    // MARK: The switch and the categories

    /// Turns the synchronisation on or off. On: the identity is made if it does not exist, and nothing else happens (no connection until a Mac is paired and a
    /// session is asked for). Off: whatever is running stops and the status says it is off; the Mac stays paired, so that turning it back on does not ask again.
    /// Returns false when the identity could not be made, and the switch stays where it was.
    @discardableResult
    func setEnabled(_ enabled: Bool) -> Bool {
        guard enabled != settings.enabled else { return true }
        if enabled {
            do {
                _ = try identityStore.loadOrCreate()
            } catch {
                print("[sync] the identity could not be made, the synchronisation stays off: \(error)")
                return false
            }
            if settings.deviceId == nil { settings.deviceId = Self.makeDeviceId() }
            settingsUnreadable = false
        } else {
            stopEverything()
        }
        settings.enabled = enabled
        status = Self.baseStatus(settings)
        save()
        if enabled { catchUp() }
        return true
    }

    func setCategory(_ category: SyncCategory, on: Bool) {
        var categories = settings.categories.filter { $0 != category }
        if on { categories.append(category) }
        // Always in the order of the catalogue, so that the file does not depend on the order of the person's taps.
        settings.categories = SyncCategory.allCases.filter(categories.contains)
        if category == .openTabs, !on { forgetOpenTabs() }
        save()
    }

    /// The Mac's open tabs are in memory only (§10.4): they go with the lock, with the category being turned off, and with the Mac.
    func forgetOpenTabs() {
        macOpenTabs = []
        macOpenTabsAt = nil
    }

    /// What « Reprise » and the source « Sur le Mac » of the command bar show: the rows, and why there are none when there are none.
    var resumeRows: [SyncResume.Row] { settings.enabled && isOn(.openTabs) ? SyncResume.rows(from: macOpenTabs) : [] }

    var resumeAvailability: SyncResume.Availability {
        SyncResume.availability(paired: settings.enabled && settings.mac != nil, categoryOnHere: isOn(.openTabs), announcedAt: macOpenTabsAt,
                                listAnnounced: lastSessionCarriedOpenTabs, rowCount: resumeRows.count, sessionHappened: lastExchange != nil)
    }

    func isOn(_ category: SyncCategory) -> Bool { settings.categories.contains(category) }

    // MARK: Pairing

    /// Pairs with the Mac a code names. The code is a QR read by the camera or a code typed with the address (`SyncPairingCode`). On success the Mac is kept
    /// and a first session starts at once (one path for the first synchronisation and the next ones, §4.1).
    func pair(with code: SyncPairingCode) async -> Result<Void, PairingFailure> {
        guard settings.enabled, pairingTask == nil else { return .failure(.cancelled) }
        let task = Task { await performPairing(code) }
        pairingTask = task
        let result = await task.value
        pairingTask = nil
        pairingStep = .idle
        if case .success = result { requestSession(.manual) }
        return result
    }

    func cancelPairing() { pairingTask?.cancel() }

    /// The person's answer to the code (§4.6): `true` is « Appairer », `false` is « Annuler ». Nothing else keeps a Mac: no answer, a cancel of the pairing and the time
    /// given all end in a refusal.
    func answerComparison(_ agree: Bool) {
        if !agree { comparisonDeclined = true }
        resolveComparison(agree)
    }

    private func resolveComparison(_ agree: Bool) {
        guard let waiting = comparison else { return }
        comparison = nil
        waiting.resume(returning: agree)
    }

    /// Shows the proposal and waits for the person. The wait ends by itself when the task that waits is cancelled (the time given, « Annuler » of the sheet, the
    /// application locked): the pairing is then refused and nothing is kept.
    private func compare(_ proposal: SyncPairingProposal) async -> Bool {
        comparisonShown = true
        pairingStep = .comparing(proposal)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in comparison = continuation }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resolveComparison(false) }
        }
    }

    private func performPairing(_ code: SyncPairingCode) async -> Result<Void, PairingFailure> {
        let identity: SyncIdentity
        do {
            identity = try identityStore.loadOrCreate()
        } catch {
            print("[sync] the identity could not be read for a pairing: \(error)")
            return .failure(.identity)
        }
        guard let deviceId = settings.deviceId else { return .failure(.identity) }
        comparisonShown = false
        comparisonDeclined = false
        pairingStep = .connecting
        let pin: SyncPin = code.fingerprint.map { .fingerprint($0) } ?? .learn
        let reach = await SyncReacher.connect(hosts: code.hosts, port: code.port, pin: pin, using: makeConnector(identity))
        guard case .connected(let connection) = reach else {
            if case .failed(let why) = reach { return .failure(.reach(why)) }
            return .failure(.reach(.unreachable))
        }
        if Task.isCancelled {
            connection.transport.close()
            return .failure(.cancelled)
        }
        do {
            let outcome = try await SyncPairingClient.pair(code: code, connection: connection, ownFingerprint: identity.fingerprint,
                                                          device: SyncDeviceInfo(id: deviceId, name: deviceName, platform: .ios), nonce: Self.randomBytes(16),
                                                          onRequestSent: { Task { @MainActor in if self.pairingStep == .connecting { self.pairingStep = .waitingForMac } } },
                                                          confirm: { proposal in await self.compare(proposal) })
            let hosts = outcome.hosts.isEmpty ? SyncCandidates.ordered(code.hosts) : outcome.hosts
            settings.mac = SyncPairedMac(id: outcome.mac.id, name: outcome.mac.name, fingerprintHex: SyncEncoding.hex(outcome.fingerprint), port: Int(code.port), hosts: hosts, pairedAt: now())
            status = .idle
            save()
            return .success(())
        } catch let failure as SyncFailure {
            print("[sync] the pairing failed: \(failure.code.rawValue) \(failure.detail)")
            // A refusal that is ours, not the Mac's: the person said no to the code (nothing to say to them), or was shown it and did not answer in time.
            if failure.code == .pairingRefused, comparisonShown { return .failure(comparisonDeclined || Task.isCancelled ? .cancelled : .notConfirmed) }
            return .failure(.code(failure.code))
        } catch {
            print("[sync] the pairing was interrupted: \(error)")
            return .failure(.reach(.unreachable))
        }
    }

    // MARK: Sessions

    /// Asks for a session; the rules of the scheduler say whether and when it starts.
    func requestSession(_ trigger: SyncScheduler.Trigger) {
        let since = lastStart.map { clock.now - $0 }
        let decision = SyncScheduler.decide(trigger, enabled: settings.enabled, hasMac: settings.mac != nil, appLocked: isAppLocked(), running: status == .running, sinceLastStart: since)
        guard case .start(let delay) = decision else { return }
        // A request that arrives while another waits to start replaces it: they are grouped (§8.1).
        sessionTask?.cancel()
        sessionTask = Task { [weak self] in
            if delay > .zero {
                do { try await Task.sleep(for: delay) } catch { return }  // cancelled: a newer request took its place
            }
            await self?.runSession()
        }
    }

    func launched() { requestSession(.launch) }
    func becameActive() { requestSession(.foreground) }

    private func runSession() async {
        guard settings.enabled, let mac = settings.mac, let fingerprint = mac.fingerprint, let deviceId = settings.deviceId, !isAppLocked() else { return }
        let identity: SyncIdentity
        do {
            guard let found = try identityStore.load() else {
                forgetLocally(becauseKeyIsLost: true)
                return
            }
            identity = found
        } catch {
            print("[sync] the identity could not be read: \(error)")
            status = .failed(.internal)
            return
        }
        status = .running
        lastStart = clock.now
        let reach = await SyncReacher.connect(hosts: mac.hosts, port: UInt16(mac.port), pin: .fingerprint(fingerprint), using: makeConnector(identity))
        // A session that was cancelled (the application was locked, the switch turned off) is not a failure of the Mac: the state goes back to what it was.
        if Task.isCancelled {
            if case .connected(let connection) = reach { connection.transport.close() }
            status = Self.baseStatus(settings)
            return
        }
        guard case .connected(let connection) = reach else {
            if case .failed(let why) = reach { status = Self.status(for: why) }
            return
        }
        do {
            // With the model's host the session exchanges the data (§8.2 to §8.5); without one it goes as far as `hello`. The hash of the base is what the `hello` says: both
            // devices must hold the same one for the merge to start from it.
            let sessionBody: any SyncSessionBody
            var baseHash: String?
            if let exchangeHost, let keeper = markKeeper() {
                let exchange = SyncExchangeBody(host: exchangeHost, marks: keeper, bases: SyncBaseStore(directory: directory), now: now)
                sessionBody = exchange
                baseHash = await exchange.baseHash(forMac: mac.id)
            } else {
                sessionBody = body
            }
            let report = try await SyncSessionClient.run(connection: connection, peer: mac, device: SyncDeviceInfo(id: deviceId, name: deviceName, platform: .ios),
                                                         categories: settings.categories, appVersion: appVersion, supportedStateVersion: BrowserState.supportedVersion,
                                                         nonce: Self.randomBytes(16), baseHash: baseHash, now: now, body: sessionBody)
            let at = now()
            settings.mac?.lastContactAt = at
            if let hosts = report.hosts, !hosts.isEmpty { settings.mac?.hosts = hosts }
            save()
            if report.clockSkew {
                status = .clockSkew
            } else if case .committed(let when) = report.outcome {
                status = .upToDate(at: when)
            } else {
                status = .macAnswered(at: at)
            }
        } catch let failure as SyncFailure {
            print("[sync] the session stopped: \(failure.code.rawValue) \(failure.detail)")
            switch failure.code {
            case .notPaired:
                // The Mac does not know this phone any more (it was forgotten there): this side forgets it too (§12).
                forgetLocally(becauseKeyIsLost: false)
                status = .failed(.notPaired)
            case .locked: status = .waiting
            default: status = .failed(failure.code)
            }
        } catch {
            if Task.isCancelled {
                status = Self.baseStatus(settings)
                return
            }
            print("[sync] the session was interrupted: \(error)")
            status = .interrupted
        }
    }

    /// The application has just been locked: whatever is open is closed (docs/synchronisation.md §8.1: no session while it is locked, and a locked space is not sent).
    func applicationLocked() {
        forgetOpenTabs()
        sessionTask?.cancel()
        pairingTask?.cancel()
    }

    static func status(for failure: SyncReachFailure) -> SyncStatus {
        switch failure {
        case .refused: .waiting
        case .unreachable: .unreachable
        case .localNetworkDenied: .localNetworkDenied
        case .fingerprintMismatch: .failed(.fingerprintMismatch)
        }
    }

    // MARK: Forgetting

    /// "Forget this Mac": the pairing is erased here at once, and a last word (`unpair`) is sent when the Mac can be reached, so that it forgets this phone too.
    /// When it cannot, it learns it at the next session and answers `not-paired` (§12).
    func forgetMac() {
        guard let mac = settings.mac, let fingerprint = mac.fingerprint, let deviceId = settings.deviceId else { return }
        let identity: SyncIdentity?
        do {
            identity = try identityStore.load()
        } catch {
            print("[sync] the identity could not be read to tell the Mac it is forgotten: \(error)")
            identity = nil
        }
        forgetLocally(becauseKeyIsLost: false)
        guard let identity else { return }
        let connector = makeConnector(identity)
        let device = SyncDeviceInfo(id: deviceId, name: deviceName, platform: .ios)
        let version = appVersion
        let time = now
        let nonce = Self.randomBytes(16)
        Task.detached {
            guard case .connected(let connection) = await SyncReacher.connect(hosts: mac.hosts, port: UInt16(mac.port), pin: .fingerprint(fingerprint), using: connector) else {
                print("[sync] the Mac could not be told it is forgotten: it will learn it at the next session")
                return
            }
            do {
                _ = try await SyncSessionClient.run(connection: connection, peer: mac, device: device, categories: [], appVersion: version, supportedStateVersion: BrowserState.supportedVersion,
                                                    nonce: nonce, baseHash: nil, now: time, body: SyncUnpairBody())
            } catch {
                print("[sync] the Mac could not be told it is forgotten: \(error)")
            }
        }
    }

    private func forgetLocally(becauseKeyIsLost: Bool) {
        sessionTask?.cancel()
        // What was kept for this Mac goes with it (§12): its base, the marks of this phone, the journal of the conflicts and the tabs it announced. The Mac that is
        // paired again starts from an empty base, and every field takes a mark of the time it is seen.
        forgetExchangeFiles(of: settings.mac)
        settings.mac = nil
        status = becauseKeyIsLost ? .identityLost : (settings.enabled ? .noDevice : .off)
        save()
    }

    private func stopEverything() {
        forgetOpenTabs()
        sessionTask?.cancel()
        pairingTask?.cancel()
        pairingStep = .idle
    }

    // MARK: The exchange of the data

    /// The book of marks of this phone, made when it is first needed (the switch is on and the phone has its identifier). Nothing is made while the synchronisation is off.
    private func markKeeper() -> SyncMarkKeeper? {
        guard exchangeHost != nil, let deviceId = settings.deviceId else { return nil }
        if let marks { return marks }
        let keeper = SyncMarkKeeper(device: deviceId, file: SyncMarksFile(url: directory.appending(path: SyncMarksFile.fileName)))
        marks = keeper
        return keeper
    }

    /// The model wrote the state: the marks are taken now (§9.2), while the gesture is fresh. Does nothing while the switch is off.
    func stateWritten(_ state: BrowserState) {
        guard settings.enabled, let keeper = markKeeper() else { return }
        keeper.observe(state, now: now())
    }

    /// The switch was just turned on: what changed while it was off is marked now (a change cannot be dated better than the moment it is seen).
    private func catchUp() {
        guard let exchangeHost, let keeper = markKeeper() else { return }
        let time = now
        Task { keeper.observe(await exchangeHost.currentState(), now: time()) }
    }

    /// A session went through: what it settled goes to the journal, the Mac's open tabs are kept in memory, and the page says what happened.
    func exchangeDone(_ summary: SyncExchangeSummary) {
        // The summary is kept without the list: the list has one home (`macOpenTabs`), so that forgetting it forgets it everywhere.
        var kept = summary
        kept.openTabs = nil
        lastExchange = kept
        macOpenTabs = summary.openTabs ?? []
        macOpenTabsAt = summary.openTabs == nil ? nil : summary.at
        lastSessionCarriedOpenTabs = summary.openTabs != nil
        conflictJournal = SyncConflicts.add(summary.conflicts, to: conflictJournal, now: summary.at)
        saveJournal()
        if !summary.refusedSent.isEmpty || !summary.refusedReceived.isEmpty || !summary.rejectedByApply.isEmpty {
            print("[sync] left aside: \(summary.refusedSent.count) not sent, \(summary.refusedReceived.count) not taken, \(summary.rejectedByApply.count) values not kept")
        }
    }

    /// The conflicts of the last session that had any: the content of the screen « Conflit réglé ».
    var lastConflicts: [SettledConflict] { SyncConflicts.lastSession(conflictJournal) }

    /// « Rétablir » on a line: the version that lost is written back as an ordinary change of the state (it goes out at the next session), and the line goes.
    func restore(_ change: SyncChange, lineID: String) {
        guard let exchangeHost else { return }
        Task {
            let written = await exchangeHost.restore(change)
            if !written { print("[sync] nothing was put back for \(lineID): the entity or the list is no longer there, or it was changed since") }
            conflictJournal = SyncConflicts.remove(lineID, from: conflictJournal)
            saveJournal()
        }
    }

    private var journalFile: SyncJournalFile { SyncJournalFile(url: directory.appending(path: SyncJournalFile.fileName)) }

    private func loadJournal() {
        let loaded = journalFile.load(now: now())
        conflictJournal = loaded.entries
        journalTooNew = loaded.tooNew
    }

    /// A journal of a newer version is never written over (§11.7.3): the lines of this run stay in memory.
    private func saveJournal() {
        guard !journalTooNew else { return }
        do {
            try journalFile.save(conflictJournal)
        } catch {
            print("[sync] the journal of the conflicts was not written: \(error)")
        }
    }

    private func forgetExchangeFiles(of mac: SyncPairedMac?) {
        forgetOpenTabs()
        lastSessionCarriedOpenTabs = false
        guard exchangeHost != nil else { return }
        lastExchange = nil
        conflictJournal = []
        marks = nil
        let manager = FileManager.default
        for url in [journalFile.url, directory.appending(path: SyncMarksFile.fileName)] where manager.fileExists(atPath: url.path) {
            do { try manager.removeItem(at: url) } catch { print("[sync] \(url.lastPathComponent) was not removed: \(error)") }
        }
        if let mac {
            do { try SyncBaseStore(directory: directory).remove(peerId: mac.id) } catch { print("[sync] the base of the Mac was not removed: \(error)") }
        }
    }

    // MARK: Files and randomness

    private func save() {
        do {
            try file.save(settings)
        } catch {
            print("[sync] the settings were not written: \(error)")
        }
    }

    private static func randomBytes(_ count: Int) -> Data {
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        // A system that cannot give random bytes is not one to build a secret on: stop rather than send a nonce that is not one.
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed (\(status))")
        return bytes
    }

    private static func makeDeviceId() -> String { SyncEncoding.base64url(randomBytes(16)) }
}

/// The body of a session that only says "forgotten": the last word of a phone that no longer wants to be paired (§12).
struct SyncUnpairBody: SyncSessionBody {
    func run(_ context: SyncSessionContext, channel: SyncChannel) async throws -> SyncBodyOutcome {
        try await channel.send(.unpair)
        return .notExchanged
    }
}

/// Keeps `SyncOrigin` (whether this phone was ever modified) and its file. The model hands it the state each time it is written; once the phone is judged
/// modified the file is written once and nothing more is done.
@MainActor
final class SyncOriginKeeper {
    private(set) var origin: SyncOrigin
    private let file: SyncOriginFile

    init(file: SyncOriginFile, stateWasFound: Bool, state: BrowserState) {
        self.file = file
        switch file.load() {
        case .loaded(let kept):
            origin = kept
        case .none:
            origin = SyncOrigin.atFirstRun(stateWasFound: stateWasFound, state: state)
            write()
        case .unreadable:
            // What cannot be read cannot be trusted to say "never modified": the union loses nothing, adopting the Mac's state could.
            origin = SyncOrigin(firstStructure: nil, untouched: false)
            write()
        }
    }

    func observe(_ state: BrowserState) {
        let next = origin.observing(state)
        guard next != origin else { return }
        origin = next
        write()
    }

    private func write() {
        do {
            try file.save(origin)
        } catch {
            print("[sync] the origin of this phone was not written: \(error)")
        }
    }
}
