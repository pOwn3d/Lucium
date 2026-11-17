import Foundation
import Testing
@testable import LuciumKit

private func folder() -> URL { FileManager.default.temporaryDirectory.appending(path: "lucium-tabs-\(UUID().uuidString)") }

@Suite("What a sleeping tab keeps")
struct TabSideStoreTests {
    @Test func whatIsKeptComesBackPerTabAndPerSort() throws {
        let store = TabSideStore(directory: folder())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try store.write(Data("history".utf8), kind: .interaction, for: "a")
        try store.write(Data("picture".utf8), kind: .thumbnail, for: "a")
        try store.write(Data("other".utf8), kind: .interaction, for: "b")
        #expect(store.read(.interaction, for: "a") == Data("history".utf8))
        #expect(store.read(.thumbnail, for: "a") == Data("picture".utf8))
        #expect(store.read(.interaction, for: "b") == Data("other".utf8))
        #expect(store.read(.thumbnail, for: "b") == nil, "a tab that never slept has no picture")
    }

    @Test func aHostileTabIdCannotLeaveTheFolder() throws {
        let store = TabSideStore(directory: folder())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let hostile = "../../../escape"
        try store.write(Data("x".utf8), kind: .thumbnail, for: hostile)
        let written = store.url(of: .thumbnail, for: hostile).standardizedFileURL.path
        #expect(written.hasPrefix(store.directory.standardizedFileURL.path + "/"), "\(written)")
        #expect(!written.contains(".."))
        #expect(store.url(of: .thumbnail, for: "a") != store.url(of: .thumbnail, for: "b"))
    }

    @Test func somethingTooLargeIsRefusedAndNothingIsWritten() throws {
        let store = TabSideStore(directory: folder())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let big = Data(count: TabSideStore.maxBytes + 1)
        #expect(throws: TabSideStore.StoreError.tooLarge(bytes: big.count, limit: TabSideStore.maxBytes)) { try store.write(big, kind: .interaction, for: "a") }
        #expect(store.read(.interaction, for: "a") == nil)
    }

    @Test func removingATabRemovesBothFiles() throws {
        let store = TabSideStore(directory: folder())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try store.write(Data("h".utf8), kind: .interaction, for: "a")
        try store.write(Data("p".utf8), kind: .thumbnail, for: "a")
        try store.write(Data("h".utf8), kind: .interaction, for: "b")
        store.remove(for: "a")
        #expect(store.read(.interaction, for: "a") == nil && store.read(.thumbnail, for: "a") == nil)
        #expect(store.read(.interaction, for: "b") != nil)
    }

    @Test func pruningKeepsTheTabsOfTheStateAndLeavesOtherFilesAlone() throws {
        let store = TabSideStore(directory: folder())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try store.write(Data("h".utf8), kind: .interaction, for: "kept")
        try store.write(Data("p".utf8), kind: .thumbnail, for: "kept")
        try store.write(Data("h".utf8), kind: .interaction, for: "closed on the Mac")
        try store.write(Data("p".utf8), kind: .thumbnail, for: "closed on the Mac")
        try Data("mine".utf8).write(to: store.directory.appending(path: "notes.txt"))
        #expect(store.prune(keeping: ["kept"]) == 2)
        #expect(store.read(.interaction, for: "kept") != nil && store.read(.thumbnail, for: "kept") != nil)
        #expect(store.read(.interaction, for: "closed on the Mac") == nil)
        #expect(FileManager.default.fileExists(atPath: store.directory.appending(path: "notes.txt").path), "only what this store wrote is pruned")
    }

    @Test func pruningAFolderThatDoesNotExistYetIsNothing() {
        #expect(TabSideStore(directory: folder()).prune(keeping: ["a"]) == 0)
    }
}

@Suite("The data store of a profile")
struct ProfileStoreTests {
    @Test func theSameProfileAlwaysGetsTheSameStoreAndTwoProfilesNeverShareOne() {
        #expect(ProfileStore.identifier(for: "work") == ProfileStore.identifier(for: "work"))
        let ids = ["default", "work", "home", "Work", "work ", ""].map(ProfileStore.identifier(for:))
        #expect(Set(ids).count == ids.count)
    }

    @Test func itIsAWellFormedIdentifier() {
        let text = ProfileStore.identifier(for: "work").uuidString
        #expect(text.count == 36)
        #expect(text[text.index(text.startIndex, offsetBy: 14)] == "8", "version 8: \(text)")
        #expect("89AB".contains(text[text.index(text.startIndex, offsetBy: 19)]), "variant 10: \(text)")
    }
}
