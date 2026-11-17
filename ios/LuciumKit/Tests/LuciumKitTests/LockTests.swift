import Foundation
import Testing
@testable import LuciumKit

// MARK: Settings

@Suite("The settings of the lock")
struct LockSettingsTests {
    @Test func aSpaceIsKeptOnceAndOnlyIfItExists() {
        let settings = LockSettings(lockApp: true, lockedSpaces: ["a", "b", "a", "", "gone", "c"])
        #expect(settings.cleaned().lockedSpaces == ["a", "b", "gone", "c"], "without a list of spaces, only the duplicates and the empty id go")
        #expect(settings.cleaned(spaceIds: ["a", "b", "c"]) == LockSettings(lockApp: true, lockedSpaces: ["a", "b", "c"]))
    }

    @Test func atMostTwoHundredSpacesAreGuarded() {
        let many = (0..<300).map { "s\($0)" }
        #expect(LockSettings(lockedSpaces: many).cleaned().lockedSpaces == Array(many.prefix(200)))
    }

    @Test func anIdLongerThanTheMacKeepsIsDropped() {
        let long = String(repeating: "x", count: 257)
        let fits = String(repeating: "y", count: 256)
        #expect(LockSettings(lockedSpaces: [long, fits]).cleaned().lockedSpaces == [fits])
    }

    @Test func somethingIsActiveWhenTheApplicationOrASpaceIsSet() {
        #expect(!LockSettings().isActive)
        #expect(LockSettings(lockApp: true).isActive)
        #expect(LockSettings(lockedSpaces: ["a"]).isActive)
    }

    @Test func theFileFormatRoundTripsAndNamesItsVersion() throws {
        let settings = LockSettings(lockApp: true, lockedSpaces: ["a", "b"])
        let data = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(LockSettings.self, from: data) == settings)
        #expect(String(decoding: data, as: UTF8.self).contains("\"version\":1"))
    }

    @Test func aNewerFormatOrAMissingFieldIsNotRead() {
        let newer = Data(#"{"version":2,"lockApp":false,"lockedSpaces":[]}"#.utf8)
        #expect(throws: LockSettings.ReadError.newerVersion(2)) { try JSONDecoder().decode(LockSettings.self, from: newer) }
        let missing = Data(#"{"version":1,"lockedSpaces":[]}"#.utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(LockSettings.self, from: missing) }
    }
}

// MARK: What is locked

@Suite("What is locked at this moment")
struct LockSessionTests {
    private let settings = LockSettings(lockApp: true, lockedSpaces: ["work", "home"])

    @Test func aLaunchLocksTheApplicationAndEveryGuardedSpace() {
        let session = LockSession(settings: settings)
        #expect(session.appLocked)
        #expect(session.lockedSpaces == ["work", "home"])
        #expect(!LockSession(settings: LockSettings(lockedSpaces: ["work"])).appLocked, "the application is locked only when it is set to")
    }

    @Test func aLockedApplicationCoversEverySpaceAGuardedSpaceOnlyItself() {
        var session = LockSession(settings: settings)
        #expect(session.covers(space: "other"))
        session.unlockApp()
        #expect(!session.covers(space: "other"))
        #expect(session.covers(space: "work"))
        session.unlock(space: "work")
        #expect(!session.covers(space: "work"))
        #expect(session.covers(space: "home"), "opening one space opens no other")
    }

    @Test func openingASpaceDoesNotOpenTheApplicationNorTheOtherWayRound() {
        var session = LockSession(settings: settings)
        session.unlock(space: "work")
        #expect(session.appLocked)
        #expect(session.covers(space: "work"), "a space opened under a locked application stays hidden by it")
        var other = LockSession(settings: settings)
        other.unlockApp()
        #expect(other.isSpaceLocked("work"))
    }

    @Test func leavingLuciumLocksEverythingAgain() {
        var session = LockSession(settings: settings)
        session.unlockApp()
        session.unlock(space: "work")
        session.unlock(space: "home")
        #expect(session.lockedSpaces.isEmpty && !session.appLocked)
        session.lockAll()
        #expect(session.appLocked)
        #expect(session.lockedSpaces == ["work", "home"])
    }

    @Test func aSpaceThatIsNotGuardedCannotBeOpenedIntoTheList() {
        var session = LockSession(settings: settings)
        session.unlock(space: "free")
        #expect(session.unlockedSpaces.isEmpty)
        #expect(!session.isSpaceLocked("free"))
    }

    @Test func aSpaceThatHasJustBeenGuardedIsLockedAtOnce() {
        var session = LockSession(settings: LockSettings(lockedSpaces: ["work"]))
        session.unlock(space: "work")
        session.apply(LockSettings(lockedSpaces: ["work", "home"]))
        #expect(session.isSpaceLocked("home"))
        #expect(!session.isSpaceLocked("work"), "the space that was already open stays open")
    }

    @Test func aSpaceThatIsReleasedAndGuardedAgainIsLocked() {
        var session = LockSession(settings: LockSettings(lockedSpaces: ["work"]))
        session.unlock(space: "work")
        session.apply(LockSettings())
        session.apply(LockSettings(lockedSpaces: ["work"]))
        #expect(session.isSpaceLocked("work"))
    }

    @Test func turningTheApplicationLockOffOpensItAndTurningItOnDoesNotLockTheScreenInUse() {
        var session = LockSession(settings: LockSettings(lockApp: true))
        session.apply(LockSettings(lockApp: false))
        #expect(!session.appLocked)
        session.apply(LockSettings(lockApp: true))
        #expect(!session.appLocked)
        session.lockAll()
        #expect(session.appLocked)
    }

    @Test func theScreenIsHiddenFromTheSystemOnlyWhenSomethingIsSetToBeLocked() {
        let session = LockSession(settings: LockSettings(lockedSpaces: ["work"]))
        #expect(session.coversScreen(sceneActive: false))
        #expect(!session.coversScreen(sceneActive: true))
        #expect(!LockSession(settings: LockSettings()).coversScreen(sceneActive: false), "no lock, no cover")
    }
}

// MARK: The file

private final class Sandbox {
    let directory: URL
    init() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-lock-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    var url: URL { directory.appending(path: LockSettingsFile.fileName) }
    var names: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted() }
    deinit {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
        try? FileManager.default.removeItem(at: directory)
    }
}

