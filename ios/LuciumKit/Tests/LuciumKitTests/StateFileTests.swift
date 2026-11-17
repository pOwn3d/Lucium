import Foundation
import Testing
@testable import LuciumKit

/// A folder of its own for each test, removed afterwards.
private final class Sandbox {
    let directory: URL
    init() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-state-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    var file: URL { directory.appending(path: "state.json") }
    var names: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted() }
    func write(_ text: String, to name: String = "state.json") throws { try Data(text.utf8).write(to: directory.appending(path: name)) }
    func text(_ name: String = "state.json") throws -> String { try String(contentsOf: directory.appending(path: name), encoding: .utf8) }
    deinit {
        // Put the folder's permissions back first: a test may have made it read-only.
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
        try? FileManager.default.removeItem(at: directory)
    }
}

private func sampleState() -> BrowserState {
    var state = BrowserState(revision: 2, spaces: [Space(id: "s1", name: "Work", emoji: "💼", profileId: "work")], activeSpaceId: "s1", activeTabBySpace: ["s1": nil],
                             rest: ["settings": .object(["blockAds": .bool(true)])])
    state.openTab(id: "t1", in: "s1", url: "https://a.example/", title: "A", now: 1_790_000_000_000)
    return state
}

private let validJSON = #"{ "version": 1, "spaces": [{ "id": "s1", "name": "W", "emoji": "💼", "profileId": "work" }], "tabs": [], "activeSpaceId": "s1", "activeTabBySpace": { "s1": null } }"#

@Suite("The state file")
struct StateFileTests {
    @Test func noFileIsAFirstLaunch() throws {
        let box = try Sandbox()
        var file = StateFile(url: box.file)
        #expect(file.load() == .fresh)
        #expect(box.names.isEmpty, "loading writes nothing")
    }

    @Test func aSavedStateComesBackAsItWasAndLeavesNoTemporaryFile() throws {
        let box = try Sandbox()
        var file = StateFile(url: box.file)
        try file.save(sampleState())
        #expect(box.names == ["state.json"])
        var again = StateFile(url: box.file)
        #expect(again.load() == .loaded(sampleState()))
    }

    @Test func aWriteThatFailsLeavesTheFileAsItWas() throws {
        let box = try Sandbox()
        var file = StateFile(url: box.file)
        try file.save(sampleState())
        let before = try box.text()
        // A folder where the temporary file goes: the write cannot even start.
        try FileManager.default.createDirectory(at: box.directory.appending(path: "state.json.tmp"), withIntermediateDirectories: false)
        var changed = sampleState()
        changed.tabs[0].title = "Changed"
        #expect(throws: (any Error).self) { try file.save(changed) }
        #expect(try box.text() == before, "the old state is intact: a write goes to a temporary file first")
    }

    @Test func aFailedWriteRemovesItsTemporaryFile() throws {
        let box = try Sandbox()
        var file = StateFile(url: box.file)
        // The target is a dangling link: the temporary file is written, then the move into place is refused ("file exists").
        try FileManager.default.createSymbolicLink(at: box.file, withDestinationURL: URL(fileURLWithPath: "/nonexistent-lucium-target"))
        #expect(throws: (any Error).self) { try file.save(sampleState()) }
        #expect(!box.names.contains("state.json.tmp"), "a complete copy of the state must not stay behind: \(box.names)")
    }

    @Test func aDamagedFileIsMovedAsideNeverDeleted() throws {
        let box = try Sandbox()
        try box.write("{ not json")
        var file = StateFile(url: box.file, now: { Date(timeIntervalSince1970: 1_790_000_000) })
        guard case .setAside(.corrupt, let backup, _) = file.load() else { Issue.record("expected the file to be set aside"); return }
        #expect(backup.lastPathComponent == "state.json.corrupt-1790000000000")
        #expect(try box.text("state.json.corrupt-1790000000000") == "{ not json")
        #expect(!FileManager.default.fileExists(atPath: box.file.path))
        // The next save starts again from a fresh file and does not touch the one set aside.
        try file.save(sampleState())
        #expect(try box.text("state.json.corrupt-1790000000000") == "{ not json")
        #expect(box.names.contains("state.json"))
    }

    @Test func aStateOfANewerFormatIsKeptUnderItsOwnNameAndNeverRewritten() throws {
        let box = try Sandbox()
        let newer = #"{ "version": 2, "spaces": [], "tabs": [], "activeSpaceId": "", "activeTabBySpace": {}, "fromTheFuture": true }"#
        try box.write(newer)
        var file = StateFile(url: box.file, now: { Date(timeIntervalSince1970: 1_790_000_000) })
        guard case .setAside(.future, _, _) = file.load() else { Issue.record("expected the newer state to be set aside as .future"); return }
        #expect(try box.text("state.json.future-1790000000000") == newer, "byte for byte")
        #expect(box.names.allSatisfy { !$0.contains("corrupt") })
    }

