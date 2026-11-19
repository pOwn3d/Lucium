import Foundation
import Testing
@testable import LuciumKit

@Suite("Synchronisation: what the page says about the last exchange")
struct SyncLastExchangeTests {
    private func summary(categories: Set<SyncCategory> = [.structure], taken: Int = 0, refused: Int = 0, rejected: Int = 0) -> SyncExchangeSummary {
        let refusedReceived = (0..<refused).map { SyncInbound.Refused(kind: "tab", id: "t\($0)", reason: .invalidValue) }
        return SyncExchangeSummary(at: 1, conflicts: [], refusedSent: [], refusedReceived: refusedReceived, rejectedByApply: (0..<rejected).map { "value \($0)" }, applied: taken > 0, adoptedTheMacState: false,
                                   spacesSetAside: 0, openTabs: nil, categories: categories, taken: taken)
    }

    @Test func aCategoryTickedHereAndNotOnTheMacIsNamedAsNotExchanged() {
        let lines = SyncLastExchange.lines(of: summary(categories: [.structure]), ticked: [.structure, .settings, .archive, .openTabs])
        #expect(lines == [.exchanged([.structure]), .notExchanged([.settings, .archive, .openTabs]), .nothingNew])
    }

    @Test func nothingIsSaidNotExchangedWhenEveryTickedCategoryCrossed() {
        let lines = SyncLastExchange.lines(of: summary(categories: [.structure, .settings], taken: 3), ticked: [.structure, .settings])
        #expect(lines == [.exchanged([.structure, .settings]), .received(3)])
    }

    @Test func aCategoryTheMacTickedAndThisPhoneDidNotIsNotReportedAsMissing() {
        // The Mac ticked more, the phone did not: the phone has nothing to tick, and the session carried what both ticked.
        let lines = SyncLastExchange.lines(of: summary(categories: [.structure]), ticked: [.structure])
        #expect(lines == [.exchanged([.structure]), .nothingNew])
    }

    @Test func noCategoryInCommonSaysNothingCrossedAndDoesNotClaimThereIsNothingNew() {
        let lines = SyncLastExchange.lines(of: summary(categories: []), ticked: [.settings])
        #expect(lines == [.exchanged([]), .notExchanged([.settings])])
    }

    @Test func whatWasLeftAsideIsCountedFromBothTheDoorAndTheWrite() {
        let lines = SyncLastExchange.lines(of: summary(categories: [.structure], taken: 1, refused: 2, rejected: 3), ticked: [.structure])
        #expect(lines == [.exchanged([.structure]), .received(1), .leftAside(5)])
    }

    @Test func theCategoriesCrossedAreListedInTheOrderOfTheSettingsPage() {
        let lines = SyncLastExchange.lines(of: summary(categories: [.archive, .structure, .openTabs], taken: 1), ticked: [.structure, .archive, .openTabs])
        #expect(lines.first == .exchanged([.structure, .archive, .openTabs]))
    }
}
