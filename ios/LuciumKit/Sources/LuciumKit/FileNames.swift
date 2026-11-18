import Foundation

/// A file name made from what a page says (a header, an address, a title). It may hold a path, control characters, characters that reorder
/// text on screen, a name too long for the disk, or be a name the system reads as something else (".", ".."). What is offered is a plain file
/// name.
///
/// The Swift twin of `suggestedFileName` in `src/shared/file-names.ts` (the Mac, with the rules of macOS and Linux, which are those of
/// APFS on an iPhone too): the same rules, held by the same vectors (`ios/Contracts/file-name-vectors.json`, read by both test suites).
/// The Windows rules of the Mac's function have no use here.
public enum FileNames {
    /// A file name is at most 255 bytes on APFS: keep a margin for the " (12)" that makes a name unique.
    public static let maxBytes = 240
    /// What a name becomes when nothing is left of it. The Mac's word; the application passes its own, in the language of the person.
    public static let fallback = "téléchargement"
    /// A name is a short line: what comes from a page is cut before anything else is done to it (UTF-16 units, like the Mac's `slice`).
    static let maxInputUnits = 4096
    /// An extension longer than this is not one: it must not carry a name past the bound.
    static let maxExtensionBytes = 16

    /// The name proposed for a file: the last part of what the page said, cleaned, never empty, never a dot name, at most 240 bytes with its
    /// extension kept.
    public static func suggested(_ raw: String?, fallback: String = FileNames.fallback) -> String {
        let text = String(decoding: Array((raw ?? "").utf16.prefix(maxInputUnits)), as: UTF16.self)
        // Both separators count: a name made on another system can carry a path of the other kind.
        let last = text.unicodeScalars.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? []
        var scalars: [Unicode.Scalar] = []
        var lastWasSpace = false
        for scalar in last where !isUnsafe(scalar) {
            if isSpace(scalar) {
                if !lastWasSpace { scalars.append(" ") }
                lastWasSpace = true
            } else {
                scalars.append(scalar)
                lastWasSpace = false
            }
        }
        // Dots and spaces at the start (a hidden file) and at the end are dropped.
        while let first = scalars.first, first == "." || first == " " { scalars.removeFirst() }
        while let tail = scalars.last, tail == "." || tail == " " { scalars.removeLast() }
        if scalars.isEmpty { return fallback }
        return bytes(of: scalars) <= maxBytes ? String(String.UnicodeScalarView(scalars)) : cut(scalars, fallback: fallback)
    }

    /// `name` shortened to `maxBytes` with its extension kept.
    private static func cut(_ scalars: [Unicode.Scalar], fallback: String) -> String {
        let dot = scalars.lastIndex(of: ".")
        let extensionScalars = dot.flatMap { $0 > 0 ? Array(scalars[$0...]) : nil } ?? []
        let kept = bytes(of: extensionScalars) <= maxExtensionBytes ? extensionScalars : []
        var stem: [Unicode.Scalar] = []
        var used = 0
        for scalar in scalars.dropLast(kept.count) {
            used += utf8Length(scalar)
            if used > maxBytes - bytes(of: kept) { break }
            stem.append(scalar)
        }
        while let tail = stem.last, tail == "." || isSpace(tail) { stem.removeLast() }
        let name = stem.isEmpty ? Array(fallback.unicodeScalars) : stem
        return String(String.UnicodeScalarView(name + kept))
    }

    private static func bytes(of scalars: [Unicode.Scalar]) -> Int { scalars.reduce(0) { $0 + utf8Length($1) } }
    private static func utf8Length(_ scalar: Unicode.Scalar) -> Int { UTF8.width(scalar) }

    /// Control characters (C0, DEL, C1), line and paragraph separators, and the bidirectional formatting characters (U+202E turns "fdp.exe"
    /// into "exe.pdf" on screen).
    private static func isUnsafe(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x00...0x1F, 0x7F...0x9F, 0x2028, 0x2029, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069: true
        default: false
        }
    }

    /// What JavaScript's `\s` matches (the Mac collapses it to one space). Not `Character.isWhitespace`: that one leaves U+FEFF alone.
    static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }
}

/// The Swift twin of `uniquePath` in `src/main/engine/download-paths.ts`: `report.pdf` → `report (1).pdf` (then `(2)`…) when the name is taken.
public enum UniqueFileName {
    /// `filename` (a plain name, as `FileNames.suggested` gives it), or the first numbered variant `isTaken` does not refuse. The caller says what is taken:
    /// a file on the disk, or a name promised to a download that has not written its file yet. Names are compared without regard to case (the volume of
    /// an iPhone is case-insensitive, like the Mac's), so `isTaken` must compare that way too.
    public static func next(_ filename: String, isTaken: (String) -> Bool) -> String {
        let name = filename
        let last = fileExtension(of: name)
        // A tarball keeps its two extensions together: `backup.tar.gz` becomes `backup (1).tar.gz`, not `backup.tar (1).gz` (which no tool would unpack).
        var ext = last
        if !last.isEmpty {
            let beforeLast = String(name.dropLast(last.count))
            // At least one character before ".tar": the Mac's `/.\.tar$/i`.
            if beforeLast.count > 4, beforeLast.lowercased().hasSuffix(".tar") { ext = String(name.suffix(last.count + 4)) }
        }
        let stem = String(name.dropLast(ext.count))
        var candidate = name
        var n = 1
        while isTaken(candidate) {
            candidate = "\(stem) (\(n))\(ext)"
            n += 1
        }
        return candidate
    }

    /// Node's `extname`: from the last dot, but a dot that starts the name is not an extension.
    private static func fileExtension(of name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
        return String(name[dot...])
    }
}
