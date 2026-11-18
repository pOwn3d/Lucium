import LuciumKit
import SwiftUI
import WebKit

/// The downloads of the application: what WebKit hands over (`WKDownload`), where the files go, and the list the person sees. A file is written in
/// `Documents/Downloads`, which the Files app shows (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`): "On My iPhone › Lucium › Downloads".
/// From there the person opens it, shares it, or moves it where they like. Nothing leaves the phone by our hand, and no download starts unless a
/// page, a link or a response asks for one (the person's own navigation).
///
/// The decisions are pure and live in `LuciumKit` (`DownloadPolicy`, `FileNames`, `UniqueFileName`, `DownloadList`); this class only carries them out.
@MainActor @Observable
final class DownloadsModel: NSObject, WKDownloadDelegate {
    /// What the strip above the bottom bar says.
    enum Strip: Equatable {
        case running(name: String, fraction: Double?, more: Int)
        case saved(name: String)
        case failed(name: String)
    }

    private(set) var list = DownloadList()
    /// Whether a space is covered by the lock (`BrowserModel` gives the real answer). The lines of a covered space are not shown anywhere.
    @ObservationIgnored var isCovered: (String) -> Bool = { _ in false }
    var sheetShown = false
    /// Something the person asked for went wrong on the disk (a file that could not be removed, a folder that could not be made).
    private(set) var problem: String?
    /// The line of the list whose end the strip announces, for a few seconds.
    private(set) var announced: String?
    let directory: URL

    /// What the application holds for a download that is under way (or failed with something to resume from).
    private struct Live {
        let id: String
        /// Kept: nothing else holds a `WKDownload`, and one that is let go is cancelled.
        let download: WKDownload
        weak var origin: WKWebView?
        var destination: URL?
        var resumeData: Data?
        var observers: [NSKeyValueObservation] = []
    }

    @ObservationIgnored private var live: [ObjectIdentifier: Live] = [:]
    /// The names promised to downloads that have not written their file yet, in lower case (the volume does not tell `a.pdf` from `A.PDF`).
    @ObservationIgnored private var reserved: Set<String> = []
    @ObservationIgnored private var announceTask: Task<Void, Never>?
    @ObservationIgnored private let announceFor: Duration

    init(directory: URL, announceFor: Duration = .seconds(5)) {
        self.directory = directory
        self.announceFor = announceFor
        super.init()
    }

    /// The folder of the downloads: the one the Files app shows.
    static func defaultDirectory() -> URL {
        URL.documentsDirectory.appending(path: "Downloads", directoryHint: .isDirectory)
    }

    // MARK: What the screen shows

    /// The lines of the list the person may see: none of a space the lock covers.
    var visibleItems: [DownloadItem] { list.visible(hiding: isCovered) }
    /// Whether "Clear list" has something to clear.
    var hasEndedVisible: Bool { visibleItems.contains { $0.phase != .running } }

    /// The strip: the download that runs (with how many others), else the end that was just announced.
    var strip: Strip? {
        let running = visibleItems.filter { $0.phase == .running }
        if let lead = running.first {
            return .running(name: label(of: lead), fraction: lead.fraction, more: running.count - 1)
        }
        if let id = announced, let item = visibleItems.first(where: { $0.id == id }) {
            switch item.phase {
            case .finished: return .saved(name: label(of: item))
            case .failed: return .failed(name: label(of: item))
            case .running, .cancelled: return nil
            }
        }
        return nil
    }

    /// How a line is called: its file, else where it comes from (the file is not named until the server has answered).
    func label(of item: DownloadItem) -> String {
        if !item.fileName.isEmpty { return item.fileName }
        return item.source.isEmpty ? String(localized: "download.fallback-name") : item.source
    }

