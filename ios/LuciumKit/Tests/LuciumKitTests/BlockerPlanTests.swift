import Foundation
import Testing
@testable import LuciumKit

@Suite("What the blocker attaches to a page")
struct BlockerPlanTests {
    private let ads = BlockerPlan.Part(source: .catalogue(.ads), kind: .network)
    private let adsHiding = BlockerPlan.Part(source: .catalogue(.ads), kind: .cosmetic)
    private let banners = BlockerPlan.Part(source: .catalogue(.cookies), kind: .network)
    private let bannersHiding = BlockerPlan.Part(source: .catalogue(.cookies), kind: .cosmetic)
    private let youtube = BlockerPlan.Part(source: .youtube, kind: .network)
    private let builtin = BlockerPlan.Part(source: .builtin, kind: .network)
    private var all: [BlockerPlan.Part] { [ads, adsHiding, banners, bannersHiding, youtube, builtin] }
    private let page = "https://news.example.org/story"

    @Test func aNewProfileAttachesEveryList() {
        #expect(BlockerPlan.attached(all, settings: .newProfile, page: page) == all)
    }

    @Test func theAdsSwitchTakesTheAdsListsAndTheYouTubeRulesAway() {
        var settings = PrivacySettings.newProfile
        settings.blockAds = false
        #expect(BlockerPlan.attached(all, settings: settings, page: page) == [banners, bannersHiding, builtin])
    }

    @Test func theBannersSwitchTakesTheCookieListsAway() {
        var settings = PrivacySettings.newProfile
        settings.blockCookieBanners = false
        #expect(BlockerPlan.attached(all, settings: settings, page: page) == [ads, adsHiding, youtube, builtin])
    }

    @Test func bothSwitchesOffAttachNothing() {
        var settings = PrivacySettings.newProfile
        settings.blockAds = false
        settings.blockCookieBanners = false
        #expect(BlockerPlan.attached(all, settings: settings, page: page).isEmpty, "the built-in list included: it follows either switch")
    }

    @Test func theHidingSwitchKeepsTheNetworkRulesAndDropsTheHidingFiles() {
        var settings = PrivacySettings.newProfile
        settings.blockCosmetic = false
        #expect(BlockerPlan.attached(all, settings: settings, page: page) == [ads, banners, youtube, builtin])
    }

    @Test func aSiteOfTheListOfExceptionsAttachesNothingAndItsSubdomainsEither() {
        var settings = PrivacySettings.newProfile
        settings.blockExceptions = ["example.org"]
        #expect(BlockerPlan.attached(all, settings: settings, page: "https://www.example.org/").isEmpty)
        #expect(BlockerPlan.attached(all, settings: settings, page: "https://news.example.org/story").isEmpty)
        #expect(BlockerPlan.attached(all, settings: settings, page: "https://example.net/") == all, "another site is blocked as before")
        #expect(BlockerPlan.attached(all, settings: settings, page: nil) == all, "no page yet: nothing to exempt")
    }
}

@Suite("The Standard mode of the blocker, written for WebKit")
struct StandardModeRulesTests {
    private func rules(_ text: String) throws -> [[String: Any]] {
        try #require(try JSONSerialization.jsonObject(with: Data(try StandardModeRules.transform(text).utf8)) as? [[String: Any]])
    }

    private func loadType(_ rule: [String: Any]) -> [String]? { (rule["trigger"] as? [String: Any])?["load-type"] as? [String] }

    @Test func aBlockingRuleThatSaysNothingOfThePartyIsLimitedToThirdParties() throws {
        let out = try rules(#"[{"trigger":{"url-filter":"ads\\.js"},"action":{"type":"block"}},{"trigger":{"url-filter":"cookie"},"action":{"type":"block-cookies"}}]"#)
        #expect(out.map(loadType) == [["third-party"], ["third-party"]])
    }

    @Test func aRuleWrittenForAPartyKeepsIt() throws {
        let out = try rules(#"[{"trigger":{"url-filter":"a","load-type":["first-party"]},"action":{"type":"block"}},{"trigger":{"url-filter":"b","load-type":["third-party"]},"action":{"type":"block"}}]"#)
        #expect(out.map(loadType) == [["first-party"], ["third-party"]], "`$first-party` is what the Mac lets through to a site's own requests")
    }

    @Test func everyOtherKindOfRuleIsLeftAsItIs() throws {
        let out = try rules(#"[{"trigger":{"url-filter":"x","if-domain":["*a.test"]},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":".*"},"action":{"type":"css-display-none","selector":".ad"}},{"trigger":{"url-filter":"y"},"action":{"type":"make-https"}}]"#)
        #expect(out.map(loadType) == [nil, nil, nil])
    }

    @Test func theOrderAndTheOtherFieldsOfTheRulesAreKept() throws {
        let out = try rules(#"[{"trigger":{"url-filter":"one","resource-type":["script"],"unless-domain":["*b.test"]},"action":{"type":"block"}},{"trigger":{"url-filter":"two"},"action":{"type":"block"}}]"#)
        #expect((out[0]["trigger"] as? [String: Any])?["url-filter"] as? String == "one")
        #expect((out[1]["trigger"] as? [String: Any])?["url-filter"] as? String == "two")
        #expect((out[0]["trigger"] as? [String: Any])?["resource-type"] as? [String] == ["script"])
        #expect((out[0]["trigger"] as? [String: Any])?["unless-domain"] as? [String] == ["*b.test"])
    }

    @Test func textThatIsNotAListOfRulesIsRefused() {
        #expect(throws: StandardModeRules.Failure.notRules) { try StandardModeRules.transform("not json") }
        #expect(throws: StandardModeRules.Failure.notRules) { try StandardModeRules.transform(#"{"trigger":{}}"#) }
    }

    @Test func aListHasItsOwnNameInEachModeAndAFileOfAnotherKindHasOne() {
        let network = FilterListFile(name: "easylist.json", kind: .network, rules: 1, sha256: "0123456789abcdef0123")
        let cosmetic = FilterListFile(name: "easylist.cosmetic.json", kind: .cosmetic, rules: 1, sha256: "fedcba9876543210fedc")
        #expect(network.storeIdentifier(for: .strict) == network.storeIdentifier)
        #expect(network.storeIdentifier(for: .standard) == network.storeIdentifier + ".std")
        #expect(cosmetic.storeIdentifier(for: .standard) == cosmetic.storeIdentifier(for: .strict), "the hiding does not depend on the mode")
    }
}

@Suite("The list of sites where nothing is blocked")
struct BlockHostTests {
    @Test func checkSaysWhyASiteIsRefused() {
        let hosts = ["example.com"]
        #expect(BlockHost.check("other.test", in: hosts) == .host("other.test"))
        #expect(BlockHost.check("HTTPS://Other.test/x", in: hosts) == .host("other.test"))
        #expect(BlockHost.check("not a host", in: hosts) == .invalid)
        #expect(BlockHost.check("www.example.com", in: hosts) == .alreadyListed)
        #expect(BlockHost.check("shop.example.com", in: hosts) == .coveredBy("example.com"))
        let full = (0..<BlockHost.exceptionsMax).map { "site\($0).test" }
        #expect(BlockHost.check("one-more.test", in: full) == .full)
    }

    @Test func aSavedListIsBounded() {
        let many = JSONValue.array((0..<(BlockHost.exceptionsMax + 20)).map { .string("site\($0).test") })
        #expect(BlockHost.clean(many).count == BlockHost.exceptionsMax)
    }
}
