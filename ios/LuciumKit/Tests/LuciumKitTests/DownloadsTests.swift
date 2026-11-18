import Foundation
import Testing
@testable import LuciumKit

@Suite("What turns a navigation into a download")
struct DownloadPolicyTests {
    @Test func aPageThatTheWebViewCannotShowIsDownloaded() {
        #expect(DownloadPolicy.shouldDownload(canShowMIMEType: false, contentDisposition: nil))
        #expect(!DownloadPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: nil))
    }

    @Test func anAttachmentIsDownloadedEvenWhenItsTypeCanBeShown() {
        #expect(DownloadPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: "attachment; filename=\"report.pdf\""))
        #expect(DownloadPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: "  Attachment ;filename=x"))
        #expect(DownloadPolicy.shouldDownload(canShowMIMEType: true, contentDisposition: "ATTACHMENT"))
    }

    @Test func inlineAndLookAlikesAreNotAttachments() {
        #expect(!DownloadPolicy.isAttachment(contentDisposition: "inline; filename=\"attachment\""))
        #expect(!DownloadPolicy.isAttachment(contentDisposition: "inline"))
        #expect(!DownloadPolicy.isAttachment(contentDisposition: "attachments"))
        #expect(!DownloadPolicy.isAttachment(contentDisposition: "x-attachment"))
        #expect(!DownloadPolicy.isAttachment(contentDisposition: ""))
        #expect(!DownloadPolicy.isAttachment(contentDisposition: nil))
    }

    @Test func aPageMayAskForOnlyTheAddressesThatHaveAUse() {
        for address in ["https://example.com/a.zip", "http://example.com/a.zip", "HTTPS://EXAMPLE.COM/a", "blob:https://example.com/1234", "data:text/plain,hello"] {
            #expect(DownloadPolicy.canDownload(URL(string: address)), "\(address)")
        }
        for address in ["file:///private/var/mobile/secret", "ftp://example.com/a", "javascript:alert(1)", "about:blank", "lucium://x"] {
            #expect(!DownloadPolicy.canDownload(URL(string: address)), "\(address)")
        }
        #expect(!DownloadPolicy.canDownload(nil))
    }
}

@Suite("The list of downloads")
struct DownloadListTests {
    private func running(_ id: String = "a") -> DownloadList {
        var list = DownloadList()
        list.begin(id: id, source: "example.com")
        list.named(id: id, fileName: "report.pdf")
        return list
    }

    @Test func aNewDownloadGoesToTheTopAndRuns() {
        var list = running("a")
        list.begin(id: "b", source: "other.org")
        #expect(list.items.map(\.id) == ["b", "a"])
        #expect(list.runningCount == 2)
        list.begin(id: "a", source: "again.net")
        #expect(list.items.count == 2, "an id that is already there is not added twice")
        #expect(list.item("a")?.source == "example.com")
    }

    @Test func progressIsAFractionOfTheAnnouncedSize() {
        var list = running()
        #expect(list.item("a")?.fraction == nil, "no size announced: no fraction")
        list.progress(id: "a", received: 250, total: 1000)
        #expect(list.item("a")?.fraction == 0.25)
        list.progress(id: "a", received: 5000, total: 1000)
        #expect(list.item("a")?.fraction == 1, "never above 1")
        list.progress(id: "a", received: -5, total: -1)
        #expect(list.item("a")?.receivedBytes == 0)
        #expect(list.item("a")?.fraction == nil)
    }

    @Test func aFinishedDownloadStaysFinishedWhateverWebKitSaysNext() {
        var list = running()
        list.progress(id: "a", received: 10, total: 100)
        list.finish(id: "a")
        #expect(list.item("a")?.phase == .finished)
        #expect(list.item("a")?.fraction == 1)
        #expect(list.item("a")?.receivedBytes == 100)
        list.progress(id: "a", received: 20, total: 100)
        list.fail(id: "a", message: "late", canResume: true)
        list.cancel(id: "a")
        #expect(list.item("a")?.phase == .finished)
        #expect(list.item("a")?.failure == nil)
        #expect(list.item("a")?.receivedBytes == 100)
    }

    @Test func aCancelledDownloadIsNotTurnedIntoAFailureByTheErrorThatFollows() {
        var list = running()
        list.cancel(id: "a")
        list.fail(id: "a", message: "cancelled", canResume: true)
        #expect(list.item("a")?.phase == .cancelled)
        #expect(list.item("a")?.canResume == false)
        #expect(list.item("a")?.failure == nil)
    }

