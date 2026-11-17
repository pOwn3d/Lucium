import Foundation
import Testing
@testable import LuciumKit

private func rules(youtubeCalls: String = #"[["json-prune",["adPlacements"]],["set-constant",["ytInitialPlayerResponse.adSlots","emptyArr"]]]"#) throws -> GuardRules {
    try GuardRules.decode(Data("""
    {"schema":1,
     "youtube":{"domain":"youtube.com","scriptlets":\(youtubeCalls),"css":"ytd-ad-slot-renderer{display:none!important}",
                "networkRules":[{"trigger":{"url-filter":"^[a-z]+://([^/]+\\\\.)?youtube\\\\.com/pagead/"},"action":{"type":"block"}}]},
     "consentWalls":{"css":"#onetrust-consent-sdk{display:none!important}"}}
    """.utf8))
}

private func table() throws -> ScriptletTable {
    var table = ScriptletTable()
    try table.merge(Data(#"{"schema":1,"domains":{"site.example":[["aopr",["ads"]]],"youtube.com":[["aopr",["fromList"]]]}}"#.utf8), category: .ads)
    try table.merge(Data(#"{"schema":1,"domains":{"site.example":[["aopr",["banner"]]]}}"#.utf8), category: .cookies)
    return table
}

private func plan(_ address: String?, _ settings: GuardSettings = GuardSettings()) throws -> PagePlan {
    PagePlanner.plan(for: address, settings: settings, table: try table(), rules: try rules())
}

@Suite("What a page is given when it starts")
struct PageGuardTests {
    @Test func aYouTubePageGetsTheYouTubeRulesTheConsentWallsAndWhatTheListsNameForIt() throws {
        let plan = try plan("https://www.youtube.com/watch?v=abc")
        #expect(plan.scriptlets.map(\.id) == ["json-prune", "set-constant", "aopr"])
        #expect(plan.scriptlets.last?.args == ["fromList"])
        #expect(plan.css.contains("ytd-ad-slot-renderer"))
        #expect(plan.css.contains("#onetrust-consent-sdk"))
    }

    @Test func anotherSiteGetsTheConsentWallsAndItsOwnCalls() throws {
        let plan = try plan("https://site.example/page")
        #expect(plan.scriptlets.map { $0.args[0] } == ["ads", "banner"])
        #expect(plan.css == "#onetrust-consent-sdk{display:none!important}")
        #expect(try !plan.css.contains("ytd-ad-slot-renderer") && PagePlanner.plan(for: "https://other.example/", settings: GuardSettings(), table: table(), rules: rules()).scriptlets.isEmpty)
    }

    @Test func thePlanIsWrittenInTheShapeTheRuntimeReads() throws {
        let plan = PagePlan(scriptlets: [ScriptletCall(id: "set-constant", args: ["a.b", "true"])], css: "x{}")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        #expect(String(decoding: try encoder.encode(plan), as: UTF8.self) == #"{"css":"x{}","scriptlets":[{"args":["a.b","true"],"id":"set-constant"}]}"#)
    }

    @Test func theAdsSwitchControlsTheYouTubeRulesAndTheAdsLists() throws {
        let plan = try plan("https://www.youtube.com/watch", GuardSettings(blockAds: false))
        #expect(plan.scriptlets.isEmpty, "no YouTube rule, and the list's call is an ads one")
        #expect(!plan.css.contains("ytd-ad-slot-renderer"))
        #expect(plan.css.contains("#onetrust-consent-sdk"), "the consent walls follow their own switch")
    }

    @Test func theCookieBannerSwitchControlsTheConsentWallsAndTheCookieLists() throws {
        let plan = try plan("https://site.example/", GuardSettings(blockCookieBanners: false))
        #expect(plan.scriptlets.map { $0.args[0] } == ["ads"])
        #expect(plan.css.isEmpty)
    }

    @Test func theExtendedRulesSwitchStopsTheListsButNotTheYouTubeRules() throws {
        let youtube = try plan("https://www.youtube.com/watch", GuardSettings(blockScriptlets: false))
        #expect(youtube.scriptlets.map(\.id) == ["json-prune", "set-constant"], "on the Mac the YouTube rules do not wait for the extended rules")
        #expect(try plan("https://site.example/", GuardSettings(blockScriptlets: false)).scriptlets.isEmpty)
    }

    @Test func aSiteWithAnExceptionGetsNothingAtAll() throws {
        let settings = GuardSettings(exemptSites: ["site.example", "YouTube.com"])
        #expect(try plan("https://www.site.example/", settings).isEmpty)
        #expect(try plan("https://www.youtube.com/watch", settings).isEmpty)
        #expect(try !plan("https://other.example/", settings).isEmpty, "a site that is not named keeps its consent walls")
    }

    @Test func onlyAWebPageGetsAPlan() throws {
        for address in [nil, "", "about:blank", "file:///tmp/a.html", "ftp://site.example/", "mailto:a@site.example", "not an address"] {
            #expect(try plan(address).isEmpty, "\(address ?? "nil")")
        }
    }

    @Test func aPageWithNoRulesAtAllGetsAnEmptyPlan() throws {
        let plan = PagePlanner.plan(for: "https://site.example/", settings: GuardSettings(), table: ScriptletTable(), rules: nil)
        #expect(plan == .empty)
    }

    @Test func nameTheCompiledRulesAfterTheirContent() throws {
        let one = try rules()
        let same = try rules()
        let other = try GuardRules.decode(Data(#"{"schema":1,"youtube":{"domain":"youtube.com","scriptlets":[],"css":"","networkRules":[]},"consentWalls":{"css":""}}"#.utf8))
        #expect(one.networkRulesIdentifier == same.networkRulesIdentifier)
        #expect(one.networkRulesIdentifier != other.networkRulesIdentifier)
        #expect(one.networkRulesIdentifier.hasPrefix(GuardRules.identifierPrefix))
    }

    @Test func refusesRulesOfAnotherSchema() throws {
        #expect(throws: GuardRules.RulesError.unsupportedSchema(9)) {
            try GuardRules.decode(Data(#"{"schema":9,"youtube":{"domain":"youtube.com","scriptlets":[],"css":"","networkRules":[]},"consentWalls":{"css":""}}"#.utf8))
        }
    }
}

/// The shared vectors (`ios/Contracts/guard-vectors.json`), also run against the Mac's TypeScript by `src/shared/ios-contract.test.ts`.
@Suite("Page vectors shared with the Mac")
struct GuardContractTests {
    struct Vectors: Decodable {
        struct Case: Decodable { let input: String?; let expect: Bool }
        let youtube: [Case]

        static func load() throws -> Vectors {
            // …/ios/LuciumKit/Tests/LuciumKitTests/PageGuardTests.swift → …/ios/Contracts/guard-vectors.json
            let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().appending(path: "Contracts/guard-vectors.json")
            return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        }
    }

    @Test func vectorsAreNotEmpty() throws {
        let vectors = try Vectors.load()
        #expect(vectors.youtube.filter(\.expect).count > 5)
        #expect(vectors.youtube.filter { !$0.expect }.count > 5)
    }

    @Test func theYouTubePagesAreTheOnesTheMacMeans() throws {
        for vector in try Vectors.load().youtube {
            #expect(PagePlanner.isYouTubePage(vector.input) == vector.expect, "\(vector.input ?? "nil")")
        }
    }
}
