import LuciumKit
import SwiftUI
import UIKit
import WebKit
import XCTest
@testable import Lucium

/// The pictures of the App Store listing (ios/AppStore/README.md): the real screens of the application, on a real window of the simulator, with demo
/// data in the language of the run. This is a tool and not a check: without `LUCIUM_STORE_SHOTS` in the environment (`TEST_RUNNER_LUCIUM_STORE_SHOTS`
/// for `xcodebuild`) every test here is skipped, so `scripts/ios-check.sh` does not wait for anyone.
///
/// A picture is taken from outside, by `xcrun simctl io … screenshot`, because only the simulator draws the status bar, the Dynamic Island and the
/// home indicator that a store picture shows; `scripts/ios-store-shots.sh` is the one that takes it. The two sides talk through files in the folder
/// that `LUCIUM_STORE_SHOTS` names: this test writes `ready-<name>` once the screen is drawn and still, the script takes the picture and answers
/// with `done-<name>`. The pages are drawn from strings (`loadHTMLString` with the address of a reserved domain as its base), so that nothing is
/// fetched from the network, no real site is shown and the address bar reads `journal.example`.
@MainActor
final class StoreScreenshotTests: BrowserCoreTestCase {
    private var handshake: URL?
    private var window: UIWindow?

    override func setUp() async throws {
        // Before anything is made: a run that is not taking pictures must cost nothing (no server, no folder).
        let folder = ProcessInfo.processInfo.environment["LUCIUM_STORE_SHOTS"] ?? ""
        try XCTSkipUnless(!folder.isEmpty, "the pictures of the listing are taken by scripts/ios-store-shots.sh")
        try await super.setUp()
        handshake = URL(fileURLWithPath: folder, isDirectory: true)
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        // Nothing was made when the test was skipped.
        if server != nil { try await super.tearDown() }
    }

    func testThePicturesOfTheListing() async throws {
        let demo = Demo.ofTheRun
        let model = await demoModel(demo)
        try show(model)
        try await loadArticle(demo, in: model)
        try await shoot("01-browse")

        model.tabsSheetShown = true
        try await shoot("02-tabs")
        model.tabsSheetShown = false
        try await settle()

        model.spacesSheetShown = true
        try await shoot("03-spaces")
        model.spacesSheetShown = false
        try await settle()

        model.commandBarShown = true
        try await shoot("04-commands")
        model.commandBarShown = false
        try await settle()

        // The privacy sheet belongs to the tabs sheet (its "Privacy" button): it is shown over it, and both go away together.
        model.tabsSheetShown = true
        try await settle()
        model.privacyPrompts.settingsShown = true
        try await shoot("05-privacy")
        model.privacyPrompts.settingsShown = false
        try await settle()
        model.tabsSheetShown = false
        try await settle()
    }

    // MARK: the demo

    /// What the pictures show, in one language: the titles are the ones of the demo profile, on reserved `.example` hosts, and none names a real
    /// site or a product.
    struct Demo {
        let articleTitle: String
        let article: String
        let pinned: [(title: String, host: String)]
        let meetings: (name: String, tabs: [(title: String, host: String)])
        let docs: (name: String, tabs: [(title: String, host: String)])
        let today: [(title: String, host: String)]
        let favorites: [(title: String, host: String)]
        let archived: [(title: String, host: String)]
        /// What the two other spaces hold, so that the list of spaces is not three names with nothing behind them.
        let home: [(title: String, host: String)]
        let projects: [(title: String, host: String)]

        /// French when the run is in French (`-testLanguage fr`), English otherwise.
        static var ofTheRun: Demo { Bundle.main.preferredLocalizations.first == "fr" ? french : english }

