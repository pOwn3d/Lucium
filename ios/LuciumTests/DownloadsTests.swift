import CoreGraphics
import LuciumKit
import UIKit
import WebKit
import XCTest
@testable import Lucium

/// An owner that always says yes: the lock is tested elsewhere (`LockTests`), here it only has to cover a space.
private final class Owner: LockAuthenticating, @unchecked Sendable {
    func canCheckOwner() -> Bool { true }
    func authenticate(purpose: LockPurpose) async -> LockOutcome { .granted }
}

/// Files that come in, and pages that go out: a real web view, a real `WKDownload`, real files in a folder of the test, and a server that says how each
/// answer ends. No window, and nothing outside the folder of the test is written.
@MainActor
final class DownloadsTests: BrowserCoreTestCase {
    var scripted: ScriptedServer!
    var scriptedPort: UInt16 = 0

    override func tearDown() async throws {
        scripted?.stop()
        try await super.tearDown()
    }

    var downloadsDirectory: URL { directory.appending(path: "Downloads", directoryHint: .isDirectory) }

    func serve(_ handler: @escaping ScriptedServer.Handler) async throws {
        scripted = try ScriptedServer(handler: handler)
        scriptedPort = try await scripted.start()
    }

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(scriptedPort)\(path)")! }

    /// A model like the application's, whose downloads go to the folder of this test.
    func makeDownloadsModel() async -> BrowserModel {
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), embeddedLists: { nil }, downloadsDirectory: downloadsDirectory)
        await model.prepare()
        return model
    }

    func startDownload(_ path: String, in model: BrowserModel) throws {
        try XCTUnwrap(model.webView).load(URLRequest(url: url(path)))
    }

    func waitForPhase(_ phase: DownloadItem.Phase, in model: BrowserModel, timeout: Duration = .seconds(30), file: StaticString = #filePath, line: UInt = #line) async throws -> DownloadItem {
        do {
            try await eventually("the download is \(phase)", timeout: timeout, { model.downloads.list.items.first?.phase == phase }, file: file, line: line)
        } catch {
            XCTFail("the list was: \(model.downloads.list.items)", file: file, line: line)
            throw error
        }
        return try XCTUnwrap(model.downloads.list.items.first, file: file, line: line)
    }

    func filesInDownloads() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: downloadsDirectory.path)) ?? []).sorted()
    }

    // MARK: Files that come in

    func testAnAttachmentIsSavedInTheFolderOfTheDownloadsUnderACleanName() async throws {
        try await serve { request in
            guard request.path == "/get" else { return .init(status: 404) }
            // A name that goes up the folders and carries a character that turns the text round on screen (WebKit makes the slashes underscores
            // itself; that character it leaves, and a name that ends in `.exe` read backwards is the trick it serves).
            return .init(headers: ["Content-Type": "text/plain", "Content-Disposition": "attachment; filename=\"../../.\u{202E}evil name.txt\""],
                         body: Data("hello world".utf8))
        }
        let model = await makeDownloadsModel()
        let page = try XCTUnwrap(model.webView)
        try startDownload("/get", in: model)
        let item = try await waitForPhase(.finished, in: model)

        XCTAssertEqual(item.source, "127.0.0.1:\(scriptedPort)", "the line says where the file comes from: the host (and its port, like the Mac), never the whole address")
        XCTAssertEqual(item.fileName, "_.._.evil name.txt", "the character that turns the text round on screen is gone")
        XCTAssertEqual(filesInDownloads(), ["_.._.evil name.txt"])
        XCTAssertEqual(try String(contentsOf: downloadsDirectory.appending(path: "_.._.evil name.txt"), encoding: .utf8), "hello world")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appending(path: "evil name.txt").path), "nothing is written outside the folder")
        XCTAssertFalse(item.fileName.unicodeScalars.contains("\u{202E}"))
        XCTAssertEqual(item.fraction, 1)
        XCTAssertEqual(item.receivedBytes, 11)
        XCTAssertEqual(model.downloads.strip, .saved(name: "_.._.evil name.txt"))
        XCTAssertNotEqual(page.url?.path, "/get", "the tab did not navigate: the page stays where it was")
    }

    func testATypeThatTheWebViewCannotShowIsDownloadedWithTheNameOfItsAddress() async throws {
        try await serve { request in
            .init(headers: ["Content-Type": "application/octet-stream"], body: Data([0, 1, 2, 3, 4, 5, 6, 7]))
        }
        let model = await makeDownloadsModel()
        try startDownload("/files/data.bin", in: model)
        let item = try await waitForPhase(.finished, in: model)
        XCTAssertEqual(item.fileName, "data.bin")
        XCTAssertEqual(try Data(contentsOf: downloadsDirectory.appending(path: "data.bin")), Data([0, 1, 2, 3, 4, 5, 6, 7]))
    }

    func testAPageThatTheWebViewCanShowIsNotDownloaded() async throws {
        try await serve { _ in .init(headers: ["Content-Type": "text/html"], body: Data("<!doctype html><title>Shown</title><p>hello".utf8)) }
        let model = await makeDownloadsModel()
        let view = try XCTUnwrap(model.webView)
        try startDownload("/page.html", in: model)
        try await eventually("the page is shown") { view.url?.path == "/page.html" && !view.isLoading }
        XCTAssertTrue(model.downloads.list.items.isEmpty)
        XCTAssertEqual(filesInDownloads(), [])
    }

    func testALinkMarkedDownloadIsSavedUnderTheNameThePageGives() async throws {
        try await serve { request in
            switch request.path {
            case "/page.html":
                .init(headers: ["Content-Type": "text/html"], body: Data("<!doctype html><title>Link</title><a id=\"a\" href=\"/note.txt\" download=\"renamed.txt\">note</a>".utf8))
            case "/note.txt":
                .init(headers: ["Content-Type": "text/plain"], body: Data("a note".utf8))
            default:
                .init(status: 404)
            }
        }
        let model = await makeDownloadsModel()
        let view = try XCTUnwrap(model.webView)
        try startDownload("/page.html", in: model)
        // The title is set once the page is parsed: the link is there.
        try await eventually("the page is loaded") { view.url?.path == "/page.html" && view.title == "Link" && !view.isLoading }
        _ = try await view.evaluateJavaScript("document.getElementById('a').click()")
        let item = try await waitForPhase(.finished, in: model)
        XCTAssertEqual(item.fileName, "renamed.txt")
        XCTAssertEqual(try String(contentsOf: downloadsDirectory.appending(path: "renamed.txt"), encoding: .utf8), "a note")
        XCTAssertEqual(view.url?.path, "/page.html", "the page stays where it was")
    }

    func testTwoDownloadsOfTheSameNameDoNotWriteOverEachOther() async throws {
        try await serve { request in
            .init(headers: ["Content-Type": "text/plain", "Content-Disposition": "attachment; filename=\"same.txt\""], body: Data(request.path.utf8))
        }
        let model = await makeDownloadsModel()
        try startDownload("/first", in: model)
        _ = try await waitForPhase(.finished, in: model)
        try startDownload("/second", in: model)
        try await eventually("the second download ends") { model.downloads.list.items.count == 2 && model.downloads.list.runningCount == 0 }
        XCTAssertEqual(filesInDownloads(), ["same (1).txt", "same.txt"])
        XCTAssertEqual(try String(contentsOf: downloadsDirectory.appending(path: "same.txt"), encoding: .utf8), "/first", "the first file is untouched")
        XCTAssertEqual(try String(contentsOf: downloadsDirectory.appending(path: "same (1).txt"), encoding: .utf8), "/second")
    }

    /// Two downloads that start together would pick the same free name: the name of the first is held until its file is written.
    func testANameIsHeldForTheDownloadThatClaimedItUntilItsFileExists() async throws {
        let model = await makeDownloadsModel()
        let first = try model.downloads.claim("report.pdf")
        let second = try model.downloads.claim("Report.PDF")
        let third = try model.downloads.claim("report.pdf")
        XCTAssertEqual([first, second, third].map(\.lastPathComponent), ["report.pdf", "Report (1).PDF", "report (2).pdf"])
        XCTAssertEqual(first.deletingLastPathComponent().standardizedFileURL, downloadsDirectory.standardizedFileURL)
    }

    func testTheFolderOfTheDownloadsIsMadeWhenItIsNotThere() async throws {
        let model = await makeDownloadsModel()
        XCTAssertFalse(FileManager.default.fileExists(atPath: downloadsDirectory.path))
        _ = try model.downloads.claim("a.txt")
        var isFolder: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: downloadsDirectory.path, isDirectory: &isFolder))
        XCTAssertTrue(isFolder.boolValue)
    }

    // MARK: Cancelling, failing, resuming

    private func stalledFile(length: Int = 1_000_000) -> ScriptedServer.Handler {
        { _ in
            .init(headers: ["Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"big.bin\""],
                  body: Data(repeating: 7, count: length), stallAfter: 50_000)
        }
    }

    func testCancellingStopsTheDownloadAndRemovesWhatWasWritten() async throws {
        try await serve(stalledFile())
        let model = await makeDownloadsModel()
        try startDownload("/big", in: model)
        try await eventually("bytes are coming in", { (model.downloads.list.items.first?.receivedBytes ?? 0) > 0 })
        XCTAssertEqual(model.downloads.strip, .running(name: "big.bin", fraction: model.downloads.list.items.first?.fraction, more: 0))
        let id = try XCTUnwrap(model.downloads.list.items.first?.id)

        model.downloads.cancel(id)
        XCTAssertEqual(model.downloads.list.item(id)?.phase, .cancelled)
        try await Task.sleep(for: .milliseconds(500))  // WebKit reports the cancellation as a failure: the line must not change
        XCTAssertEqual(model.downloads.list.item(id)?.phase, .cancelled)
        XCTAssertEqual(filesInDownloads(), [], "the part that was written is removed")
        XCTAssertNil(model.downloads.strip, "a cancelled line is not announced")
        scripted.release()
    }

    func testADownloadThatEndsEarlyFailsWithAReasonAndLeavesNoFile() async throws {
        try await serve { _ in
            // No ETag, no `Accept-Ranges`: nothing to resume from.
            .init(headers: ["Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"cut.bin\""],
                  body: Data(repeating: 1, count: 1_000), announcedLength: 100_000)
        }
        let model = await makeDownloadsModel()
        try startDownload("/cut", in: model)
        let item = try await waitForPhase(.failed, in: model)
        XCTAssertFalse(try XCTUnwrap(item.failure).isEmpty, "the person is told what went wrong")
        XCTAssertFalse(item.canResume)
        XCTAssertEqual(filesInDownloads(), [], "a failed download leaves no half file")
        XCTAssertEqual(model.downloads.strip, .failed(name: "cut.bin"))
    }

    func testADownloadThatFailedResumesFromWhatWasReceived() async throws {
        let whole = Data((0..<100_000).map { UInt8($0 % 251) })
        try await serve { request in
            var headers = ["Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"whole.bin\"",
                           "ETag": "\"v1\"", "Last-Modified": "Mon, 01 Jan 2024 00:00:00 GMT", "Accept-Ranges": "bytes"]
            if let range = request.headers["range"], let start = Int(range.dropFirst("bytes=".count).prefix { $0.isNumber }) {
                headers["Content-Range"] = "bytes \(start)-\(whole.count - 1)/\(whole.count)"
                return .init(status: 206, headers: headers, body: whole.dropFirst(start))
            }
            return .init(headers: headers, body: whole.prefix(40_000), announcedLength: whole.count)
        }
        let model = await makeDownloadsModel()
        try startDownload("/whole", in: model)
        let failed = try await waitForPhase(.failed, in: model)
        XCTAssertTrue(failed.canResume, "the server gave a validator and said it takes ranges: WebKit hands back what a resumption needs")

        await model.downloads.resume(failed.id)
        let done = try await waitForPhase(.finished, in: model)
        XCTAssertEqual(done.id, failed.id, "the same line goes on")
        XCTAssertEqual(try Data(contentsOf: downloadsDirectory.appending(path: done.fileName)), whole, "the file is the whole of what the server has, byte for byte")
        XCTAssertTrue(scripted.requests.contains { $0.headers["range"] != nil }, "the resumption asked for the rest, not for everything again")
        XCTAssertEqual(filesInDownloads(), [done.fileName])
    }

    func testADownloadGoesOnWhenItsTabIsFreed() async throws {
        try await serve(stalledFile(length: 200_000))
        let model = await makeDownloadsModel()
        let tab = try XCTUnwrap(model.activeTab)
        try startDownload("/big", in: model)
        try await eventually("bytes are coming in", { (model.downloads.list.items.first?.receivedBytes ?? 0) > 0 })
        model.putToSleep(tab.id)
        XCTAssertFalse(model.awakeTabIds.contains(tab.id))
        scripted.release()
        let item = try await waitForPhase(.finished, in: model)
        XCTAssertEqual(item.receivedBytes, 200_000)
        XCTAssertEqual(try Data(contentsOf: downloadsDirectory.appending(path: item.fileName)).count, 200_000)
    }

    // MARK: The list

    func testRemovingALineKeepsItsFileAndDeletingTheFileRemovesBoth() async throws {
        try await serve { request in
            .init(headers: ["Content-Type": "text/plain", "Content-Disposition": "attachment; filename=\"\(request.path.dropFirst()).txt\""], body: Data("x".utf8))
        }
        let model = await makeDownloadsModel()
        try startDownload("/keep", in: model)
        let keep = try await waitForPhase(.finished, in: model)
        try startDownload("/gone", in: model)
        try await eventually("the second ends") { model.downloads.list.items.count == 2 && model.downloads.list.runningCount == 0 }
        let gone = try XCTUnwrap(model.downloads.list.items.first { $0.id != keep.id })
        XCTAssertNotNil(model.downloads.fileURL(of: gone))

        model.downloads.remove(keep.id)
        XCTAssertNil(model.downloads.list.item(keep.id))
        XCTAssertEqual(filesInDownloads(), ["gone.txt", "keep.txt"], "taking a line off the list does not delete the file")

        model.downloads.deleteFile(gone.id)
        XCTAssertEqual(filesInDownloads(), ["keep.txt"])
        XCTAssertTrue(model.downloads.list.items.isEmpty)
    }

    func testClearingTheListKeepsWhatRuns() async throws {
        try await serve { request in
            request.path == "/big"
                ? .init(headers: ["Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"big.bin\""], body: Data(repeating: 7, count: 100_000), stallAfter: 10_000)
                : .init(headers: ["Content-Type": "text/plain", "Content-Disposition": "attachment; filename=\"small.txt\""], body: Data("x".utf8))
        }
        let model = await makeDownloadsModel()
        try startDownload("/small", in: model)
        _ = try await waitForPhase(.finished, in: model)
        try startDownload("/big", in: model)
        try await eventually("the big one runs", { model.downloads.list.runningCount == 1 })
        model.downloads.clearEnded()
        XCTAssertEqual(model.downloads.list.items.map(\.phase), [.running])
        XCTAssertEqual(filesInDownloads().filter { $0 == "small.txt" }, ["small.txt"], "the file of a cleared line stays")
        scripted.release()
    }

    func testTheGuardKeepsEveryFileOperationInsideTheFolder() async throws {
        let model = await makeDownloadsModel()
        for hostile in ["../escape.txt", "a/b.txt", "..", "", "/etc/hosts", "sub/../../x"] {
            XCTAssertNil(model.downloads.inside(hostile), "\(hostile.debugDescription)")
        }
        XCTAssertEqual(model.downloads.inside("a b (1).txt")?.lastPathComponent, "a b (1).txt")
        XCTAssertEqual(model.downloads.inside("%2e%2e.txt")?.lastPathComponent, "%2e%2e.txt", "a name is a name: nothing is decoded")
    }

    // MARK: The lock

    private func makeLockedModel() async -> (BrowserModel, LockController) {
        let file = LockSettingsFile(url: directory.appending(path: LockSettingsFile.fileName))
        let lock = LockController(authenticator: Owner(), file: file)
        let model = BrowserModel.launch(directory: directory.appending(path: "files"), lock: lock, embeddedLists: { nil }, downloadsDirectory: downloadsDirectory)
        await model.prepare()
        return (model, lock)
    }

    func testTheLinesOfALockedSpaceAreShownNowhereAndComeBackWhenItOpens() async throws {
        try await serve(stalledFile(length: 100_000))
        let (model, lock) = await makeLockedModel()
        // No `load` here: its waiter would take the place of the navigation delegate, which is the one that downloads.
        let space = model.activeSpace.id
        try startDownload("/big", in: model)
        try await eventually("bytes are coming in", { (model.downloads.list.items.first?.receivedBytes ?? 0) > 0 })
        XCTAssertEqual(model.downloads.list.items.first?.spaceId, space, "a line knows the space of the page that asked")
        XCTAssertNotNil(model.downloads.strip)
        XCTAssertEqual(model.downloads.visibleItems.count, 1)

        let locked = await lock.setSpace(space, guarded: true)
        XCTAssertTrue(locked)
        XCTAssertTrue(model.activeSpaceCovered)
        XCTAssertTrue(model.downloads.visibleItems.isEmpty, "the list names nothing of a locked space")
        XCTAssertNil(model.downloads.strip, "nor does the strip: a file's name and host tell what was being read")
        XCTAssertNil(model.shareURL, "no address of a covered page to share")
        XCTAssertFalse(model.canSavePDF)
        XCTAssertEqual(model.downloads.list.items.count, 1, "the line is not lost: only hidden")

        scripted.release()
        try await eventually("the hidden download ends", { model.downloads.list.items.first?.phase == .finished })
        XCTAssertNil(model.downloads.strip, "the end of a hidden download is not announced")
        XCTAssertFalse(model.downloads.hasEndedVisible)
        model.downloads.clearEnded()
        XCTAssertEqual(model.downloads.list.items.count, 1, "clearing the list does not clear what the person cannot see")

        let opened = await lock.unlock(space: space)
        XCTAssertTrue(opened)
        XCTAssertEqual(model.downloads.visibleItems.map(\.fileName), ["big.bin"])
        XCTAssertEqual(model.downloads.strip, .saved(name: "big.bin"))
    }

    func testTheDownloadsSheetClosesWhenTheApplicationIsLocked() async throws {
        let (model, lock) = await makeLockedModel()
        let turnedOn = await lock.setLockApp(true)
        XCTAssertTrue(turnedOn)
        model.downloads.sheetShown = true
        lock.lockAll()
        XCTAssertTrue(lock.appLocked)
        XCTAssertFalse(model.downloads.sheetShown, "a sheet cannot stay over the lock screen")
    }

    // MARK: Pages that go out

    func testTheStartPageIsNeitherSharedNorSavedAndAWebPageIsBoth() async throws {
        let model = await makeDownloadsModel()
        XCTAssertNil(model.shareURL, "the start page has no address to give")
        XCTAssertFalse(model.canSavePDF)
        try await load("/a.html", in: model)
        XCTAssertEqual(model.shareURL, address("/a.html"))
        XCTAssertTrue(model.canSavePDF)
    }

    func testAWebPageCanBeSearchedWithTheSystemFindBarAndTheStartPageCannot() async throws {
        let model = await makeDownloadsModel()
        XCTAssertFalse(model.canFindInPage, "the start page has no web text to search")
        try await load("/a.html", in: model)
        let view = try XCTUnwrap(model.webView)
        XCTAssertTrue(view.isFindInteractionEnabled)
        XCTAssertTrue(model.canFindInPage)
        let interaction = try XCTUnwrap(view.findInteraction)
        var shown: [UIFindInteraction] = []
        model.presentFind = { shown.append($0) }
        model.findInPage()
        XCTAssertEqual(shown.count, 1, "the entry of the menu asks for the find bar")
        XCTAssertTrue(shown.first === interaction, "on the page that is on screen")
    }

    func testAPageIsSavedAsAWholePdfNamedAfterItsTitle() async throws {
        let tall = (0..<40).map { "<p style=\"height:100px;margin:0\">line \($0)</p>" }.joined()
        try await serve { _ in
            .init(headers: ["Content-Type": "text/html"], body: Data("<!doctype html><meta charset=utf-8><title>Rapport: Q3/2026</title><body style=\"margin:0\">\(tall)".utf8))
        }
        let model = await makeDownloadsModel()
        let view = try XCTUnwrap(model.webView)
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
        let waiter = NavigationWaiter()
        try await waiter.load(in: view) { view.load(URLRequest(url: url("/tall.html"))) }
        try await eventually("the title is in the line of the tab", { model.activeTab?.title == "Rapport: Q3/2026" })

        await model.savePageAsPDF()
        let item = try XCTUnwrap(model.downloads.list.items.first)
        XCTAssertEqual(item.phase, .finished, "\(String(describing: item.failure))")
        XCTAssertEqual(item.fileName, "Rapport- Q3-2026.pdf", "the slash and the colon of a title become dashes")
        XCTAssertEqual(filesInDownloads(), ["Rapport- Q3-2026.pdf"])
        let data = try Data(contentsOf: downloadsDirectory.appending(path: item.fileName))
        XCTAssertEqual(data.prefix(5), Data("%PDF-".utf8))
        let document = try XCTUnwrap(CGPDFDocument(CGDataProvider(data: data as CFData)!))
        var height: CGFloat = 0
        for number in 1...document.numberOfPages { height += document.page(at: number)?.getBoxRect(.mediaBox).height ?? 0 }
        XCTAssertGreaterThan(height, 3_500, "the whole page is drawn (4000 points of it), not only the 700 that are on screen")
        XCTAssertEqual(model.downloads.strip, .saved(name: "Rapport- Q3-2026.pdf"))
    }

    func testAPageThatCannotBeWrittenFailsItsLineAndSaysSo() async throws {
        // A plain file where the folder of the downloads should be: nothing can be made there.
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("in the way".utf8).write(to: downloadsDirectory)
        let model = await makeDownloadsModel()
        model.downloads.save(pdf: Data("%PDF-".utf8), title: "A page", host: "example.com")
        let item = try XCTUnwrap(model.downloads.list.items.first)
        XCTAssertEqual(item.phase, .failed)
        XCTAssertFalse(try XCTUnwrap(item.failure).isEmpty)
        XCTAssertNotNil(model.downloads.problem, "the failure is kept for the screen")
        XCTAssertEqual(model.downloads.strip, .failed(name: "example.com"))
    }

    func testAPageThatCannotBeMadeIntoAPdfIsToldToThePerson() async throws {
        struct NoPDF: Error {}
        let model = await makeDownloadsModel()
        model.downloads.failPDF(host: "example.com", error: NoPDF())
        let item = try XCTUnwrap(model.downloads.list.items.first)
        XCTAssertEqual(item.phase, .failed)
        XCTAssertNotNil(model.downloads.problem)
    }

    // MARK: The wiring

    private func response(mime: String, disposition: String?) -> URLResponse {
        var headers = ["Content-Type": mime]
        if let disposition { headers["Content-Disposition"] = disposition }
        return HTTPURLResponse(url: URL(string: "https://example.com/f")!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    }

    func testTheNavigationDelegateAsksThePolicy() async throws {
        let model = await makeDownloadsModel()
        let view = try XCTUnwrap(model.webView)
        XCTAssertTrue(view.navigationDelegate === model.navigationPolicy, "the views of the tabs are made with the delegate that downloads")

        XCTAssertEqual(DownloadNavigation.policy(shouldPerformDownload: true, address: URL(string: "https://example.com/a.zip")), .download)
        XCTAssertEqual(DownloadNavigation.policy(shouldPerformDownload: true, address: URL(string: "file:///private/var/mobile/secret")), .cancel,
                       "a page cannot make the application copy a file of the phone")
        XCTAssertEqual(DownloadNavigation.policy(shouldPerformDownload: false, address: URL(string: "https://example.com/page")), .allow)

        XCTAssertEqual(DownloadNavigation.policy(canShowMIMEType: false, response: response(mime: "application/zip", disposition: nil)), .download)
        XCTAssertEqual(DownloadNavigation.policy(canShowMIMEType: true, response: response(mime: "text/html", disposition: nil)), .allow)
        XCTAssertEqual(DownloadNavigation.policy(canShowMIMEType: true, response: response(mime: "text/html", disposition: "attachment; filename=a.html")), .download)
        XCTAssertEqual(DownloadNavigation.policy(canShowMIMEType: true, response: response(mime: "application/pdf", disposition: "inline")), .allow,
                       "a PDF is shown in the page; saving it is the person's choice")
    }

    func testTheApplicationAsksForItsFolderToShowInTheFilesApp() {
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "UIFileSharingEnabled") as? Bool, true, "without it the folder does not show in Files")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "LSSupportsOpeningDocumentsInPlace") as? Bool, true)
        XCTAssertEqual(DownloadsModel.defaultDirectory().lastPathComponent, "Downloads")
        XCTAssertEqual(DownloadsModel.defaultDirectory().deletingLastPathComponent().standardizedFileURL, URL.documentsDirectory.standardizedFileURL)
    }
}
