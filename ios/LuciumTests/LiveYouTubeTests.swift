import LuciumKit
import WebKit
import XCTest
@testable import Lucium

/// A check against the real youtube.com, run by hand and never by CI (it needs the network and depends on what YouTube serves that day):
/// the guard of the application loads a watch page, the player starts up, and the ad entries of the player answer are gone, where the same page
/// without the guard (a control) still carries them when YouTube serves ads to this address at all. Playback itself is checked only where the machine
/// can play a video: `testTheSimulatorCanPlayAPlainVideo` says whether it can (a plain MP4 in a bare web view), and the check does not blame the
/// guard for what the machine cannot do.
/// `TEST_RUNNER_LUCIUM_LIVE=1 xcodebuild … -only-testing:LuciumTests/LiveYouTubeTests test` (xcodebuild hands TEST_RUNNER_* variables to the tests).
@MainActor
final class LiveYouTubeTests: XCTestCase {
    private var directory: URL!
    private var store: WKContentRuleListStore!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "lucium-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = try XCTUnwrap(WKContentRuleListStore(url: directory.appending(path: "rules", directoryHint: .isDirectory)))
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    private func requireLive() throws {
        guard ProcessInfo.processInfo.environment["LUCIUM_LIVE"] == "1" else { throw XCTSkip("a check against the real network: set TEST_RUNNER_LUCIUM_LIVE=1") }
    }

    struct Observation {
        var location = "", title = "", adPlacements = -1, playerAds = -1, adShowing = false
        var hasVideo = false, currentTime = 0.0, paused = true, readyState = 0, networkState = -1, errorCode = 0, hasSource = false
        var line: String { "[live] \(location) | title=\(title) | adPlacements=\(adPlacements) playerAds=\(playerAds) | video=\(hasVideo) src=\(hasSource) t=\(currentTime) paused=\(paused) ready=\(readyState) net=\(networkState) err=\(errorCode) adShowing=\(adShowing)" }
        var hasAds: Bool { adPlacements > 0 || playerAds > 0 }
        var plays: Bool { hasVideo && !paused && currentTime > 2 }
    }