        static let english = Demo(
            articleTitle: "Naming your files well",
            article: StoreScreenshotTests.articleHTML(
                language: "en", title: "Naming your files well", lead: "A few habits that save an hour a week.", kicker: "Notebook",
                sections: [
                    ("Start with the date", "Write it the long way round, year first: 2026-11-18. Files then sort themselves, and the newest is always where you look."),
                    ("Say what it is for", "A name is read in a list, without the file open. “budget-2027-draft” tells more than “final2”, and it stays true when a third version comes."),
                    ("Keep it short", "Three or four words are enough. The folder already says the project; the name only has to tell this file from its neighbours."),
                    ("Decide once", "Pick a rule, write it on the first page of the folder, and stop thinking about it. The best system is the one the whole team uses.")
                ]),
            pinned: [("Project board", "board.example"), ("Notebook", "notes.example")],
            meetings: ("Meetings", [("Monday meeting", "meetings.example"), ("Minutes", "minutes.example")]),
            docs: ("Documentation", [("Style guide", "docs.example"), ("Reference", "reference.example")]),
            today: [("Weather this week", "weather.example")],
            favorites: [("Weekly agenda", "agenda.example"), ("Style guide", "guide.example"), ("Library", "library.example"), ("Museum", "museum.example")],
            archived: [("Seasonal recipes", "recipes.example"), ("Sowing calendar", "garden.example"), ("Museum opening hours", "museum.example")],
            home: [("Grocery list", "groceries.example"), ("Dinner ideas", "dinner.example"), ("Trip to the coast", "coast.example"), ("Garden journal", "journal-garden.example")],
            projects: [("Moodboard", "moodboard.example"), ("Colour notes", "colours.example"), ("Prototype", "prototype.example")])

        static let french = Demo(
            articleTitle: "Bien nommer ses fichiers",
            article: StoreScreenshotTests.articleHTML(
                language: "fr", title: "Bien nommer ses fichiers", lead: "Quelques habitudes qui font gagner une heure par semaine.", kicker: "Carnet de notes",
                sections: [
                    ("Commencer par la date", "Écrivez-la à l’envers, l’année d’abord : 2026-11-18. Les fichiers se rangent alors tout seuls, et le plus récent est toujours là où vous regardez."),
                    ("Dire à quoi il sert", "Un nom se lit dans une liste, sans ouvrir le fichier. « budget-2027-brouillon » en dit plus que « final2 », et il reste vrai quand une troisième version arrive."),
                    ("Rester court", "Trois ou quatre mots suffisent. Le dossier dit déjà le projet ; le nom doit seulement distinguer ce fichier de ses voisins."),
                    ("Décider une fois", "Choisissez une règle, écrivez-la sur la première page du dossier, et n’y pensez plus. Le meilleur système est celui que toute l’équipe applique.")
                ]),
            pinned: [("Tableau du projet", "tableau.example"), ("Carnet de notes", "carnet.example")],
            meetings: ("Réunions", [("Réunion du lundi", "reunions.example"), ("Compte rendu", "comptes-rendus.example")]),
            docs: ("Documentation", [("Guide de style", "docs.example"), ("Référence", "reference.example")]),
            today: [("Météo de la semaine", "meteo.example")],
            favorites: [("Agenda de la semaine", "agenda.example"), ("Guide de style", "guide.example"), ("Bibliothèque", "biblio.example"), ("Musée", "musee.example")],
            archived: [("Recettes de saison", "recettes.example"), ("Calendrier des semis", "jardin.example"), ("Horaires du musée", "musee.example")],
            home: [("Liste de courses", "courses.example"), ("Idées de dîner", "diner.example"), ("Week-end à la côte", "cote.example"), ("Carnet de jardin", "carnet-jardin.example")],
            projects: [("Planche d’inspiration", "inspiration.example"), ("Notes de couleurs", "couleurs.example"), ("Prototype", "prototype.example")])
    }

    /// A page that reads well on a phone and on a tablet, in the light and in the dark scheme, with no outside resource.
    nonisolated static func articleHTML(language: String, title: String, lead: String, kicker: String, sections: [(String, String)]) -> String {
        let body = sections.map { "<h2>\($0.0)</h2><p>\($0.1)</p>" }.joined()
        return """
        <!doctype html><html lang="\(language)"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(title)</title>
        <style>
        :root { color-scheme: light dark; --ink: #1d1d27; --muted: #5d5d6e; --paper: #ffffff; --accent: #5b5bd6; }
        @media (prefers-color-scheme: dark) { :root { --ink: #ececf4; --muted: #a2a2b4; --paper: #15151b; --accent: #9a9aff; } }
        body { margin: 0; background: var(--paper); color: var(--ink); font: 19px/1.55 -apple-system, system-ui, sans-serif; }
        main { max-width: 680px; margin: 0 auto; padding: 0 22px 60px; }
        .hero { height: 220px; margin: 0 -22px 22px; background: linear-gradient(135deg, #ff7b5c 0%, #ffc23d 28%, #3fd092 52%, #33b3e6 76%, #5b7cff 100%); }
        .kicker { color: var(--accent); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; font-size: 14px; }
        h1 { font-size: 36px; line-height: 1.12; margin: 6px 0 10px; }
        .lead { color: var(--muted); font-size: 22px; margin: 0 0 26px; }
        h2 { font-size: 24px; margin: 30px 0 4px; }
        p { margin: 0; }
        </style>
        <main><div class="hero"></div><div class="kicker">\(kicker)</div><h1>\(title)</h1><p class="lead">\(lead)</p>\(body)</main>
        </html>
        """
    }

