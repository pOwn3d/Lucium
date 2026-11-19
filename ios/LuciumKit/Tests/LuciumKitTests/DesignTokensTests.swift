import Foundation
import XCTest

/// The iOS counterpart of `src/renderer/stylesheets.test.ts`: a view names a role of `Tokens.swift` (a radius, a gap, a status colour), never a
/// number or a colour of its own. Reads the sources of the application, so it runs with `swift test`, with no simulator.
final class DesignTokensTests: XCTestCase {
    private static let appFolder: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Lucium")

    /// The files that may write a value: the tokens themselves.
    private static let allowed: Set<String> = ["Tokens.swift"]

    private static func sources() throws -> [(name: String, lines: [String])] {
        let names = try FileManager.default.contentsOfDirectory(atPath: appFolder.path).filter { $0.hasSuffix(".swift") && !allowed.contains($0) }.sorted()
        return try names.map { ($0, try String(contentsOf: appFolder.appendingPathComponent($0), encoding: .utf8).components(separatedBy: "\n")) }
    }

    /// Lines of `lines` that match `pattern`, comments excluded, as "File:line: text".
    static func violations(of pattern: String, in files: [(name: String, lines: [String])]) -> [String] {
        let regex = try! NSRegularExpression(pattern: pattern)
        var found: [String] = []
        for file in files {
            for (index, line) in file.lines.enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                if regex.firstMatch(in: code, range: NSRange(code.startIndex..., in: code)) != nil { found.append("\(file.name):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))") }
            }
        }
        return found
    }

    func testTheTokensFileExistsAndTheScanSeesTheSources() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: Self.appFolder.appendingPathComponent("Tokens.swift").path))
        XCTAssertGreaterThan(try Self.sources().count, 20, "the scan found too few files: the path is wrong")
    }

    func testNoCornerRadiusIsWrittenByHand() throws {
        XCTAssertEqual(Self.violations(of: #"cornerRadius:\s*[0-9]|cornerRadius:\s*size\s*\*"#, in: try Self.sources()), [], "use Radius.s / m / l / xl")
    }

    func testNoColourIsWrittenByHand() throws {
        let hand = #"Color\(\.sRGB|Color\(red:|Color\(white:|Color\.(black|white|red|orange|green|blue|yellow|gray|indigo|pink|purple|teal|mint|cyan|brown)\b|\.(foregroundStyle|tint|fill|background)\(\.(black|white|red|orange|green|blue|yellow|gray|indigo|pink|purple|teal|mint|cyan|brown)\)|#[0-9a-fA-F]{6}"#
        XCTAssertEqual(Self.violations(of: hand, in: try Self.sources()), [], "use a role of Tokens.swift (Color.danger, .success, .pinned…) or the system's semantic colours")
    }

    func testTheScanSeesAViolation() {
        let sample = [(name: "Sample.swift", lines: ["Text(\"x\").foregroundStyle(.red)", "RoundedRectangle(cornerRadius: 12)", "Color.accentColor // Color.red"])]
        XCTAssertEqual(Self.violations(of: #"cornerRadius:\s*[0-9]"#, in: sample).count, 1)
        XCTAssertEqual(Self.violations(of: #"\.(foregroundStyle)\(\.(red)\)"#, in: sample).count, 1)
        XCTAssertEqual(Self.violations(of: #"Color\.(red)\b"#, in: sample).count, 0, "a comment is not code")
    }
}