    /// Opens a watch page in a model made like the application's (with the guard, or without), and observes it for up to `seconds`, stopping early
    /// when `until` holds. The consent page YouTube shows in some countries is not what this is about: the cookie the site itself sets is given first.
    private func watch(_ id: String, guarded: Bool, seconds: Int, until stop: (Observation) -> Bool) async throws -> Observation {
        let makeGuard: @MainActor (ScriptletTable) throws -> PageGuard?
        if guarded {
            makeGuard = { table in try PageGuard.load(table: table) }
        } else {
            makeGuard = { _ in nil }
        }
        let model = BrowserModel.launch(directory: directory.appending(path: "\(guarded ? "g" : "u")-\(id)"), embeddedLists: { try EmbeddedLists.load() }, pageGuard: makeGuard, store: store)
        await model.prepare()
        XCTAssertNil(model.guardFailure)
        XCTAssertEqual(model.pageGuard != nil, guarded, "the guard is in the build exactly when it is asked for")
        let view = try XCTUnwrap(model.webView)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: ".youtube.com", .path: "/", .name: "SOCS", .value: "CAI", .secure: "TRUE", .expires: Date(timeIntervalSinceNow: 86_400)]))
        await view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        view.load(URLRequest(url: URL(string: "https://www.youtube.com/watch?v=\(id)")!))
        var seen = Observation()
        for second in 0..<seconds {
            try await Task.sleep(for: .seconds(1))
            // The tap: the player starts on the person's tap; a script run by `evaluateJavaScript` counts as one for the page's autoplay rules.
            let js = """
            (() => { const v = document.querySelector('video'); const r = window.ytInitialPlayerResponse;
              if (!window.__tapped && v && !document.querySelector('.ad-showing')) {
                const tap = document.querySelector('.ytp-large-play-button, button.ytp-play-button, .ytp-cued-thumbnail-overlay, button[aria-label="Play"]');
                if (tap) { window.__tapped = true; tap.click() }
              }
              if (v && v.paused && v.readyState >= 2) { v.muted = true; v.play().catch((e) => { window.__playError = String(e) }) }
              return JSON.stringify({ location: location.href, title: document.title, adPlacements: r && r.adPlacements ? r.adPlacements.length : (r ? 0 : -1),
                playerAds: r && r.playerAds ? r.playerAds.length : (r ? 0 : -1), adShowing: !!document.querySelector('.ad-showing'),
                hasVideo: !!v, currentTime: v ? v.currentTime : 0, paused: v ? v.paused : true, readyState: v ? v.readyState : 0,
                networkState: v ? v.networkState : -1, errorCode: v && v.error ? v.error.code : 0, hasSource: !!(v && (v.currentSrc || v.src)), playError: window.__playError || '' }) })()
            """
            let text: String?
            do {
                text = try await view.evaluateJavaScript(js) as? String
            } catch {
                // The page is between two documents: the next second tries again, and the line says so.
                print("[live] second \(second): the page could not be read yet: \(error.localizedDescription)")
                continue
            }
            guard let text, let data = text.data(using: .utf8), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let playError = json["playError"] as? String, !playError.isEmpty { print("[live] play() was refused: \(playError)") }
            seen = Observation(location: json["location"] as? String ?? "", title: json["title"] as? String ?? "", adPlacements: json["adPlacements"] as? Int ?? -1,
                               playerAds: json["playerAds"] as? Int ?? -1, adShowing: json["adShowing"] as? Bool ?? false, hasVideo: json["hasVideo"] as? Bool ?? false,
                               currentTime: json["currentTime"] as? Double ?? 0, paused: json["paused"] as? Bool ?? true, readyState: json["readyState"] as? Int ?? 0,
                               networkState: json["networkState"] as? Int ?? -1, errorCode: json["errorCode"] as? Int ?? 0, hasSource: json["hasSource"] as? Bool ?? false)
            if stop(seen) { break }
        }
        print("\(guarded ? "with" : "without") the guard, \(id): \(seen.line)")
        return seen
    }

    /// Whether this simulator plays any video from the network at all (a plain MP4 in a bare web view, started the way a tap starts it).
    private func machinePlaysVideo() async throws -> Bool {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700), configuration: configuration)
        let html = "<!doctype html><video id=v src='https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' muted playsinline autoplay loop></video>"
        try await NavigationWaiter().load(in: view) { view.loadHTMLString(html, baseURL: URL(string: "https://interactive-examples.mdn.mozilla.net/")) }
        var line = ""
        for _ in 0..<20 {
            try await Task.sleep(for: .seconds(1))
            line = try await view.evaluateJavaScript("(() => { const v = document.getElementById('v'); v.play().catch(() => {}); return `t=${v.currentTime} ready=${v.readyState} net=${v.networkState} err=${v.error ? v.error.code : 0}` })()") as? String ?? ""
            if !line.hasPrefix("t=0 ") { break }
        }
        print("[live] plain mp4 in a bare web view: \(line)")
        return !line.hasPrefix("t=0 ")
    }

    /// The machine, not the guard: reported, and not a failure of the application.
    func testTheMachineAndWhetherItPlaysVideo() async throws {
        try requireLive()
        let plays = try await machinePlaysVideo()
        print("[live] this machine plays a plain MP4: \(plays)")
    }

    func testYouTubeLoadsWithTheGuardAndTheAdEntriesAreGone() async throws {
        try requireLive()
        let plays = try await machinePlaysVideo()
        // A video that YouTube serves ads for, to this address, today: the control (no guard) finds it. If none does, the check says so and keeps the first.
        let candidates = ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "JGwWNGJdvx8", "OPf0YbXqDm0"]
        var chosen = candidates[0]
        var control = Observation()
        for id in candidates {
            control = try await watch(id, guarded: false, seconds: 25) { $0.hasAds || $0.title.hasSuffix("YouTube") && $0.adPlacements >= 0 && $0.hasVideo }
            if control.hasAds { chosen = id; break }
        }
        print("[live] a video with ad entries in the control: \(control.hasAds ? chosen : "none found, the first is kept")")
        let guarded = try await watch(chosen, guarded: true, seconds: plays ? 90 : 25) { plays ? $0.plays : $0.hasVideo && $0.hasSource && $0.adPlacements >= 0 }
        XCTAssertTrue(guarded.hasVideo, "the player is on the page")
        XCTAssertTrue(guarded.hasSource, "the player has given the video its source: it started up under the guard")
        XCTAssertLessThanOrEqual(guarded.adPlacements, 0, "the ad entries of the player answer are gone")
        XCTAssertLessThanOrEqual(guarded.playerAds, 0)
        if control.hasAds {
            XCTAssertGreaterThan(control.adPlacements + control.playerAds, 0, "the control: this page carries ad entries without the guard")
        }
        if plays {
            XCTAssertTrue(guarded.plays, "the video plays under the guard")
        } else {
            print("[live] playback is not checked: this machine plays no video at all")
        }
    }
}