@Suite("The file of the lock")
struct LockSettingsFileTests {
    @Test func noFileIsALockThatWasNeverSet() throws {
        let box = try Sandbox()
        #expect(LockSettingsFile(url: box.url).load() == .none)
        #expect(box.names.isEmpty, "reading writes nothing")
    }

    @Test func savedSettingsComeBackAndLeaveNoTemporaryFile() throws {
        let box = try Sandbox()
        let file = LockSettingsFile(url: box.url)
        try file.save(LockSettings(lockApp: true, lockedSpaces: ["a"]))
        try file.save(LockSettings(lockApp: false, lockedSpaces: ["a", "b"]))
        #expect(file.load() == .loaded(LockSettings(lockApp: false, lockedSpaces: ["a", "b"])))
        #expect(box.names == [LockSettingsFile.fileName])
    }

    @Test(arguments: ["", "not json", "{}", #"{"version":1,"lockApp":"yes","lockedSpaces":[]}"#, #"{"version":9,"lockApp":false,"lockedSpaces":[]}"#])
    func aFileThatCannotBeReadIsReportedAndNeverTakenForNoLock(content: String) throws {
        let box = try Sandbox()
        try Data(content.utf8).write(to: box.url)
        guard case .unreadable = LockSettingsFile(url: box.url).load() else {
            Issue.record("\(content.debugDescription) was read as a lock")
            return
        }
    }

    @Test func aFolderInThePlaceOfTheFileIsUnreadable() throws {
        let box = try Sandbox()
        try FileManager.default.createDirectory(at: box.url, withIntermediateDirectories: true)
        guard case .unreadable = LockSettingsFile(url: box.url).load() else {
            Issue.record("a folder was read as a lock")
            return
        }
    }

    @Test func aWriteThatFailsLeavesTheFileAsItWasAndNoTemporaryFile() throws {
        let box = try Sandbox()
        let file = LockSettingsFile(url: box.url)
        try file.save(LockSettings(lockApp: true))
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: box.directory.path)
        #expect(throws: (any Error).self) { try file.save(LockSettings(lockApp: false)) }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: box.directory.path)
        #expect(file.load() == .loaded(LockSettings(lockApp: true)))
        #expect(box.names == [LockSettingsFile.fileName])
    }
}

// MARK: The controller

/// An owner that says what it is told to, and counts how often it was asked.
private final class Owner: LockAuthenticating, @unchecked Sendable {
    private let guardLock = NSLock()
    private var outcomeValue: LockOutcome
    private var passcodeValue: Bool
    private var askedValue: [LockPurpose] = []
    /// Runs while the prompt is "on screen": a test uses it to do something at that moment.
    var during: (@Sendable () async -> Void)?