    /// The file of a finished line, when it is still where it was put.
    func fileURL(of item: DownloadItem) -> URL? {
        guard item.phase == .finished, let url = inside(item.fileName), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    // MARK: A download starts

    /// A navigation became a download (`didBecome`): the application takes it over. `spaceId` is the space of the page that asked.
    func adopt(_ download: WKDownload, spaceId: String = "") {
        download.delegate = self
        let id = UUID().uuidString.lowercased()
        var entry = Live(id: id, download: download, origin: download.webView)
        entry.observers = observe(download.progress, id: id)
        live[ObjectIdentifier(download)] = entry
        list.begin(id: id, source: AddressResolver.host(of: download.originalRequest?.url?.absoluteString ?? ""), spaceId: spaceId)
    }

    private func observe(_ progress: Progress, id: String) -> [NSKeyValueObservation] {
        // KVO answers on whatever thread WebKit uses: the numbers are read there, and the change is made on the main actor.
        let changed: @Sendable (Progress, Any) -> Void = { [weak self] progress, _ in
            let received = progress.completedUnitCount
            let total = progress.totalUnitCount
            Task { @MainActor in self?.list.progress(id: id, received: received, total: total) }
        }
        return [progress.observe(\.completedUnitCount, options: [.initial], changeHandler: changed),
                progress.observe(\.totalUnitCount, options: [], changeHandler: changed)]
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        guard let entry = live[ObjectIdentifier(download)] else { return nil }
        // A resumption keeps the file it was writing.
        if let destination = entry.destination { return destination }
        do {
            let destination = try claim(suggestedFilename)
            live[ObjectIdentifier(download)]?.destination = destination
            list.named(id: entry.id, fileName: destination.lastPathComponent)
            return destination
        } catch {
            end(download, failure: "the folder of the downloads is not usable: \(error)", message: error.localizedDescription)
            return nil
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let entry = live.removeValue(forKey: ObjectIdentifier(download)) else { return }
        list.finish(id: entry.id, size: entry.destination.flatMap(fileSize(of:)))
        if let name = list.item(entry.id)?.fileName { release(name) }
        announce(entry.id)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        guard let entry = live[key] else { return }
        // A line that already ended (cancelled by the person) is not told again: WebKit reports the cancellation as a failure.
        guard list.item(entry.id)?.phase == .running else { discard(key); return }
        let canResume = resumeData != nil && entry.origin != nil
        live[key]?.resumeData = canResume ? resumeData : nil
        list.fail(id: entry.id, message: error.localizedDescription, canResume: canResume)
        print("[downloads] \(entry.destination?.lastPathComponent ?? "a download") failed: \(error)")
        if !canResume { removePartialFile(of: entry) }
        if !canResume { discard(key) }
        announce(entry.id)
    }

    // MARK: What the person does

    func cancel(_ id: String) {
        guard let key = live.first(where: { $0.value.id == id })?.key, let entry = live[key], list.item(id)?.phase == .running else { return }
        // The line ends first, so that the failure WebKit reports next does not read as one.
        list.cancel(id: id)
        entry.download.cancel { _ in }
        removePartialFile(of: entry)
        discard(key)
    }

    /// Starts a failed download again from what was received, in the same line.
    func resume(_ id: String) async {
        guard let key = live.first(where: { $0.value.id == id })?.key, let entry = live[key], let data = entry.resumeData, let origin = entry.origin,
              list.item(id)?.phase == .failed else { return }
        list.resumed(id: id)
        live[key] = nil
        let download = await origin.resumeDownload(fromResumeData: data)
        download.delegate = self
        var next = Live(id: id, download: download, origin: origin)
        next.destination = entry.destination
        next.observers = observe(download.progress, id: id)
        live[ObjectIdentifier(download)] = next
    }

    func remove(_ id: String) {
        if let key = live.first(where: { $0.value.id == id })?.key, let entry = live[key] {
            if list.item(id)?.phase == .running { entry.download.cancel { _ in } }
            removePartialFile(of: entry)
            discard(key)
        }
        if let item = list.item(id) { release(item.fileName) }
        list.remove(id: id)
    }

    /// Removes the file of a line, and the line.
    func deleteFile(_ id: String) {
        guard let item = list.item(id) else { return }
        if item.phase == .finished, let url = inside(item.fileName) {
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                report("the file \(item.fileName) was not removed: \(error)")
                return
            }
        }
        remove(id)
    }

    /// Clears the lines the person sees that are not running: a line of a covered space is not theirs to clear from here.
    func clearEnded() {
        for item in visibleItems where item.phase != .running { remove(item.id) }
    }

    // MARK: A page saved as PDF

    /// Writes the PDF of a page in the folder of the downloads, as one more line of the list. The name comes from the title of the page.
    func save(pdf: Data, title: String?, host: String, spaceId: String = "") {
        let id = UUID().uuidString.lowercased()
        list.begin(id: id, source: host, spaceId: spaceId)
        do {
            let destination = try claim(PageShare.pdfFileName(title: title, fallback: host.isEmpty ? "page" : host))
            list.named(id: id, fileName: destination.lastPathComponent)
            do {
                try pdf.write(to: destination, options: .atomic)
            } catch {
                release(destination.lastPathComponent)
                list.fail(id: id, message: error.localizedDescription, canResume: false)
                report("the PDF \(destination.lastPathComponent) was not written: \(error)")
                announce(id)
                return
            }
            release(destination.lastPathComponent)
            list.progress(id: id, received: Int64(pdf.count), total: Int64(pdf.count))
            list.finish(id: id)
        } catch {
            list.fail(id: id, message: error.localizedDescription, canResume: false)
            report("the folder of the downloads is not usable: \(error)")
        }
        announce(id)
    }

    /// A PDF that could not even be made: the page said no.
    func failPDF(host: String, error: Error, spaceId: String = "") {
        let id = UUID().uuidString.lowercased()
        list.begin(id: id, source: host, spaceId: spaceId)
        list.fail(id: id, message: error.localizedDescription, canResume: false)
        report("the page could not be made into a PDF: \(error)")
        announce(id)
    }

    // MARK: Files

    /// A free name in the folder for what the page suggested, cleaned; the folder is made if it is not there. The name is held until the file is written.
    func claim(_ suggested: String) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = FileNames.suggested(suggested, fallback: String(localized: "download.fallback-name"))
        let unique = UniqueFileName.next(name) { candidate in
            reserved.contains(candidate.lowercased()) || FileManager.default.fileExists(atPath: directory.appending(path: candidate).path)
        }
        reserved.insert(unique.lowercased())
        return directory.appending(path: unique)
    }