    @Test func aFailureKeepsItsMessageAndWhetherItCanResume() {
        var list = running()
        list.progress(id: "a", received: 40, total: 100)
        list.fail(id: "a", message: "The network connection was lost.", canResume: true)
        let failed = list.item("a")
        #expect(failed?.phase == .failed)
        #expect(failed?.failure == "The network connection was lost.")
        #expect(failed?.canResume == true)
        #expect(failed?.fraction == 0.4)
        list.resumed(id: "a")
        #expect(list.item("a")?.phase == .running)
        #expect(list.item("a")?.failure == nil)
        #expect(list.item("a")?.receivedBytes == 40, "a resumption starts where the line was")
        list.resumed(id: "a")
        #expect(list.item("a")?.phase == .running)
    }

    @Test func theSizeOfTheWrittenFileIsTheSizeOfAFinishedDownloadEvenWhenNoProgressWasReported() {
        var list = running()
        list.finish(id: "a", size: 11)
        #expect(list.item("a")?.phase == .finished)
        #expect(list.item("a")?.receivedBytes == 11, "a small file ends before WebKit reports any progress")
        #expect(list.item("a")?.totalBytes == 11)
        #expect(list.item("a")?.fraction == 1)
        var announced = running("b")
        announced.progress(id: "b", received: 10, total: 100)
        announced.finish(id: "b", size: 90)
        #expect(announced.item("b")?.receivedBytes == 90, "the file that was written wins over what the server announced")
        var unknown = running("c")
        unknown.progress(id: "c", received: 10, total: 100)
        unknown.finish(id: "c")
        #expect(unknown.item("c")?.receivedBytes == 100, "no size read: the announced size stands")
    }

    @Test func aLineOfACoveredSpaceIsNotVisible() {
        var list = DownloadList()
        list.begin(id: "open", source: "a.org", spaceId: "work")
        list.begin(id: "locked", source: "b.org", spaceId: "home")
        list.begin(id: "unknown", source: "c.org")
        #expect(list.visible(hiding: { _ in false }).map(\.id) == ["unknown", "locked", "open"])
        #expect(list.visible(hiding: { $0 == "home" }).map(\.id) == ["unknown", "open"])
        #expect(list.visible(hiding: { _ in true }).isEmpty, "the whole application is locked: nothing shows")
        #expect(list.items.count == 3, "hidden is not removed")
    }

    @Test func aLineThatIsNotFailedCannotBeResumed() {
        var list = running()
        list.finish(id: "a")
        list.resumed(id: "a")
        #expect(list.item("a")?.phase == .finished)
    }

    @Test func clearingRemovesWhatEndedAndNeverWhatRuns() {
        var list = running("a")
        list.begin(id: "b", source: "x")
        list.begin(id: "c", source: "x")
        list.finish(id: "a")
        list.fail(id: "b", message: "no", canResume: false)
        #expect(list.hasEnded)
        list.clearEnded()
        #expect(list.items.map(\.id) == ["c"])
        #expect(!list.hasEnded)
        list.remove(id: "c")
        #expect(list.items.isEmpty)
        list.finish(id: "unknown")
        #expect(list.items.isEmpty, "an id that is not there changes nothing")
    }
}

@Suite("What the person shares")
struct PageShareTests {
    @Test func onlyAWebAddressIsShared() {
        #expect(PageShare.shareableURL("https://example.com/a?b=1")?.absoluteString == "https://example.com/a?b=1")
        #expect(PageShare.shareableURL("http://example.com")?.absoluteString == "http://example.com")
        for address in ["about:blank", "file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "https://", "", "not an address", nil] {
            #expect(PageShare.shareableURL(address) == nil, "\(String(describing: address))")
        }
    }

    @Test func credentialsAreLeftOutAndTheFragmentIsKept() {
        #expect(PageShare.shareableURL("https://user:secret@example.com/path#part")?.absoluteString == "https://example.com/path#part")
        #expect(PageShare.shareableURL("https://token@example.com/")?.absoluteString == "https://example.com/")
    }

    @Test func aPageWithNoTitleGetsTheNameItIsGiven() {
        #expect(PageShare.pdfFileName(title: "", fallback: "example.com") == "example.com.pdf")
        #expect(PageShare.pdfFileName(title: nil) == "page.pdf")
        #expect(PageShare.pdfFileName(title: "  ", fallback: "") == "téléchargement.pdf", "an empty fallback is still a name")
    }
}
