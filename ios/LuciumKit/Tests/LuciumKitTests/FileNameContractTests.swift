import Foundation
import Testing
@testable import LuciumKit

/// The shared vectors (`ios/Contracts/file-name-vectors.json`), also run against the Mac's TypeScript by `src/shared/ios-file-names-contract.test.ts`.
struct FileNameVectors: Decodable {
    /// A text, or a text repeated so that a long name does not fill the file.
    indirect enum Text: Decodable {
        case plain(String)
        case repeated(String, times: Int, prefix: Text?, suffix: Text?)

        private struct Repeat: Decodable { let `repeat`: String; let times: Int; let prefix: Text?; let suffix: Text? }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let plain = try? container.decode(String.self) {
                self = .plain(plain)
            } else {
                let spec = try container.decode(Repeat.self)
                self = .repeated(spec.repeat, times: spec.times, prefix: spec.prefix, suffix: spec.suffix)
            }
        }

        var value: String {
            switch self {
            case .plain(let text): text
            case .repeated(let unit, let times, let prefix, let suffix):
                (prefix?.value ?? "") + String(repeating: unit, count: times) + (suffix?.value ?? "")
            }
        }
    }

    struct Suggested: Decodable { let input: Text; let expect: Text }
    struct Unique: Decodable { let name: String; let taken: [String]; let expect: String }
    struct PdfName: Decodable { let title: Text; let expect: Text }
    let suggested: [Suggested]
    let unique: [Unique]
    let pdfName: [PdfName]

    static func load() throws -> FileNameVectors {
        // …/ios/LuciumKit/Tests/LuciumKitTests/FileNameContractTests.swift → …/ios/Contracts/file-name-vectors.json
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/file-name-vectors.json")
        return try JSONDecoder().decode(FileNameVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("File name vectors shared with the Mac")
struct FileNameContractTests {
    @Test func vectorsAreNotEmpty() throws {
        let vectors = try FileNameVectors.load()
        #expect(vectors.suggested.count > 20)
        #expect(vectors.unique.count > 5)
        #expect(vectors.pdfName.count > 5)
    }

    @Test func suggestedNamesMatchTheVectors() throws {
        for vector in try FileNameVectors.load().suggested {
            let input = vector.input.value
            #expect(FileNames.suggested(input) == vector.expect.value, "suggested(\(input.prefix(40).debugDescription), \(input.count) characters)")
        }
    }

    @Test func uniqueNamesMatchTheVectors() throws {
        for vector in try FileNameVectors.load().unique {
            let taken = Set(vector.taken.map { $0.lowercased() })
            let got = UniqueFileName.next(vector.name) { taken.contains($0.lowercased()) }
            #expect(got == vector.expect, "next(\(vector.name)) with \(vector.taken) taken")
        }
    }

    @Test func pdfNamesMatchTheVectors() throws {
        for vector in try FileNameVectors.load().pdfName {
            let title = vector.title.value
            #expect(PageShare.pdfFileName(title: title) == vector.expect.value, "pdfFileName(\(title.prefix(40).debugDescription))")
        }
    }
}
