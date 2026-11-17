import Testing
@testable import LuciumKit

// `#expect` cannot hold a call that mutates its subject, so each step is a `let` first.
@Suite("HTTPS first: the memory of an upgrade")
struct HttpsUpgradesTests {
    private let http = "http://example.com/a"
    private let https = "https://example.com/a"

    @Test func aPublicHttpAddressIsUpgradedAndALocalOneIsNot() {
        var upgrades = HttpsUpgrades()
        let public_ = upgrades.upgrade(page: "t", http: http)
        let localhost = upgrades.upgrade(page: "t", http: "http://localhost:3000/")
        let lan = upgrades.upgrade(page: "t", http: "http://192.168.1.2/")
        #expect(public_?.https == https)
        #expect(localhost == nil)
        #expect(lan == nil)
    }

    @Test func anAddressIsNeverUpgradedTwiceSoASiteThatSendsHttpsVisitorsBackToHttpCannotLoop() {
        var upgrades = HttpsUpgrades()
        let first = upgrades.upgrade(page: "t", http: http)
        // The site answers the https address with a redirect to the http one: the same address comes back, and goes through.
        let second = upgrades.upgrade(page: "t", http: http)
        #expect(first != nil)
        #expect(second == nil)
    }

    @Test func aPageThatCommittedForgetsTheGuard() {
        var upgrades = HttpsUpgrades()
        _ = upgrades.upgrade(page: "t", http: http)
        upgrades.committed(page: "t")
        let later = upgrades.upgrade(page: "t", http: http)
        #expect(upgrades.pendingCount == 1)
        #expect(later != nil, "a later visit upgrades again")
    }

    @Test func aNavigationThePersonStartedForgetsTheGuardButOneThePageMadeKeepsIt() {
        var upgrades = HttpsUpgrades()
        _ = upgrades.upgrade(page: "t", http: http)
        upgrades.pageNavigated(page: "t", url: https)
        let redirected = upgrades.upgrade(page: "t", http: http)
        upgrades.navigationStarted(page: "t", url: http)
        let typed = upgrades.upgrade(page: "t", http: http)
        #expect(redirected == nil, "a redirect or a script does not reopen the door")
        #expect(typed != nil, "a typed address does")
    }

    @Test func aSiteThatDoesNotAnswerOverHttpsFallsBackToHttpOnce() {
        var upgrades = HttpsUpgrades()
        _ = upgrades.upgrade(page: "t", http: http)
        let failure = upgrades.failed(page: "t", failedUrl: https, cancelled: false, certificate: false)
        #expect(failure == .fellBack(http: http))
        #expect(upgrades.pendingCount == 0)
        let again = upgrades.upgrade(page: "t", http: http)
        #expect(again == nil, "the page the fall back loads is not upgraded again")
    }

    @Test func aRefusedCertificateNeverFallsBackByItself() {
        var upgrades = HttpsUpgrades()
        _ = upgrades.upgrade(page: "t", http: http)
        let failure = upgrades.failed(page: "t", failedUrl: https, cancelled: false, certificate: true)
        #expect(failure == .refused(http: http))
        // Nothing lets the http address through until the person asks for it.
        let beforeTheClick = upgrades.upgrade(page: "t", http: http)
        #expect(beforeTheClick != nil)
        let clicked = upgrades.continueOverHttp(page: "t", http: http)
        let afterTheClick = upgrades.upgrade(page: "t", http: http)
        #expect(clicked)
        #expect(afterTheClick == nil, "on the click, the address goes through once")
    }

    @Test func onlyAnHttpAddressCanBeContinuedOver() {
        var upgrades = HttpsUpgrades()
        let secure = upgrades.continueOverHttp(page: "t", http: "https://example.com/")
        let script = upgrades.continueOverHttp(page: "t", http: "javascript:alert(1)")
        #expect(!secure)
        #expect(!script)
    }