    init(_ outcome: LockOutcome = .granted, hasPasscode: Bool = true) {
        outcomeValue = outcome
        passcodeValue = hasPasscode
    }

    var outcome: LockOutcome { get { guardLock.withLock { outcomeValue } } set { guardLock.withLock { outcomeValue = newValue } } }
    var hasPasscode: Bool { get { guardLock.withLock { passcodeValue } } set { guardLock.withLock { passcodeValue = newValue } } }
    var asked: [LockPurpose] { guardLock.withLock { askedValue } }

    func canCheckOwner() -> Bool { hasPasscode }

    func authenticate(purpose: LockPurpose) async -> LockOutcome {
        guardLock.withLock { askedValue.append(purpose) }
        if let during { await during() }
        return outcome
    }
}

/// An owner that waits to be answered, to hold a prompt open.
private final class SlowOwner: LockAuthenticating, @unchecked Sendable {
    private let guardLock = NSLock()
    private var continuation: CheckedContinuation<LockOutcome, Never>?
    private var count = 0
    var calls: Int { guardLock.withLock { count } }
    var isWaiting: Bool { guardLock.withLock { continuation != nil } }

    func canCheckOwner() -> Bool { true }

    func authenticate(purpose: LockPurpose) async -> LockOutcome {
        // A second prompt while one is open would overwrite the first one's way back and hang the test: it is refused, and counted.
        let busy = guardLock.withLock { () -> Bool in
            count += 1
            return continuation != nil
        }
        if busy { return .refused(.failed) }
        return await withCheckedContinuation { continuation in
            guardLock.withLock { self.continuation = continuation }
        }
    }

    func answer(_ outcome: LockOutcome) {
        let waiting = guardLock.withLock { () -> CheckedContinuation<LockOutcome, Never>? in
            defer { continuation = nil }
            return continuation
        }
        waiting?.resume(returning: outcome)
    }
}

@MainActor
@Suite("The lock controller")
struct LockControllerTests {
    private func controller(_ owner: any LockAuthenticating, saved: LockSettings? = nil, spaces: Set<String>? = nil, box: Sandbox? = nil) throws -> (LockController, Sandbox) {
        let box = try box ?? Sandbox()
        let file = LockSettingsFile(url: box.url)
        if let saved { try file.save(saved) }
        return (LockController(authenticator: owner, file: file, spaceIds: spaces), box)
    }

    // Opening: the refusal.

