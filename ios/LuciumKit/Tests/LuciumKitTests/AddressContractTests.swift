import Foundation
import Testing
@testable import LuciumKit

/// The shared vectors (`ios/Contracts/address-vectors.json`), also run against the Mac's TypeScript by `src/shared/ios-contract.test.ts`.
struct AddressVectors: Decodable {
    struct Resolve: Decodable {
        struct Expected: Decodable { let kind: String; let url: String }
        let input: String
        let expect: Expected?
    }
    struct Host: Decodable { let input: String; let expect: String }
    let searchTemplate: String
    let resolve: [Resolve]
    let host: [Host]

    static func load() throws -> AddressVectors {
        // …/ios/LuciumKit/Tests/LuciumKitTests/AddressContractTests.swift → …/ios/Contracts/address-vectors.json
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/address-vectors.json")
        return try JSONDecoder().decode(AddressVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("Address vectors shared with the Mac")
struct AddressContractTests {
    @Test func vectorsAreNotEmpty() throws {
        let vectors = try AddressVectors.load()
        #expect(vectors.resolve.count > 10)
        #expect(vectors.host.count > 3)
    }

    @Test func resolveMatchesTheVectors() throws {
        let vectors = try AddressVectors.load()
        for vector in vectors.resolve {
            let got = AddressResolver.resolve(vector.input, searchTemplate: vectors.searchTemplate)
            switch (vector.expect, got) {
            case (nil, nil): break
            case let (expected?, got?):
                let want: ResolvedInput = expected.kind == "url" ? .url(expected.url) : .search(expected.url)
                #expect(got == want, "resolve(\(vector.input.debugDescription))")
            default:
                Issue.record("resolve(\(vector.input.debugDescription)): expected \(String(describing: vector.expect)), got \(String(describing: got))")
            }
        }
    }

    @Test func hostMatchesTheVectors() throws {
        for vector in try AddressVectors.load().host {
            #expect(AddressResolver.host(of: vector.input) == vector.expect, "host(\(vector.input.debugDescription))")
        }
    }
}
