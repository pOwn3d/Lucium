import Foundation

/// What the person may send out of the page they are looking at: its address, and its content as a PDF.
public enum PageShare {
    /// The address to share: an `http` or `https` one, without the credentials it may carry (`user:password@`), which nobody means to pass on
    /// with a link. The fragment stays (it points into the page). `nil` for anything else: the start page, `about:blank`, a `file:` address.
    public static func shareableURL(_ address: String?) -> URL? {
        guard let address, var components = URLComponents(string: address), let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = components.host, !host.isEmpty else { return nil }
        components.user = nil
        components.password = nil
        return components.url
    }

    /// The name proposed for a page saved as PDF: the title of the page, cleaned, with ".pdf". The twin of `pdfFileName` in `src/shared/pdf-source.ts`
    /// (the same vectors). A title is not a path: "AC/DC" must not lose "AC", so a slash and a colon become a dash. A page with no title gets
    /// `fallback` (the Mac says "page"; the application can give the host).
    public static func pdfFileName(title: String?, fallback: String = "page") -> String {
        let hasTitle = title?.unicodeScalars.contains { !FileNames.isSpace($0) } ?? false
        let source = hasTitle ? (title ?? "").replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-") : fallback
        let name = FileNames.suggested(source)
        return name.lowercased().hasSuffix(".pdf") ? name : name + ".pdf"
    }
}
