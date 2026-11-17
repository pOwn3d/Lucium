import Foundation
import Testing
@testable import LuciumKit

/// The shared vectors (`ios/Contracts/privacy-vectors.json`), also run against the Mac's TypeScript by `src/shared/ios-privacy-contract.test.ts`.
struct PrivacyVectors: Decodable {
    struct Strip: Decodable { let url: String; let expect: String? }
    struct Host: Decodable { let host: String; let expect: Bool }
    struct Rewrite: Decodable {
        let url: String
        let method: String?
        let isMainFrame: Bool?
        let options: Options
        let expect: String?
    }
    struct Options: Decodable { let httpsUpgrade: Bool; let globalPrivacyControl: Bool; let stripTrackingParams: Bool }

    let trackingParams: [Strip]
    let isUpgradableHost: [Host]
    let httpsUpgrade: [Strip]
    let rewrite: [Rewrite]

    static func load() throws -> PrivacyVectors {
        // …/ios/LuciumKit/Tests/LuciumKitTests/PrivacyContractTests.swift → …/ios/Contracts/privacy-vectors.json
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/privacy-vectors.json")
        return try JSONDecoder().decode(PrivacyVectors.self, from: Data(contentsOf: url))
    }
}

@Suite("Privacy vectors shared with the Mac")
struct PrivacyContractTests {
    @Test func vectorsAreNotEmpty() throws {
        let vectors = try PrivacyVectors.load()
        #expect(vectors.trackingParams.count > 15)
        #expect(vectors.isUpgradableHost.count > 20)
        #expect(vectors.httpsUpgrade.count > 10)
        #expect(vectors.rewrite.count > 5)
    }

    @Test func trackingParametersMatchTheVectors() throws {
        for vector in try PrivacyVectors.load().trackingParams {
            #expect(TrackingParams.strip(vector.url) == vector.expect, "strip(\(vector.url.debugDescription))")
        }
    }

    @Test func upgradableHostsMatchTheVectors() throws {
        for vector in try PrivacyVectors.load().isUpgradableHost {
            #expect(HttpsUpgrade.isUpgradableHost(vector.host) == vector.expect, "isUpgradableHost(\(vector.host.debugDescription))")
        }
    }

    @Test func httpsUpgradesMatchTheVectors() throws {
        for vector in try PrivacyVectors.load().httpsUpgrade {
            #expect(HttpsUpgrade.upgrade(vector.url) == vector.expect, "upgrade(\(vector.url.debugDescription))")
        }
    }

    @Test func rewritesMatchTheVectors() throws {
        for vector in try PrivacyVectors.load().rewrite {
            let options = PrivacyOptions(httpsUpgrade: vector.options.httpsUpgrade, globalPrivacyControl: vector.options.globalPrivacyControl,
                                         stripTrackingParams: vector.options.stripTrackingParams)
            let request = RewriteRequest(url: vector.url, method: vector.method ?? "GET", isMainFrame: vector.isMainFrame ?? true)
            #expect(PrivacyRules.rewriteNavigation(request, options: options, upgrade: HttpsUpgrade.upgrade) == vector.expect,
                    "rewrite(\(vector.url.debugDescription), \(vector.options))")
        }
    }
}