    @Test func theApplicationStaysLockedWhenTheOwnerIsRefused() async throws {
        let owner = Owner(.refused(.failed))
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true, lockedSpaces: ["work"]))
        #expect(lock.appLocked)
        #expect(await lock.unlockApp() == false)
        #expect(lock.appLocked, "a refusal must not open the application")
        #expect(lock.covers(space: "free"))
        #expect(lock.notice == .refused(.failed))
        #expect(owner.asked == [.unlockApp])
    }

    @Test func theApplicationOpensWhenTheOwnerIsConfirmed() async throws {
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true))
        #expect(await lock.unlockApp())
        #expect(!lock.appLocked)
        #expect(lock.notice == nil)
    }

    @Test(arguments: [LockRefusal.cancelled, .failed, .unavailable])
    func aSpaceStaysLockedForEveryKindOfRefusalAndTheOthersAreUntouched(refusal: LockRefusal) async throws {
        let owner = Owner(.refused(refusal))
        let (lock, _) = try controller(owner, saved: LockSettings(lockedSpaces: ["work", "home"]))
        #expect(await lock.unlock(space: "work") == false)
        #expect(lock.isSpaceLocked("work") && lock.isSpaceLocked("home"))
        #expect(!lock.covers(space: "free"), "a space that is not guarded is never covered")
        #expect(lock.notice == .refused(refusal))
    }

    @Test func aSpaceOpensForTheOwnerAndOnlyThatSpace() async throws {
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, saved: LockSettings(lockedSpaces: ["work", "home"]))
        #expect(await lock.unlock(space: "work"))
        #expect(!lock.isSpaceLocked("work") && lock.isSpaceLocked("home"))
        #expect(owner.asked == [.unlockSpace])
        #expect(await lock.unlock(space: "work"), "an open space is not asked about again")
        #expect(owner.asked.count == 1)
    }

    @Test func aSpaceUnderALockedApplicationIsNotAskedFor() async throws {
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true, lockedSpaces: ["work"]))
        #expect(await lock.unlock(space: "work") == false)
        #expect(owner.asked.isEmpty)
        #expect(lock.isSpaceLocked("work"))
    }

    @Test func leavingLuciumLocksEverythingAgainAndTellsTheBrowser() async throws {
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true, lockedSpaces: ["work"]))
        var told = 0
        lock.onChange = { told += 1 }
        await lock.unlockApp()
        await lock.unlock(space: "work")
        #expect(told == 2)
        lock.lockAll()
        #expect(lock.appLocked && lock.isSpaceLocked("work"))
        #expect(told == 3)
    }

    // The answer of a prompt that belongs to a screen that is gone.

    @Test func anAnswerThatArrivesAfterLuciumWasLeftOpensNothing() async throws {
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true, lockedSpaces: ["work"]))
        owner.during = { await MainActor.run { lock.lockAll() } }
        #expect(await lock.unlockApp() == false, "the owner agreed, but Lucium had been left in between")
        #expect(lock.appLocked)
        owner.during = nil
        #expect(await lock.unlockApp(), "the next prompt works")
    }

    @Test func aSecondRequestWhileAPromptIsOpenAsksNothing() async throws {
        let owner = SlowOwner()
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true))
        let first = Task { await lock.unlockApp() }
        while !owner.isWaiting { await Task.yield() }
        #expect(lock.isAuthenticating)
        #expect(await lock.unlockApp() == false)
        #expect(owner.calls == 1, "two prompts stacked would answer each other")
        owner.answer(.granted)
        #expect(await first.value)
        #expect(!lock.isAuthenticating && !lock.appLocked)
    }

    @Test func theScreenAsksOncePerLaunchOrLeaveNotAgainAfterARefusal() async throws {
        let owner = Owner(.refused(.cancelled))
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true))
        #expect(lock.promptPending)
        await lock.promptIfPending()
        await lock.promptIfPending()
        #expect(owner.asked.count == 1, "a cancelled prompt must not come back by itself")
        lock.lockAll()
        #expect(lock.promptPending)
        let none = Owner()
        let (unlocked, _) = try controller(none, saved: LockSettings(lockedSpaces: ["a"]))
        #expect(!unlocked.promptPending)
        await unlocked.promptIfPending()
        #expect(none.asked.isEmpty)
    }

    // Changing: the owner is asked, and a refusal changes nothing.

    @Test func turningTheApplicationLockOnNeedsTheOwnerAndIsKept() async throws {
        let owner = Owner(.granted)
        let (lock, box) = try controller(owner)
        #expect(await lock.setLockApp(true))
        #expect(lock.lockApp)
        #expect(!lock.appLocked, "the screen in use is not locked when the lock is turned on")
        #expect(owner.asked == [.turnOn])
        #expect(LockSettingsFile(url: box.url).load() == .loaded(LockSettings(lockApp: true)))
        let (again, _) = try controller(owner, box: box)
        #expect(again.appLocked, "the next launch is locked")
    }

    @Test func aRefusedOwnerTurnsNothingOnOrOff() async throws {
        let owner = Owner(.refused(.failed))
        let (lock, box) = try controller(owner)
        #expect(await lock.setLockApp(true) == false)
        #expect(await lock.setSpace("work", guarded: true) == false)
        #expect(!lock.lockApp && !lock.isGuarded("work"))
        #expect(LockSettingsFile(url: box.url).load() == .none, "nothing is written for a refusal")

        try LockSettingsFile(url: box.url).save(LockSettings(lockApp: true, lockedSpaces: ["work"]))
        let (guarded, _) = try controller(owner, box: box)
        #expect(await guarded.unlockApp() == false)
        guarded.onChange = nil
        #expect(await guarded.setLockApp(false) == false, "a thief of the open phone cannot turn the lock off")
        #expect(await guarded.setSpace("work", guarded: false) == false)
        #expect(guarded.lockApp && guarded.isGuarded("work"))
        #expect(LockSettingsFile(url: box.url).load() == .loaded(LockSettings(lockApp: true, lockedSpaces: ["work"])))
    }

    @Test func turningALockOffNeedsTheOwnerAndIsKept() async throws {
        let owner = Owner(.granted)
        let (lock, box) = try controller(owner, saved: LockSettings(lockApp: true, lockedSpaces: ["work", "home"]))
        await lock.unlockApp()
        #expect(await lock.setLockApp(false))
        #expect(await lock.setSpace("work", guarded: false))
        #expect(owner.asked.suffix(2) == [.turnOff, .turnOff])
        #expect(LockSettingsFile(url: box.url).load() == .loaded(LockSettings(lockApp: false, lockedSpaces: ["home"])))
    }

    @Test func guardingASpaceLocksItAtOnce() async throws {
        let (lock, _) = try controller(Owner(.granted))
        #expect(await lock.setSpace("work", guarded: true))
        #expect(lock.isSpaceLocked("work"))
    }

    @Test func aChangeThatCannotBeKeptIsNotMade() async throws {
        let owner = Owner(.granted)
        let (lock, box) = try controller(owner, saved: LockSettings(lockedSpaces: ["home"]))
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: box.directory.path)
        #expect(await lock.setLockApp(true) == false)
        #expect(await lock.setSpace("home", guarded: false) == false)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: box.directory.path)
        #expect(lock.notice == .saveFailed)
        #expect(!lock.lockApp && lock.isGuarded("home"), "a lock that is on until the next launch, or off now and on later, is a lie")
        #expect(LockSettingsFile(url: box.url).load() == .loaded(LockSettings(lockedSpaces: ["home"])))
    }

    // A device with no passcode.

    @Test func aLockCannotBeTurnedOnWhereNothingCanAskTheOwner() async throws {
        let owner = Owner(.granted, hasPasscode: false)
        let (lock, box) = try controller(owner)
        #expect(await lock.setLockApp(true) == false)
        #expect(await lock.setSpace("work", guarded: true) == false)
        #expect(lock.notice == .noPasscode)
        #expect(owner.asked.isEmpty)
        #expect(LockSettingsFile(url: box.url).load() == .none)
    }

    @Test func aLockIsTurnedOffAtLaunchWhenTheDeviceLostItsPasscode() throws {
        let owner = Owner(.granted, hasPasscode: false)
        let (lock, box) = try controller(owner, saved: LockSettings(lockApp: true, lockedSpaces: ["work"]))
        #expect(!lock.appLocked && !lock.isActive, "nobody could unlock it, and the phone protects nothing")
        #expect(lock.notice == .switchedOffNoPasscode)
        #expect(LockSettingsFile(url: box.url).load() == .loaded(LockSettings()))
    }

    @Test func aPasscodeRemovedWhileLuciumWasAwayTurnsTheLockOffOnReturn() async throws {
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, saved: LockSettings(lockApp: true))
        await lock.unlockApp()
        lock.lockAll()
        owner.hasPasscode = false
        lock.recheckDevice()
        #expect(!lock.appLocked && !lock.isActive)
        #expect(lock.notice == .switchedOffNoPasscode)
    }

    @Test func aNoticeStaysUntilThePersonHasReadIt() throws {
        let (lock, _) = try controller(Owner(.granted, hasPasscode: false), saved: LockSettings(lockApp: true))
        #expect(lock.notice == .switchedOffNoPasscode)
        lock.dismissNotice()
        #expect(lock.notice == nil)
    }

    // A file that cannot be read.

    @Test func anUnreadableFileLocksTheApplicationInsteadOfOpeningIt() async throws {
        let box = try Sandbox()
        try Data("garbage".utf8).write(to: box.url)
        let owner = Owner(.granted)
        let (lock, _) = try controller(owner, box: box)
        #expect(lock.appLocked, "a lock that fails open is no lock")
        #expect(lock.notice == .settingsUnreadable)
        #expect(await lock.unlockApp(), "the owner can still open it")
    }

    @Test func aGuardedSpaceThatDoesNotExistAnyMoreIsDropped() throws {
        let (lock, _) = try controller(Owner(), saved: LockSettings(lockedSpaces: ["work", "gone"]), spaces: ["work", "home"])
        #expect(lock.isGuarded("work") && !lock.isGuarded("gone"))
        lock.reconcile(spaceIds: ["home"])
        #expect(!lock.isGuarded("work"))
    }
}