    @Test func aCancelledLoadSaysNothingAboutTheSite() {
        var upgrades = HttpsUpgrades()
        _ = upgrades.upgrade(page: "t", http: http)
        let failure = upgrades.failed(page: "t", failedUrl: https, cancelled: true, certificate: false)
        #expect(failure == .none)
        #expect(upgrades.pendingCount == 1, "the upgrade is still under way")
    }

    @Test func theFailureOfAnotherSiteIsNotTheUpgradesFailure() {
        var upgrades = HttpsUpgrades()
        _ = upgrades.upgrade(page: "t", http: http)
        let failure = upgrades.failed(page: "t", failedUrl: "https://other.example/", cancelled: false, certificate: false)
        #expect(failure == .none)
        #expect(upgrades.pendingCount == 0)
    }

    @Test func theTimerFallsBackOnlyForTheUpgradeItBelongsToAndOnlyWhileThePageLoads() {
        var upgrades = HttpsUpgrades()
        let first = upgrades.upgrade(page: "t", http: http)!
        let wrongToken = upgrades.timedOut(page: "t", token: first.token + 1, isLoading: true)
        let rung = upgrades.timedOut(page: "t", token: first.token, isLoading: true)
        let rungAgain = upgrades.timedOut(page: "t", token: first.token, isLoading: true)
        let afterFallBack = upgrades.upgrade(page: "t", http: http)
        #expect(wrongToken == nil, "not the token of this upgrade")
        #expect(rung == http)
        #expect(rungAgain == nil, "rung once")
        #expect(afterFallBack == nil, "the fall back goes through once")

        let second = upgrades.upgrade(page: "t", http: "http://example.org/")!
        let settled = upgrades.timedOut(page: "t", token: second.token, isLoading: false)
        #expect(settled == nil, "a page that settled on its own did not fail")
        #expect(upgrades.pendingCount == 0)
    }

    @Test func aTimerOfAnOlderUpgradeDoesNotCutANewerOne() {
        var upgrades = HttpsUpgrades()
        let old = upgrades.upgrade(page: "t", http: http)!
        upgrades.navigationStarted(page: "t", url: "http://example.org/b")
        let newer = upgrades.upgrade(page: "t", http: "http://example.org/b")!
        let oldRings = upgrades.timedOut(page: "t", token: old.token, isLoading: true)
        let newerRings = upgrades.timedOut(page: "t", token: newer.token, isLoading: true)
        #expect(oldRings == nil)
        #expect(newerRings == "http://example.org/b")
    }

    @Test func aNavigationToAnotherAddressDropsTheUpgradeUnderWay() {
        var upgrades = HttpsUpgrades()
        let started = upgrades.upgrade(page: "t", http: http)!
        upgrades.navigationStarted(page: "t", url: https)
        #expect(upgrades.pendingCount == 1, "the https address the upgrade loads is not another address")
        upgrades.navigationStarted(page: "t", url: "https://elsewhere.example/")
        #expect(upgrades.pendingCount == 0)
        let rung = upgrades.timedOut(page: "t", token: started.token, isLoading: true)
        #expect(rung == nil)
    }

    @Test func pagesDoNotShareAnything() {
        var upgrades = HttpsUpgrades()
        let one = upgrades.upgrade(page: "one", http: http)
        let two = upgrades.upgrade(page: "two", http: http)
        #expect(one != nil && two != nil)
        upgrades.forget(page: "one")
        #expect(upgrades.pendingCount == 1)
    }

    @Test func theRuleIsTheCallersToChange() {
        // The tests of the application give a rule that upgrades a loopback address; the real one never does.
        var upgrades = HttpsUpgrades(rule: { $0.replacingOccurrences(of: "http://", with: "https://") })
        let started = upgrades.upgrade(page: "t", http: "http://127.0.0.1:1/")
        #expect(started?.https == "https://127.0.0.1:1/")
    }
}
