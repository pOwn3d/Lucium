import Foundation
import Testing
@testable import LuciumKit

/// "A phone never modified since its first launch" (docs/synchronisation.md §11.8, [Q3]): at the first exchange such a phone adopts the Mac's state instead of
/// adding its own empty space to it. It is a latch: true only for a phone that started with no state file, and false for good once the structure the person arranges
/// is no longer the one of that first launch.
@Suite("Synchronisation: a phone that was never modified")
struct SyncOriginTests {
    private func firstState() -> BrowserState {
        BrowserState(revision: 2,
                     spaces: [Space(id: "work", name: "Travail", emoji: "💼", profileId: "work", rest: ["theme": .object(["hue": .number(250)])]),
                              Space(id: "home", name: "Maison", emoji: "🏠", profileId: "home")],
                     activeSpaceId: "work", activeTabBySpace: ["work": nil, "home": nil])
    }

    private func firstOrigin() -> SyncOrigin { SyncOrigin.atFirstRun(stateWasFound: false, state: firstState()) }

    @Test func aPhoneThatStartedWithNoStateFileStartsUntouched() {
        #expect(firstOrigin().untouched)
        #expect(firstOrigin().firstStructure != nil)
    }

    @Test func aPhoneWhoseStateWasReadFromAFileStartsTouchedBecauseTheUnionLosesNothingAndAdoptionCould() {
        let origin = SyncOrigin.atFirstRun(stateWasFound: true, state: firstState())
        #expect(!origin.untouched)
        #expect(origin.firstStructure == nil)
        #expect(origin.observing(firstState()) == origin, "it never becomes untouched again")
    }

    @Test func whatIsNotTheStructureDoesNotMakeItTouched() {
        var state = firstState()
        let origin = firstOrigin()
        // Browsing: tabs of "Today", the space on screen, the page a tab is on, the archive the application fills itself.
        state.tabs = [TabItem(id: "t1", spaceId: "work", url: "https://example.com/", title: "Example")]
        state.activeSpaceId = "home"
        state.tabs[0].url = "https://example.org/"
        state.archive = [ArchivedTab(id: "a1", spaceId: "work", url: "https://old.example/", title: "Old", archivedAt: 1)]
        state.rest["settings"] = .object(["sendGpc": .bool(false)])
        // A library operation may write an empty list, or a null, where there was none: that is no change.
        state.rest["folders"] = .array([])
        state.rest["favorites"] = .null
        #expect(origin.observing(state).untouched)
    }

    @Test func eachThingAPersonArrangesMakesItTouched() {
        let origin = firstOrigin()
        var variants: [(String, BrowserState)] = []
        var renamed = firstState(); renamed.spaces[0].name = "Bureau"; variants.append(("a space renamed", renamed))
        var added = firstState(); added.spaces.append(Space(id: "s3", name: "Projets", emoji: "🧩", profileId: "s3")); variants.append(("a space added", added))
        var removed = firstState(); removed.spaces.removeLast(); variants.append(("a space removed", removed))
        var theme = firstState(); theme.spaces[0].rest["theme"] = .object(["hue": .number(10)]); variants.append(("a theme changed", theme))
        var folder = firstState(); folder.folders = [Folder(id: "f1", spaceId: "work", name: "Réunions")]; variants.append(("a folder", folder))
        var pinned = firstState(); pinned.tabs = [TabItem(id: "t1", spaceId: "work", url: "https://example.com/", title: "Example", pinned: true)]; variants.append(("a pinned tab", pinned))
        var favourite = firstState(); favourite.favorites = [Favorite(id: "v1", url: "https://example.com/", title: "Example")]; variants.append(("a favourite", favourite))
        for (name, state) in variants {
            #expect(!origin.observing(state).untouched, "\(name)")
        }
    }

    @Test func onceTouchedItStaysTouchedEvenIfEverythingIsPutBack() {
        var folder = firstState()
        folder.folders = [Folder(id: "f1", spaceId: "work", name: "Réunions")]
        let touched = firstOrigin().observing(folder)
        #expect(!touched.untouched)
        #expect(touched.observing(firstState()) == touched, "deleting what was made does not make the phone new again: the person did use it")
    }

    @Test func aStructureThatIsTheSameIsTheSameWhateverOrderTheKeysAreWritten() {
        var a = firstState()
        a.spaces[0].rest = ["theme": .object(["hue": .number(250), "sat": .number(50)])]
        var b = firstState()
        b.spaces[0].rest = ["theme": .object(["sat": .number(50), "hue": .number(250)])]
        #expect(SyncOrigin.structureHash(of: a) == SyncOrigin.structureHash(of: b))
    }

    @Test func theFileComesBackAsItWasAndAnUnreadableOneIsReportedNotGuessed() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "lucium-origin-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = SyncOriginFile(url: dir.appending(path: SyncOriginFile.fileName))
        #expect(file.load() == .none)
        let origin = firstOrigin()
        try file.save(origin)
        #expect(file.load() == .loaded(origin))
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        try Data("not json".utf8).write(to: file.url)
        guard case .unreadable = file.load() else {
            Issue.record("an unreadable file was read")
            return
        }
        try Data(repeating: 0x20, count: SyncOriginFile.maxBytes + 1).write(to: file.url)
        #expect(file.load() == .unreadable("not a small regular file"))
    }
}
