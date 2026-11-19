import Foundation
import Testing
@testable import LuciumKit

private func state(settings: [String: JSONValue]? = nil) -> BrowserState {
    var state = BrowserState(spaces: [Space(id: "s", name: "S", emoji: "🏠", profileId: "p")], activeSpaceId: "s", activeTabBySpace: ["s": nil])
    if let settings { state.rest["settings"] = .object(settings) }
    return state
}

@Suite("Privacy settings in the state file")
struct PrivacySettingsTests {
    @Test func aStateWithNoSettingsIsANewProfileAtTheEnhancedLevel() {
        let settings = state().privacy
        #expect(settings == .newProfile)
        #expect(settings.level == .enhanced)
        #expect(settings.options == PrivacyOptions(httpsUpgrade: true, globalPrivacyControl: true, stripTrackingParams: true))
    }

    @Test func aProfileOfTheMacThatNeverChoseHasTheEarlierDefaults() {
        // The Mac's rule (`mergeSettings`): a key that was never written is what the profile had before « Renforcée » became the default.
        let settings = state(settings: ["searchUrlTemplate": .string("https://duckduckgo.com/?q=%s")]).privacy
        #expect(settings == .earlierProfile)
        #expect(settings.level == .standard)
        #expect(settings.httpsUpgrade, "HTTPS first is older than the four others and stays on")
    }

    @Test func aValueThatIsNotAFlagNeverSwitchesARewriteOn() {
        let settings = state(settings: ["sendGpc": .string("yes"), "stripTrackingParams": .number(1), "stripCopiedLinks": .null, "httpsUpgrade": .string("no")]).privacy
        #expect(!settings.sendGpc && !settings.stripTrackingParams && !settings.stripCopiedLinks)
        #expect(settings.httpsUpgrade, "a damaged HTTPS flag gives the default back, as on the Mac")
    }

    @Test func theFlagsTheMacWroteAreRead() {
        let settings = state(settings: ["httpsUpgrade": .bool(false), "sendGpc": .bool(true), "stripTrackingParams": .bool(false), "stripCopiedLinks": .bool(true)]).privacy
        #expect(settings == PrivacySettings(httpsUpgrade: false, sendGpc: true, stripTrackingParams: false, stripCopiedLinks: true))
        #expect(settings.level == nil, "neither level: the settings stay as chosen")
    }

