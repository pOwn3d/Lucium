import Foundation

/// The page a new tab shows. Built from the catalogue, so that its text is in the language of the interface like everything else.
enum StartPage {
    static func html(bundle: Bundle = .main) -> String {
        let title = String(localized: "start.title", bundle: bundle)
        let body = String(localized: "start.body", bundle: bundle)
        return """
        <!doctype html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(escape(title))</title>
        <style>
        :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
        body { margin: 0; padding: 48px 24px; line-height: 1.45; }
        h1 { font-size: 28px; margin: 0 0 12px; }
        p { font-size: 17px; margin: 0; opacity: .75; }
        </style></head>
        <body><h1>\(escape(title))</h1><p>\(escape(body))</p></body></html>
        """
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}
