import LuciumKit
import SwiftUI
import XCTest
@testable import Lucium

/// « Conflit réglé » (`SyncConflictScreen`, docs/synchronisation.md §13.4): the words in both languages, and the screen drawn with real lines. The table of
/// keys is checked against the two catalogues by `src/shared/ios-sync-conflict-contract.test.ts`; this checks that the built application carries every text
/// and puts the words where the sentence says.
@MainActor
final class SyncConflictScreenTests: XCTestCase {
    private let en = Locale(identifier: "en"), fr = Locale(identifier: "fr")
    private let now = 1_790_000_100_000

    /// A line as the journal keeps it: the iPhone renamed a space at 9:15 and the Mac at 9:12; the Mac deleted a tab the iPhone had changed.
    private func entries() -> [SettledConflict] {
        func at(_ hour: Int, _ minute: Int) -> Int {
            Int(Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 18, hour: hour, minute: minute))!.timeIntervalSince1970 * 1000)
        }
        return [
            SettledConflict(id: SyncConflicts.entryID(kind: "space", id: "s1", field: "name"), settledAt: now, peer: .mac, kind: "space", entityID: "s1", field: "name", reason: .newer, winner: .local,
                            label: "Boulot", kept: .text("Boulot"), lost: .text("Pro"), keptAt: at(9, 15), lostAt: at(9, 12), restore: .set(kind: "space", id: "s1", field: "name", value: .string("Pro"))),
            SettledConflict(id: SyncConflicts.entryID(kind: "tab", id: "t1", field: nil), settledAt: now, peer: .mac, kind: "tab", entityID: "t1", field: nil, reason: .modificationOverDeletion, winner: .local,
                            label: "Garde", kept: .absent, lost: .absent, keptAt: at(9, 20), lostAt: at(9, 25), restore: .delete(kind: "tab", id: "t1")),
        ]
    }

    private func bundle(_ language: String) throws -> Bundle {
        let path = try XCTUnwrap(Bundle.main.path(forResource: language, ofType: "lproj"), "\(language).lproj is missing from the application")
        return try XCTUnwrap(Bundle(path: path))
    }

    func testEveryTextOfTheTableIsInTheApplicationInFrenchAndInEnglish() throws {
        XCTAssertGreaterThan(SyncConflictTexts.keys.count, 60)
        for language in ["fr", "en"] {
            let bundle = try bundle(language)
            for (descriptor, key) in SyncConflictTexts.keys {
                let text = bundle.localizedString(forKey: key, value: nil, table: nil)
                XCTAssertNotEqual(text, key, "\(key) (\(descriptor)) has no \(language) text")
                XCTAssertFalse(text.trimmingCharacters(in: .whitespaces).isEmpty, "\(key) (\(descriptor)) is empty in \(language)")
            }
        }
        // A count is one key with a text for each plural form.
        func count(_ n: Int, _ bundle: Bundle, _ locale: Locale) -> String { String(localized: "conflict.count \(n)", bundle: bundle, locale: locale) }
        XCTAssertEqual([1, 2].map { count($0, (try? self.bundle("fr"))!, fr) }, ["1 conflit réglé", "2 conflits réglés"])
        XCTAssertEqual([1, 2].map { count($0, (try? self.bundle("en"))!, en) }, ["1 conflict settled", "2 conflicts settled"])
    }

    func testTheWordsGoWhereTheSentenceSaysInBothLanguages() {
        let named = SyncText("sync-conflict.row-set", .text(SyncText("sync-conflict.field-name")), .literal("Boulot"))
        XCTAssertEqual(SyncConflictTexts.string(named, locale: fr), "Nom changé en « Boulot »")
        XCTAssertEqual(SyncConflictTexts.string(named, locale: en), "Name changed to “Boulot”")
        XCTAssertEqual(SyncConflictTexts.string(SyncText("sync-conflict.row-moved", .literal("Réunions")), locale: fr), "Rangé dans « Réunions »")
        XCTAssertEqual(SyncConflictTexts.string(SyncText("sync-conflict.outcome-newer-ios"), locale: fr), "La version de l’iPhone, la plus récente, est appliquée.")
        XCTAssertEqual(SyncConflictTexts.string(SyncText("sync-conflict.outcome-newer-mac"), locale: en), "The Mac’s version, the most recent, is applied.")
        XCTAssertEqual(SyncConflictTexts.string("sync-conflict.title", locale: fr), "Deux changements se croisaient")
        XCTAssertEqual(SyncConflictTexts.string("sync-conflict.title", locale: en), "Two changes crossed")
        // What the person typed is put in as it is, never read as a format.
        XCTAssertEqual(SyncConflictTexts.string(SyncText("sync-conflict.row-moved", .literal("100% %@ %1$@ \\n")), locale: en), "Moved into “100% %@ %1$@ \\n”")
        // A key the table does not know is shown as it is, not invented.
        XCTAssertEqual(SyncConflictTexts.string("sync-conflict.nothing", locale: en), "sync-conflict.nothing")
    }

    func testTheTextOfALineIsTheSameAsTheMacsForTheSameLine() {
        let view = SyncConflicts.view(of: entries()[0])
        XCTAssertEqual(view.rows.map { SyncConflictTexts.string($0.text, locale: fr) }, ["Nom changé en « Pro »", "Nom changé en « Boulot »"])
        // This device is the iPhone (its peer is the Mac) and its own change, at 9:15, is the one in force.
        XCTAssertEqual(SyncConflictTexts.string(view.outcome, locale: fr), "La version de l’iPhone, la plus récente, est appliquée.")
        XCTAssertEqual(SyncConflictTexts.string(view.title, locale: en), "Space")
    }

    /// The screen draws the lines under its title in the language it is given, and « Comparer » opens the two versions; a picture of each is written when
    /// `LUCIUM_SHOTS` names a folder (`scripts/ios-check.sh` does), for the person who reads the captures.
    func testTheScreenDrawsTheLinesInEachLanguageClosedAndOpenOnComparer() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the hosted tests run inside the application's scene")
        var restored: [(SyncChange, String)] = []
        for language in ["en", "fr"] {
            for open in [false, true] {
                // The screen is read at 10:00 on the day of the lines: it says times, not dates.
                let screenNow = Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 18, hour: 10))!
                let screen = SyncConflictScreen(entries: entries(), now: screenNow, initialComparing: open ? entries()[0].id : nil, onClose: {}, onRestore: { restored.append(($0, $1)) })
                let controller = UIHostingController(rootView: screen.environment(\.locale, Locale(identifier: language)))
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
                window.rootViewController = controller
                window.makeKeyAndVisible()
                controller.view.layoutIfNeeded()
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 1))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                XCTAssertGreaterThan(image.size.width, 0)
                // The screen is not blank: it draws pixels of more than one colour.
                XCTAssertGreaterThan(Set(Self.sampledPixels(of: image)).count, 4, "\(language) \(open ? "open" : "closed")")
                if let folder = ProcessInfo.processInfo.environment["LUCIUM_SHOTS"], let png = image.pngData() {
                    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
                    try png.write(to: URL(fileURLWithPath: folder).appending(path: "lucium-ios-conflict-\(language)-\(open ? "compare" : "list").png"))
                }
                window.isHidden = true
            }
        }
        XCTAssertTrue(restored.isEmpty, "drawing the screen restores nothing")
    }

    private static func sampledPixels(of image: UIImage) -> [UInt32] {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return [] }
        let step = max(1, cg.bytesPerRow / 4 / 40)
        var out: [UInt32] = []
        for y in stride(from: 0, to: cg.height, by: 40) {
            for x in stride(from: 0, to: cg.width, by: step) {
                let offset = y * cg.bytesPerRow + x * 4
                out.append(UInt32(bytes[offset]) << 16 | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]))
            }
        }
        return out
    }
}
