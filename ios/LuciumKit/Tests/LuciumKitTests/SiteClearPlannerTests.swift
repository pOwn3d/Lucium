import Foundation
import Testing
@testable import LuciumKit

@Suite("Effacer à la fermeture")
struct SiteClearPlannerTests {
    private func tab(_ id: String, _ url: String, space: String = "s1", isPrivate: Bool = false) -> TabItem {
        TabItem(id: id, spaceId: space, url: url, title: id, rest: isPrivate ? ["private": .bool(true)] : [:])
    }

    private func state(_ tabs: [TabItem]) -> BrowserState {
        var state = BrowserState(spaces: [Space(id: "s1", name: "One", emoji: "1️⃣", profileId: "p1"), Space(id: "s2", name: "Two", emoji: "2️⃣", profileId: "p2"),
                                          Space(id: "s3", name: "Three", emoji: "3️⃣", profileId: "p1")],
                                 activeSpaceId: "s1", activeTabBySpace: ["s1": nil, "s2": nil, "s3": nil])
        state.tabs = tabs
        return state
    }

    private func rule(enabled: Bool = true, sites: [String] = ["shop.example"], onQuit: Bool = false) -> PrivacySettings {
        var settings = PrivacySettings.newProfile
        settings.clearOnClose = .init(enabled: enabled, sites: sites, onQuit: onQuit)
        return settings
    }

    @Test func theLastTabOfAListedSiteErasesItsDataInItsProfile() {
        let before = state([tab("a", "https://shop.example/cart"), tab("b", "https://other.test/")])
        let after = state([tab("b", "https://other.test/")])
        #expect(SiteClearPlanner.onClose(before: before, after: after, settings: rule()) == [.init(profileId: "p1", sites: ["shop.example"])])
    }

    @Test func whileAnotherTabOfTheSameProfileIsOnTheSiteNothingIsErased() {
        let before = state([tab("a", "https://shop.example/cart"), tab("c", "https://shop.example/home", space: "s3")])
        let after = state([tab("c", "https://shop.example/home", space: "s3")])
        #expect(SiteClearPlanner.onClose(before: before, after: after, settings: rule()).isEmpty, "s3 shares the profile p1 and the site is still open there")
    }

    @Test func aTabOnTheSiteInAnotherProfileDoesNotKeepTheDataOfThisOne() {
        let before = state([tab("a", "https://shop.example/cart"), tab("d", "https://shop.example/", space: "s2")])
        let after = state([tab("d", "https://shop.example/", space: "s2")])
        #expect(SiteClearPlanner.onClose(before: before, after: after, settings: rule()) == [.init(profileId: "p1", sites: ["shop.example"])])
    }

    @Test func aTabOnAnotherHostOfTheSameSiteKeepsTheData() {
        // WebKit keeps data by site: erasing it would sign the other tab out.
        let before = state([tab("a", "https://shop.example/cart"), tab("e", "https://mail.shop.example/")])
        let after = state([tab("e", "https://mail.shop.example/")])
        #expect(SiteClearPlanner.onClose(before: before, after: after, settings: rule()).isEmpty)
    }

    @Test func aTabThatGoesToAnotherSiteKeepsItsPlaceAndErasesNothing() {
        let before = state([tab("a", "https://shop.example/cart")])
        let after = state([tab("a", "https://pay.test/login")])
        #expect(SiteClearPlanner.onClose(before: before, after: after, settings: rule()).isEmpty, "a sign-in goes through other hosts and must not log the person out halfway")
    }

    @Test func aPrivateTabHasNothingToErase() {
        let before = state([tab("a", "https://shop.example/cart", isPrivate: true)])
        #expect(SiteClearPlanner.onClose(before: before, after: state([]), settings: rule()).isEmpty)
    }

    @Test func aSiteNotOnTheListIsLeftAlone() {
        let before = state([tab("a", "https://other.test/")])
        #expect(SiteClearPlanner.onClose(before: before, after: state([]), settings: rule()).isEmpty)
        // The list names a host: a subdomain is another entry, as on the Mac.
        #expect(SiteClearPlanner.onClose(before: state([tab("a", "https://mail.shop.example/")]), after: state([]), settings: rule()).isEmpty)
    }

    @Test func theSwitchAndTheListBothHaveToBeOn() {
        let before = state([tab("a", "https://shop.example/cart")])
        #expect(SiteClearPlanner.onClose(before: before, after: state([]), settings: rule(enabled: false)).isEmpty)
        #expect(SiteClearPlanner.onClose(before: before, after: state([]), settings: rule(sites: [])).isEmpty)
    }

    @Test func aPortIsPartOfTheSiteOnTheList() {
        let before = state([tab("a", "http://localhost:3000/app")])
        #expect(SiteClearPlanner.onClose(before: before, after: state([]), settings: rule(sites: ["localhost:3000"])) == [.init(profileId: "p1", sites: ["localhost:3000"])])
        #expect(SiteClearPlanner.onClose(before: before, after: state([]), settings: rule(sites: ["localhost:4000"])).isEmpty)
    }

    @Test func atLaunchTheWholeListGoesInEveryProfileWhenTheApplicationIsToBeErasedAtItsEnd() {
        let current = state([])
        #expect(SiteClearPlanner.atLaunch(state: current, settings: rule(onQuit: true)) == [.init(profileId: "p1", sites: ["shop.example"]), .init(profileId: "p2", sites: ["shop.example"])])
        #expect(SiteClearPlanner.atLaunch(state: current, settings: rule(onQuit: false)).isEmpty)
        #expect(SiteClearPlanner.atLaunch(state: current, settings: rule(enabled: false, onQuit: true)).isEmpty)
    }

    @Test func theListTakesASiteOnceAndRefusesWhatIsNotAHost() {
        var sites = SiteClearPlanner.setting([], site: "https://Shop.Example/cart", on: true)
        #expect(sites == ["shop.example"])
        sites = SiteClearPlanner.setting(sites, site: "shop.example", on: true)
        #expect(sites == ["shop.example"])
        #expect(SiteClearPlanner.setting(sites, site: "not a host", on: true) == sites)
        #expect(SiteClearPlanner.setting(sites, site: "other.test", on: false) == sites)
        #expect(SiteClearPlanner.setting(sites, site: "shop.example", on: false).isEmpty)
    }
}