    @Test func choosingALevelWritesEverythingItStandsForAndLeavesHttpsAlone() {
        var settings = PrivacySettings(httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false)
        settings.choose(.enhanced)
        #expect(settings == PrivacySettings(httpsUpgrade: false, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true, blockCookieBanners: true))
        #expect(settings.level == .enhanced)
        settings.choose(.strict)
        #expect(settings == PrivacySettings(httpsUpgrade: false, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true, blockCookieBanners: true,
                                            blockScriptlets: true, blockMode: .strict))
        #expect(settings.level == .strict)
        settings.choose(.standard)
        #expect(settings == PrivacySettings(httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false))
        #expect(settings.level == .standard)
    }

    @Test func choosingALevelKeepsTheListsOfSitesAndTheSwitchesThatAreNotALevel() {
        var settings = PrivacySettings.newProfile
        settings.blockExceptions = ["example.com"]
        settings.clearOnClose = .init(enabled: true, sites: ["a.example"], onQuit: true)
        settings.choose(.strict)
        settings.choose(.standard)
        #expect(settings.blockExceptions == ["example.com"])
        #expect(settings.clearOnClose == .init(enabled: true, sites: ["a.example"], onQuit: true))
    }

    @Test func aSwitchOutsideTheLevelsMakesTheLevelCustom() {
        var settings = PrivacySettings.newProfile
        #expect(settings.level == .enhanced)
        settings.blockAds = false
        #expect(settings.level == nil)
        settings = .newProfile
        settings.blockMode = .strict
        #expect(settings.level == nil, "strict mode alone is neither « Renforcée » nor « Stricte »")
        settings = .newProfile
        settings.blockCookieBanners = false
        #expect(settings.level == nil)
    }

    @Test func theAdsSwitchIsReadAndWrittenWithItsAlias() {
        // Either key on blocks (`adsBlockingOn`): a file that carries the alias alone is still blocking.
        #expect(state(settings: ["blockAds": .bool(false), "blockTrackers": .bool(true)]).privacy.blockAds)
        #expect(!state(settings: ["blockAds": .bool(false), "blockTrackers": .bool(false)]).privacy.blockAds)
        #expect(state(settings: ["sendGpc": .bool(true)]).privacy.blockAds, "neither written: the default, on")
        var after = state(settings: ["blockAds": .bool(true)])
        var settings = after.privacy
        settings.blockAds = false
        after.privacy = settings
        guard case .object(let written)? = after.rest["settings"] else { Issue.record("no settings"); return }
        #expect(written["blockAds"] == .bool(false))
        #expect(written["blockTrackers"] == .bool(false), "the Mac writes both: a file with one of them left on would still block")
    }

    @Test func theBlockerKeysOfTheMacAreRead() {
        let settings = state(settings: [
            "blockCookieBanners": .bool(true), "blockCosmetic": .bool(false), "blockScriptlets": .bool(true), "blockMode": .string("strict"),
            "blockExceptions": .array([.string("Example.com"), .string("https://www.other.test/x"), .number(3), .string("bad host")]),
            "siteDataClearOnCloseEnabled": .bool(true), "siteDataClearOnClose": .array([.string("shop.example"), .string("localhost:3000"), .string("not a host")]),
            "siteDataClearOnQuit": .bool(true),
        ]).privacy
        #expect(settings.blockCookieBanners && !settings.blockCosmetic && settings.blockScriptlets && settings.blockMode == .strict)
        #expect(settings.blockExceptions == ["example.com", "other.test"])
        #expect(settings.clearOnClose == .init(enabled: true, sites: ["shop.example", "localhost:3000"], onQuit: true))
    }

    @Test func aModeThatIsNotOneOfTheTwoNeverSwitchesTheStricterFilteringOn() {
        #expect(state(settings: ["blockMode": .string("paranoid")]).privacy.blockMode == .standard)
        #expect(state(settings: ["blockMode": .bool(true)]).privacy.blockMode == .standard)
    }

    @Test func theKeysThatAreNotOursSurviveAndTheModeOfASiteIsKept() {
        var before = state(settings: ["blockModeSites": .object(["example.com": .string("strict")]), "reduceFingerprint": .bool(true), "blockMode": .string("standard")])
        before.privacy.blockMode = .strict
        guard case .object(let written)? = before.rest["settings"] else { Issue.record("no settings"); return }
        #expect(written["blockModeSites"] == .object(["example.com": .string("strict")]), "the mode of a site is the Mac's, kept as it is")
        #expect(written["reduceFingerprint"] == .bool(true), "choosing or changing anything here never writes the setting the iPhone does not have")
        #expect(written["blockMode"] == .string("strict"))
    }

    @Test func theGuardReadsTheSwitches() {
        var settings = PrivacySettings.newProfile
        settings.blockAds = false
        settings.blockExceptions = ["example.com"]
        #expect(settings.guardSettings == GuardSettings(blockAds: false, blockCookieBanners: true, blockScriptlets: false, exemptSites: ["example.com"]))
    }

    @Test func writingKeepsEveryOtherKeyOfTheSettingsAndOfTheState() throws {
        var before = state(settings: ["searchUrlTemplate": .string("https://example.org/?q=%s"), "blockCookieBanners": .bool(true), "future": .object(["x": .number(1)])])
        before.rest["somethingNewer"] = .array([.string("kept")])
        var after = before
        var settings = after.privacy
        settings.sendGpc = true
        after.privacy = settings

        guard case .object(let written)? = after.rest["settings"], case .object(let original)? = before.rest["settings"] else { Issue.record("no settings"); return }
        #expect(written["sendGpc"] == .bool(true))
        for key in original.keys { #expect(written[key] == original[key], "\(key) is not ours to change") }
        #expect(written["protectionBaseline"] == nil, "a profile that has settings keeps its own baseline")
        #expect(after.rest["somethingNewer"] == before.rest["somethingNewer"])
        #expect(after.spaces == before.spaces && after.tabs == before.tabs)
        // The file the Mac reads: written, then read back, it says the same.
        let round = try BrowserState.decode(JSONEncoder().encode(after))
        #expect(round == after && round.privacy == settings)
    }

    @Test func theAddressToCopyKeepsItsParametersUnlessTheSettingIsOn() {
        let tracked = "https://example.com/a?utm_source=x&id=1"
        var settings = PrivacySettings.newProfile
        #expect(settings.copiedAddress(tracked) == "https://example.com/a?id=1")
        #expect(settings.copiedAddress("https://example.com/a?id=1") == "https://example.com/a?id=1", "nothing to remove")
        #expect(settings.copiedAddress("not an address") == "not an address")
        settings.stripCopiedLinks = false
        #expect(settings.copiedAddress(tracked) == tracked)
    }

    @Test func aStateWithNoSettingsGetsTheFiveKeysOfANewProfileOfTheMac() {
        var fresh = state()
        var settings = fresh.privacy
        settings.stripCopiedLinks = false
        fresh.privacy = settings
        guard case .object(let written)? = fresh.rest["settings"] else { Issue.record("no settings"); return }
        // The five keys of a new profile of the Mac, then the blocker's, all at their defaults: what the Mac would read from a file it wrote itself.
        #expect(written == [
            "protectionBaseline": .string("renforcee"), "httpsUpgrade": .bool(true), "sendGpc": .bool(true), "stripTrackingParams": .bool(true), "stripCopiedLinks": .bool(false),
            "blockAds": .bool(true), "blockTrackers": .bool(true), "blockCookieBanners": .bool(true), "blockCosmetic": .bool(true), "blockScriptlets": .bool(false),
            "blockMode": .string("standard"), "blockExceptions": .array([]),
            "siteDataClearOnCloseEnabled": .bool(false), "siteDataClearOnClose": .array([]), "siteDataClearOnQuit": .bool(false),
        ])
    }
}

