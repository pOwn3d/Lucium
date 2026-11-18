import Foundation

/// What turns a navigation into a download. The decisions are made here, on plain values, so that `swift test` proves them; the web view only asks.
public enum DownloadPolicy {
    /// The addresses a page may ask to download. `file:` is not one: a page must not make the application copy a file of the phone into the
    /// folder the person browses in Files, and `ftp:` and the like have no use here.
    public static let allowedSchemes: Set<String> = ["http", "https", "blob", "data"]

    /// Whether a link marked `download` (or any navigation WebKit says should download) may be followed.
    public static func canDownload(_ url: URL?) -> Bool {
        guard let scheme = url?.scheme?.lowercased() else { return false }
        return allowedSchemes.contains(scheme)
    }

    /// Whether the header `Content-Disposition` asks for a download: its type is `attachment` (`inline`, or no header, leaves the choice to the
    /// type of the content). The parameters (`filename=…`) are not read here: WebKit hands the suggested name over, and it is cleaned later.
    public static func isAttachment(contentDisposition: String?) -> Bool {
        guard let header = contentDisposition else { return false }
        let type = header.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        return type.trimmingCharacters(in: .whitespaces).lowercased() == "attachment"
    }

    /// A response is downloaded when the web view cannot show its type (an archive, a binary…) or when the server says `attachment`.
    public static func shouldDownload(canShowMIMEType: Bool, contentDisposition: String?) -> Bool {
        !canShowMIMEType || isAttachment(contentDisposition: contentDisposition)
    }
}