    /// The demo state: the three default spaces, the first one filled like the mockups, and the tab on screen blank, so that the page is the one drawn
    /// from a string (a blank tab loads its start page from the application's own string, never from the network).
    private func demoModel(_ demo: Demo) async -> BrowserModel {
        let now = 1_790_000_000_000.0
        var state = BrowserModel.defaultState()
        func open(_ id: String, _ title: String, _ host: String, in space: String = "work", at: Double) {
            state.openTab(id: id, in: space, url: "https://\(host)/", title: title, now: at)
        }
        var step = 40.0
        func next() -> Double { step -= 1; return now - step }
        for (index, entry) in demo.pinned.enumerated() {
            open("pin\(index)", entry.title, entry.host, at: next())
            state.pin(tabId: "pin\(index)")
        }
        if let meetings = state.createFolder(id: "f-meetings", name: demo.meetings.name, fallbackName: "?", in: "work") {
            for (index, entry) in demo.meetings.tabs.enumerated() {
                open("meet\(index)", entry.title, entry.host, at: next())
                state.move(tabId: "meet\(index)", toFolder: meetings.id)
            }
        }
        if let docs = state.createFolder(id: "f-docs", name: demo.docs.name, fallbackName: "?", in: "work") {
            for (index, entry) in demo.docs.tabs.enumerated() {
                open("doc\(index)", entry.title, entry.host, at: next())
                state.move(tabId: "doc\(index)", toFolder: docs.id)
            }
        }
        for (index, entry) in demo.today.enumerated() { open("today\(index)", entry.title, entry.host, at: next()) }
        for (index, entry) in demo.favorites.enumerated() {
            state.addFavorite(id: "fav\(index)", url: "https://\(entry.host)/", title: entry.title, in: "work")
        }
        for (index, entry) in demo.archived.enumerated() {
            open("old\(index)", entry.title, entry.host, at: now - Double(30 + index * 40) * 3_600_000)
        }
        for (space, tabs) in [("home", demo.home), ("projects", demo.projects)] {
            for (index, entry) in tabs.enumerated() { open("\(space)\(index)", entry.title, entry.host, in: space, at: next()) }
        }
        state.archive(tabIds: demo.archived.indices.map { "old\($0)" }, source: .auto, now: now)
        state.openTab(id: "article", in: "work", now: now)
        state.show(tabId: "article", now: now)
        let model = BrowserModel(state: state, clock: { now })
        await model.prepare()
        return model
    }

    // MARK: the window and the handshake

    /// The application's own screen, in a window above the host's: what a person sees, with its bar, its sheets and its status bar.
    private func show(_ model: BrowserModel) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the host has no scene")
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.rootViewController = UIHostingController(rootView: BrowserScreen(model: model))
        window.makeKeyAndVisible()
        self.window = window
    }

    /// Draws the article in the tab on screen and waits until the title of the page has reached the line of the tab.
    private func loadArticle(_ demo: Demo, in model: BrowserModel) async throws {
        let view = try XCTUnwrap(model.webView, "no web view")
        // The start page of the blank tab is still loading: let it finish, or its end would be taken for the end of the article.
        try await eventually("the start page", { !view.isLoading })
        try await NavigationWaiter().load(in: view) { view.loadHTMLString(demo.article, baseURL: URL(string: "https://journal.example/")) }
        try await eventually("the title of the article", { model.activeTab?.title == demo.articleTitle })
        try await eventually("the host in the bar", { model.host == "journal.example" })
        // The web process paints a moment after the load ends.
        try await Task.sleep(for: .milliseconds(800))
    }

    /// Time for a sheet to finish moving, in or out.
    private func settle() async throws { try await Task.sleep(for: .milliseconds(1_300)) }

    /// Asks the script to take the picture of what is on screen, and waits for its answer.
    private func shoot(_ name: String) async throws {
        try await settle()
        let folder = try XCTUnwrap(handshake)
        try Data().write(to: folder.appending(path: "ready-\(name)"))
        let done = folder.appending(path: "done-\(name)")
        let deadline = ContinuousClock.now + .seconds(60)
        while !FileManager.default.fileExists(atPath: done.path) {
            if ContinuousClock.now > deadline { XCTFail("nobody took the picture \(name)"); return }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
}