    @Test func aFileWithNoSpaceIsNotAStateAndIsSetAside() throws {
        let box = try Sandbox()
        try box.write(#"{ "version": 1, "spaces": [], "tabs": [], "activeSpaceId": "", "activeTabBySpace": {} }"#)
        var file = StateFile(url: box.file)
        guard case .setAside(.corrupt, _, _) = file.load() else { Issue.record("expected the file to be set aside"); return }
    }

    @Test func aByteOrderMarkIsNotDamage() throws {
        let box = try Sandbox()
        try Data([0xEF, 0xBB, 0xBF] + Array(validJSON.utf8)).write(to: box.file)
        var file = StateFile(url: box.file)
        guard case .loaded(let state) = file.load() else { Issue.record("expected the file to be read"); return }
        #expect(state.spaces.map(\.id) == ["s1"])
    }

    @Test func aFileLargerThanTheLimitIsNotReadIntoMemory() throws {
        let box = try Sandbox()
        // A sparse file: it costs no disk, and its size alone says it is not a state.
        FileManager.default.createFile(atPath: box.file.path, contents: nil)
        let handle = try FileHandle(forWritingTo: box.file)
        try handle.truncate(atOffset: UInt64(StateFile.maxBytes + 1))
        try handle.close()
        var file = StateFile(url: box.file)
        guard case .setAside(.corrupt, let backup, let why) = file.load() else { Issue.record("expected the file to be set aside"); return }
        #expect(why.contains("tooLarge"), "\(why)")
        #expect(FileManager.default.fileExists(atPath: backup.path))
    }

    @Test func aFolderWhereTheFileShouldBeIsSetAside() throws {
        let box = try Sandbox()
        try FileManager.default.createDirectory(at: box.file, withIntermediateDirectories: false)
        var file = StateFile(url: box.file)
        guard case .setAside(.corrupt, _, let why) = file.load() else { Issue.record("expected the folder to be set aside"); return }
        #expect(why.contains("notARegularFile"), "\(why)")
    }

    @Test func onlyTheThreeMostRecentFilesOfEachSortAreKept() throws {
        let box = try Sandbox()
        for stamp in 1...5 {
            try box.write("damaged \(stamp)")
            var file = StateFile(url: box.file, now: { Date(timeIntervalSince1970: Double(stamp)) })
            _ = file.load()
        }
        try box.write(#"{ "version": 9, "spaces": [], "tabs": [], "activeSpaceId": "", "activeTabBySpace": {} }"#)
        var file = StateFile(url: box.file, now: { Date(timeIntervalSince1970: 100) })
        _ = file.load()
        #expect(box.names == ["state.json.corrupt-3000", "state.json.corrupt-4000", "state.json.corrupt-5000", "state.json.future-100000"], "\(box.names)")
    }

    @Test func twoFilesSetAsideInTheSameMillisecondDoNotOverwriteEachOther() throws {
        let box = try Sandbox()
        let clock: @Sendable () -> Date = { Date(timeIntervalSince1970: 7) }
        try box.write("first")
        var one = StateFile(url: box.file, now: clock)
        _ = one.load()
        try box.write("second")
        var two = StateFile(url: box.file, now: clock)
        _ = two.load()
        #expect(try box.text("state.json.corrupt-7000") == "first")
        #expect(try box.text("state.json.corrupt-7000-1") == "second")
    }

    @Test func whenTheUnreadableFileCannotBeMovedNothingIsWrittenOverItUntilItCan() throws {
        let box = try Sandbox()
        try box.write("{ not json")
        // A read-only folder: the file can be read but not renamed.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: box.directory.path)
        var file = StateFile(url: box.file)
        guard case .held(.corrupt, _) = file.load() else { Issue.record("expected the file to be held"); return }
        #expect(throws: StateFileError.self) { try file.save(sampleState()) }
        #expect(try box.text() == "{ not json", "the file nobody could read is still there, unchanged")
        // The folder is writable again: the next save puts the old file aside, then writes.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: box.directory.path)
        try file.save(sampleState())
        #expect(box.names.contains { $0.hasPrefix("state.json.corrupt-") })
        var again = StateFile(url: box.file)
        #expect(again.load() == .loaded(sampleState()))
    }
}
