import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// The history of the phone, watched on real pages: a visit is noted for a normal tab, never for a private one, never when the profile keeps nothing,
/// it comes back after a restart, and one gesture clears it and the file. No window.
@MainActor
final class HistoryModelTests: BrowserCoreTestCase {
    private var historyURL: URL { directory.appending(path: HistoryFile.fileName) }

    func testALoadedPageIsNotedWithItsTitleAndComesBackAfterARestart() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        let entries = model.historyEntries(matching: "", limit: 10)
        XCTAssertEqual(entries.map(\.title), ["Page A"])
        XCTAssertEqual(entries.first?.url, address("/a.html").absoluteString)
        XCTAssertEqual(model.historyEntries(matching: "page a", limit: 4).count, 1, "the command bar finds it by its title")

        model.flush()
        let restarted = BrowserModel.launch(directory: directory, embeddedLists: { nil })
        XCTAssertEqual(restarted.historyEntries(matching: "", limit: 10).map(\.title), ["Page A"])
    }

    func testAPrivateTabNeverWritesToTheHistoryNorToItsFile() async throws {
        let model = await makeModel()
        model.newPrivateTab()
        try await load("/b.html", in: model)
        model.flush()
        XCTAssertTrue(model.historyEntries(matching: "", limit: 10).isEmpty)
        XCTAssertTrue(model.history.profiles.isEmpty)
        if FileManager.default.fileExists(atPath: historyURL.path) {
            XCTAssertNil(try Data(contentsOf: historyURL).range(of: Data("127.0.0.1".utf8)), "no address of a private page is in the file")
        }
    }

    func testAProfileThatKeepsNothingNotesNothingAndTheChoiceIsTheMacs() async throws {
        let model = await makeModel()
        model.chooseRecordsHistory(false)
        XCTAssertFalse(model.recordsHistory)
        XCTAssertTrue(model.changedSettingsRows.contains(.history))
        try await load("/a.html", in: model)
        XCTAssertTrue(model.historyEntries(matching: "", limit: 10).isEmpty)
        model.chooseRecordsHistory(true)
        try await load("/b.html", in: model)
        XCTAssertEqual(model.historyEntries(matching: "", limit: 10).map(\.title), ["Page B"])
    }

    func testClearingIsOneGestureAndTheFileIsWrittenAtOnce() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.flush()
        XCTAssertTrue(FileManager.default.fileExists(atPath: historyURL.path))
        model.clearHistory()
        XCTAssertTrue(model.historyEntries(matching: "", limit: 10).isEmpty)
        let restarted = BrowserModel.launch(directory: directory, embeddedLists: { nil })
        XCTAssertTrue(restarted.historyEntries(matching: "", limit: 10).isEmpty, "what was cleared does not come back")
        XCTAssertEqual(restarted.history.retentionDays, HistoryBook.defaultRetentionDays)
    }

    func testTheHistoryIsNotInTheStateFile() async throws {
        let model = await makeModel()
        try await load("/a.html", in: model)
        model.flush()
        let state = try String(contentsOf: directory.appending(path: StateFile.fileName), encoding: .utf8)
        XCTAssertFalse(state.contains("visitCount"), "the visits are not in the file the synchronisation reads")
    }

    func testAFailedWriteIsReportedAndBrowsingGoesOn() async throws {
        let model = await makeModel()
        // A folder where the file should be: the write fails.
        try FileManager.default.createDirectory(at: historyURL, withIntermediateDirectories: true)
        try await load("/a.html", in: model)
        model.flushHistory()
        XCTAssertNotNil(model.problem(.history), "the failure is kept, not swallowed")
        XCTAssertEqual(model.historyEntries(matching: "", limit: 10).count, 1, "the page is still in memory")
    }

    func testTheChipAndTheListAreOfferedOnlyWhileThereIsSomethingToOpen() async throws {
        let model = await makeModel()
        XCTAssertTrue(model.historyAvailable, "a profile that keeps pages offers the chip")
        model.chooseRecordsHistory(false)
        XCTAssertFalse(model.historyAvailable, "nothing kept and nothing recorded: the chip would lead nowhere")
        model.chooseRecordsHistory(true)
        try await load("/a.html", in: model)
        model.chooseRecordsHistory(false)
        XCTAssertTrue(model.historyAvailable, "pages already kept can still be opened")
        let content = model.commandBarContent(for: "page", filter: nil)
        XCTAssertEqual(content.history.map(\.title), ["Page A"])
        XCTAssertTrue(content.sections.contains(.history))
        XCTAssertTrue(model.commandBarContent(for: "", filter: .history).history.count == 1)
        XCTAssertTrue(model.commandBarContent(for: "", filter: .tabs).history.isEmpty)
    }
}
