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

    @Test func choosingALevelWritesItsThreeSettingsAndLeavesHttpsAlone() {
        var settings = PrivacySettings(httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false)
        settings.choose(.enhanced)
        #expect(settings == PrivacySettings(httpsUpgrade: false, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true))
        settings.choose(.standard)
        #expect(settings == PrivacySettings(httpsUpgrade: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false))
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
        #expect(written == [
            "protectionBaseline": .string("renforcee"), "httpsUpgrade": .bool(true), "sendGpc": .bool(true), "stripTrackingParams": .bool(true), "stripCopiedLinks": .bool(false),
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