@Suite("Tracking parameters")
struct TrackingParamsTests {
    @Test func whatIsOutsideTheQueryComesBackAsItWentIn() {
        #expect(TrackingParams.strip("https://Example.com/A%20B?utm_source=x&k=v#Frag") == "https://Example.com/A%20B?k=v#Frag")
    }

    @Test func theOtherPiecesKeepTheirOrderAndTheirSpelling() {
        #expect(TrackingParams.strip("https://example.com/?z=1&utm_a=2&A=%C3%A9&gclid=3&b=a+b") == "https://example.com/?z=1&A=%C3%A9&b=a+b")
    }

    @Test func onlyTheUtmFamilyIsOpenEndedAndMatomoIsSpelledOutOneByOne() {
        #expect(TrackingParams.isTracking("utm_anything"))
        #expect(TrackingParams.isTracking("UTM_ID"))
        #expect(TrackingParams.isTracking("pk_campaign"))
        #expect(!TrackingParams.isTracking("pk_live"), "an unrelated key that a page needs")
        #expect(!TrackingParams.isTracking("page"))
        #expect(!TrackingParams.isTracking("q"))
    }

    @Test func theListIsFixedAndPublished() {
        #expect(TrackingParams.list.contains("fbclid") && TrackingParams.list.contains("gclid") && TrackingParams.list.contains("utm_*"))
        #expect(!TrackingParams.list.contains("pk_live"))
    }
}