    private func release(_ name: String) { reserved.remove(name.lowercased()) }

    /// The size of a file that was written, read from the file (not a timestamp: nothing to declare in the privacy manifest).
    private func fileSize(of url: URL) -> Int64? {
        do {
            return try url.resourceValues(forKeys: [.fileSizeKey]).fileSize.map(Int64.init)
        } catch {
            print("[downloads] the size of \(url.lastPathComponent) cannot be read, the last progress stands: \(error)")
            return nil
        }
    }

    /// The file of a name of the list, only when it is inside the folder of the downloads (nothing outside it is ever read or removed).
    func inside(_ name: String) -> URL? {
        guard !name.isEmpty, !name.contains("/") else { return nil }
        let url = directory.appending(path: name).standardizedFileURL
        return url.path.hasPrefix(directory.standardizedFileURL.path + "/") ? url : nil
    }

    private func removePartialFile(of entry: Live) {
        guard let destination = entry.destination else { return }
        release(destination.lastPathComponent)
        guard let url = inside(destination.lastPathComponent), FileManager.default.fileExists(atPath: url.path) else { return }
        do { try FileManager.default.removeItem(at: url) } catch { report("the partial file \(destination.lastPathComponent) was not removed: \(error)") }
    }

    private func discard(_ key: ObjectIdentifier) { live[key] = nil }

    /// A download that cannot start (or go on): its line fails, with the reason for the log and the words for the person.
    private func end(_ download: WKDownload, failure: String, message: String) {
        let key = ObjectIdentifier(download)
        guard let entry = live[key] else { return }
        list.fail(id: entry.id, message: message, canResume: false)
        report(failure)
        discard(key)
        announce(entry.id)
    }

    private func announce(_ id: String) {
        announced = id
        announceTask?.cancel()
        announceTask = Task { [weak self, announceFor] in
            do { try await Task.sleep(for: announceFor) } catch { return }  // cancelled: a newer end owns the strip
            if self?.announced == id { self?.announced = nil }
        }
    }

    /// Something could not be done on the disk: the failure is logged where it happened, and kept for the screen and the tests.
    func report(_ message: String) {
        problem = message
        print("[downloads] \(message)")
    }

    func dismissProblem() { problem = nil }
}
