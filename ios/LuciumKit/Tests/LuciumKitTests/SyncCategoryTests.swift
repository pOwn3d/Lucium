import Foundation
import Testing
@testable import LuciumKit

/// Which categories the phone announces and which ones a session takes as common (docs/synchronisation.md §10.1, card 516), played against the vectors the Mac's TypeScript plays
/// too: `ios/Contracts/sync-categories-vectors.json` (`src/main/sync/session-category-vectors.test.ts`). A category whose entities hang on a space travels only with `structure`.
/// The vectors name every category of the Mac; this version plays the ones it knows (`SyncCategory(rawValue:)`), so a category added here is played from then on.
@Suite("Synchronisation: the categories announced and taken as common")
struct SyncCategoryTests {
    private static let file: JSONValue = {
        do { return try Contract.load("sync-categories-vectors.json") } catch {
            Issue.record("the category vectors do not load: \(error)")
            return .object([:])
        }
    }()

    private static func known(_ value: JSONValue?) -> [SyncCategory] { (value?.items ?? []).compactMap(\.text).compactMap(SyncCategory.init(rawValue:)) }
    private static func inOrder(_ set: some Sequence<SyncCategory>) -> [SyncCategory] { SyncCategory.allCases.filter(Set(set).contains) }

    @Test func theCategoriesThatNeedTheStructureAreTheOnesOfTheVectors() {
        let names = (Self.file["needStructure"]?.items ?? []).compactMap(\.text)
        #expect(!names.isEmpty)
        for name in names {
            // A name this version does not know is for a later card to add; one it knows must say it needs the structure.
            if let category = SyncCategory(rawValue: name) { #expect(category.needsStructure, "\(name) hangs on a space") }
        }
        for category in SyncCategory.allCases where category.needsStructure { #expect(names.contains(category.rawValue), "\(category.rawValue) is not in the vectors") }
    }

    @Test func whatAnnouncedIsWhatTheVectorsSayForEverySetOfCategories() {
        let cases = Self.file["announced"]?.items ?? []
        #expect(cases.count == 16)
        for item in cases {
            let ticked = Self.known(item["ticked"])
            #expect(SyncCategory.announced(ticked) == Self.known(item["announced"]), "ticked \(ticked.map(\.rawValue))")
        }
    }

    @Test func whatIsCommonIsWhatTheVectorsSayForEveryPairOfSets() {
        let cases = Self.file["common"]?.items ?? []
        #expect(cases.count > 256)
        for item in cases {
            let ticked = Self.known(item["ticked"])
            let theirs = (item["theirs"]?.items ?? []).compactMap(\.text)
            let common = SyncCategory.common(mine: SyncCategory.announced(ticked), theirs: theirs)
            #expect(Self.inOrder(common) == Self.known(item["common"]), "ticked \(ticked.map(\.rawValue)) with \(theirs)")
        }
    }

    @Test func noPairOfSetsMakesACategoryThatHangsOnASpaceCommonWithoutTheStructure() {
        let all = SyncCategory.allCases
        let subsets = (0..<(1 << all.count)).map { mask in all.enumerated().filter { mask & (1 << $0.offset) != 0 }.map(\.element) }
        for mine in subsets {
            for theirs in subsets {
                let common = SyncCategory.common(mine: SyncCategory.announced(mine), theirs: theirs.map(\.rawValue))
                if !common.contains(.structure) { #expect(common.allSatisfy { !$0.needsStructure }, "ticked \(mine.map(\.rawValue)) with \(theirs.map(\.rawValue))") }
            }
        }
    }
}
