import Foundation
import Testing
@testable import LuciumKit

/// The shared vectors (`ios/Contracts/blocker-vectors.json`), also run against the Mac's TypeScript by `src/shared/ios-blocker-contract.test.ts`.
struct BlockerVectors: Decodable {
    struct Normalize: Decodable { let input: String; let expect: String? }
    struct Exempt: Decodable { let url: String; let hosts: [String]; let expect: Bool }
    struct Clean: Decodable { let input: JSONValue; let expect: [String] }
    struct Level: Decodable { let name: String; let settings: [String: JSONValue]; let expect: String? }
    struct Choose: Decodable { let level: String; let option: String; let patch: [String: JSONValue] }

    let normalizeBlockHost: [Normalize]
    let isBlockingExempt: [Exempt]
    let cleanBlockExceptions: [Clean]
    let parseSiteHost: [Normalize]
    let cleanClearOnClose: [Clean]
    let protectionLevel: [Level]
    let chooseLevel: [Choose]

    static func load() throws -> BlockerVectors {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appending(path: "Contracts/blocker-vectors.json")
        return try JSONDecoder().decode(BlockerVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("Blocker vectors shared with the Mac")
struct BlockerContractTests {
    private func state(settings: [String: JSONValue]) -> BrowserState {
        var state = BrowserState(spaces: [Space(id: "s", name: "S", emoji: "🏠", profileId: "p")], activeSpaceId: "s", activeTabBySpace: ["s": nil])
        state.rest["settings"] = .object(settings)
        return state
    }

    @Test func vectorsAreNotEmpty() throws {
        let vectors = try BlockerVectors.load()
        #expect(vectors.normalizeBlockHost.count > 12)
        #expect(vectors.isBlockingExempt.count > 6)
        #expect(vectors.parseSiteHost.count > 18)
        #expect(vectors.protectionLevel.count > 8)
        #expect(vectors.chooseLevel.count == 3)
    }

    @Test func normalizeBlockHostMatchesTheVectors() throws {
        for vector in try BlockerVectors.load().normalizeBlockHost { #expect(BlockHost.normalize(vector.input) == vector.expect, "\(vector.input)") }
    }

    @Test func isBlockingExemptMatchesTheVectors() throws {
        for vector in try BlockerVectors.load().isBlockingExempt { #expect(BlockHost.isExempt(vector.url, in: vector.hosts) == vector.expect, "\(vector.url) in \(vector.hosts)") }
    }

    @Test func cleanBlockExceptionsMatchesTheVectors() throws {
        for vector in try BlockerVectors.load().cleanBlockExceptions { #expect(BlockHost.clean(vector.input) == vector.expect, "\(vector.input)") }
    }

    @Test func parseSiteHostMatchesTheVectors() throws {
        for vector in try BlockerVectors.load().parseSiteHost { #expect(SiteHostEntry.parse(vector.input) == vector.expect, "\(vector.input)") }
    }

    @Test func cleanClearOnCloseMatchesTheVectors() throws {
        for vector in try BlockerVectors.load().cleanClearOnClose { #expect(SiteHostEntry.clean(vector.input) == vector.expect, "\(vector.input)") }
    }

    @Test func theLevelOfTheSettingsMatchesTheMacs() throws {
        let names: [ProtectionLevel?: String?] = [.standard: "standard", .enhanced: "renforcee", .strict: "stricte", nil: nil]
        for vector in try BlockerVectors.load().protectionLevel {
            let level = state(settings: vector.settings).privacy.level
            #expect(names[level] == .some(vector.expect), "\(vector.name)")
        }
    }

    @Test func choosingALevelWritesWhatTheMacWrites() throws {
        let keys = ["standard": ProtectionLevel.standard, "enhanced": .enhanced, "strict": .strict]
        for vector in try BlockerVectors.load().chooseLevel {
            // From the opposite settings, so that every key the level stands for is written.
            var after = state(settings: [:])
            var settings = after.privacy
            settings.choose(vector.level == "strict" ? .standard : .strict)
            settings.choose(try #require(keys[vector.level]))
            after.privacy = settings
            guard case .object(let written)? = after.rest["settings"] else { Issue.record("no settings"); return }
            for (key, value) in vector.patch { #expect(written[key] == value, "\(vector.option): \(key)") }
        }
    }
}
